/**
 * 精选工具面 —— 契约 v2.1.0 中人工筛选的 13 个工具（scope 硬门禁先行）。
 *
 * 纳入原则（对齐设计文档 §11 + grape-dsh CLI-CAPABILITY-BOUNDARY / DESIGN-A-MCP）：
 * - 只触发、只观察、可推进（start/resume/cancel 属用户决策层，工具描述里强制「需用户确认」）；
 * - 不暴露 A2A 节点间交接（trigger 是唯一入口，节点流转由服务端 pipelines.json 驱动）；
 * - session_only 命令（git-repo 等 28 个）不纳入 —— 外部 grape_ token 必 403；
 * - 高危动作（terminate / remove / delete）不纳管，兜底走 `grape` CLI 原生命令。
 *
 * 每个工具：{ name, description, schema, buildArgs, render }
 *   buildArgs(args) -> string[]   CLI 参数（不含 --json-out）
 *   render(json)    -> string     Markdown（无 UI 补偿层）
 */
import * as R from './render.mjs'
import * as lifecycleModule from './lifecycle.mjs'
import { hostname, tmpdir } from 'node:os'
import {
  existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, rmdirSync,
  readdirSync, readFileSync, lstatSync, realpathSync, statSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join, resolve, sep, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipDirectory } from './zip.mjs'
import { api, apiRequest, getBaseUrl, AGENT_TYPES, normalizeTriggerAgent, GrapeApiError } from './api.mjs'
import { materializeSkillAssets, SKILL_ROOT_DIRNAME } from './skill-materialize.mjs'
import { getServerCapabilities, normalizeSkills, evaluateTakeoverGate } from './capabilities.mjs'

/** kit 安装根（发布包含 skills/，Node 版接管脚本随 skill 副本分发） */
const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const fillCwd = (text, cwd) => String(text ?? '').replaceAll('{{CWD}}', cwd)

/* ── Issue #37：本地接管 workspace 解析（入参 > cwd_hint > 当前目录） ── */

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/

/** 路径比较用归一（统一分隔符、去尾分隔符；不做 fs 解析，云端 Windows 路径也安全） */
const normPathForCompare = (p) => String(p ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')

/** 字符串级包含判定（按分隔符边界；/a/bc 不算 /a/b 内） */
function pathInsideString(root, target) {
  const r = normPathForCompare(root)
  const t = normPathForCompare(target)
  if (!r || !t) return false
  return t === r || t.startsWith(r + '/')
}

/**
 * 路径归一：相对路径按基目录解析；绝对路径（含 Windows 盘符）原样保留。
 * 云端 cwd_hint 常是别的机器上的绝对路径，重解析会改写语义，因此只剥尾分隔符。
 */
function normalizeWorkspacePath(p, base) {
  const s = String(p ?? '').trim()
  if (!s) return ''
  const out = (isAbsolute(s) || WIN_ABS_RE.test(s)) ? s : resolvePath(base || process.cwd(), s)
  return out.replace(/[\\/]+$/, '') || out
}

/**
 * 本地接管工作区解析（纯优先级，不探测路径存在性）：
 * `args.workspace` > `bundle.workspace.cwd_hint` > `cwd`（缺省 process.cwd()）。
 * 三者不一致时由调用方（render/native）显式披露，不静默替换。
 */
export function resolveLocalWorkspace({ workspace, bundle, cwd } = {}) {
  const base = normalizeWorkspacePath(cwd) || normalizeWorkspacePath(process.cwd())
  const explicit = normalizeWorkspacePath(workspace, base)
  if (explicit) return explicit
  const hint = normalizeWorkspacePath((bundle?.workspace || {}).cwd_hint, base)
  if (hint) return hint
  return base
}

/**
 * 把平台下发的 `GRAPE_AUTH_FILE` 本地化到本机可写工作区（Issue #37）。
 * 规则（按序）：`{{CWD}}` 占位符 → 以本地 workspace 填充；位于 cwd_hint 根内 → 前缀替换为本地 workspace；
 * 平台默认 token 文件（`.grape-takeover-token`）但不在本地工作区 → 回落 `<workspace>/.grape-takeover-token`；
 * 其余无法安全重写的路径保持原值，但返回 note 由 render 显式提示 source。
 * @returns {{path: string, rewritten: boolean, note: string}}
 */
export function localizeAuthFile(authFile, { workspace, cwdHint } = {}) {
  const raw = String(authFile ?? '').trim()
  if (!raw) return { path: '', rewritten: false, note: '' }
  const local = normalizeWorkspacePath(workspace)
  if (!local) return { path: raw, rewritten: false, note: '' }
  if (raw.includes('{{CWD}}')) return { path: fillCwd(raw, local), rewritten: true, note: '' }
  const hint = normalizeWorkspacePath(cwdHint)
  if (hint && pathInsideString(hint, raw)) {
    const rest = normPathForCompare(raw).slice(normPathForCompare(hint).length + 1)
    const path = rest ? join(local, rest) : local
    return { path, rewritten: true, note: `凭据文件路径已按本地工作区重写：${raw} → ${path}` }
  }
  if (basename(raw) === '.grape-takeover-token' && !pathInsideString(local, raw)) {
    const path = join(local, '.grape-takeover-token')
    return { path, rewritten: true, note: `平台凭据文件位于云端视角路径（${raw}），本机不可写，已改为 ${path}；请把接管 token 写入该文件后再 source。` }
  }
  if ((isAbsolute(raw) || WIN_ABS_RE.test(raw)) && !pathInsideString(local, raw)) {
    return { path: raw, rewritten: false, note: `凭据文件仍在云端视角路径（${raw}），本机可能不可读；source 前先确认文件存在，或把 token 放到本地工作区后重新接管。` }
  }
  return { path: raw, rewritten: false, note: '' }
}

/** skill 详情直出上限（UTF-8 字节 = 64KB）；超过则落盘 + 预览，绝不静默截断（Issue #29） */
const SKILL_DETAIL_INLINE_LIMIT = 64 * 1024
/** 落盘场景透出的预览字数（Issue #29） */
const SKILL_DETAIL_PREVIEW_CHARS = 2000

/**
 * 超阈值正文落盘（Issue #29）：写入 os.tmpdir() 下的独立目录（mkdtemp 0700，防并发冲突），返回文件路径。
 * 逐字节原样写入（不做任何二次加工，与 API 返回的 content 字符串一致）；文件保留不删除，供调用方按路径读取全文。
 */
function dumpSkillDetail(name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-skill-'))
  const safe = String(name || 'skill').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'skill'
  const path = join(dir, `${safe}-${Date.now()}.md`)
  writeFileSync(path, body, 'utf8')
  return path
}

/** 服务端渲染脚本（未来 host_os 字段）兼容：字符串 / 数组 / 对象三种形态，统一替换 {{CWD}} */
function renderBundleScripts(scripts, cwd) {
  if (!scripts) return null
  const out = []
  const pushText = (label, text) => {
    const filled = fillCwd(text, cwd)
    if (!filled) return
    if (label) out.push(`# ${label}`)
    out.push(...String(filled).split('\n'))
  }
  if (typeof scripts === 'string') pushText('', scripts)
  else if (Array.isArray(scripts)) {
    for (const s of scripts) {
      if (typeof s === 'string') pushText('', s)
      // 平台资产形态 {name, filename, ext, mode, exec, content}：文件名比 name 更能指导落地
      else pushText(s.filename || s.name || s.os || s.platform || '', s.content || s.script || s.text || '')
    }
  } else if (typeof scripts === 'object') {
    for (const [k, v] of Object.entries(scripts)) {
      pushText(k, typeof v === 'string' ? v : (v?.content || v?.script || v?.text || ''))
    }
  }
  return out.length ? out : null
}

/**
 * Issue #28：接管会话建立后，把平台下发的 `bundle.assets.skill` 物化到本地工作区
 * `<cwd>/.grape-takeover-skills/<skill>/`（cwd 与接管脚本 `{{CWD}}` 同源：Issue #37 起为
 * `args.workspace > bundle.workspace.cwd_hint > process.cwd()` 解析出的**本地**路径）。
 *
 * 语义：物化失败 **不作废已建立的接管会话** —— 结果作为普通字段挂在返回体上，
 * 由 render 显式告警（legacy / failed）；这里只兜底“任何异常都不许外抛”。
 * 调用方显式传入 workspace 且与 cwd_hint 不一致时，返回体带 `workspace_effective` / `workspace_note`，
 * 供 render 披露「云端路径在本机不存在、已改用本地路径」，不静默替换。
 */
async function attachSkillMaterialization(json, { workspace } = {}) {
  if (!json || typeof json !== 'object') return json
  const bundle = json.bundle || {}
  const explicit = String(workspace ?? '').trim()
  const cwd = resolveLocalWorkspace({ workspace: explicit, bundle })
  const hint = String((bundle.workspace || {}).cwd_hint ?? '').trim()
  if (explicit) {
    json.workspace_effective = cwd
    if (hint && normPathForCompare(hint) !== normPathForCompare(cwd)) {
      json.workspace_note = `云端工作区路径在本机不存在（${hint}），已改用 ${cwd}（入参 workspace 优先）`
    }
  }
  if (json.detail) return json
  try {
    json.skillMaterialization = await materializeSkillAssets(bundle.assets?.skill, cwd, { env: bundle.env || process.env })
  } catch (e) {
    json.skillMaterialization = {
      status: 'failed',
      skill: '',
      path: '',
      fileCount: 0,
      hasReferences: false,
      reason: e && e.message ? e.message : String(e),
    }
  }
  return json
}

const str = (desc) => ({ type: 'string', description: desc })
const num = (desc) => ({ type: 'number', description: desc })
const bool = (desc) => ({ type: 'boolean', description: desc })


/* ── Issue #31：git 写回（tko_ 换一次性本仓券 → GIT_ASKPASS → push → PR） ── */

const ASKPASS_DIR = '.grape'
const ASKPASS_POSIX = 'git-askpass.sh'
const ASKPASS_WIN = 'git-askpass.cmd'
const REPO_SEG_RE = /^[A-Za-z0-9._-]+$/
const CODING_EVIDENCE_LABELS = { branch: 'branch', commit: 'commit sha', pr: 'PR 编号/链接' }

/**
 * 本进程内写出的 askpass（session_id → 绝对路径）：finish/abort 只清理自己写过的文件，
 * 不凭 session_id 猜测/遍历其它工作区的同名文件（防止误删）。
 */
const ASKPASS_REGISTRY = new Map()

const safeRealpath = (p) => {
  try { return realpathSync(p) } catch { return resolve(String(p ?? '')) }
}

/** 路径包含判定（归一后比较；按分隔符边界，避免 /a/bc 命中 /a/b 前缀） */
function insideRoot(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

const isDotSeg = (v) => {
  const s = String(v ?? '')
  return s === '.' || s === '..'
}

function assertRepoSeg(owner, repo) {
  const bad = (v) => !REPO_SEG_RE.test(String(v ?? '')) || isDotSeg(v)
  if (bad(owner) || bad(repo)) {
    throw new GrapeApiError(`非法仓库标识：${owner}/${repo}`, {
      status: 400,
      hint: 'owner/repo 只允许字母数字与 ._-，且不得为 . / ..（拒绝路径注入）；非本仓请求一律拒绝且不落盘。',
    })
  }
}

/** 接管会话的仓库绑定：repo_key（gitcode:o/r）> repo_full_name/repository > owner+repo */
function sessionRepoOf(session) {
  const s = session?.session || session || {}
  const rk = String(s.repo_key ?? s.repoKey ?? '').trim()
  if (rk.includes('/')) {
    const [o, r] = rk.split(':').pop().split('/')
    if (o && r) return { owner: o, repo: r }
  }
  const full = String(s.repo_full_name ?? s.full_name ?? s.repository ?? '').trim()
  if (full.includes('/')) {
    const [o, r] = full.split('/')
    if (o && r) return { owner: o, repo: r }
  }
  return { owner: String(s.owner ?? '').trim(), repo: String(s.repo ?? '').trim() }
}

/** 接管会话工作区：bundle.workspace.cwd_hint > workspace（对象/字符串）> cwd_hint */
function sessionWorkspaceOf(session) {
  const root = session?.session || session || {}
  const ws = root.bundle?.workspace ?? root.workspace
  if (typeof ws === 'string') return ws.trim()
  return String(ws?.cwd_hint ?? ws?.cwd ?? root.cwd_hint ?? root.cwd ?? '').trim()
}

/** 凭据到期 epoch：显式 expires_at 优先；否则 now + expires_in（平台实测只给 expires_in="600"） */
function credentialExpiry(cred, now) {
  const at = Number(cred?.expires_at ?? cred?.expiresAt ?? 0)
  if (Number.isFinite(at) && at > 0) return at
  const ttl = Number(cred?.expires_in ?? cred?.expiresIn ?? 0)
  if (Number.isFinite(ttl) && ttl > 0) return now + ttl
  return 0
}

const shSingleQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

/**
 * POSIX askpass：git 以 `<prompt>` 作为 $1 调用；先自检到期 epoch，
 * 过期 → stderr 提示「重新换券」并 exit 1（不存在 native git / CLI 静默回退分支）。
 */
function askpassPosix({ username, password, expiresAt }) {
  return [
    '#!/bin/sh',
    '# grape-kit 一次性 git askpass（Issue #31）——请勿提交/外传',
    `GRAPE_ASKPASS_EXPIRES=${Number(expiresAt)}`,
    `GRAPE_ASKPASS_USERNAME=${shSingleQuote(username)}`,
    `GRAPE_ASKPASS_PASSWORD=${shSingleQuote(password)}`,
    'NOW=$(date +%s 2>/dev/null || echo 0)',
    'if [ "$NOW" -ge "$GRAPE_ASKPASS_EXPIRES" ]; then',
    '  echo "[grape] git 凭据已过期（epoch ${GRAPE_ASKPASS_EXPIRES}），请重新换券：再次调用 grape_git_credential 换新券后重试；本脚本不静默回退本机 git/CLI 凭据。" >&2',
    '  exit 1',
    'fi',
    'case "$1" in',
    '  *[Uu]sername*) printf "%s\\n" "$GRAPE_ASKPASS_USERNAME" ;;',
    '  *) printf "%s\\n" "$GRAPE_ASKPASS_PASSWORD" ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Windows askpass（.cmd）：epoch 由 PowerShell 取。
 * 口令/用户名已在 run() 中拒绝 cmd 元字符，这里统一用 `set "VAR=..."` 包裹，避免 `%`/`&`/`^` 破坏脚本；
 * 取时间失败或非数字时**立即非零退出**（否则 `if %NOW% GEQ ...` 语法失败后会继续执行并回显口令）。
 */
function askpassCmd({ username, password, expiresAt }) {
  return [
    '@echo off',
    'rem grape-kit one-shot git askpass (Issue #31) - do not commit/share',
    `set "GRAPE_ASKPASS_EXPIRES=${Number(expiresAt)}"`,
    `set "GRAPE_ASKPASS_USERNAME=${username}"`,
    `set "GRAPE_ASKPASS_PASSWORD=${password}"`,
    'set "NOW="',
    'for /f "usebackq delims=" %%e in (`powershell -NoProfile -Command "[int][double]::Parse((Get-Date -UFormat %%s))"`) do set "NOW=%%e"',
    'if not defined NOW goto expired_guard',
    'echo %NOW%|findstr /r "^[0-9][0-9]*$" >nul',
    'if errorlevel 1 goto expired_guard',
    'if %NOW% GEQ %GRAPE_ASKPASS_EXPIRES% goto expired',
    'echo %1 | findstr /i "sername" >nul',
    'if errorlevel 1 (echo %GRAPE_ASKPASS_PASSWORD%) else (echo %GRAPE_ASKPASS_USERNAME%)',
    'exit /b 0',
    ':expired',
    'echo [grape] git 凭据已过期，请重新换券：再次调用 grape_git_credential 换新券后重试；不静默回退。 1>&2',
    'exit /b 1',
    ':expired_guard',
    'echo [grape] 无法获取有效系统时间（防凭据泄露已终止），请重新换券后重试。 1>&2',
    'exit /b 1',
    '',
  ].join('\r\n')
}

const CMD_UNSAFE_RE = /["%&^|<>()!`]/

/**
 * git 仓库内把 `/.grape/` 写进 `.git/info/exclude`，并用 `git check-ignore --no-index` 复核。
 * 非 git 工作区（无提交风险）跳过；是 git 仓库但无法确认已排除 → 拒绝写盘（600s 券不得进远端历史）。
 * worktree 中 `.git` 是文件，用 `git rev-parse --git-path info/exclude` 定位真实 exclude 文件。
 */
function ensureGrapeIgnored(ws) {
  const dotGit = join(ws, '.git')
  if (!existsSync(dotGit)) return { is_git: false, excluded: false }
  let rel = join('.git', 'info', 'exclude')
  try {
    rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: ws, encoding: 'utf8' }).trim() || rel
  } catch { /* 保持默认 .git/info/exclude */ }
  const excludePath = resolve(ws, rel)
  try {
    const cur = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    const hasRule = cur.split(/\r?\n/).some((line) => /^\s*\/?\.grape\/?\s*$/.test(line))
    if (!hasRule) {
      mkdirSync(dirname(excludePath), { recursive: true })
      const sep0 = cur && !cur.endsWith('\n') ? '\n' : ''
      writeFileSync(excludePath, `${cur}${sep0}/.grape/\n`)
    }
    execFileSync('git', ['check-ignore', '--no-index', '-q', join(ASKPASS_DIR, ASKPASS_POSIX)], { cwd: ws })
  } catch (e) {
    throw new GrapeApiError('拒绝写入 askpass：无法确认 .grape/ 已被 git 排除（600s 券可能被提交进远端历史）', {
      status: 400,
      hint: `写入 .git/info/exclude 的 /.grape/ 规则后 check-ignore 复核未通过（${e?.message || e}）。请先修复工作区 git exclude（可手动添加 /.grape/）后重新换券；本次未写入任何凭据文件。`,
    })
  }
  return { is_git: true, excluded: true, exclude_path: excludePath }
}

function askpassFiles(ws) {
  return [join(ws, ASKPASS_DIR, ASKPASS_POSIX), join(ws, ASKPASS_DIR, ASKPASS_WIN)]
}

/** askpass 所在目录（空则移除；非空/被占用不动，不影响清理结果） */
function pruneAskpassDir(file) {
  const dir = dirname(file)
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
  } catch { /* 目录非空/被占用：保留 */ }
}

/** 删除指定工作区的 askpass（幂等）；只碰本工具的两份固定文件名，目录空则一并移除 */
function removeAskpass(ws) {
  const removed = []
  for (const f of askpassFiles(ws)) {
    if (existsSync(f)) { rmSync(f, { force: true }); removed.push(f) }
  }
  for (const f of removed) pruneAskpassDir(f)
  return removed
}

/**
 * finish/abort 清理：优先清理本进程为 session 写出的路径（registry），再按显式 workspace 入参清理。
 * 二者都没有时不猜测路径——避免误删其它工作区里的同名文件。
 */
function cleanupAskpassFor(sessionId, workspace) {
  const removed = new Set()
  const key = String(sessionId ?? '')
  const reg = ASKPASS_REGISTRY.get(key)
  if (reg) {
    if (existsSync(reg)) { rmSync(reg, { force: true }); removed.add(reg); pruneAskpassDir(reg) }
    ASKPASS_REGISTRY.delete(key)
  }
  const ws = String(workspace ?? '').trim()
  if (ws) for (const f of removeAskpass(safeRealpath(ws))) removed.add(f)
  return [...removed]
}

/** coding 交回三件套（branch / commit / PR）：finish 的产物校验入参 */
function codingEvidence(a = {}) {
  return {
    branch: String(a.branch ?? '').trim(),
    commit: String(a.commit ?? '').trim(),
    pr: String(a.pr_number ?? a.pr ?? '').trim(),
  }
}

const missingCodingEvidence = (ev) => Object.entries(CODING_EVIDENCE_LABELS)
  .filter(([k]) => !ev[k])
  .map(([, label]) => label)

const WARNING_HINTS = {
  remote_may_still_run: '远程分支可能已被云端 worker 推送并开过 MR：先查远端分支与 issue/MR，避免破坏性强推（分支/MR 冲突必须先裁决）。',
  node_already_advanced: '链已交棒至下一节点：本次接管与下一节点并行，交回前先看 issue 事件，避免重复实现。',
  next_node_pending_dispatch: '下一节点未被派发：确认远端/节点状态后调 grape_trigger_pipeline(agent=…) 补发，或用 grape_takeover_status 复查会话。',
}
const warningHint = (w) => WARNING_HINTS[String(w).split(':')[0].trim()] || ''

/* ── Issue #19 / #30：交回后按场景链确保下一节点被派发（「链不断」不能只在描述里） ── */

/**
 * 多技能 fail-closed 的渲染（Issue #32）：首行必须是稳定错误码，随后完整披露
 * required 技能、服务端版本/能力来源/握手时间与三条升级指引——判据可追溯到本次握手。
 */
function renderCapabilityRefusal(json) {
  const lines = [
    `**接管已被拒绝：${json.code}**`,
    '',
    String(json.message || ''),
    '',
    `- 服务端版本: ${json.service_version || '未知'}`,
    `- 已声明能力: ${(json.supported_capabilities || []).join(', ') || '（无）'}`,
    `- 能力来源: ${json.capabilities_source || 'unknown'}`,
    `- 握手时间: ${json.handshake_at || '未知'}`,
    `- 要求技能（${json.required_count ?? 0}）: ${(json.required_skills || []).join(', ') || '（无）'}`,
  ]
  const remediation = Array.isArray(json.remediation) ? json.remediation : []
  if (remediation.length) {
    lines.push('', '**升级指引**', '')
    for (const r of remediation) lines.push(`- ${r}`)
  }
  if (json.retryable) lines.push('', '_本次握手未取得服务端能力（retryable=true）：稍后重试，或检查 /api/health 可达性。_')
  return lines.join('\n')
}

/* ── Issue #19：交回后按场景链确保下一节点被派发（「链不断」不能只在描述里） ── */

/**
 * 场景链缺省值：平台未在交回结果/会话里携带节点链时的兜底顺序。
 * #30 起客户端兜底不再硬编码 coding→qa，而是按**场景链 next** 推导（自定义链
 * coding→review→sre 同样可派发），未知节点名仍不改写、落 pending。
 */
const DEFAULT_SCENE_CHAIN = ['vod', 'issue', 'coding', 'qa', 'sre']
const DEPLOYMENT_NODES = new Set(['sre', 'deploy'])

const normalizeNodeName = (v) => String(v ?? '').trim().toLowerCase()

/** 场景节点既可能是字符串，也可能是 `{tag|agent|skill|name|type}` 对象 */
function nodeNamesOf(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((n) => (typeof n === 'string' ? n : (n?.tag ?? n?.agent ?? n?.skill ?? n?.name ?? n?.type ?? '')))
    .map(normalizeNodeName)
    .filter(Boolean)
}

/**
 * 取场景链：优先交回结果/会话携带的场景节点，缺省回落内置链。
 * 只认明确的场景字段，不猜测任意数组，避免把无关列表误当节点链。
 */
const sceneNodeName = (n) => normalizeNodeName(n?.tag ?? n?.id ?? n?.agent ?? n?.skill ?? n?.name ?? n?.type)

async function resolveSceneChain(json = {}, args = {}, apiMod = api) {
  const explicit = sceneChainOf(json)
  if (explicit.length) return { chain: explicit, nextMap: null, source: 'response' }
  const sess = json.session || {}
  let sceneId = String(json.scene_id ?? sess.scene_id ?? args.scene_id ?? process.env.GRAPE_SCENE_ID ?? '').trim()
  // scene_id 缺失时按会话所属仓库回查仓库场景（唯一或唯一 custom-* 场景），补出可查的 scene_id；
  // 查不到不猜默认链，落 pending 待人工裁决。
  if (!sceneId && typeof apiMod?.repoScenes === 'function') {
    const t0 = resolveDispatchTarget(json, args)
    if (t0.owner && t0.repo && t0.issue_number) {
      try {
        const rows = await apiMod.repoScenes(t0.owner, t0.repo)
        const list = Array.isArray(rows) ? rows : (rows?.scenes || rows?.items || [])
        const sceneRow = list.length === 1 ? list[0] : list.find((r) => String(r?.id ?? r?.scene_id ?? '').startsWith('custom-'))
        sceneId = String(sceneRow?.id ?? sceneRow?.scene_id ?? '').trim()
      } catch { /* 仓库场景回查失败：不猜链 */ }
    }
  }
  if (!sceneId || typeof apiMod.scenesDetail !== 'function') {
    return { chain: [], nextMap: null, source: '' }
  }
  try {
    const detail = await apiMod.scenesDetail(sceneId)
    const nodes = Array.isArray(detail?.nodes) ? detail.nodes : []
    const chain = nodes.map(sceneNodeName).filter(Boolean)
    if (!chain.length) return { chain: [], nextMap: null, source: 'scene_empty' }
    const nextMap = {}
    for (const n of nodes) {
      const name = sceneNodeName(n)
      if (name) nextMap[name] = normalizeNodeName(n?.next)
    }
    return { chain, nextMap, source: 'scene' }
  } catch {
    return { chain: [], nextMap: null, source: 'scene_failed' }
  }
}

function nextNodeInChain(chain, current, nextMap) {
  const cur = normalizeNodeName(current)
  if (!cur) return { agent: '', tail: false, notInChain: false }
  if (nextMap) {
    if (!(cur in nextMap)) return { agent: '', tail: false, notInChain: true }
    const nx = normalizeNodeName(nextMap[cur])
    if (!nx || nx === 'done' || nx === 'end') return { agent: '', tail: true, notInChain: false }
    return { agent: nx, tail: false, notInChain: false }
  }
  const at = chain.indexOf(cur)
  if (at < 0) return { agent: '', tail: false, notInChain: true }
  return { agent: chain[at + 1] || '', tail: at === chain.length - 1, notInChain: false }
}

function sceneChainOf(json = {}) {
  const sess = json.session || {}
  const candidates = [
    json.scene_agents, json.scene_chain, json.scene?.agents, json.scene?.nodes,
    json.pipeline?.agents, json.pipeline?.nodes,
    sess.scene_agents, sess.scene_chain, sess.scene?.agents, sess.scene?.nodes,
  ]
  for (const c of candidates) {
    const names = nodeNamesOf(c)
    if (names.length) return names
  }
  return []
}

/** 场景链里 `current` 的下一节点；不在链中则返回空（不臆造） */
function nextInSceneChain(chain, current) {
  const at = chain.indexOf(normalizeNodeName(current))
  return at < 0 ? '' : (chain[at + 1] || '')
}

/**
 * 交回结果里会阻塞「立即派发」的警告**稳定码**（取 `code:` 前缀精确匹配）。
 * 平台 warnings 元素是稳定 code 列表；不匹配散文子串——「branch_sync: 远端无冲突」
 * 这类含「冲突」二字的文案不得误阻塞派发（远端仍在跑时贸然派发会与云端任务撞车）。
 */
const DISPATCH_BLOCKER_CODES = new Set(['remote_may_still_run', 'branch_conflict', 'merge_conflict'])
const warningCode = (w) => String(w ?? '').split(':')[0].trim().toLowerCase()

const asAgentType = (v) => {
  const s = String(v ?? '').trim().toLowerCase()
  return AGENT_TYPES.includes(s) ? s : ''
}

/**
 * 交回响应派发相关字段的唯一取值口径：**session 优先、仅 nullish 回落顶层**。
 * session 是会话记录的权威形态；判据（next_seq/handoff_seq/skipped_dispatches）、
 * 渲染与补发 context 必须共用本 getter——顶层出现 0/空值时不得遮蔽 session 里的真实指针，
 * 否则同一字段两处取值会得出「判据说未派发、渲染说已派发」的互斥结论。
 */
const seqOf = (json, key) => Number(json?.session?.[key] ?? json?.[key]) || 0

/**
 * #30「下一节点已派发」的唯一权威判据：`handoff.seq>0` 或 `handoff.reason=already_dispatched`。
 * 平台 finish 不回填 `next_seq`（实测恒 0），故 `next_seq` 降级为辅助展示信号，**不单独构成已派发证据**。
 * finish 判据与 takeover_status 渲染必须共用本函数，禁止两套取值顺序。
 */
function dispatchEvidenceOf(json = {}) {
  const sess = json.session || {}
  const ho = [json.handoff, sess.handoff].find((v) => v && typeof v === 'object') || {}
  const seq = Number(ho.seq ?? ho.event_seq ?? ho.handoff_seq) || 0
  const rawReason = ho.reason ?? ho.status ?? json.handoff_reason ?? sess.handoff_reason
    ?? (typeof json.handoff === 'string' ? json.handoff : '')
    ?? (typeof sess.handoff === 'string' ? sess.handoff : '')
  const reason = normalizeNodeName(rawReason)
  return { seq, reason, dispatched: seq > 0 || reason === 'already_dispatched' }
}

/** issue 事件里是否已有下一节点的 `a2a_event`：命中返回事件 seq，否则 0 */
function eventsTruncated(events) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) return false
  const rows = events.events || events.items || []
  const total = Number(events.total)
  return Number.isFinite(total) && total > (Array.isArray(rows) ? rows.length : 0)
}

function nextNodeEventSeq(events, agent, sinceSeq = 0) {
  const rows = Array.isArray(events) ? events : (events?.events || events?.items || [])
  const target = normalizeNodeName(agent)
  const floor = Number(sinceSeq) || 0
  if (!target || !Array.isArray(rows) || floor <= 0) return 0
  let hit = 0
  for (const e of rows) {
    const type = normalizeNodeName(e?.event_type ?? e?.type)
    const node = normalizeNodeName(e?.agent_type ?? e?.agent)
    const status = normalizeNodeName(e?.status)
    if (type !== 'a2a_event' || node !== target || status === 'failed') continue
    const seq = Number(e?.seq) || 0
    if (seq < floor) continue
    if (seq > hit) hit = seq
  }
  return hit
}

/**
 * issue 展示口径：`issue_number` 是单号，`issue_id` 是平台内部主键（#19 实测 18808）——
 * 两者不得互换，缺单号时内部主键必须显式标注，避免读者把它当单号对外引用。
 */
const issueLabel = (r = {}) => {
  const num = Number(r.issue_number ?? r.number) || 0
  if (num > 0) return `#${num}`
  const id = String(r.issue_id ?? '').trim()
  return id ? `id=${id}（内部主键）` : ''
}

/**
 * 平台 `handoff` 字段的渲染口径：字符串直接当标签；对象一律按结构化口径描述，
 * 不得把对象插进模板串——否则渲染成 `handoff=[object Object]`，
 * 平台失败原文（实测形状 `{"ok":false,"error":"HTTP 405: ..."}`）随之丢失。
 */
function describeHandoff(v) {
  if (v === undefined || v === null || v === '') return { label: 'a2a', failure: '' }
  if (typeof v === 'string') return { label: v.trim() || 'a2a', failure: '' }
  if (typeof v === 'object') return { label: '结构化', failure: handoffFailure(v) }
  return { label: String(v), failure: '' }
}

/** 平台 handoff 失败原文：`ok=false`（或缺 ok 但带错误字段）即失败，原样透出 error/detail/message */
function handoffFailure(v = {}) {
  const failed = v.ok === false || (v.ok === undefined && Boolean(v.error || v.detail || v.message))
  if (!failed) return ''
  return String(v.error ?? v.detail ?? v.message ?? '').trim() || '平台返回 ok=false 但未给错误详情'
}

/** 交回结果里的结构化输出（session.result_json 平台给对象或 JSON 文本两种形态） */
function resultJsonOf(json = {}) {
  const raw = json.result_json ?? json.session?.result_json
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(String(raw)) } catch { return {} }
}

/**
 * 下一节点：平台 next_agent > 结构化 next_step（**整串** agent 名，如 `qa`）> 兜底范围内的场景链推导。
 * next_step 不做自然语言解析：真实形如「qa：请复查 PR #10」的散文推导为空，交给场景链兜底。
 *
 * ⚠️ 与 `seqOf` 的优先级相反（这里顶层优先）是刻意的语义差异，不要为「统一」而互换：
 * `next_agent` 是离散标签，顶层代表**本次交回**平台刚给出的决定，session 快照可能还停在旧值；
 * 而 `next_seq`/`handoff_seq` 是计数器，交回响应顶层常被置 0 或缺省（0 是缺省值而非事实），
 * 必须让 session 记录先说话。两处各自取「最新且可靠的那一份」。
 *
 * 返回值区分两件不同的事（QA 终审判断项 2）：
 * - `agent`：认得出来的节点名（可直接派发）；
 * - `unknown`：平台**给了**一个白名单外的节点名（实测 `reviewer`）。
 * 「没给」（unknown 为空）才允许按场景链兜底；「给了但不认识」必须原样上报、不得静默改写成
 * 场景链下一节点——否则平台的决定被客户端顶掉，读者还以为是平台派的。
 * `next_step` 的散文（如「qa：请复查 PR #10」）不算平台给了节点名，仍按场景链兜底（S6）。
 */
function resolveNextTarget(json = {}, chain = [], nextMap = null) {
  const sess = json.session || {}
  const rj = resultJsonOf(json)
  const knownNode = (v) => {
    const n = normalizeNodeName(v)
    return n && (AGENT_TYPES.includes(n) || chain.includes(n)) ? n : ''
  }
  const declared = [json.next_agent, sess.next_agent, rj.next_agent]
    .map((v) => String(v ?? '').trim())
    .find(Boolean)
  if (declared !== undefined) {
    const agent = knownNode(declared)
    return agent
      ? { agent, unknown: '', derived: false, tail: false, notInChain: false }
      : { agent: '', unknown: declared, derived: false, tail: false, notInChain: false }
  }
  const stepAgent = knownNode(rj.next_step)
  if (stepAgent) return { agent: stepAgent, unknown: '', derived: false, tail: false, notInChain: false }
  const current = normalizeNodeName(sess.agent_type) || normalizeNodeName(json.agent_type)
  const next = nextNodeInChain(chain, current, nextMap)
  return { agent: next.agent, unknown: '', derived: true, tail: next.tail, notInChain: next.notInChain }
}

/**
 * 派发所需仓库/issue 标识：优先交回结果与 session，缺则回落到工具入参。
 * ⚠️ 不拿 issue_id 兜底 issue_number：平台 /tasks 里 issue.id 是内部主键（#19 实测 18808），
 * issue_number 才是单号（19）；把主键当单号派发会打到错误 issue。
 */
function resolveDispatchTarget(json = {}, args = {}) {
  const sess = json.session || {}
  const first = (...vals) => vals
    .map((v) => (v === undefined || v === null ? '' : String(v).trim()))
    .find(Boolean) || ''
  const repoKey = first(sess.repo_key, json.repo_key, sess.repoKey, json.repoKey)
  const full = repoKey
    ? repoKey.split(':').pop()
    : first(sess.repo_full_name, json.repo_full_name, sess.full_name, json.full_name, sess.repository, json.repository)
  const [keyOwner, keyRepo] = full && full.includes('/') ? full.split('/') : ['', '']
  const owner = keyOwner || first(sess.owner, json.owner, args.owner)
  const repo = keyRepo || first(sess.repo, json.repo, args.repo)
  const issue = Number(first(sess.issue_number, json.issue_number, args.issue_number))
  return { owner, repo, issue_number: Number.isFinite(issue) && issue > 0 ? issue : 0 }
}

/** 补发前的平台事实核查：issue 事件里是否已有下一节点的 a2a 派发事件（seq 门槛避免拿历史事件当本次派发） */
async function findDispatchedSeq(apiMod, target, agent, sinceSeq) {
  if (!agent || !target?.owner || !target?.repo || !target?.issue_number) return 0
  if (typeof apiMod?.issueEvents !== 'function') return 0
  try {
    const d = await apiMod.issueEvents(target.owner, target.repo, target.issue_number)
    const evs = Array.isArray(d?.events) ? d.events : (Array.isArray(d) ? d : [])
    const floor = Number(sinceSeq) || 0
    const hits = evs
      .filter((e) => asAgentType(e?.agent_type ?? e?.agent) === agent)
      .filter((e) => String(e?.event_type ?? '').includes('a2a'))
      .filter((e) => Number(e?.seq) >= floor)
      .map((e) => Number(e?.seq) || 0)
      .filter((s) => s > 0)
    return hits.length ? Math.max(...hits) : 0
  } catch {
    return 0
  }
}

/** 补发时的 A2A context：说清上一节点已完成，避免下一节点重复实现 */
function dispatchContext(json, nextAgent) {
  const sid = String(json.session?.id || json.session_id || '').trim()
  const handoff = seqOf(json, 'handoff_seq')
  // 无会话 id 时不留「接管会话  正式交回」的空指代
  const who = sid ? `接管会话 ${sid} 已正式交回` : '本地接管成果已正式交回'
  const ref = handoff ? `（交回侧事件 seq=${handoff}）` : ''
  return `${who}${ref}，按场景链派发下一节点 ${nextAgent}；上一节点已完成，勿重复实现。`
}

/**
 * 待派发标记的持久化依据：finish 在服务端**同步关会话**（status→finished），
 * 之后再向该会话写 progress 必被 409 not_active「接管会话已结束」拒绝（平台 mgmt 路由实测）——
 * task_messages 通道对交回后的标记不可用。标记因此不靠事后写入，而由**会话记录本身**承载：
 * finished + next_agent 有值 + 派发指针 next_seq=0 即「交回已写、派发未证实」，
 * grape_takeover_status 对已结束会话仍可查（GET 无状态门），渲染据此派生目标/原因/补发指引。
 */

/**
 * 交回后确保下一节点被派发：平台已派发不重复；平台漏派时客户端兜底补发；
 * 无法派发时返回结构化告警 + 待派发标记（不再静默 grace）。
 *
 * 幂等判据只用 next_seq（派发指针）——handoff_seq 是平台侧「交回事件」序号，
 * 不代表派发已发生；只见 handoff_seq 时按「交回已写、派发未证实」兜底补发并告警
 * （两字段合并会把「事件已写、派发未发生」误判成已派发）。
 */
async function ensureNextNodeDispatched(json, args = {}, apiMod = api) {
  const base = json && typeof json === 'object' ? json : { raw: json }
  const sess = base.session || {}
  const scene = await resolveSceneChain(base, args, apiMod)
  const chain = scene.chain
  const { agent: nextAgent, unknown: unknownNextAgent, derived, tail, notInChain } = resolveNextTarget(base, chain, scene.nextMap)
  const chainLabel = chain.length ? chain.join('→') : '未知（场景接口未返回节点链）'
  const evidence = dispatchEvidenceOf(base)
  const roundFloor = seqOf(base, 'handoff_seq')
  let target = resolveDispatchTarget(base, args)
  // 交回响应常缺仓库/issue 标识（实测 shape：next_agent + handoff_seq）：
  // 会话记录里 repo_key/issue_number 是权威来源，缺标识时回读一次会话再解析。
  {
    const sid = String(base.session?.id || base.session_id || args.session_id || '').trim()
    if ((!target.owner || !target.repo || !target.issue_number) && sid && typeof apiMod?.takeoverGet === 'function') {
      try {
        const fresh = await apiMod.takeoverGet(sid)
        const sn = fresh?.session || fresh || {}
        base = { ...base, session: { ...base.session, ...sn } }
        const refreshed = resolveDispatchTarget(base, args)
        if (refreshed.owner && refreshed.repo && refreshed.issue_number) target = refreshed
      } catch { /* 读不到会话就保留原判：仍按 no_target 显式告警 */ }
    }
  }
  // 无法派发时一律落到「待派发」：显式告警；标记随交回结果返回，事后经会话记录可查（见 pending 注释）。
  // `cause` 只用于渲染分支（交回未成功 / 节点名不认识 / 派发未证实 的处置动作各不相同）。
  const pending = (reason, cause = 'blocked') => ({
    ...base,
    next_agent: nextAgent,
    next_seq: 0,
    pending_dispatch: { agent: nextAgent, ...target, reason },
    dispatch: { status: 'pending', agent: nextAgent, seq: 0, warnings: [reason], cause },
  })
  // 交回本身没成功（平台明确 ok=false，或 changed=false 表示未真正落账）时**不得**派发下一节点：
  // 下一节点会接手一个未交回的任务。「部分成功当全部成功」正是 #19 要根除的形态，
  // 现实测可达面为「200 + ok:false」（401 经 CLI 回退后同样返回 ok:false）。
  if (base.ok === false || base.changed === false) {
    const cause = base.ok === false ? 'finish_not_ok' : 'finish_not_changed'
    const detail = String(base.error ?? base.detail ?? base.message ?? '').trim()
      || (base.ok === false ? '平台返回 ok=false 但未给错误详情' : '平台返回 changed=false（交回未落账）')
    return pending(
      `next_node_pending_dispatch: 交回未成功（${detail}），未派发 ${nextAgent || '下一节点'}；先重试交回，成功后再派发`,
      cause,
    )
  }
  // #30 权威判据：handoff.seq>0 或 handoff.reason=already_dispatched 即平台已派发。
  // next_seq 恒为 0，不能作为「未派发」证据；这里也不再据 next_seq 反推已派发。
  if (evidence.dispatched) {
    return {
      ...base,
      next_agent: nextAgent || unknownNextAgent || base.next_agent || '',
      next_seq: evidence.seq,
      dispatch: {
        status: 'already_dispatched',
        agent: nextAgent || unknownNextAgent || '',
        seq: evidence.seq,
        reason: evidence.reason,
        warnings: [],
      },
    }
  }
  if (unknownNextAgent) {
    // 平台给了场景链/已知节点之外的节点名：不是「平台未给」，不得按场景链改写顶掉平台决定
    return {
      ...base,
      next_agent: unknownNextAgent,
      next_seq: 0,
      pending_dispatch: { agent: unknownNextAgent, ...target, reason: `平台指定的下一节点「${unknownNextAgent}」不在场景链（${chainLabel}）内，未按场景链改写` },
      dispatch: {
        status: 'pending', agent: unknownNextAgent, seq: 0, cause: 'unknown_next_agent',
        warnings: [`next_node_pending_dispatch: 平台指定的下一节点「${unknownNextAgent}」不在场景链（${chainLabel}）内，未按场景链改写、未派发，需人工裁决`],
      },
    }
  }
  if (!nextAgent) {
    if (tail) {
      // 场景链尾（node.next=done/空）：正常收尾，无需派发
      return { ...base, next_agent: '', next_seq: 0, dispatch: { status: 'no_next_node', agent: '', seq: 0, warnings: [] } }
    }
    // 平台未指定且场景链不可用/当前节点不在链内：不猜默认链，落 pending 待人工确认
    const why = notInChain
      ? `当前节点「${normalizeNodeName(sess.agent_type) || normalizeNodeName(base.agent_type) || '未知'}」不在场景链（${chainLabel}）内`
      : `场景链未知（${chainLabel}），无法按节点 next 推导下一节点`
    return pending(`next_node_pending_dispatch: ${why}，未猜测默认链、未派发；请核实场景链后手动 grape_trigger_pipeline 补发`, 'no_scene_chain')
  }
  // 部署类节点（sre/deploy）保留用户确认决策门：自动派发会触发不可撤回的部署/发布
  if (DEPLOYMENT_NODES.has(nextAgent)) {
    return pending(
      `next_node_pending_dispatch: 下一节点 ${nextAgent} 属部署/发布类，需用户确认后再执行；确认后调用 grape_trigger_pipeline(agent=${nextAgent}) 派发`,
      'confirmation_required',
    )
  }
  const platformWarnings = [base.warnings, sess.warnings]
    .flatMap((w) => (Array.isArray(w) ? w : (w ? [w] : [])))
  const blockers = platformWarnings.filter((w) => DISPATCH_BLOCKER_CODES.has(warningCode(w)))
  const skipped = seqOf(base, 'skipped_dispatches')
  if (blockers.length) {
    return pending(`next_node_pending_dispatch: 平台警告「${blockers.join('；')}」，未立即派发 ${nextAgent}，需人工裁决后补发`, 'blocked')
  }
  if (skipped > 0) {
    return pending(`next_node_pending_dispatch: 平台 skipped_dispatches=${skipped}，未派发 ${nextAgent}，需人工补发`, 'skipped')
  }
  if (!target.owner || !target.repo || !target.issue_number) {
    return pending(`next_node_pending_dispatch: 缺少仓库/issue 标识，无法派发 ${nextAgent}；可用 owner/repo/issue_number 入参重试`, 'no_target')
  }
  // 双判据缺失：以本轮交回事件序号为下界回读 issue 事件，确认本轮无下一节点 a2a_event 才补发。
  // 回读失败/被截断时落 pending，不盲目补发。
  if (typeof apiMod.issueEvents !== 'function') {
    return pending(`next_node_pending_dispatch: 当前 api 模块缺少 issueEvents，无法回读事件确认 ${nextAgent} 是否已派发；先核实事件再补发`, 'readback_failed')
  }
  let existingSeq = 0
  try {
    const events = await apiMod.issueEvents(target.owner, target.repo, target.issue_number)
    existingSeq = nextNodeEventSeq(events, nextAgent, roundFloor)
    if (!existingSeq && eventsTruncated(events)) {
      return pending(`next_node_pending_dispatch: 事件回读被分页截断（total>返回条数），无法确认本轮是否已派发 ${nextAgent}；先核实事件再补发`, 'readback_incomplete')
    }
  } catch (e) {
    return pending(`next_node_pending_dispatch: 回读 issue 事件失败（${e?.message || e}），无法确认 ${nextAgent} 是否已派发；先核实事件再补发`, 'readback_failed')
  }
  if (existingSeq > 0) {
    return {
      ...base,
      next_agent: nextAgent,
      next_seq: existingSeq,
      dispatch: { status: 'already_dispatched', agent: nextAgent, seq: existingSeq, reason: 'event_exists', warnings: [] },
    }
  }
  try {
    const ctx = dispatchContext(base, nextAgent)
    const r = AGENT_TYPES.includes(nextAgent) || typeof apiMod.dispatchPipeline !== 'function'
      ? await apiMod.triggerPipeline(target.owner, target.repo, target.issue_number, ctx, nextAgent)
      : await apiMod.dispatchPipeline(target.owner, target.repo, target.issue_number, ctx, nextAgent)
    const seq = Number(r?.seq ?? r?.event_seq) || 0
    if (!seq) {
      // 补发响应缺事件 seq（stub/平台 200 形态 `{}`）：派发是否发生无证据，
      // 判 dispatched 并渲染「已自动派发 seq=0」会把未证实当成功——落 pending 由人工查事件核实。
      return pending(`next_node_pending_dispatch: 补发 ${nextAgent} 的响应未返回事件 seq，派发未证实，需查事件核实后决定是否补发`, 'dispatch_unconfirmed')
    }
    return {
      ...base,
      next_agent: nextAgent,
      next_seq: seq,
      dispatch: { status: 'dispatched', agent: nextAgent, seq, warnings: [] },
    }
  } catch (e) {
    return pending(`next_node_pending_dispatch: 自动派发 ${nextAgent} 失败（${e?.message || e}），需手动补发`, 'dispatch_failed')
  }
}

/**
 * 审核类端点直调：apiRequest 是 src/api.mjs 的命名导出，必须直接调用
 * （曾误写成 api.apiRequest → 三个工具 native 必崩）。403 属凭据通道边界，
 * 补上可执行的修复动作，避免用户误以为权限缺失而反复重试。
 */
async function reviewPost(path, body) {
  try {
    return await apiRequest('POST', path, { body })
  } catch (e) {
    if (e instanceof GrapeApiError && e.status === 403) {
      throw new GrapeApiError(e.message, {
        status: 403,
        code: e.code,
        hint: '审核端点仅放行会话级 tk_ token；用户级 grape_ Key 会被 403 拒绝（属凭据通道边界，不是权限缺失）。请改用 Grape WebUI 审核，或由持有 tk_ 会话的宿主执行。',
      })
    }
    throw e
  }
}

/* ── 技能上传：本地预检 + ZIP 打包（对齐服务端 validate_skill 口径） ── */

/** 系统标签（与 Agent 类型同名会被服务端 400「标签不能与系统标签重名」拦掉） */
const SYSTEM_SKILL_TAGS = new Set([...AGENT_TYPES, 'chat', 'auto'])

/** 解析 SKILL.md 的 YAML frontmatter（只取顶层 `key: value`，够校验用，不引 yaml 依赖） */
export function parseSkillFrontmatter(md) {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || ''))
  if (!m) return null
  const out = {}
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^\s/.test(raw)) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    val = val.replace(/\s+#.*$/, '')  // 行内注释
    if (val.startsWith('#')) val = ''
    const clean = val.replace(/^['"]|['"]$/g, '').trim()
    if (clean) out[key] = clean   // 空值不落键（与缺字段同义，preflight 用 ?? '' 取值）
  }
  return out
}

/**
 * 技能目录本地预检：服务端 validate_skill 的硬性要求前置到本地，
 * 一次把所有问题列出来（服务端只会 400 + errors 列表，宿主侧常只看到第一条）。
 * 返回 { rootName, name, version, description, errors[] }
 */
export function preflightSkillDir(dir, overrideName = '') {
  const abs = resolvePath(String(dir || '').trim())
  if (!dir || !existsSync(abs) || !statSync(abs).isDirectory()) {
    return { rootName: '', name: '', version: '', description: '', errors: [`目录不存在或不是目录：${dir || '（空）'}`] }
  }
  const dirName = basename(abs)
  const rootName = String(overrideName || dirName)
  const mdPath = `${abs}/SKILL.md`
  if (!existsSync(mdPath)) {
    return { rootName, name: '', version: '', description: '', errors: [`缺少 ${mdPath}（技能根目录必须直接包含 SKILL.md）`] }
  }
  const errors = []
  const fm = parseSkillFrontmatter(readFileSync(mdPath, 'utf8'))
  if (!fm) errors.push('SKILL.md 缺少 YAML Front Matter（首行 ---、字段区、再一行 ---）')
  const name = String(fm?.name ?? '').trim()
  const version = String(fm?.version ?? '').trim()
  const description = String(fm?.description ?? '').trim()
  if (!name) errors.push('frontmatter 缺 name（只允许小写字母/数字/连字符，且必须等于目录名）')
  else if (!/^[a-z0-9-]+$/.test(name)) errors.push(`frontmatter name='${name}' 只允许小写字母、数字、连字符`)
  else if (name !== rootName) errors.push(`frontmatter name='${name}' 必须与技能目录名（${rootName}）一致；改名或改目录后再传`)
  if (version && !/^v?\d+(\.\d+){0,2}$/.test(version)) errors.push(`frontmatter version='${version}' 需为 x / x.y / x.y.z（可带 v 前缀）`)
  if (!description) errors.push('frontmatter description 不能为空（技能列表靠它展示）')
  else if (description.length > 2048) errors.push('frontmatter description 不超过 2048 字')
  return { rootName, name, version, description, errors }
}

/** 标签预检：≤5 个、≤12 字、不与系统标签重名（服务端同名规则） */
export function preflightSkillTags(tags) {
  const list = String(tags || '').split(',').map((t) => t.trim()).filter(Boolean)
  const errors = []
  if (list.length > 5) errors.push(`标签最多 5 个（当前 ${list.length} 个）`)
  const long = list.filter((t) => t.length > 12)
  if (long.length) errors.push(`单个标签最多 12 字，超出：${long.join('、')}`)
  const conflicts = list.filter((t) => SYSTEM_SKILL_TAGS.has(t.toLowerCase()))
  if (conflicts.length) errors.push(`标签不能与系统标签（Agent 类型）重名：${conflicts.join('、')}——改用业务词，如 deploy-playbook、obs-site`)
  return { list, errors }
}

async function uploadSkillNative(a) {
  const scope = String(a.scope || 'user')
  if (!['user', 'repo'].includes(scope)) {
    throw new GrapeApiError(`scope 只能是 user 或 repo（收到 '${scope}'）`, { status: 400 })
  }
  if (!AGENT_TYPES.includes('chat')) { /* schema 已枚举，防御未来变更 */ }
  if (!a.agent_type) {
    throw new GrapeApiError('缺少 agent_type（技能类型）：vod / issue / coding / qa / sre / chat / auto', { status: 400 })
  }
  const repoFull = a.owner && a.repo ? `${a.owner}/${a.repo}` : ''
  if (scope === 'repo' && !repoFull) {
    throw new GrapeApiError('scope=repo 必须同时给 owner + repo（仓库技能要落到具体仓库）', { status: 400 })
  }
  const pf = preflightSkillDir(a.path, a.skill_name)
  const tagCheck = preflightSkillTags(a.tags)
  const errors = [...pf.errors, ...tagCheck.errors]
  if (errors.length) {
    throw new GrapeApiError(`技能本地预检未通过（未发起上传，共 ${errors.length} 条）：\n- ${errors.join('\n- ')}`, { status: 400 })
  }
  const { buffer, rootName, files } = zipDirectory(resolvePath(a.path), { rootName: pf.rootName })
  const json = await api.skillUpload(buffer, `${rootName}.zip`, {
    scope,
    repo: repoFull,
    agent_type: a.agent_type,
    tags: a.tags || '',
    summary: a.summary || pf.description.slice(0, 200),
    change_note: a.change_note || '',
  })
  return {
    ...json,
    root_name: rootName,
    files_count: files.length,
    bytes: buffer.length,
    version: pf.version || '1.0.0',
    scope,
    repo: repoFull,
  }
}

function renderSkillWrite(json, verb) {
  if (!json || typeof json !== 'object') return R.fallbackJson(json)
  if (json.detail) {
    return `技能${verb}失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
  }
  const sid = json.skill_id ?? json.id ?? json.data?.skill_id ?? ''
  const lines = [`### 技能已${verb}`, '']
  lines.push(`- 技能名: \`${json.root_name ?? json.skill_name ?? json.name ?? ''}\`${json.version ? ` · v${json.version}` : ''}`)
  if (sid) lines.push(`- skill id: \`${sid}\``)
  if (json.scope) lines.push(`- scope: ${json.scope}${json.repo ? ` · 仓库 ${json.repo}` : ''}`)
  if (json.bytes) lines.push(`- 包大小: ${json.bytes} B（${json.files_count ?? '?'} 个文件）`)
  if (json.message) lines.push(`- ${json.message}`)
  lines.push('', `_下一步（绑到场景节点）：grape_list_scenes(owner, repo) 取场景副本 → 读场景详情拿 nodes → 把目标节点的 \`skill_id\` 改成 \`${sid || '新 id'}\` → 整场景 PUT 回去。平台目前**没有节点级写端点**（D5 缺口），只能整场景提交；repo 级场景不能引用 user 级技能，个人技能先用 grape_convert_skill 复制成 repo 技能。_`)
  return lines.join('\n')
}

const OWNER_REPO_NUM = {
  owner: str('仓库归属（owner）'),
  repo: str('仓库名（repo）'),
  number: num('issue 编号'),
}

/* ── Issue #27 写工具公共层：只读检出 → 生成命令 → 决策门渲染（零执行） ── */

const HOST_TARGETS = lifecycleModule.HOST_NAMES
/** 状态词表与更新状态词表的唯一来源（lifecycle 导出）：判定与渲染共用常量，改名不会静默失效 */
const { HOST_STATE, UPDATE_STATE } = lifecycleModule

/** 检出状态的人类可读标签（damaged 必须显式「先修复」，否则用户会照装一遍再踩同样的坑） */
const STATE_LABEL = {
  [HOST_STATE.INSTALLED]: '已装配',
  [HOST_STATE.ABSENT]: '未装配（文件在、无条目）',
  [HOST_STATE.MISSING]: '未装配（无配置文件）',
  [HOST_STATE.DAMAGED]: '配置损坏（先修复）',
}

const WRITE_GATE = '⚠️ 决策门：以上命令只生成、未执行。请先把命令块与影响范围交给用户确认，确认后再执行（可随时 Ctrl-C 打断）。'
const NO_TERMINAL_HINT = '无终端工具的宿主：把命令与需要编辑的文件路径原样给用户，由用户手动执行/编辑。'

/**
 * install / uninstall 共用的计划构建：逐宿主只读检出 → 需要动作的宿主才生成命令。
 * damaged 宿主（配置解析失败）**一律不生成命令**：CLI 侧的 install/uninstall 对解析失败的
 * 配置直接 `exit 1`（「请先修复或移走该文件后重试」），照给命令等于给一条必失败的动作；
 * 它们单列进 `blocked`，带出解析错误，让用户先修配置。
 * @param {'install'|'uninstall'} action
 * @param {string} targetArg 宿主名或 all（缺省 all）
 */
function buildHostPlan(action, targetArg, L) {
  const target = String(targetArg || 'all').trim()
  if (target !== 'all' && !HOST_TARGETS.includes(target)) {
    return { action, target, error: `不支持的宿主：${target}（可用：${HOST_TARGETS.join(' / ')} / all）` }
  }
  const rows = L.detectHostStatus({})
  const targets = target === 'all' ? HOST_TARGETS : [target]
  const hosts = targets.map((host) => {
    const r = rows.find((x) => x.host === host) || { host, state: HOST_STATE.MISSING, installed: false, path: '', skillsDir: '', entry: '' }
    const blocked = r.state === HOST_STATE.DAMAGED
    const needsAction = blocked ? false : action === 'install' ? !r.installed : !!r.installed
    return {
      host,
      state: r.state || HOST_STATE.MISSING,
      path: r.path || '',
      entry: r.entry || '',
      skillsDir: r.skillsDir || '',
      installed: !!r.installed,
      blocked,
      evidence: r.evidence || r.error || '',
      error: r.error || '',
      // 修复指引不给可执行命令：配置坏着跑 install/uninstall 必被 CLI 拒，只说明「改什么、改完怎么办」
      repair: blocked ? `先修复或移走 ${r.path}（${r.error || '配置解析失败'}），修好后重跑本工具即可生成${action === 'install' ? '装配' : '卸载'}命令` : '',
      command: needsAction ? `npx -y @grape-dev/grape-kit ${action} --target ${host}` : '',
    }
  })
  const active = hosts.filter((h) => h.command)
  const blocked = hosts.filter((h) => h.blocked)
  const plan = {
    action,
    target,
    hosts,
    commands: active.map((h) => h.command),
    skipped: hosts.filter((h) => !h.command && !h.blocked).map((h) => h.host),
    blocked: blocked.map((h) => ({ host: h.host, path: h.path, error: h.error, repair: h.repair })),
  }
  if (action === 'uninstall') {
    // 影响预览：只列不删。条目 + skill 副本 + （officeace）客户端侧手动删除提示
    plan.effects = active.flatMap((h) => {
      const out = [`移除 ${h.entry || 'grape-kit'} 条目（${h.path}）`]
      if (h.skillsDir) out.push(`删除 skill 副本（${h.skillsDir}/grape-remote/）`)
      if (h.host === 'officeace') out.push('果办OfficeAce 侧还需在「扩展 → 连接器 → 我的连接器」手动删除该连接器')
      return out
    })
    plan.dryRun = active.map((h) => `npx -y @grape-dev/grape-kit uninstall --target ${h.host} --dry-run`).join('\n')
  }
  return plan
}

/** 写工具渲染：状态表格 + 待执行命令 + 决策门（uninstall 追加影响预览与 --dry-run） */
function renderHostPlan(json) {
  if (!json || typeof json !== 'object') return R.fallbackJson(json)
  if (json.error) return `### ${json.action === 'uninstall' ? '卸载' : '装配'} grape-kit\n\n${json.error}`
  const isUninstall = json.action === 'uninstall'
  const lines = [
    `### ${isUninstall ? '卸载' : '装配'} grape-kit（命令生成，未执行）`, '',
    R.mdTable(json.hosts || [], [
      { h: '宿主', v: 'host' },
      { h: '状态', v: (r) => STATE_LABEL[r.state] || r.state || '-' },
      { h: '依据文件', v: (r) => `${r.path || '-'}${r.entry ? `（${r.entry}）` : ''}` },
    ]),
  ]
  if (json.skipped?.length) {
    lines.push('', `已${isUninstall ? '跳过' : '装配'}的宿主本次不生成命令：${json.skipped.join(' / ')}`)
  }
  // damaged 宿主单列：表内既已写「配置损坏（先修复）」，命令块就不能照给（CLI 会 exit 1）
  if (json.blocked?.length) {
    lines.push('', '**⚠️ 配置损坏的宿主本次不生成命令（照着执行必被 CLI 拒绝，先修复）：**')
    for (const b of json.blocked) {
      lines.push(`- ${b.host} — ${b.repair || `${b.path}（${b.error || '配置解析失败'}）`}`)
    }
  }
  if (isUninstall && json.effects?.length) {
    lines.push('', '**将移除的内容（只列不删，执行前请逐条确认）**', '')
    for (const e of json.effects) lines.push(`- ${e}`)
  }
  if (json.commands?.length) {
    lines.push('', `**待执行命令（逐宿主复制执行）**`, '', '```bash', ...json.commands, '```')
    if (isUninstall && json.dryRun) {
      lines.push('', '**先预览（--dry-run 只列不删，推荐先跑一遍）**', '', '```bash', json.dryRun, '```')
    }
  } else {
    // 空命令有两种真实原因：全 blocked（配置损坏待修）vs 全为相反状态——混说会让用户去查错方向（QA SJ5）
    lines.push('', json.blocked?.length
      ? '_本次没有可生成的命令：目标宿主配置均损坏（先按上方「先修复」逐条处理，修好后重跑本工具）。_'
      : '_本次没有需要生成的命令（目标宿主均为相反状态）。_')
  }
  lines.push('', isUninstall
    ? '⚠️ 强决策门：卸载会移除宿主配置条目与 skill 副本（不可自动回滚），以上命令只生成、未执行——执行前必须向用户逐条确认影响范围。'
    : '⚠️ 决策门：安装会改写宿主 MCP 配置（installer 自带备份），以上命令只生成、未执行——执行前必须向用户确认目标宿主。',
  NO_TERMINAL_HINT)
  return lines.join('\n')
}

/**
 * 版本全景「服务端」一行：值列与备注列由同一组分支决定（三分支：未探测 / 不可达 / 可达）。
 * 抽成函数的原因：原先内联四层三元链，改一个分支要看穿整行才能确认其余分支没被带歪。
 * @returns {{v: string, note: string}}
 */
function serverRow(srv = {}) {
  const url = srv.baseUrl || ''
  const contract = srv.contractVersion ? `契约版本 ${srv.contractVersion}` : ''
  if (srv.probe === 'skipped') {
    return {
      v: `未探测（缺凭据）${url}`,
      note: `${srv.reason || '未配置凭据'}${contract ? `；${contract}` : ''}`,
    }
  }
  if (srv.reachable) {
    return { v: `可达 ${url}`, note: contract || '契约版本未取到（404/不可达时省略）' }
  }
  return {
    v: `不可达 ${url}`,
    note: `${srv.error || ''}${srv.hint ? `（${srv.hint}）` : ''}${contract ? `；${contract}` : ''}`,
  }
}

export const TOOLS = [
  {
    name: 'grape_trigger_pipeline',
    description:
      '触发 Grape DevOps 流水线（A2A 交接给首个节点，默认 vod）。⚠️ 用户决策层动作：触发前必须向用户确认目标 issue 与意图。' +
      'Grape 多 agent 流水线的唯一外部入口；节点间流转由服务端内部驱动。' +
      '【本地接管成果交回场景】若该 issue 此前被本地接管实现过（远端分支已有成果），context 必须结构化说明：' +
      '产出分支名 + commit + 测试证据，并明确「代码已在远端分支，请识别后直接进入 QA，勿重复实现」。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        issue_number: num('issue 编号'),
        agent: { type: 'string', enum: AGENT_TYPES, description: '起始节点 agent（默认 vod）。指定后跳过已完成的上游节点，用于 cascade 断链续跑；可用值：vod/issue/coding/qa/sre', default: 'vod' },
        context: str('任务上下文/补充说明（可选）'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    buildArgs(a) {
      // CLI 回退通道与 native 共用 normalizeTriggerAgent：非法 agent 在本地就报错，不静默下发给服务端
      const agent = normalizeTriggerAgent(a.agent)
      const payload = {
        repository: `${a.owner}/${a.repo}`,
        account: a.owner,
        issue_number: a.issue_number,
      }
      if (a.context) payload.context = a.context
      return ['a2a', 'handoff', '--json', JSON.stringify({ agent, payload })]
    },
    async native(a) {
      const r = await api.triggerPipeline(a.owner, a.repo, a.issue_number, a.context || '', a.agent)
      return { seq: r.seq ?? r.event_seq, agent: r.agent ?? 'vod', status: r.status ?? 'running' }
    },
    render: R.renderTrigger,
  },
  {
    name: 'grape_get_task_status',
    description: '按事件序列号（trigger 返回的 seq）查询流水线任务当前状态。',
    schema: { type: 'object', properties: { seq: num('事件序列号') }, required: ['seq'] },
    buildArgs(a) { return ['events', 'detail', '--seq', String(a.seq)] },
    async native(a) { return api.taskStatus(a.seq) },
    render: R.renderTaskStatus,
  },
  {
    name: 'grape_wait_task',
    description:
      '阻塞等待流水线任务到终态（completed/failed/cancelled）或超时。每 interval 秒轮询一次。' +
      '默认上限 300 秒；长流水线建议由用户稍后用 get_task_status 复查，而不是无限等待。',
    schema: {
      type: 'object',
      properties: {
        seq: num('事件序列号'),
        timeout: num('超时秒数，默认 300'),
        interval: num('轮询间隔秒数，默认 3'),
      },
      required: ['seq'],
    },
    async run(a, { waitTask }) {
      const r = await waitTask(a.seq, { timeoutSec: a.timeout ?? 300, intervalSec: a.interval ?? 3 })
      return r
    },
    waitBased: true,
    render(json) {
      const base = R.renderTaskStatus(json)
      return json && json.timedOut
        ? base + `\n\n_等待超时（${json.polls ?? '-'} 次轮询后任务仍未终态）。复查方式：① 让我过几分钟再查（grape_get_task_status seq=${json.seq ?? '?'}）② 看流水线节点位置（grape_get_pipeline_info）③ 长任务别死等，先做别的。_`
        : base
    },
  },
  {
    name: 'grape_list_issues',
    description: '列出仓库的 issue 及 Grape 流水线状态（GitCode API 没有的 pipeline 视角）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        status: str('按状态过滤（open/closed/processing 等，可选）'),
      },
      required: ['owner', 'repo'],
    },
    buildArgs(a) {
      const args = ['issues', 'list', '--owner', a.owner, '--repo', a.repo]
      if (a.status) args.push('--status', String(a.status))
      return args
    },
    async native(a) { return api.listIssues(a.owner, a.repo, a.status) },
    render: R.renderIssues,
  },
  {
    name: 'grape_list_my_issues',
    description: '列出「我」的 issue（不需要 owner/repo），适合开始工作前领任务。',
    schema: {
      type: 'object',
      properties: {
        status: str('按状态过滤（如 processing，可选）'),
      },
    },
    buildArgs(a) {
      const args = ['issues', 'mine']
      if (a.status) args.push('--status', String(a.status))
      return args
    },
    async native(a) { return api.myIssues(a.status) },
    render: R.renderIssues,
  },
  {
    name: 'grape_get_issue_detail',
    description: '查看 issue 详情（含验收要求正文），开始实现前必读。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'detail', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issueDetail(a.owner, a.repo, a.number) },
    render: R.renderIssueDetail,
  },
  {
    name: 'grape_get_pipeline_info',
    description: '查看 issue 的流水线节点状态（vod→issue→coding→qa→sre 各节点进度）。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'pipeline', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issuePipeline(a.owner, a.repo, a.number) },
    render: R.renderPipeline,
  },
  {
    name: 'grape_get_issue_events',
    description: '查看 issue 的事件历史（QA 打回 / 评论 / 节点交接），端云协同的事件回环入口。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'events', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issueEvents(a.owner, a.repo, a.number) },
    render: R.renderEventTimeline,
  },
  {
    name: 'grape_create_issue',
    description: '⚠️ 用户决策层动作：建单前必须向用户确认标题与描述。' +
      '在托管仓库创建 issue（可选同时触发流水线——由服务端场景配置决定）。' +
      '`description` 是**必填**：服务端缺正文直接 400「任务描述必填」，只有标题会建单失败。' +
      '正文请写清目标、验收标准、涉及模块；字段名是 description（不是 body）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        title: str('issue 标题'),
        description: str('issue 正文（markdown，必填：目标 + 验收标准 + 涉及模块）'),
      },
      required: ['owner', 'repo', 'title', 'description'],
    },
    buildArgs(a) {
      const body = { title: a.title }
      if (a.description) body.description = a.description
      return ['issues', 'create', '--owner', a.owner, '--repo', a.repo, '--json', JSON.stringify(body)]
    },
    async native(a) { return api.createIssue(a.owner, a.repo, a.title, a.description) },
    render(json) {
      if (json && typeof json === 'object' && (json.number || json.issue_number)) {
        return `Issue 已创建：**#${json.number ?? json.issue_number}** ${json.title ?? ''}`.trim()
      }
      return R.fallbackJson(json)
    },
  },
  {
    name: 'grape_list_scenes',
    description:
      '列场景，两种用法：① 不传 owner/repo → 场景市场（`id` 是应用场景用的数字标识，`name` 是场景名）；' +
      '② 传 owner/repo → 该仓库已落地的场景副本（id 形如 custom-xxxxxxxx，是 grape_set_repo_scene 唯一合法入参）。' +
      '市场模板 ≠ 仓库场景：仓库必须先应用（grape_apply_scene）生成副本，副本才能被设为默认。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner（可选；与 repo 同传则列仓库场景）'),
        repo: str('仓库名（可选）'),
        q: str('关键字过滤（仅市场列表，可选）'),
      },
    },
    buildArgs(a) {
      if (a.owner && a.repo) return ['scenes', 'list', '--repo', `${a.owner}/${a.repo}`]
      const args = ['scenes', 'market', 'list']
      if (a.q) args.push('--q', String(a.q))
      return args
    },
    async native(a) {
      if (a.owner && a.repo) return api.repoScenes(a.owner, a.repo)
      return api.scenesMarket(a.q)
    },
    render(json) {
      const rows = R.asArray(json?.scenes ?? json?.items ?? json)
      const isRepo = rows.some((r) => String(r.id ?? r.scene_id ?? '').startsWith('custom-') || r.scope === 'repo')
      if (!rows.length) {
        return isRepo
          ? '仓库内还没有场景副本：先用 grape_apply_scene(owner, repo, scene=市场数字id或场景名) 应用。'
          : '场景市场为空（或 token 无读权限）。'
      }
      const table = isRepo
        ? R.mdTable(rows, [
            { h: '场景 ID（设默认用）', v: (r) => r.id ?? r.scene_id ?? '' },
            { h: '名称', v: (r) => r.display_name ?? r.name ?? '' },
            { h: '节点链', v: (r) => (Array.isArray(r.nodes) ? r.nodes.map((n) => n.id || n.tag).join('→') : '') },
          ])
        : R.mdTable(rows, [
            { h: '市场 ID（应用用）', v: (r) => r.id ?? '' },
            { h: '场景名', v: (r) => r.name ?? '' },
            { h: '标题', v: (r) => r.display_name ?? '' },
            { h: '范围', v: (r) => r.scope ?? '' },
          ])
      return `${isRepo ? '#### 仓库场景副本' : '#### 场景市场'}\n\n${table}`
    },
  },
  {
    name: 'grape_apply_scene',
    description:
      '把市场场景应用到仓库（在仓库内创建场景副本），可选同时设为仓库默认场景。三步语义，别记错：' +
      '① POST /api/scenes/market/{市场数字id}/apply?owner=&repo= 创建仓库副本，返回 scene_id=custom-xxxxxxxx（同模板重复应用幂等复用）；' +
      '② 回读 GET /api/scenes?repo=owner/repo 确认副本真的存在（不信回执）；' +
      '③ set_default=true 时再调 PUT /api/repos/{owner}/{repo}/default-scene —— 只有这一步决定「新建 issue 默认走哪条流水线」。' +
      '入参 scene 只认市场数字 id 或场景名（先用 grape_list_scenes 不传 owner/repo 获取）；custom- 开头的副本 id 不属于应用入参。' +
      '⚠️ 不要拿 POST /api/scenes/apply/{owner}/{repo} 当切场景：它只把节点技能与引擎绑定刷进 agent_session，不改场景归属、响应也没有 scene_id（历史 P0：返回成功但什么都没切）。' +
      '⚠️ 用户决策层动作：调用前必须向用户确认目标场景；set_default=true 会改变该仓库后续新建需求的默认流水线。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('仓库名'),
        scene: str('市场数字 id（如 10）或场景名（如 huawei-skill）'),
        display_name: str('仓库内场景显示名（可选；与仓库已有场景重名会 409，换名重试）'),
        set_default: bool('是否同时设为仓库默认场景（默认 false）'),
      },
      required: ['owner', 'repo', 'scene'],
    },
    async native(a) {
      const owner = a.owner
      const repo = a.repo
      const wanted = String(a.scene ?? a.scene_id ?? '').trim()
      if (!wanted) {
        throw new GrapeApiError('缺少场景标识：传市场数字 id（grape_list_scenes 的 id 列）或场景名', { status: 400 })
      }
      if (/^custom-/i.test(wanted)) {
        throw new GrapeApiError(
          `'${wanted}' 是仓库内已有的场景副本 id，不是市场场景。要把它设为默认请用 grape_set_repo_scene；要重新应用市场模板请传市场数字 id 或场景名。`,
          { status: 400 })
      }
      const marketJson = await api.scenesMarket()
      const scenes = R.asArray(marketJson?.scenes ?? marketJson?.items ?? marketJson)
      let market = null
      if (/^\d+$/.test(wanted)) market = scenes.find((s) => String(s.id) === wanted) || null
      else market = scenes.find((s) => String(s.name) === wanted || String(s.display_name) === wanted) || null
      if (!market) {
        // 数字 id 在列表里找不到时不盲发请求：服务端会把未命中的场景静默回落成 default
        const hint = /^\d+$/.test(wanted)
          ? `市场里没有 id=${wanted} 的场景`
          : `市场里没有名为 '${wanted}' 的场景`
        const avail = scenes.slice(0, 20).map((s) => `${s.id}:${s.name}`).join('、')
        throw new GrapeApiError(`${hint}。可用（id:name）：${avail || '（市场为空，先确认 token 是否有权读市场）'}`, { status: 404 })
      }
      const applied = await api.marketApply(owner, repo, market.id, a.display_name || '')
      // 回读：副本必须能在仓库场景列表里查到，否则“已应用”只是回执
      const repoJson = await api.repoScenes(owner, repo)
      const rows = R.asArray(repoJson?.scenes ?? repoJson?.items ?? repoJson)
      const sceneId = applied?.scene_id || ''
      const verified = Boolean(sceneId && rows.some((r) => String(r.id ?? r.scene_id ?? '') === sceneId))
      let defaultResult = null
      if (a.set_default && sceneId && verified) {
        defaultResult = await api.setDefaultScene(owner, repo, sceneId)
      }
      return {
        market_id: market.id,
        market_name: market.name,
        market_display: market.display_name ?? market.name,
        applied,
        scene_id: sceneId,
        verified,
        set_default: Boolean(a.set_default),
        default_result: defaultResult,
        repo_scenes: rows.map((r) => ({ id: r.id ?? r.scene_id ?? '', name: r.display_name ?? r.name ?? '' })),
      }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const ap = json.applied || {}
      const lines = ['### 场景已应用到仓库', '']
      lines.push(`- 市场模板: ${json.market_id} · ${json.market_display ?? json.market_name ?? ''}`)
      lines.push(`- 仓库场景副本: \`${json.scene_id || '（响应未给 scene_id）'}\`${ap.reused ? '（幂等复用既有副本）' : ''}`)
      if (!json.verified) {
        lines.push('', '**⚠️ 回读未在仓库场景列表里找到该副本**', '')
        lines.push(`- 用 \`grape_list_scenes(owner, repo)\` 复核；列表现有：${(json.repo_scenes || []).map((s) => `${s.id}(${s.name})`).join('、') || '（空）'}`)
        lines.push('', '_未确认副本存在前不要宣称“已应用”，也不要继续设默认场景。_')
        return lines.join('\n')
      }
      lines.push(`- 回读确认: ✅ 副本已在仓库场景列表（现有 ${(json.repo_scenes || []).length} 个）`)
      if (json.set_default) {
        const dr = json.default_result || {}
        lines.push('', '**仓库默认场景**', '')
        lines.push(dr.dev_scene
          ? `- ✅ dev_scene = \`${dr.dev_scene}\`（新建 issue 未显式选场景时走它）`
          : '- ⚠️ 默认场景写入未确认（响应缺 dev_scene），用 `grape_get_repo_dashboard` 复核 dev_scene')
      } else {
        lines.push('', '_副本已建，但**仓库默认场景没变**：新建 issue 仍走旧场景。要让它成为默认，再调 `grape_set_repo_scene(owner, repo, scene_id="' + (json.scene_id || '') + '")`（需用户确认）。_')
      }
      return lines.join('\n')
    },
  },
  {
    name: 'grape_set_repo_scene',
    description:
      '把仓库默认场景设为某个仓库场景副本（写 managed_repos.dev_scene），或 clear=true 清空（回落智能推荐）。' +
      '这是「新建 issue 走哪条流水线」的唯一开关：只影响后续新建且未显式选场景的 issue，不改已存在 issue 的 scene_id 快照。' +
      'scene_id 必须是本仓库场景（grape_list_scenes 传 owner/repo 拿到的 custom-xxxxxxxx）；市场数字 id、模板名会被 404 拒绝。' +
      '⚠️ 用户决策层动作：调用前必须向用户确认。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('仓库名'),
        scene_id: str('仓库场景 id（custom-xxxxxxxx）；clear=true 时可省略'),
        clear: bool('true=清空默认场景（新建 issue 回落智能推荐）'),
      },
      required: ['owner', 'repo'],
    },
    async native(a) {
      const sceneId = a.clear ? '' : String(a.scene_id || '').trim()
      if (!a.clear && !sceneId) {
        throw new GrapeApiError('缺少 scene_id：传仓库场景 id，或 clear=true 清空默认场景', { status: 400 })
      }
      const r = await api.setDefaultScene(a.owner, a.repo, sceneId)
      let devScene = r?.dev_scene
      if (devScene === undefined) {
        // 旧平台没有 default-scene 端点时 sdk 会 404；若平台接受但没回读值，这里再读一次 dashboard
        try {
          const dash = await api.repoDashboard(a.owner, a.repo)
          devScene = dash?.dev_scene
        } catch { /* 读不到就如实说未确认 */ }
      }
      return { ...r, dev_scene: devScene, requested: sceneId }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `设置失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const dev = json.dev_scene ?? ''
      const ok = json.requested === undefined ? Boolean(dev) : String(dev) === String(json.requested)
      if (!ok) {
        return ['### ⚠️ 默认场景未确认', '',
          `- 期望: \`${json.requested ?? ''}\` · 回读 dev_scene: \`${dev || '（空）'}\``,
          '- 用 `grape_get_repo_dashboard` 复核；未确认前不要宣称已切换。'].join('\n')
      }
      return ['### 仓库默认场景已更新', '',
        `- dev_scene: \`${dev || '（已清空 → 回落智能推荐）'}\``,
        '- 生效范围：后续新建且未显式选场景的 issue；已存在 issue 保留自身 scene_id 快照。'].join('\n')
    },
  },
  {
    name: 'grape_search',
    description: '全局搜索：按关键字检索事件（event）、仓库（repo）、agent（all）。type 枚举仅 all/event/repo/agent，不支持 issue。',
    schema: {
      type: 'object',
      properties: { q: str('关键字'), type: { type: 'string', enum: ['all', 'event', 'repo', 'agent'], description: '结果类型过滤（服务端枚举，issue 不在其中）' } },
      required: ['q'],
    },
    buildArgs(a) {
      const args = ['search', '--q', String(a.q)]
      if (a.type) args.push('--type', String(a.type))
      return args
    },
    async native(a) { return api.globalSearch(a.q, a.type) },
    render: R.renderSearch,
  },
  {
    name: 'grape_get_repo_dashboard',
    description:
      '查看仓库仪表盘：流水线运行汇总、issue/PR 状态统计，适合汇报与总览场景。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo: str('repo') },
      required: ['owner', 'repo'],
    },
    buildArgs(a) { return ['dashboard', 'repo', '--owner', a.owner, '--repo', a.repo] },
    async native(a) { return api.repoDashboard(a.owner, a.repo) },
    render: R.renderGeneric,
  },

  /* ── v0.2.0 能力补齐（对齐 grape-dsh 工具面）────────────────────────── */

  {
    name: 'grape_get_pipeline_roadmap',
    description: '查看仓库级流水线蓝图（场景节点链，不针对单个 issue）。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo: str('repo') },
      required: ['owner', 'repo'],
    },
    buildArgs(a) { return ['pipeline', 'get', '--owner', a.owner, '--repo', a.repo] },
    async native(a) { return api.repoRoadmap(a.owner, a.repo) },
    render: R.renderPipeline,
  },

  {
    name: 'grape_review_pass',
    description: '审核通过：对处于 pending_review 的 issue 点审通过（节点放行、流水线继续）。通道：/api/issues/{n}/review-pass 仅放行会话级 tk_ token，用户级 grape_ Key 会 403（请用 WebUI 或持有 tk_ 会话的宿主执行）。',
    schema: { type: 'object', properties: { owner: str('仓库 owner'), repo: str('仓库名'), number: num('issue 编号'), comment: str('审批意见（可选）') }, required: ['owner', 'repo', 'number'] },
    async native(a) {
      return reviewPost(`/api/issues/${a.owner}/${a.repo}/${a.number}/review-pass`, { ...(a.comment ? { comment: a.comment } : {}) })
    },
    render(json) {
      return json && typeof json === 'object' && !json.detail
        ? `审核通过 ✓（#${json.issue_number ?? ''}）——流水线将放行继续`
        : R.fallbackJson(json)
    },
  },
  {
    name: 'grape_review_reject',
    description: '审核打回：对 pending_review 的 issue 打回并附意见（打回后按平台规则重派整改）。通道：仅放行会话级 tk_ token，用户级 grape_ Key 会 403。⚠️ 用户决策层动作：打回前向用户确认。',
    schema: { type: 'object', properties: { owner: str('仓库 owner'), repo: str('仓库名'), number: num('issue 编号'), comment: str('打回意见（必填，说明原因）') }, required: ['owner', 'repo', 'number', 'comment'] },
    async native(a) {
      return reviewPost(`/api/issues/${a.owner}/${a.repo}/${a.number}/review-reject`, { comment: a.comment })
    },
    render(json) {
      return json && typeof json === 'object' && !json.detail
        ? `已打回（附意见）——流水线将按平台规则重派整改`
        : R.fallbackJson(json)
    },
  },
  {
    name: 'grape_confirm_done',
    description: '确认完成（开发者确认通道）：issue 实际已完成但单据未落终态时，以开发者身份确认收尾（效果等同 WebUI 确认完成/CLI issues confirm done）。通道：confirm-done 仅放行会话级 tk_ token，用户级 grape_ Key 会 403。⚠️ 用户决策层动作：确认前向用户核实成果真实存在。',
    schema: { type: 'object', properties: { owner: str('仓库 owner'), repo: str('仓库名'), number: num('issue 编号'), confirmation: str('完成确认说明（必填）') }, required: ['owner', 'repo', 'number', 'confirmation'] },
    async native(a) {
      const list = await api.listIssues(a.owner, a.repo)
      const row = (list.issues || []).find((i) => Number(i.issue_number) === Number(a.number))
      if (!row) throw new Error(`未找到 #${a.number}`)
      return reviewPost(`/api/issues/${row.id}/confirm-done`, { confirmation: a.confirmation })
    },
    render(json) {
      return json && typeof json === 'object' && !json.detail
        ? `已确认完成 ✓ 单据收尾`
        : R.fallbackJson(json)
    },
  },
  ...['cancel', 'resume', 'start'].map((action) => ({
    name: `grape_${action}_issue`,
    description:
      action === 'cancel'
        ? '终止 issue 的整条流水线（⚠️ 不是「暂停当前节点」：已完成的 vod/issue 节点成果保留，但当前及后续节点全部停止、不做 QA/SRE 交接——本地接管后想交回请确认远端分支已推送并用 grape_trigger_pipeline 重新触发）。'
        + '⚠️ 强制决策门：调用前必须让用户在「①让渡接管（推荐：不取消，云端继续跑）②暂停等我确认 ③终止整链」中显式选择，未选择不得执行。'
        : action === 'resume'
          ? '恢复已取消的 issue 流水线。⚠️ 用户决策层动作：调用前必须向用户确认。'
          : '启动 issue 会话。⚠️ 用户决策层动作：调用前必须向用户确认。',
    schema: {
      type: 'object',
      properties: OWNER_REPO_NUM,
      required: ['owner', 'repo', 'number'],
    },
    async run(a, { runGrape, apiModule }) {
      const A = apiModule || (await import('./api.mjs')).api
      const det = await A.issueDetail(a.owner, a.repo, a.number)
      const id = det && (det.issue_id ?? det.id)
      if (!id) throw new Error('无法解析 issue 内部 id（detail 响应缺 issue_id）')
      const act = { cancel: A.cancelIssue, resume: A.resumeIssue, start: A.startIssue }[action]
      const r = await act(id)
      // #1-3 修复：resume 返回成功≠事实恢复——自动回读 pipeline_info 复核，向用户报告事实而非接口回执
      if (action === 'resume') {
        try {
          const pipe = await A.issuePipeline(a.owner, a.repo, a.number)
          const stage = pipe && (pipe.stage ?? pipe.task_status)
          return { ...(r ?? { ok: true, issue_id: id, action }), verified_stage: stage ?? 'unknown',
                   verify_note: stage ? `resume 已生效，当前阶段 ${stage}` : 'resume 接口返回成功但流水线状态读取失败，请用 grape_get_pipeline_info 人工复核' }
        } catch { 
          return { ...(r ?? { ok: true, issue_id: id, action }), verified_stage: 'unknown',
                   verify_note: 'resume 接口返回成功，但状态复核失败——请用 grape_get_pipeline_info 确认流水线真的恢复' }
        }
      }
      return r ?? { ok: true, issue_id: id, action }
    },
    render(json) {
      return json && typeof json === 'object'
        ? `\`${json.action ?? '操作'}\` 已执行：issue_id=${json.issue_id ?? '-'} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  })),

  {
    name: 'grape_list_managed_repos',
    description: '列出 Grape 已纳管的仓库（repo_key/场景/工作分支），是端侧找活干的第一步。注意：与成员/同步视图数据源不同，本视图为空时改用 grape_list_repos_member 或 grape_sync_repos 查看可操作仓库。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'managed'] },
    async native() { return api.managedRepos() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: '仓库', v: (r) => r.repo_key ?? r.full_name ?? r.name ?? '' },
        { h: '场景', v: (r) => r.scene_id ?? r.scene ?? '' },
        { h: '分支', v: (r) => r.work_branch ?? '' },
      ])
    },
  },
  {
    name: 'grape_list_repos_member',
    description: '列出当前用户有操作权限的仓库成员视图。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'member'] },
    async native() { return api.memberRepos() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: '仓库', v: (r) => r.repo_key ?? r.full_name ?? r.name ?? '' },
        { h: '角色', v: (r) => r.role ?? '' },
      ])
    },
  },
  {
    name: 'grape_get_repo_project_info',
    description: '查看仓库的项目信息（语言/框架/结构分析等）。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo_name: str('repo 名') },
      required: ['owner', 'repo_name'],
    },
    buildArgs(a) { return ['repos', 'project', 'info', '--owner', a.owner, '--repo', a.repo_name] },
    async native(a) { return api.projectInfo(a.owner, a.repo_name) },
    render: R.renderGeneric,
  },
  {
    name: 'grape_host_repo',
    description:
      '把一个 Git 仓库纳管进 Grape（owner/repo 形式的 full_name）。⚠️ 用户决策层动作：纳管会让该仓库进入流水线托管，调用前必须向用户确认。',
    schema: {
      type: 'object',
      properties: { full_name: str('owner/repo'), provider: str('来源平台（gitcode/github/gitlab，可选，默认 gitcode）') },
      required: ['full_name'],
    },
    buildArgs(a) {
      const args = ['repos', 'host', '--json', JSON.stringify({ full_name: a.full_name })]
      if (a.provider) args.push('--provider', a.provider)
      return args
    },
    async native(a) { return api.hostRepo(a.full_name, a.provider) },
    render(json) {
      return json && typeof json === 'object' && !json.error
        ? `纳管成功：${json.full_name ?? json.repo_key ?? ''} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  },
  {
    name: 'grape_sync_repos',
    description: '⚠️ 用户决策层动作：同步会刷新仓库纳管清单，执行前需用户确认。' +
      '从 VCS 同步仓库列表到 Grape（纳管清单与远端对齐）。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'sync'] },
    async native() { return api.syncRepos() },
    render(json) { return `同步完成 ${R.fallbackJson(json)}` },
  },

  {
    name: 'grape_list_skills',
    description: '列出 Grape 技能库技能。',
    schema: {
      type: 'object',
      properties: { q: str('关键字过滤（可选）') },
    },
    buildArgs(a) {
      return a.q ? ['skills', 'search', '--q', a.q] : ['skills', 'list']
    },
    async native(a) { return a.q ? api.skillsSearch(a.q) : api.skillsList() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.skill_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_search_skills',
    description: '按关键字搜索 Grape 技能库（name/描述全文匹配）。',
    schema: { type: 'object', properties: { q: str('关键字') }, required: ['q'] },
    buildArgs(a) { return ['skills', 'search', '--q', String(a.q)] },
    async native(a) { return api.skillsSearch(a.q) },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.skill_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_get_skill_detail',
    description: '查看 skill 详情（含 SKILL.md 内容）。',
    schema: { type: 'object', properties: { skill_id: str('skill id') }, required: ['skill_id'] },
    buildArgs(a) { return ['skills', 'detail', '--skill_id', String(a.skill_id)] },
    async native(a) { return api.skillDetail(a.skill_id) },
    render(json) {
      if (json && typeof json === 'object') {
        const title = `### ${json.name ?? json.skill_id ?? ''}\n\n`
        const body = String(json.content ?? json.skill_md ?? json.description ?? '')
        const bytes = Buffer.byteLength(body, 'utf8')
        // 常规体量全文直出；超 64KB 落盘 + 预览 + 显式标注（Issue #29：不得静默截断）
        if (bytes <= SKILL_DETAIL_INLINE_LIMIT) return `${title}${body}`
        const path = dumpSkillDetail(json.name ?? json.skill_id, body)
        return `${title}${body.slice(0, SKILL_DETAIL_PREVIEW_CHARS)}\n\n> 已截断，全文在 ${path}（共 ${bytes} 字节）`
      }
      return R.fallbackJson(json)
    },
  },

  /* ── 技能上传 / 升级 / 跨 scope（测试报告 D2-D4：此前 kit 没有工具面，只能手搓 HTTP） ── */

  {
    name: 'grape_upload_skill',
    description:
      '把本地技能目录打包成 ZIP 上传到技能库（scope=user 个人 / scope=repo 仓库）。' +
      '本地先做与服务端同口径的预检（SKILL.md 存在、frontmatter name/description/version、name 与目录名一致、标签不与 Agent 类型重名），' +
      '预检不过**不发请求**并把全部问题一次列出；服务端校验失败时把 detail.errors 全部透出（不截断）。' +
      'ZIP 顶层目录由本工具自动生成（=目录名），不用手搓打包——「ZIP 缺顶层目录」是上传失败最常见原因。' +
      '同名同 scope 再上传即升级内容；要保留 skill id 与场景引用请用 grape_update_skill。' +
      '⚠️ 用户决策层动作：上传会进入仓库/个人技能库，调用前向用户确认技能名与 scope。',
    schema: {
      type: 'object',
      properties: {
        path: str('本地技能目录（必须含 SKILL.md）'),
        scope: { type: 'string', enum: ['user', 'repo'], description: 'user=个人技能；repo=仓库技能（需 owner+repo）' },
        owner: str('scope=repo 时的仓库 owner'),
        repo: str('scope=repo 时的仓库名'),
        agent_type: { type: 'string', enum: ['vod', 'issue', 'coding', 'qa', 'sre', 'chat', 'auto'], description: '技能类型（必填）' },
        tags: str('标签，逗号分隔（≤5 个、每个 ≤12 字、不得与 vod/issue/coding/qa/sre/chat/auto 重名）'),
        summary: str('一句话摘要（可选，缺省用 frontmatter description）'),
        change_note: str('变更说明（升级时写清改了什么）'),
        skill_name: str('覆盖 ZIP 顶层目录名（默认取目录名）'),
      },
      required: ['path', 'scope', 'agent_type'],
    },
    async native(a) { return uploadSkillNative(a) },
    render: (json) => renderSkillWrite(json, '上传'),
  },
  {
    name: 'grape_update_skill',
    description:
      '按 skill_id 覆盖既有技能包（= 技能升级）：保留 id/scope/owner/场景引用/点赞，刷新内容与缓存。' +
      'ZIP 顶层目录名必须与既有技能名一致（本工具默认取目录名，目录名不一致会先本地报错）。' +
      'official 技能不可更新；user scope 需本人；repo scope 需托管该仓库。' +
      '⚠️ 用户决策层动作：升级会立即影响所有引用该技能的节点，调用前向用户确认。',
    schema: {
      type: 'object',
      properties: {
        skill_id: num('要升级的 skill id（grape_list_skills / grape_get_skill_detail 获取）'),
        path: str('本地技能目录（必须含 SKILL.md，目录名 = 既有技能名）'),
        agent_type: str('技能类型（可选，缺省沿用原记录）'),
        tags: str('标签，逗号分隔（可选）'),
        summary: str('摘要（可选）'),
        change_note: str('变更说明（建议写清本次改了什么）'),
      },
      required: ['skill_id', 'path'],
    },
    async native(a) {
      const pf = preflightSkillDir(a.path, a.skill_name)
      if (pf.errors.length) {
        throw new GrapeApiError(`技能本地预检未通过（未发起升级）：\n- ${pf.errors.join('\n- ')}`, { status: 400 })
      }
      const { buffer, rootName } = zipDirectory(resolvePath(a.path), { rootName: pf.rootName })
      const json = await api.skillUpdate(buffer, a.skill_id, {
        filename: `${rootName}.zip`,
        agent_type: a.agent_type || '', tags: a.tags || '',
        summary: a.summary || pf.description.slice(0, 200), change_note: a.change_note || '',
      })
      return { ...json, skill_id: a.skill_id, root_name: rootName, bytes: buffer.length }
    },
    render: (json) => renderSkillWrite(json, '升级'),
  },
  {
    name: 'grape_convert_skill',
    description:
      '跨 scope 复制技能（user ↔ repo）：原记录保留，是复制不是移动。' +
      '当场景节点只能用 repo 技能、而你手上是个人技能时用它——repo 级场景引用 user 技能会被平台拒绝（skill scope 校验）。' +
      '⚠️ 用户决策层动作：调用前向用户确认目标仓库与技能名。',
    schema: {
      type: 'object',
      properties: {
        skill_name: str('技能名（frontmatter name / 目录名）'),
        owner: str('目标仓库 owner'),
        repo: str('目标仓库名'),
        source_scope: { type: 'string', enum: ['user', 'repo'], description: '源 scope（默认 user）' },
      },
      required: ['skill_name', 'owner', 'repo'],
    },
    async native(a) {
      return api.skillConvert(a.skill_name, `${a.owner}/${a.repo}`, a.source_scope || 'user')
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `复制失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      return ['### 技能已复制', '',
        `- 技能: ${json.skill_name ?? json.name ?? ''}`,
        `- 新 skill id: ${json.skill_id ?? json.new_skill_id ?? '-'} · scope: ${json.scope ?? '-'}`,
        json.message ? `- ${json.message}` : ''].filter(Boolean).join('\n')
    },
  },

  {
    name: 'grape_list_knowledge',
    description: '列出知识库条目（标题/摘要），实现前检索上下文用。',
    schema: {
      type: 'object',
      properties: {
        repo: str('限定仓库（owner/repo，服务端要求必须指定 repo）'),
        q: str('关键字过滤（可选）'),
      },
      required: ['repo'],
    },
    buildArgs(a) {
      const args = ['knowledge', 'list', '--repo', String(a.repo)]
      if (a.q) args.push('--q', a.q)
      return args
    },
    async native(a) { return api.knowledgeList(a.repo, a.q) },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.knowledge_id ?? r.id ?? '' },
        { h: '标题', v: (r) => r.title ?? r.name ?? '' },
        { h: '摘要', v: (r) => String(r.summary ?? r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_get_knowledge_detail',
    description: '查看知识条目详情（正文 markdown），供实现前吸收仓库沉淀的经验。',
    schema: { type: 'object', properties: { knowledge_id: str('知识条目 id') }, required: ['knowledge_id'] },
    buildArgs(a) { return ['knowledge', 'detail', '--knowledge_id', String(a.knowledge_id)] },
    async native(a) { return api.knowledgeDetail(a.knowledge_id) },
    render(json) {
      if (json && typeof json === 'object') {
        return `### ${json.title ?? json.knowledge_id ?? ''}\n\n${String(json.content ?? json.body ?? '').slice(0, 3000)}`
      }
      return R.fallbackJson(json)
    },
  },

  {
    name: 'grape_list_project_templates',
    description: '列出 Grape 项目模板——开源项目即模板，选一个即可一键建仓进入 AI 工作流。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['project', 'templates', 'list'] },
    async native() { return api.templatesList() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.template_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? r.title ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_create_project',
    description:
      '从模板创建项目（建在当前账号命名空间下）。⚠️ 用户决策层动作：调用前必须向用户确认模板与仓库名。',
    schema: {
      type: 'object',
      properties: {
        template_id: str('模板 id（grape_list_project_templates 获取）'),
        repo_name: str('新仓库名'),
        provider: str('来源平台（可选，默认 gitcode）'),
      },
      required: ['template_id', 'repo_name'],
    },
    buildArgs(a) {
      const body = { template_id: a.template_id, repo_name: a.repo_name }
      if (a.provider) body.provider = a.provider
      return ['project', 'template', 'create', '--json', JSON.stringify(body)]
    },
    async native(a) { return api.createProject(a.template_id, a.repo_name, a.provider) },
    render(json) {
      return json && typeof json === 'object' && !json.error
        ? `项目创建中：${json.repo_name ?? json.full_name ?? ''} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  },

  {
    name: 'grape_takeover_context',
    description:
      '获取 issue 当前运行任务的接管上下文（task_id/原 prompt/执行日志/env）。端云协同接管第一步：' +
      '拿到上下文后通常还需取消原任务（grape_cancel_issue，需用户确认），再在本机以该上下文交互式继续。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        number: num('issue 编号'),
      },
      required: ['owner', 'repo', 'number'],
    },
    buildArgs(a) {
      return ['runtime', 'takeover', 'context', '--repo_key', `gitcode:${a.owner}/${a.repo}`, '--issue_number', String(a.number)]
    },
    async native(a) { return api.takeoverContext(a.owner, a.repo, a.number) },
    render(json) {
      if (!json || typeof json !== 'object' || !json.task_id) {
        return json && json.error ? `无正在运行的任务：${json.error}` : R.fallbackJson(json)
      }
      const lines = [`### 接管上下文（task ${json.task_id}）`, '']
      lines.push(`- agent: ${json.agent_type ?? '-'} · skill: ${json.skill ?? '-'} · 状态: ${json.status ?? '-'}`)
      const msgs = Array.isArray(json.messages) ? json.messages : []
      if (msgs.length) {
        lines.push('', `**执行日志（最近 ${msgs.length} 条，已归一化）**`, '')
        const typeLine = (m) => {
          const type = m.type ?? ''
          const content = String(m.content ?? '').slice(0, 300)
          const output = String(m.output ?? '').slice(0, 300)
          if (type === 'step_start') return `--- ${content} ---`
          if (type === 'reasoning') return `[思考] ${content}`
          if (type === 'text') return `[回复] ${content}`
          if (type === 'tool_use') return `[工具调用] ${m.tool ?? ''}${content ? ': ' + content : ''}`
          if (type === 'tool_result') return `[工具结果] ${content || output}`
          if (type === 'error') return `[错误] ${content}`
          if (type === 'log') return `[日志] ${content}`
          return null
        }
        const logLines = msgs.map(typeLine).filter(Boolean)
        lines.push(logLines.join('\n').slice(-8000))
      }
      if (json.prompt) lines.push('', '**原始任务 Prompt（尾部）**', '', String(json.prompt).slice(-4000))
      lines.push('', '_接管动作：先 grape_cancel_issue（需用户确认）→ 本机以以上上下文交互式继续。env_extra 已随上下文返回，接管会话需还原 REPO_FULL_NAME / ISSUE_NUMBER 等环境。_')
      return lines.join('\n')
    },
  },

  {
    name: 'grape_takeover_start',
    description:
      '发起接管会话（weekly-11+ 平台一等接管原语，替代「cancel 整链 + context 口述」的旧路径）。' +
      '原子动作：云端任务让渡给本地、签发 tko_ 接管凭据（12h 可续 24h）、返回完整接管上下文与按 host_os 渲染的脚本。' +
      '之后本地继续该节点工作，用 grape_takeover_progress 回报进度，完成用 grape_takeover_finish 携结构化产物交回，' +
      '或用 grape_takeover_abort 让渡回流水线（当前节点重新派发，链不断）。' +
      '⚠️ push 能力边界：tko_ 仅 repo_session 能力，**不含 git 凭据注入**；洁净机器用 `grape_git_credential` 以 tko_ 换一次性本仓券（600s → GIT_ASKPASS 0600）后 push，PR 用 `grape_create_pull`。' +
      `接管同时把平台下发的 bundle.assets.skill 物化到本地工作区 <cwd>/${SKILL_ROOT_DIRNAME}/<skill>/（SKILL.md + references/），渲染给出落盘路径；旧平台未下发技能包时显式提示未物化。` +
      '本地接管（服务端在别的机器/云端跑）时务必传 `workspace`=本机绝对路径：解析优先级 `workspace` > `bundle.workspace.cwd_hint` > `process.cwd()`，' +
      '物化目录、脚本 `{{CWD}}`、`GRAPE_AUTH_FILE` 一律以解析出的本地路径为准；与 cwd_hint 不一致时渲染显式披露「云端路径在本机不存在，已改用本地路径」，不静默替换。' +

      '⚠️ 能力依赖（Issue #32）：接管前握手 `GET /api/health` 的 version/capabilities；节点 required 技能数 > 1 且服务端未声明 `skills.multi` 时拒绝接管，返回稳定错误码 `E_CAP_UNSUPPORTED_MULTI_SKILL` 与升级指引（升级服务端/kit 或改为单技能节点）。`takeover_bundle.v2` 不隐含多技能支持，客户端唯一判据是 `skills.multi`。' +
      '⚠️ 需要平台支持 takeover API（404/无该工具能力时回退 grape_takeover_context + cancel 老路径）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        number: num('issue 编号'),
        agent_type: str('要接管的节点（可选，默认当前运行节点，如 coding）'),
        bundle: {
          type: 'object',
          description: '节点接管 bundle（可选）：用于接管前的多技能能力门槛预检，支持 skills[] / assets.skill / env.GRAPE_BOUND_SKILL',
        },
        skills: {
          type: 'array',
          description: '节点技能清单（可选）：[{name, required}] 或 ["skill-name"]；缺省时 best-effort 读取当前节点绑定技能',
          items: {},
        },
        workspace: str('本地接管工作区（可选，本机绝对路径）：优先于 bundle.workspace.cwd_hint；技能物化、脚本 {{CWD}}、GRAPE_AUTH_FILE 均落此路径。服务端 cwd_hint 是本机不存在的云端路径时必传。'),
      },
      required: ['owner', 'repo', 'number'],
    },
    async native(a) {
      const caps = await getServerCapabilities()
      const supplied = a.bundle ?? (a.skills ? { skills: a.skills } : null)
      let skills = normalizeSkills(supplied)
      if (!supplied) {
        // 预检入口：读当前任务绑定技能（只读，不是 takeover 请求）；失败降级为单技能保守处理。
        try {
          const ctx = await api.takeoverContext(a.owner, a.repo, a.number)
          skills = normalizeSkills(ctx)
        } catch {
          skills = []
        }
      }
      const gate = evaluateTakeoverGate(skills, caps)
      if (!gate.allowed) return gate.payload
      const r = await api.takeoverStart(a.owner, a.repo, a.number, a.agent_type)
      const out = await attachSkillMaterialization(r && typeof r === 'object' ? r : { result: r }, { workspace: a.workspace })
      // 判据可追溯：render 需要 version + capabilities + source + handshake_at
      return {
        ...out,
        client_capabilities: {
          version: caps.version,
          capabilities: caps.capabilities,
          source: caps.source,
          handshake_at: caps.handshake_at,
          required_count: gate.required_count,
          required_skills: gate.required_skills,
          verdict: 'passed',
        },
      }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.refused && json.code === 'E_CAP_UNSUPPORTED_MULTI_SKILL') return renderCapabilityRefusal(json)
      if (json.detail) return `接管发起失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const sid = json.takeover_id ?? json.session_id ?? json.id ?? ''
      const b = json.bundle || {}
      const env = b.env || {}
      const lines = ['### 接管会话已建立', '']
      const cc = json.client_capabilities
      if (cc && typeof cc === 'object') {
        lines.push(`- capabilities: ${cc.version || '未知版本'} [${(cc.capabilities || []).join(', ') || '—'}]（来源 ${cc.source || 'unknown'}）| 判据：通过（required=${cc.required_count ?? 1}）`)
      }
      lines.push(`- 会话: \`${sid}\`${json.reused ? '（复用已有会话）' : ''}`)
      if (env.GRAPE_SESSION_TOKEN) lines.push(`- 接管凭据: \`${String(env.GRAPE_SESSION_TOKEN).slice(0, 8)}…\`（完整值在 env.GRAPE_SESSION_TOKEN，12h TTL）`)
      if (b.task && b.task.id) lines.push(`- 让渡的云端任务: ${b.task.id}（已停止）`)
      if (json.token_expires_at) lines.push(`- 凭据到期 epoch: ${json.token_expires_at}`)
      const ws = b.workspace || {}
      const hint = String(ws.cwd_hint || '').trim()
      // Issue #37：本地接管以解析后的本地 workspace 渲染 {{CWD}}；与云端 cwd_hint 不一致时显式披露
      const cwd = String(json.workspace_effective || '').trim() || resolveLocalWorkspace({ bundle: b })
      const mismatched = Boolean(hint) && normPathForCompare(hint) !== normPathForCompare(cwd)
      if (mismatched) lines.push(`- 云端工作区路径（cwd_hint，本机可能不存在）: ${hint}`)
      lines.push(`- 本地工作目录: ${cwd}`)
      if (mismatched) lines.push(`- ⚠️ ${json.workspace_note || `云端工作区路径在本机不存在（${hint}），已改用 ${cwd}`}`)
      else if (json.workspace_note) lines.push(`- ⚠️ ${json.workspace_note}`)
      const authFile = localizeAuthFile(env.GRAPE_AUTH_FILE, { workspace: cwd, cwdHint: hint })
      if (authFile.path) lines.push(`- 凭据文件（路径占位符已渲染）: ${authFile.path}`)
      if (authFile.note) lines.push(`- ⚠️ 凭据文件: ${authFile.note}`)
      lines.push('', '**push 能力边界（先读）**', '')
      lines.push('- `tko_` 只覆盖 repo_session：可继续该节点工作、回报进度、`request-finish`；**不含 git 凭据注入**，需先换券才能 push。')
      lines.push('- 洁净机器回推（推荐，全链只用换的券）：`grape_git_credential` 用 tko_ 换一次性本仓券（600s）→ 在工作区写 `GIT_ASKPASS`（0600，过期自检提示重新换券）→ `git push` → `grape_create_pull` 建 PR。券在 push 前换、不缓存。')
      lines.push('- 本机已有用户级凭据（`grape git` 注入 / 自有 PAT / SSH key）→ 也可直接 commit & push；不存在静默回退：券过期必须重新换券。')
      const bundleScripts = renderBundleScripts(b.assets?.scripts ?? b.scripts, cwd)
      if (bundleScripts) {
        lines.push('', '**接管脚本（平台渲染，路径占位符已本地替换为实际路径）**', '', '```bash', ...bundleScripts, '```')
      }
      // Issue #28：技能物化结果（native 后置写入；无该字段时不受影响，保持既有渲染不变）
      const sm = json.skillMaterialization
      if (sm && typeof sm === 'object') {
        lines.push('', '**技能物化（本地工作区）**', '')
        if (sm.status === 'ok') {
          lines.push(`- 技能: ${sm.skill} · 文件 ${sm.fileCount} 个 · references: ${sm.hasReferences ? '有' : '无'}`)
          lines.push(`技能已物化：${sm.path}`)
        } else if (sm.status === 'legacy') {
          lines.push(`- ⚠️ 本次未物化技能：${sm.reason || '平台未下发 assets.skill'}。技能名见 env.GRAPE_BOUND_SKILL，SKILL.md 需自行获取后再动手。`)
        } else {
          lines.push(`- ⚠️ 技能未能物化：${sm.reason || '未知原因'}（接管会话不受影响；核对技能包后可重试）`)
        }
      }
      if (sid) {
        const scriptDir = `${KIT_ROOT}/skills/grape-remote/scripts/takeover`
        lines.push('', '**内置 Node 接管脚本（Node ≥20，Windows/Linux 通用；token 从 env 读取，不进 argv）**', '', '```bash')
        lines.push('# 回报进度（tko_ 即可）')
        lines.push(`node "${scriptDir}/report.mjs" --session ${sid} --summary "完成 <动作>，测试通过"`)
        lines.push('# 报告完成（request-finish，tko_ 即可；之后等用户对话确认）')
        lines.push(`node "${scriptDir}/request-finish.mjs" --session ${sid} --summary "<结论>" --evidence "npm test 全绿"`)
        lines.push('# 正式交回（仅用户确认后；必须用用户级凭据 grape_，tko_ 会 403）')
        lines.push(`node "${scriptDir}/finish.mjs" --session ${sid} --summary "<结论>" --evidence "npm test 全绿" --next-step "交给 QA"`)
        lines.push('```')
      }
      const instr = b.instructions || {}
      if (instr.prompt) lines.push('', '**接管任务 Prompt（尾部）**', '', String(instr.prompt).slice(-3000))
      const warnings = Array.isArray(json.warnings) ? json.warnings : []
      // 分支/MR 冲突前置项：不依赖上游字段——无论有无 warnings 都先让接手者裁决远端状态
      lines.push('', '**分支/MR 前置检查**', '')
      lines.push('- [ ] `git ls-remote origin <branch>` 确认目标分支远端已有提交（云端 worker 可能已推送）')
      lines.push('- [ ] 查 issue 事件 / MR 列表，确认是否已有 MR 及其状态')
      lines.push(`- 裁决：${warnings.some((w) => /remote_may_still_run/i.test(String(w))) ? '⚠️ 平台已警告 remote_may_still_run，' : ''}复用远端分支（推荐）/ rebase 后强推（需用户确认）/ 另起分支；禁止裸 \`--force\`。完整分叉裁决 playbook 见 \`docs/20261114-takeover-architecture.md#分叉裁决-playbook\``)
      if (warnings.length) {
        // 前置检查清单：全量透出（不取前 5、不截断）——警告是用户动手前的裁决输入，不是装饰
        lines.push('', `**前置检查清单（平台警告 ${warnings.length} 条，逐条裁决后再动手）**`, '')
        warnings.forEach((w, i) => {
          const text = String(w)
          lines.push(`- [ ] \`${i + 1}\` ${text}`)
          const hint = warningHint(text)
          if (hint) lines.push(`      裁决：${hint}`)
        })
      }
      lines.push('', '_下一步：本地继续该节点工作 → grape_takeover_progress 回报 → grape_takeover_finish 交回（勿再调用 grape_cancel_issue）。_')
      return lines.join('\n')
    },
  },
  {
    name: 'grape_takeover_status',
    description:
      '查看接管会话状态/列表（不改变任何状态）。可查单条（含 renew 续期凭据）或列仓库/issue 的活跃会话。' +
      '接管中途断连后用本工具找回 session_id 与最新进度。已结束会话可查待派发标记：' +
      'finished + next_agent 有值 + 未见 handoff.seq>0 / handoff.reason=already_dispatched 即「派发未证实」，渲染给出目标/原因/补发指引。' +
      '判据注明：平台 finish 不回填 next_seq（恒 0），next_seq 仅作辅助展示、不构成已派发证据——需查事件核实（grape_get_issue_events）后再决定是否补发。',
    schema: {
      type: 'object',
      properties: {
        session_id: str('会话 id（有则查单条）'),
        owner: str('owner（无 session_id 时列表用）'),
        repo: str('repo'),
        number: num('issue 编号（可选过滤）'),
        renew: bool('查单条时是否顺带续期接管凭据（默认 false）'),
      },
    },
    async native(a) {
      if (a.session_id) return api.takeoverGet(a.session_id, a.renew)
      if (!a.owner || !a.repo) throw new Error('需要 session_id，或 owner+repo 用于列表')
      return api.takeoverList(a.owner, a.repo, a.number)
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const sess = json.session || json
      if (Array.isArray(json.sessions) || Array.isArray(json)) {
        const rows = (json.sessions || json).map((r) => r.session || r)
        return R.mdTable(R.asArray(rows) || [], [
          { h: '会话', v: (r) => r.id ?? r.session_id ?? '' },
          { h: 'issue', v: (r) => issueLabel(r) },
          { h: '节点', v: (r) => r.agent_type ?? '' },
          { h: '状态', v: (r) => r.status ?? '' },
          { h: '到期(epoch)', v: (r) => String(r.token_expires_at ?? '').slice(0, 16) },
        ])
      }
      const lines = [`### 接管会话 \`${sess.id ?? '-'}\``, '']
      lines.push(`- 状态: ${sess.status ?? '-'} · 节点: ${sess.agent_type ?? '-'} · 任务: ${sess.task_id ?? '-'}`)
      if (sess.token_expires_at) lines.push(`- 凭据到期 epoch: ${sess.token_expires_at}`)
      if (sess.summary) lines.push(`- 摘要: ${String(sess.summary).slice(0, 200)}`)
      if (sess.result_json) lines.push('', '**交回结果**', '', String(sess.result_json).slice(0, 2000))
      /* 待派发标记从会话记录派生：交回在服务端同步关会话，事后写 progress 必 409 not_active，
       * 已结束会话的 durable 事实只有会话字段本身。判据与 finish 同源——
       * **已派发 = handoff.seq>0 或 handoff.reason=already_dispatched**；
       * next_seq 恒 0、仅作辅助展示，不单独构成已派发证据。 */
      const nextA = String(sess.next_agent ?? '').trim()
      const evidence = dispatchEvidenceOf(json)
      const nextSeq = seqOf(json, 'next_seq')
      const finished = String(sess.status).toLowerCase() === 'finished'
      const issue = issueLabel(sess)
      if (finished && nextA && evidence.dispatched) {
        const how = evidence.seq > 0 ? `handoff.seq=${evidence.seq}` : `handoff.reason=${evidence.reason || 'already_dispatched'}`
        lines.push('', `- 下一节点 ${nextA} 已派发（${how}）：平台已派发，不重复补发`)
      }
      if (finished && nextA && !evidence.dispatched) {
        const repoKey = String(sess.repo_key ?? '').split(':').pop()
        const warns = Array.isArray(sess.warnings) ? sess.warnings
          : (() => { try { return JSON.parse(sess.warnings_json || '[]') } catch { return [] } })()
        const skipped = seqOf(json, 'skipped_dispatches')
        lines.push('', '**⚠️ 待派发标记（派发未证实）**', '')
        lines.push(nextSeq > 0
          ? `- 下一节点 ${nextA} 仅见 next_seq=${nextSeq}（辅助信号，平台 finish 不回填该指针、不单独作派发证据）：需回读事件核实是否已派发`
          : `- 下一节点 ${nextA} 未见 handoff.seq / already_dispatched（next_seq=${nextSeq}）：需回读事件核实是否已派发`)
        if (repoKey) lines.push(`- 目标仓库: ${repoKey}${issue ? ` · issue: ${issue}` : ''}`)
        if (warns.length) lines.push(`- 会话警告: ${warns.join('；')}`)
        if (skipped > 0) lines.push(`- 平台跳过派发: skipped_dispatches=${skipped}`)
        lines.push(`- 口径: 已派发以 handoff.seq>0 / handoff.reason=already_dispatched 为准；客户端兜底派发只写事件、不回填会话记录，故会话字段缺失不构成「未派发」证据`)
        lines.push('', `_补发前先 grape_get_issue_events 确认下一节点无 a2a_event，确认后才 grape_trigger_pipeline(agent=${nextA}) 补发。_`)
      }
      return lines.join('\n')
    },
  },
  {
    name: 'grape_takeover_progress',
    description:
      '向平台回报接管节点的执行进度（写入 task_messages，云端/面板可见）。接管期间本地每完成一个关键动作调用一次。' +
      '可选 attach：把本地会话 id 绑回接管会话，面板可跳回本地会话。',
    schema: {
      type: 'object',
      properties: {
        session_id: str('接管会话 id'),
        summary: str('一句话进度摘要'),
        messages: { type: 'array', items: { type: 'string' }, description: '进度消息列表（可选）' },
        client_session: str('本地会话 id（可选，attach 用）'),
      },
      required: ['session_id'],
    },
    async native(a) {
      if (a.client_session) await api.takeoverAttach(a.session_id, a.client_session).catch(() => {})
      return api.takeoverProgress(a.session_id, a.messages || (a.summary ? [a.summary] : []), a.summary || '')
    },
    render(json) {
      return json && typeof json === 'object' && !json.detail
        ? `进度已回报${json.written != null ? `（written=${json.written}）` : ''}`
        : R.fallbackJson(json)
    },
  },
  {
    name: 'grape_takeover_finish',
    description:
      '结束接管：本地携结构化产物交回（conclusion/actions/artifacts/next_step/issue_summary），' +
      '平台写入 events.structured_output（与 worker 同格式），并按场景链确保下一节点被派发，链不断：' +
      '**已派发判据 = `handoff.seq>0` 或 `handoff.reason=already_dispatched`**（平台不回填 `next_seq`，其恒 0，仅作辅助展示）——命中即不重复派发。' +
      '双判据缺失时先回读 issue 事件，确认下一节点无 `a2a_event` 才按场景链 **兜底补发**（复用 trigger 同源 A2A 通道，目标按场景链 `next` 推导，自定义链 coding→review→sre 同样生效）；' +
      '因 remote_may_still_run 等警告码阻塞、缺仓库/issue 标识、事件回读失败或补发失败时，返回**显式告警 + 待派发标记（pending_dispatch）**，' +
      '标记随交回结果返回（平台对已结束会话拒绝 progress 写入——409 not_active，不走 task_messages），' +
      '事后经 `grape_takeover_status` 复查会话记录同样可见派发未证实与补发指引，不再静默。' +
      '下一节点推导顺序：平台 next_agent > 结构化 next_step（**整串** agent 名如 `qa`，散文如「qa：请复查 PR #10」不解析）> 场景链 next。' +
      '三个不放行的边界：交回未成功（平台 `ok=false` 或 `changed=false`）时**不派发**下一节点（否则下一节点会接手一个未交回的任务），落待派发并渲染「交回未成功」；' +
      '平台给了场景链之外的节点名（如 `reviewer`）时**不按场景链改写**，原样上报「未知节点」待人工裁决；' +
      '补发响应缺事件 `seq` 时判「派发未证实」（不渲染 `seq=0`、不宣称已派发），需查事件核实。' +
      '⚠️ 用户决策层动作：确认本地成果可交回后再调用。' +
      '两阶段确认流：先 request-finish（仅报告完成，等用户确认），用户确认后再本工具 finish。' +
      '⚠️ coding 交回产物校验（Issue #31）：agent_type=coding（或直接带 branch/commit/pr_number 任一）时须带齐 branch、commit、PR；' +
      '未显式声明 agent_type 且无任何产物时回退读取会话记录的 agent_type 判定（不再静默放行 coding 会话）；' +
      'request-finish 只出强 warning，正式 finish 缺项直接拒绝并列出缺失项，补齐后通过；确需带缺项交回时显式 allow_incomplete=true（在 actions 留痕）。' +
      '校验通过的 branch/commit/PR 自动追加进交回 artifacts 留痕（不写平台顶层字段），下游 QA 可从交回记录读到 PR。' +
      'finish/abort 会清理本次进程写出的 GIT_ASKPASS（registry + 传入/会话 workspace 兜底，跨进程重启可清）。',
    schema: {
      type: 'object',
      properties: {
        session_id: str('接管会话 id'),
        request_only: bool('true=只报告完成等用户确认（request-finish），false=正式交回（finish，需用户已确认）'),
        summary: str('结论（做了什么、结果如何）'),
        evidence: str('验证证据（命令+输出/测试结果）'),
        files_written: { type: 'array', items: { type: 'string' }, description: '改动文件列表' },
        actions: { type: 'array', items: { type: 'string' }, description: '关键动作列表' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '产物（分支/PR/报告链接等）' },
        next_step: str('给下一节点（如 qa）的提示'),
        issue_summary: str('整单摘要（可选）'),
        owner: str('兜底派发用 owner（可选；仅当会话未带仓库标识时使用）'),
        repo: str('兜底派发用 repo（可选）'),
        issue_number: num('兜底派发用 issue 编号（可选）'),
        agent_type: str('本次交回的节点（coding 时校验 branch/commit/PR）'),
        branch: str('coding 交回产物：分支（head，如 feat/issue-31）'),
        commit: str('coding 交回产物：commit sha（git rev-parse HEAD）'),
        pr_number: str('coding 交回产物：PR 编号或链接'),
        allow_incomplete: bool('true=允许 coding 产物缺项交回（在 actions 留痕）'),
        workspace: str('工作区路径（用于清理 askpass；缺省用本次进程写出的记录）'),
      },
      required: ['session_id', 'summary'],
    },
    async native(a) {
      const payload = {
        summary: a.summary,
        evidence: a.evidence || '',
        files_written: a.files_written || [],
        actions: Array.isArray(a.actions) ? a.actions : [],
        artifacts: a.artifacts || [],
        next_step: a.next_step || '',
        issue_summary: a.issue_summary || '',
      }
      /* coding 产物校验（Issue #31）：agent_type=coding，或带了任一产物字段（按 coding 处理）；
       * 未显式声明且无产物时回退读取会话记录的 agent_type，封堵「不传 agent_type 也不传产物 → 静默放行」。
       * request-finish 只强 warning（用户确认前可能还要补 push/PR）；正式 finish 缺项拒绝，allow_incomplete 覆写留痕。 */
      const evidence = codingEvidence(a)
      const declared = asAgentType(a.agent_type)
      const hasEvidence = Object.values(evidence).some(Boolean)
      const workspaceArg = String(a.workspace ?? '').trim()
      const needsSession = !declared || (!workspaceArg && !ASKPASS_REGISTRY.has(String(a.session_id)))
      let session = null
      if (needsSession) {
        try { session = await api.takeoverGet(a.session_id) } catch { /* 会话不可读：无法证明 coding 时按未声明处理（保持既有行为） */ }
      }
      const sessionAgent = asAgentType((session?.session ?? session ?? {}).agent_type)
      const effective = declared || sessionAgent
      const coding = effective === 'coding' || (!effective && hasEvidence)
      const missing = coding ? missingCodingEvidence(evidence) : []
      // 校验到的 branch/commit/PR 追加进 artifacts 留痕（不写平台顶层字段），保证下游 QA 从交回记录读到 PR
      const evidenceArtifacts = []
      if (evidence.branch) evidenceArtifacts.push(`branch: ${evidence.branch}`)
      if (evidence.commit) evidenceArtifacts.push(`commit: ${evidence.commit}`)
      if (evidence.pr) evidenceArtifacts.push(`PR: ${evidence.pr}`)
      if (evidenceArtifacts.length) payload.artifacts = [...payload.artifacts, ...evidenceArtifacts]
      if (a.request_only) {
        const json = await api.takeoverRequestFinish(a.session_id, payload)
        const base = json && typeof json === 'object' ? json : { raw: json }
        return {
          ...base,
          ...(missing.length
            ? { coding_evidence_warning: { missing, message: `coding 交回产物不齐：${missing.join('、')}；补齐后再正式 finish（缺项会被拒绝）` } }
            : {}),
        }
      }
      if (missing.length && !a.allow_incomplete) {
        throw new GrapeApiError(`coding 交回缺少产物：${missing.join('、')}`, {
          status: 400,
          hint: '交回前须带齐 branch / commit / PR 三件套：`git rev-parse HEAD` 取 commit、`grape_create_pull` 建 PR 后回填 pr_number。'
            + '确需带缺项交回时显式传 allow_incomplete=true（会在 actions 留痕）。本次未调用 finish，交回未发生。',
        })
      }
      if (missing.length) {
        payload.actions = [...payload.actions, `⚠️ allow_incomplete 覆写：coding 交回缺少 ${missing.join('、')}（显式允许，未补齐）`]
      }
      // 正式交回后不再需要 askpass：registry（本进程）+ 显式 workspace；都没有时用会话工作区兜底（跨进程重启）
      const cleanupWs = workspaceArg || sessionWorkspaceOf(session)
      const askpassCleanup = cleanupAskpassFor(a.session_id, cleanupWs)
      const json = await api.takeoverFinish(a.session_id, { ...payload, outcome: 'completed', handoff: 'a2a' })
      const out = await ensureNextNodeDispatched(json, a)
      const base = out && typeof out === 'object' ? out : { raw: out }
      return {
        ...base,
        ...(missing.length ? { incomplete_override: { allowed: true, missing } } : {}),
        ...(askpassCleanup.length ? { askpass_cleanup: askpassCleanup } : {}),
      }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `交回失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const lines = []
      const isRequestOnly = json.changed === undefined && !json.event_status && !json.next_agent
        && (json.awaiting_confirmation || json.requested || json.session?.finish_requested_at)
      if (isRequestOnly) {
        lines.push('### 已报告完成，等待用户确认', '', '用户确认后再次调用本工具（request_only=false）正式交回。')
        const w = json.coding_evidence_warning
        if (w && Array.isArray(w.missing) && w.missing.length) {
          lines.push('', '**⚠️ coding 交回产物不齐（正式 finish 会被拒绝）**', '')
          lines.push(`- 缺少: ${w.missing.join('、')}`)
          lines.push('', '_补齐 branch / commit / PR 后再交回；确需带缺项交回时显式 allow_incomplete=true（在 actions 留痕）。_')
        }
      }
      else {
        // 平台明确 ok=false / changed=false：交回未生效，标题不得写「完成」
        const uncommitted = json.ok === false || json.changed === false
        lines.push(uncommitted ? '### 接管交回未完成' : '### 接管交回完成', '')
        const ho = describeHandoff(json.handoff)
        if (json.next_agent) lines.push(`- 下一节点: ${json.next_agent}（handoff=${ho.label}）`)
        const handoffCovered = ['dispatched', 'already_dispatched'].includes(json.dispatch?.status)
        if (ho.failure) lines.push(`- **⚠️ 平台 handoff 派发失败：${ho.failure}**${handoffCovered ? '（已由客户端兜底派发覆盖）' : ''}`)
        if (json.issue_stage) lines.push(`- issue 阶段: ${json.issue_stage}`)
        if (json.event_status) lines.push(`- 事件终态: ${json.event_status}`)
        if (json.incomplete_override?.allowed) {
          lines.push(`- **⚠️ allow_incomplete 覆写**：缺少 ${json.incomplete_override.missing.join('、')}（已在 actions 留痕）`)
        }
        if (Array.isArray(json.askpass_cleanup) && json.askpass_cleanup.length) {
          lines.push(`- askpass 已清理: ${json.askpass_cleanup.join('、')}`)
        }
        const handoffSeq = dispatchEvidenceOf(json).seq
        if (handoffSeq) {
          // handoff.seq（或历史字段 handoff_seq）是「下一节点已派发」的权威证据
          lines.push(`- 平台 handoff.seq=${handoffSeq}（已派发证据）`)
        }
        const d = json.dispatch || {}
        if (d.status === 'dispatched') {
          lines.push(`- 下一节点已自动派发：事件 seq=${d.seq}（平台未见 handoff.seq/already_dispatched，客户端回读事件确认后按场景链兜底补发）`)
          for (const w of (d.warnings || [])) lines.push(`- ⚠️ ${w}`)
          lines.push('', '_链不断：下一节点已收到派发事件，无需手动 trigger。_')
        } else if (d.status === 'already_dispatched') {
          const how = d.seq > 0 ? `seq=${d.seq}` : `handoff.reason=${d.reason || 'already_dispatched'}`
          lines.push(`- 下一节点 ${d.agent || '-'} 已派发（${how}），未重复派发`)
          lines.push('', '_链不断：下一节点已被派发，无需手动 trigger。_')
        } else if (d.status === 'out_of_scope') {
          lines.push(`- 下一节点 ${d.agent || '-'} 的派发不由本工具兜底，保持平台原行为`)
          lines.push('', '_平台若未派发该节点，链会停在当前节点；确认无事件后再手动 grape_trigger_pipeline 补发。_')
        } else if (d.status === 'pending') {
          const pd = json.pending_dispatch || {}
          if (d.cause === 'finish_not_ok' || d.cause === 'finish_not_changed') {
            // 交回没成功就派发下一节点，会把下一节点拉去接手一个未交回的任务
            lines.push('', '**⚠️ 交回未成功：未派发下一节点**', '')
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', '_先解决交回本身（修完再调 grape_takeover_finish 正式交回），成功后再由本工具兜底派发。本次未派发，链可能停在当前节点。_')
          } else if (d.cause === 'unknown_next_agent') {
            lines.push('', '**⚠️ 下一节点未被派发（平台指定的节点名不在场景链内）**', '')
            lines.push(`- 平台指定的节点: ${d.agent || '-'}（未知节点名，未按场景链改写）`)
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', '_场景链兜底只派发场景链内的节点，链外节点名不被静默顶掉：请核实场景链后手动派发。_')
          } else if (d.cause === 'readback_failed') {
            lines.push('', '**⚠️ 下一节点派发未证实（事件回读失败）**', '')
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', `_回读失败时不盲目补发：先 \`grape_get_issue_events\` 核实下一节点是否已有 a2a_event，确认无事件再 \`grape_trigger_pipeline(agent=${d.agent})\` 补发。_`)
          } else if (d.cause === 'dispatch_unconfirmed') {
            // 补发响应缺事件 seq：不能把「请求发出去了」当成「派发发生了」
            lines.push('', '**⚠️ 下一节点派发未证实（补发响应缺事件 seq）**', '')
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', `_补发请求已发出但平台未返回事件序号：先 \`grape_get_issue_events\` 核实下一节点是否已有事件，确认无事件再 \`grape_trigger_pipeline(agent=${d.agent})\` 补发。_`)
          } else {
            lines.push('', '**⚠️ 下一节点未被派发（待派发，pending_dispatch）**', '')
            lines.push(`- 目标节点: ${d.agent || '-'}${pd.owner ? ` · 仓库: ${pd.owner}/${pd.repo}` : ''}${pd.issue_number ? ` · issue: #${pd.issue_number}` : ''}`)
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push(`- 标记随本次交回结果返回；事后用 grape_takeover_status 复查会话（finished + next_agent=${d.agent || '-'} + 未见 handoff.seq 即派发未证实）`)
            lines.push('', `_链未自动接续：先 grape_get_issue_events 确认下一节点无 a2a_event，再调 \`grape_trigger_pipeline(agent=${d.agent})\` 补发。_`)
          }
        } else if (ho.failure) {
          // 无 dispatch 字段但平台已明确 handoff 失败：不得再宣称「无需 trigger」
          lines.push('', '_平台未返回派发结果，且 handoff 已失败：链可能停在当前节点，以下指引为准。_')
        } else {
          // 无 dispatch 字段：旧平台/CLI 回退通道的响应形状，按平台原样披露
          lines.push('', '_流水线从断点继续，无需 context 口述、无需 trigger 重触发。_')
        }
        // pending 分支已给出更具体的补发指引；已派发（含兜底覆盖）时不再要求手动补发，避免与「无需 trigger」互斥
        if (ho.failure && !handoffCovered && json.dispatch?.status !== 'pending') {
          lines.push('', `_平台 handoff 未成功：先 grape_get_issue_events 确认下一节点无事件，再调 \`grape_trigger_pipeline(agent=${json.next_agent || '…'})\` 手动补发。_`)
        }
      }
      return lines.join('\n')
    },
  },
  {
    name: 'grape_takeover_abort',
    description:
      '放弃接管、让渡回流水线：接管会话终止、凭据吊销，当前节点重新派发给云端引擎（redispatch=true，默认）。' +
      'redispatch=false 仅停止接管不重派（节点回到队列等待人工/调度）。' +
      '与旧路径 cancel 的区别：链完全不断，已完成节点保留、后续节点不动。',
    schema: {
      type: 'object',
      properties: {
        session_id: str('接管会话 id'),
        redispatch: bool('是否重新派发当前节点（默认 true）'),
        reason: str('放弃原因（写入审计事件）'),
        workspace: str('工作区路径（用于清理 askpass；缺省用本次进程写出的记录）'),
      },
      required: ['session_id'],
    },
    async native(a) {
      // 让渡后本地不再需要凭据：清理本次进程为该 session 写出的 askpass
      const askpassCleanup = cleanupAskpassFor(a.session_id, a.workspace)
      const json = await api.takeoverAbort(a.session_id, a.redispatch !== false, a.reason || '')
      const base = json && typeof json === 'object' ? json : { raw: json }
      return { ...base, ...(askpassCleanup.length ? { askpass_cleanup: askpassCleanup } : {}) }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `让渡失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const lines = ['### 接管已让渡回流水线', '']
      if (json.redispatched === false) {
        // 平台 #2517 修复后顶层披露：重派失败必须可见，否则链静默断裂
        lines.push('- 接管会话已终止、凭据已吊销')
        lines.push('', '**⚠️ 重派失败——链未自动恢复！**', '')
        lines.push(`原因: ${json.redispatch_error || (json.redispatch && json.redispatch.error) || '未知'}`)
        lines.push('', '请稍后手动重派该节点事件（`POST /api/events/{seq}/redispatch`），或联系平台方。')
      } else if (json.redispatched === true || json.redispatch) {
        lines.push('- 当前节点已重新派发，云端引擎将接手继续')
      } else {
        lines.push('- 节点已回到队列（未重派）')
      }
      if (json.reason) lines.push(`- 原因: ${json.reason}`)
      if (Array.isArray(json.askpass_cleanup) && json.askpass_cleanup.length) {
        lines.push(`- askpass 已清理: ${json.askpass_cleanup.join('、')}`)
      }
      return lines.join('\n')
    },
  },

  {
    name: 'grape_git_credential',
    description:
      'git 写回 · 换一次性本仓凭据并落地 GIT_ASKPASS（Issue #31：干净机器可 push 的关键一环）。' +
      '用接管凭据 tko_（或会话级 tk_）调 `/api/repos/{owner}/{repo}/git-credential`（600s、仅本仓），' +
      '在工作区写 `.grape/git-askpass.sh`（POSIX）/ `.cmd`（Windows），权限 0600；脚本内嵌到期 epoch，' +
      '过期后非零退出并在 stderr 提示「重新换券」，**不存在**静默回退本机 git / CLI 凭据的分支。' +
      '⚠️ 先校验：owner/repo 必须与接管会话绑定的仓库一致（非本仓拒绝），workspace 必须在会话工作区内（越界拒绝且不落盘）。' +
      '⚠️ 提交防泄漏：.grape 目录或 askpass 目标文件为 symlink 时拒绝写入（不越界写）；git 仓库内写盘前把 `/.grape/` 写入 `.git/info/exclude` 并 `git check-ignore --no-index` 复核，无法确认即拒绝（600s 券不得进远端历史）。' +
      '⚠️ 凭据短时（600s）：push 前重新换券、不缓存；返回只含掩码口令，不回显明文。' +
      'cleanup=true 只删除本工具写出的 askpass 文件（幂等），不换券。',
    schema: {
      type: 'object',
      properties: {
        session_id: str('接管会话 id（用于 owner/repo 与工作区绑定校验）'),
        owner: str('owner（必须与会话仓库一致）'),
        repo: str('repo（必须与会话仓库一致）'),
        workspace: str('本地工作区路径（必须是会话工作区或其子目录）'),
        cleanup: bool('true=只清理 askpass 文件，不换券'),
      },
      required: ['session_id', 'owner', 'repo', 'workspace'],
    },
    async run(a, deps = {}) {
      const A = deps.apiModule || api
      const platform = deps.platform || process.platform
      const now = deps.now || (() => Math.floor(Date.now() / 1000))
      assertRepoSeg(a.owner, a.repo)
      const wsInput = String(a.workspace ?? '').trim()
      if (!wsInput) {
        throw new GrapeApiError('缺少 workspace：请传入接管会话的本地工作区路径', { status: 400, hint: '凭据只允许落在会话工作区内，不提供默认落盘位置。' })
      }
      const ws = safeRealpath(wsInput)
      // ① 会话绑定校验（本仓 + 工作区边界）：拿不到会话就不换券，杜绝「非本仓/越界」静默通过
      let session
      try {
        session = await A.takeoverGet(a.session_id)
      } catch (e) {
        const needsSessionToken = e instanceof GrapeApiError && (e.status === 401 || e.status === 403)
        throw new GrapeApiError(`无法校验接管会话 ${a.session_id}：${e?.message || e}`, {
          status: e?.status || 0,
          hint: needsSessionToken
            ? '换券需要会话级凭据（tko_ 接管凭据 / tk_ worker 凭据）；用户级 grape_ 调用 git-credential 必 403，属预期边界，不要更换 token 绕行。'
            : (e?.hint || ''),
        })
      }
      const bound = sessionRepoOf(session)
      if (!bound.owner || !bound.repo) {
        throw new GrapeApiError(`接管会话 ${a.session_id} 未带仓库绑定，拒绝换券（无法校验非本仓）`, {
          status: 400,
          hint: '会话缺 repo_key/repository 时无法证明「本仓」；请先用 grape_takeover_status 找回正确会话再换券，本次未写入任何文件。',
        })
      }
      if (bound.owner.toLowerCase() !== String(a.owner).toLowerCase() || bound.repo.toLowerCase() !== String(a.repo).toLowerCase()) {
        throw new GrapeApiError(`拒绝换券：owner/repo 与接管会话绑定的仓库不一致（会话 ${bound.owner}/${bound.repo}，请求 ${a.owner}/${a.repo}）`, {
          status: 400,
          hint: '只允许为本仓换券；不一致时未写入任何文件（不做跨仓降级）。',
        })
      }
      // Issue #37：会话根（本机视角）与 workspace 解析同优先级——显式 workspace 优先，cwd_hint 仅兜底。
      // 本机确实存在该 cwd_hint 目录时仍用它作越界边界（云端 worker 场景不放松）；云端 hint 在本机不存在（本地接管）
      // 时显式 workspace 即本机会话根，否则本地接管永远无法换券。
      const hintRaw = sessionWorkspaceOf(session)
      const hintIsLocal = Boolean(hintRaw) && existsSync(hintRaw)
      const rootRaw = hintIsLocal && !pathInsideString(hintRaw, ws)
        ? hintRaw                                                        // 本机存在的 hint → 沿用 insideRoot 越界拒绝
        : (ws || String(deps.workspaceRoot ?? '').trim() || process.cwd()) // 云端 hint（本机不存在）→ 显式 workspace 作会话根
      const root = safeRealpath(rootRaw)
      const rootNote = hintRaw && !hintIsLocal
        ? `云端 cwd_hint（${hintRaw}）在本机不存在，已用显式 workspace（${root}）作会话根；越界拒绝仍生效。`
        : ''
      if (!insideRoot(root, ws)) {
        throw new GrapeApiError(`拒绝换券：workspace（${ws}）不在接管会话工作区（${root}）内`, {
          status: 400,
          hint: '凭据只允许落在会话工作区（含子目录）；越界路径未写入任何文件。',
        })
      }
      // ② cleanup：只删本工具的两份固定文件，不换券
      if (a.cleanup) {
        const cleaned = removeAskpass(ws)
        ASKPASS_REGISTRY.delete(String(a.session_id))
        return { cleaned, workspace: ws }
      }
      // ③ 换券（一次性、600s）：过期/无到期一律不写盘，提示重新换券
      const cred = await A.gitCredential(a.owner, a.repo)
      const username = String(cred?.username ?? 'x-access-token')
      const password = String(cred?.password ?? cred?.token ?? '')
      if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) {
        throw new GrapeApiError('换券响应含换行/NUL，拒绝写入 askpass（会破坏脚本）', {
          status: 400,
          hint: '重新换券；凭据内容异常时不落盘、不静默改用本机凭据。',
        })
      }
      if (!password) {
        throw new GrapeApiError('换券响应未含 password/token，未写盘', {
          status: 400,
          hint: '请重新换券（grape_git_credential）；不得回退本机 git / CLI 凭据静默推送。',
        })
      }
      const expiresAt = credentialExpiry(cred, now())
      if (!expiresAt || expiresAt <= now()) {
        throw new GrapeApiError(`换券返回的凭据已过期或缺少有效期（expires=${expiresAt || 'unknown'}），未写盘`, {
          status: 400,
          hint: '重新换券（grape_git_credential）后再 push；过期券一律不落盘，不存在静默回退分支。',
        })
      }
      // ④ Windows .cmd 通路：口令含 cmd 元字符会破坏脚本/泄露，直接拒绝（平台 token 为字母数字，正常不命中）
      if (platform === 'win32' && (CMD_UNSAFE_RE.test(username) || CMD_UNSAFE_RE.test(password))) {
        throw new GrapeApiError('拒绝写入：凭据含 cmd 元字符（" % & ^ | < > ( ) ! `），会破坏 .cmd 脚本或泄露口令', {
          status: 400,
          hint: '重新换券；本次未写入任何文件，不降级为不安全的 .cmd 拼接。',
        })
      }
      // ⑤ 落盘：<ws>/.grape（拒绝 symlink 目录，防写到工作区外）
      const dir = join(ws, ASKPASS_DIR)
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
        throw new GrapeApiError(`拒绝写入：${dir} 是符号链接（可能指向工作区外）`, {
          status: 400,
          hint: '删除该符号链接后重试；凭据只允许落在工作区内的真实目录。',
        })
      }
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = platform === 'win32' ? join(dir, ASKPASS_WIN) : join(dir, ASKPASS_POSIX)
      // 文件级 symlink：writeFileSync 会跟随链接写到工作区外（并对外部目标 chmod），写入前 lstat 拒绝
      let fileStat = null
      try { fileStat = lstatSync(file) } catch { /* 文件尚不存在 */ }
      if (fileStat?.isSymbolicLink()) {
        throw new GrapeApiError(`拒绝写入：${file} 是符号链接（可能指向工作区外）`, {
          status: 400,
          hint: '删除该符号链接后重试；凭据文件必须是工作区内的真实普通文件，本次未写入任何凭据。',
        })
      }
      // ⑥ 提交防泄漏：git 仓库内先确保 .grape/ 已 exclude 且 check-ignore 复核通过，否则拒绝写盘
      const ignore = ensureGrapeIgnored(ws)
      const content = platform === 'win32'
        ? askpassCmd({ username, password, expiresAt })
        : askpassPosix({ username, password, expiresAt })
      writeFileSync(file, content, { mode: 0o600 })
      // win32 无 0600 权限位（按目录 ACL）；POSIX 上显式再 chmod 一次，兼容 umask
      try { chmodSync(file, 0o600) } catch {}
      ASKPASS_REGISTRY.set(String(a.session_id), file)
      return {
        ok: true,
        owner: a.owner,
        repo: a.repo,
        provider: String(cred?.provider ?? ''),
        username,
        masked_password: R.maskSecret(password),
        expires_at: expiresAt,
        ttl_seconds: Math.max(0, expiresAt - now()),
        askpass_path: file,
        mode: '0600',
        workspace: ws,
        session_root: root,
        session_root_note: rootNote,
        git_ignore: ignore,
        clone_url: String(cred?.clone_url ?? ''),
        note: '凭据一次性（600s）：push 前重新换券、不缓存；过期后脚本非零退出并提示重新换券（无静默回退）。提交前务必排除 .grape/（已写入 .git/info/exclude 并以 check-ignore 复核）。finish/abort 会清理该文件。',
      }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.cleaned !== undefined) {
        return Array.isArray(json.cleaned) && json.cleaned.length
          ? ['### askpass 已清理', '', ...json.cleaned.map((f) => `- 删除: ${f}`)].join('\n')
          : '### askpass 无需清理（文件不存在）'
      }
      const lines = ['### git 凭据已换（一次性，短时）', '']
      lines.push(`- 仓库: ${json.owner}/${json.repo}${json.provider ? `（${json.provider}）` : ''}`)
      lines.push(`- 用户名: ${json.username} · 口令: ${json.masked_password}（掩码；明文只在 askpass 文件内）`)
      lines.push(`- 到期: ${R.formatEpoch(json.expires_at)}（epoch ${json.expires_at}，TTL ${json.ttl_seconds}s）`)
      lines.push(`- askpass: \`${json.askpass_path}\`（权限 ${json.mode}）`)
      if (json.session_root_note) lines.push(`- ⚠️ 会话根: ${json.session_root_note}`)
      const gi = json.git_ignore
      if (gi && gi.is_git) {
        lines.push(`- git 排除: \`/.grape/\` 已写入 \`${gi.exclude_path}\`，且 \`git check-ignore --no-index\` 复核通过`)
      } else if (gi) {
        lines.push('- git 排除: 工作区非 git 仓库（无提交风险，跳过 exclude 写入）')
      }
      lines.push('', '**⚠️ 提交前必须排除 .grape/**：不要把凭据文件加入 git（`git add -A` 前先 `git status` 确认 `.grape/` 不在待提交列表；仓内 `.gitignore` 不含该项，本工具靠 `.git/info/exclude` 兜底）。')
      lines.push('', '**push 用法（券在 push 前换，不缓存）**', '', '```bash')
      lines.push(`export GIT_ASKPASS="${json.askpass_path}"`)
      lines.push('export GIT_TERMINAL_PROMPT=0')
      lines.push('git push origin <branch>')
      lines.push('```')
      lines.push('', '_过期后 askpass 非零退出并提示「重新换券」；本工具没有静默回退本机 git / CLI 凭据的分支。finish/abort 会清理该文件。_')
      return lines.join('\n')
    },
  },
  {
    name: 'grape_create_pull',
    description:
      'git 写回 · 创建 PR（薄代理 `POST /api/git-repo/{owner}/{repo}/pulls`，会话级 tk_/tko_ 通道；用户级 grape_ 403 属预期）。' +
      '只建 PR，不评审、不合并；返回 PR 编号与 URL，作为 takeover finish 的 branch/commit/PR 三件套证据。' +
      '`issue_number` 映射为 `related_issue_nums`；`auto_close_issues` 默认 false（不擅自关闭 Issue）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        title: str('PR 标题'),
        head: str('源分支（如 feat/issue-31）'),
        base: str('目标分支（工作基线，如 main）'),
        body: str('PR 描述（可选）'),
        issue_number: num('关联 issue 编号（可选，映射 related_issue_nums）'),
        related_issue_nums: { type: 'array', items: { type: 'number' }, description: '关联 issue 编号列表（可选）' },
        auto_close_issues: bool('合并后自动关闭关联 Issue（默认 false）'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    async native(a) {
      assertRepoSeg(a.owner, a.repo)
      for (const k of ['title', 'head', 'base']) {
        if (!String(a[k] ?? '').trim()) {
          throw new GrapeApiError(`缺少 ${k}：创建 PR 需要 title/head/base`, {
            status: 400,
            hint: 'head 是开发分支、base 是目标合入分支（工作基线）；先用 grape_takeover_status 确认分支后重试。',
          })
        }
      }
      const payload = { title: a.title, head: a.head, base: a.base }
      if (a.body) payload.body = a.body
      const nums = Array.isArray(a.related_issue_nums)
        ? a.related_issue_nums
        : (a.issue_number ? [Number(a.issue_number)] : [])
      if (nums.length) payload.related_issue_nums = nums
      if (a.auto_close_issues === true) payload.auto_close_issues = true
      return api.createPull(a.owner, a.repo, payload)
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const err = json.detail ?? json.error
      if (err !== undefined) return `PR 创建失败：${typeof err === 'string' ? err : JSON.stringify(err)}`
      const num = json.number ?? json.pr_number ?? json.iid ?? json.id ?? ''
      const url = json.html_url || json.web_url || json.url || ''
      const head = typeof json.head === 'string' ? json.head : (json.head?.ref ?? '')
      const base = typeof json.base === 'string' ? json.base : (json.base?.ref ?? '')
      const lines = ['### PR 已创建', '']
      lines.push(`- 编号: ${num || '-'}`)
      if (head || base) lines.push(`- 分支: ${head || '?'} → ${base || '?'}`)
      if (json.title) lines.push(`- 标题: ${json.title}`)
      if (url) lines.push(`- 链接: ${url}`)
      lines.push('', '_交回前把 PR 编号与 commit sha 传给 grape_takeover_finish（coding 缺项会被拒绝）；本工具不评审、不合并。_')
      return lines.join('\n')
    },
  },

  {
    name: 'grape_worker_onboard',
    description:
      '把本机接入为 Grape Worker（生成 runtime 凭据并给出安装命令）。' +
      '⚠️ 用户决策层动作：接入前必须向用户确认设备名与目标服务器；凭据只展示一次，请提示用户立即保存。' +
      '本工具只生成【可见的安装命令】，由 agent 在终端中执行（用户可亲眼看到并打断）——不静默安装。' +
      '执行后本机即与远端 worker 同级参与任务认领。',
    schema: {
      type: 'object',
      properties: { device_name: str('设备名（可选，默认 grape-kit-<主机名>）') },
    },
    async run(a, { runGrape, apiModule }) {
      // 地址与运行时 API 同源：env > ~/.grape/config.json > 默认（否则文件通道用户会连错实例）
      const base = getBaseUrl().replace(/\/$/, '')
      const baseName = a.device_name || `grape-kit-${hostname()}`
      const A = apiModule || (await import('./api.mjs')).api
      // 凭据名全局唯一且 token 只展示一次：重名（400 已存在）自动加时间戳后缀重试一次
      let cred
      let name = baseName
      const create = async (n) => (runGrape && !apiModule)
        ? runGrape(['settings', 'runtime', 'credential', 'create', '--json', JSON.stringify({ name: n, scope: 'user' })])
        : { json: await A.workerCredentialCreate(n, 'user') }
      try {
        cred = await create(name)
      } catch (err) {
        if (/已存在/.test(err.message || '')) {
          name = `${baseName}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
          cred = await create(name)
        } else {
          throw err
        }
      }
      const j = cred.json
      const token = j && (j.token || (j.result && j.result.token))
      if (!token) return { onboard: false, error: 'credential create 未返回 token', raw: j }
      return {
        onboard: 'ready',
        device: name,
        credential_name: name,
        install_command: `# 凭据 ${name} 已创建，token 仅展示一次（不写入命令历史）。
# 方式一（推荐，token 不进 argv）：先 export 再执行
RUNTIME_TOKEN=<在 WebUI 凭据页查看 ${name} 的 token> \
  curl -sSL ${base}/api/runtime/install | bash -s -- --server ${base} --device ${name}
# 方式二（一键安装，适用于一次性受控终端）：在 WebUI 复制 token 后替换 <TOKEN>
curl -sSL ${base}/api/runtime/install | bash -s -- --token <TOKEN> --server ${base} --device ${name}`,
        note: '凭据可在 grape settings runtime credentials 中管理/吊销；安装命令不内联真实 token（避免 shell 历史泄露）',
      }
    },
    render(json) {
      if (json && json.onboard === false) return `凭据创建失败：${json.error}\n\n${R.fallbackJson(json.raw)}`
      if (json && json.install_command) {
        return [
          `### 本机接入 Worker（${json.device}）`, '',
          '在终端执行以下命令（幂等，可随时打断）：', '',
          '```bash', json.install_command, '```', '',
          json.note ?? '',
        ].join('\n')
      }
      return R.fallbackJson(json)
    },
  },

  
/* ── Issue #27：自管理五工具（读直执行 / 写只生成命令） ──
   * 公共红线（Spec §3.6）：三个写工具**绝不**执行任何变更，只返回可复制命令块 + 决策门文案；
   * run() 不触碰 runGrape / api 通道（无静默执行路径），服务端契约与 CLI 红线都不受影响。 */

  {
    name: 'grape_kit_version',
    description:
      '查询 grape-kit 自身的版本全景（只读直执行）：本地 kit 版本 / npm 最新版与是否可升级 / grape CLI 回退通道是否可用 / ' +
      '服务端连通性与契约版本 / 当前生效的凭据来源。各通道均为 best-effort：单一通道失败只降级该字段，不阻塞其余字段。' +
      '只输出诊断信息，不做任何变更。',
    schema: { type: 'object', properties: {} },
    async run(a, { lifecycle: L = lifecycleModule } = {}) {
      return L.aggregateVersion({})
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const cli = json.grapeCli || {}
      const srv = json.server || {}
      const cred = json.credentials || {}
      const rows = [
        { k: '本地 kit 版本', v: json.kitVersion || '-', note: '包根 package.json（与 server.mjs 同源）' },
        { k: 'npm 最新版', v: json.latestVersion || 'unavailable', note: 'registry.npmjs.org 直查，5s 超时' },
        {
          k: '更新',
          // 四态各有独立结论（dismissed ≠ latest ≠ newer），映射而非三元链，避免把「已忽略」说成「已是最新」（QA Q6）
          v: {
            [UPDATE_STATE.NEWER]: '⬆️ 有可用更新',
            [UPDATE_STATE.LATEST]: '✅ 已是最新',
            [UPDATE_STATE.DISMISSED]: '🙈 已忽略（冷却中）',
            [UPDATE_STATE.UNAVAILABLE]: '检测不可用',
          }[json.updateState] || (json.updateState || '-'),
          note: json.updateNotice || '',
        },
        {
          k: 'grape CLI',
          v: cli.status === 'ok' ? `ok（${cli.version || cli.bin || ''}）` : '未安装',
          note: cli.status === 'ok' ? '可选回退通道（v0.3.0 起原生 HTTP 直连，CLI 仅 401 回退用）' : (cli.hint || ''),
        },
        {
          k: '服务端',
          ...serverRow(srv),
        },
        {
          k: '凭据来源',
          v: cred.configured ? (cred.source || '已配置') : '未配置',
          note: cred.configured ? '按优先级链判定，不回显 token 明文' : (cred.hint || ''),
        },
      ]
      return [
        '### grape-kit 版本全景（只读）', '',
        R.mdTable(rows, [{ h: '项', v: 'k' }, { h: '值', v: 'v' }, { h: '备注', v: 'note' }]), '',
        '_只读诊断：不改任何配置、不执行任何命令。升级请用 grape_kit_upgrade（只生成命令）。_',
      ].join('\n')
    },
  },

  {
    name: 'grape_kit_check_update',
    description:
      '主动检查 grape-kit 是否有新版本（只读）：npm 直查 latest 并与本地版本做 semver 比较。' +
      'dismiss=true 时把该版本记为「已忽略」（写本地 ~/.grape/grape-kit-dismiss.json），3 天内同版本不再提示，新版本出现会重新提醒。' +
      '与启动期被动提醒（24h 缓存）语义解耦；除 dismiss 状态外不产生任何变更。',
    schema: {
      type: 'object',
      properties: {
        dismiss: bool('true = 把该版本记为已忽略（3 天冷却）；缺省 false 只查询'),
        dismissVersion: str('要忽略的版本号（缺省取 npm latest；dismiss=false 时忽略该参数）'),
      },
    },
    async run(a, { lifecycle: L = lifecycleModule } = {}) {
      return L.checkForUpdate({ dismiss: a?.dismiss === true, dismissVersion: a?.dismissVersion })
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const conclusion = {
        [UPDATE_STATE.NEWER]: '⬆️ 有新版本',
        [UPDATE_STATE.LATEST]: '✅ 已是最新',
        [UPDATE_STATE.DISMISSED]: '🙈 已按用户要求忽略（冷却中）',
        [UPDATE_STATE.UNAVAILABLE]: '❔ 检测不可用（npm registry 不可达或响应异常）',
      }[json.state] || (json.state || '-')
      const lines = [
        '### grape-kit 更新检查', '',
        R.mdTable([
          { k: '当前版本', v: json.currentVersion || '-' },
          { k: 'npm 最新', v: json.latestVersion || 'unavailable' },
          { k: '结论', v: conclusion },
        ], [{ h: '项', v: 'k' }, { h: '值', v: 'v' }]),
      ]
      if (json.updateNotice) lines.push('', json.updateNotice)
      // 三项互斥且必须如实：落盘成功才说「已记录」，失败说失败，没版本可记说没记（QA Q4/Q5）
      if (json.dismiss && json.dismiss.ok === false) {
        lines.push('', `**⚠️ 记录失败（路径不可写）**：未能写入 \`${json.dismiss.file || '~/.grape/grape-kit-dismiss.json'}\`（${json.dismiss.error || '落盘失败'}）。`
          + `该版本**未被忽略**，下次检查仍会提示——请修好该路径权限（或 \`GRAPE_HOME\`）后重试。`)
      } else if (json.dismiss) {
        lines.push('', `已记录忽略版本 \`${json.dismiss.version}\`：3 天内不再提示，出现新版本会重新提醒。`)
      } else if (json.dismissSkipped) {
        lines.push('', `**未记录忽略版本**：${json.dismissSkipped}——本次查询结论不受影响。`)
      }
      return lines.join('\n')
    },
  },

  {
    name: 'grape_kit_upgrade',
    description:
      '升级 grape-kit 自身：只读检出安装形态（全局 npm / npx 缓存 / ClawHub / 项目本地依赖 / 未知）并生成对应升级命令。' +
      '⚠️ 用户决策层：执行前必须向用户确认（征得同意后方可执行）；本工具只生成命令、不执行。升级完成后需重启宿主会话才加载新版本。',
    schema: { type: 'object', properties: {} },
    async run(a, { lifecycle: L = lifecycleModule } = {}) {
      const plan = L.detectInstallForm({})
      return { action: 'upgrade', kitVersion: L.readKitVersion(), ...plan }
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      const FORM_LABEL = {
        global: '全局 npm 安装', npx: 'npx 缓存运行', clawhub: 'ClawHub 市场安装', local: '项目本地依赖', unknown: '未知形态',
      }
      const lines = [
        '### 升级 grape-kit（命令生成，未执行）', '',
        R.mdTable([
          { k: '当前版本', v: json.kitVersion || '-' },
          { k: '安装形态', v: FORM_LABEL[json.form] || json.form || '-' },
          { k: '检出依据', v: json.evidence || '-' },
        ], [{ h: '项', v: 'k' }, { h: '值', v: 'v' }]),
      ]
      if (json.upgradeCommand) {
        lines.push('', '**升级命令（复制到终端执行）**', '', '```bash', json.upgradeCommand, '```')
      }
      if (json.guidance) lines.push('', json.guidance)
      if (json.restartHint) lines.push('', `- ${json.restartHint}`)
      lines.push('', WRITE_GATE, NO_TERMINAL_HINT)
      return lines.join('\n')
    },
  },

  {
    name: 'grape_kit_install',
    description:
      '装配 grape-kit 到本机宿主（opencode / workbuddy / codearts / officeace / dsh）：先只读检出各宿主当前装配状态，' +
      '已装配的跳过，只为未装配的生成 npx 安装命令。⚠️ 用户决策层：执行前必须向用户确认；本工具只生成命令、不执行。' +
      '实际装配命令形如 npx -y @grape-dev/grape-kit install --target <宿主>。',
    schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: [...HOST_TARGETS, 'all'],
          description: '目标宿主（缺省 all = 五宿主逐个处理）',
          default: 'all',
        },
      },
    },
    async run(a, { lifecycle: L = lifecycleModule } = {}) {
      return buildHostPlan('install', a?.target, L)
    },
    render: renderHostPlan,
  },

  {
    name: 'grape_kit_uninstall',
    description:
      '卸载本机宿主上的 grape-kit 装配：先只读检出，列出将被移除的配置条目与 skill 副本（只列不删），再生成卸载命令并附 --dry-run 预览指引。' +
      '⚠️ 用户决策层（强决策门）：卸载会移除宿主配置条目与 skill 副本，执行前必须向用户逐条确认影响范围；本工具只生成命令、不执行。',
    schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: [...HOST_TARGETS, 'all'],
          description: '目标宿主（缺省 all = 五宿主逐个处理）',
          default: 'all',
        },
      },
    },
    async run(a, { lifecycle: L = lifecycleModule } = {}) {
      return buildHostPlan('uninstall', a?.target, L)
    },
    render: renderHostPlan,
  },
]

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null
}

/** MCP tools/list 用的定义（strip 实现字段） */
export function toolDefs() {
  return TOOLS.map(({ name, description, schema }) => ({ name, description, inputSchema: schema }))
}
