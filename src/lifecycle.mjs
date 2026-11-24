/**
 * 自管理核心（Issue #27）——版本全景 / 更新检查 / 安装形态 / 宿主检出。
 *
 * 设计约束（Spec §2 §4）：
 * - **不 import `grape-kit.mjs`**（CLI 红线）：宿主路径与检出判定在本模块独立实现，
 *   与 CLI 侧函数**成对维护**。同步指针只写**函数名/常量名**（见 SYNC_POINTERS），不写行号——
 *   行号随 CLI 侧任何无关改动立刻漂移；名字的漂移风险（重命名/删除）由
 *   test/lifecycle.test.mjs 的 SYNC_POINTERS 校验 + 同夹具一致性断言（Spec §4.2）兜住。
 * - **纯函数 + 可注入依赖**：home / env / fetchImpl / spawnImpl / apiModule / now 全部可选注入，
 *   单测因此不读进程真实 HOME、不联网、不写真实 ~/.grape。
 * - **只读**：检出与版本聚合绝不落盘；唯一写路径是 `recordDismiss()`（Spec §3.2 的 dismiss 状态文件）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { api as defaultApi, grapeHome, getBaseUrl, npxCacheRoot, resolveCredentials } from './api.mjs'
import { isNewerVersion } from './update-check.mjs'

/** 五宿主标识：与 `grape-kit.mjs` 的 `SUPPORTED_TARGETS`（opencode/workbuddy/codearts/officeace/dsh）逐一对应 */
export const HOST_NAMES = ['opencode', 'workbuddy', 'codearts', 'officeace', 'dsh']

/** 检出状态四态：missing=没有配置文件；absent=文件在但无 grape 条目；installed=已装配；damaged=配置损坏 */
export const HOST_STATE = { MISSING: 'missing', ABSENT: 'absent', INSTALLED: 'installed', DAMAGED: 'damaged' }

/**
 * 成对维护清单（Spec §4.2）：本模块在 CLI 侧对应的源头符号。
 * 指针只登记**名字**——行号会随 grape-kit.mjs 的任何无关改动漂移（实测一次性 7/14 失准）；
 * 名字锚则能让 test/lifecycle.test.mjs 直接断言「CLI 侧这个函数/常量还在」，
 * 重命名或删除时立刻变红，逼着两侧同改。
 */
export const SYNC_POINTERS = [
  { symbol: 'SUPPORTED_TARGETS', kind: 'const', what: '五宿主标识（HOST_NAMES）' },
  { symbol: 'skipString', kind: 'function', what: 'jsonc 字符串跳过' },
  { symbol: 'stripComments', kind: 'function', what: 'jsonc 去注释' },
  { symbol: 'stripTrailingCommas', kind: 'function', what: 'jsonc 去尾随逗号' },
  { symbol: 'parseLoose', kind: 'function', what: 'jsonc 解析（含 BOM 处理口径）' },
  { symbol: 'opencodePaths', kind: 'function', what: 'opencode 配置/技能路径' },
  { symbol: 'workbuddyPaths', kind: 'function', what: 'workbuddy 配置/技能路径' },
  { symbol: 'codeartsPaths', kind: 'function', what: 'codearts 配置路径（含覆盖点）' },
  { symbol: 'codeartsConfigPath', kind: 'function', what: 'codearts 生效配置文件选取' },
  { symbol: 'officeacePaths', kind: 'function', what: 'officeace manifest 路径（含覆盖点）' },
  { symbol: 'dshPaths', kind: 'function', what: 'dsh patch/技能路径（含覆盖点）' },
  { symbol: 'DSH_BLOCK_START', kind: 'const', what: '托管块起始标记' },
  { symbol: 'DSH_BLOCK_END', kind: 'const', what: '托管块结束标记' },
  { symbol: 'findDshBlock', kind: 'function', what: '托管块定位（完整性判定）' },
  { symbol: 'isTopLevelSequence', kind: 'function', what: 'patch 顶层 YAML 序列自检' },
  { symbol: 'detectJsonEntry', kind: 'function', what: '纯 JSON 宿主条目检出（BOM 口径同源）' },
  { symbol: 'detectOpencode', kind: 'function', what: 'opencode 条目检出' },
  { symbol: 'detectDsh', kind: 'function', what: 'dsh 托管块检出' },
]

/* ── jsonc 解析（字符串感知去注释/尾随逗号） ──
 * 同步指针：与 `grape-kit.mjs` 的 skipString → stripComments → stripTrailingCommas → parseLoose 同语义、同顺序。
 * 检出只需「能否解析 + 有无条目」，故这里不复制 mcp 块的位置手术逻辑。 */

/** 跳过一个字符串字面量（i 指向开引号），返回闭引号下标；未闭合返回 -1（同步指针：grape-kit.mjs skipString） */
function skipString(text, i) {
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '"') return j
    j++
  }
  return -1
}

function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const e = skipString(text, i)
      if (e < 0) throw new Error('字符串未闭合')
      out += text.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue }
    out += c
    i++
  }
  return out
}

function stripTrailingCommas(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const e = skipString(text, i)
      if (e < 0) throw new Error('字符串未闭合')
      out += text.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

/** jsonc 结构解析：去 BOM/注释/尾随逗号；失败抛出可读错误（检出报 damaged 用） */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(String(text).replace(/^\uFEFF/, ''))))
}

/* ── 宿主路径单源（与 grape-kit.mjs 成对维护；路径变更必须两侧同改） ── */

/** 同步指针：grape-kit.mjs opencodePaths() */
function opencodePaths(home) {
  return {
    config: join(home, '.config', 'opencode', 'opencode.jsonc'),
    configAlt: join(home, '.config', 'opencode', 'opencode.json'),
    skillsDir: join(home, '.config', 'opencode', 'skills'),
  }
}

/** 同步指针：grape-kit.mjs workbuddyPaths() */
function workbuddyPaths(home) {
  return {
    mcpJson: join(home, '.workbuddy', 'mcp.json'),
    skillsDir: join(home, '.workbuddy', 'skills'),
  }
}

/** 同步指针：grape-kit.mjs codeartsPaths() / codeartsConfigPath()（GRAPE_CODEARTS_CONFIG 覆盖点同源） */
function codeartsPaths(home, env) {
  const override = String(env.GRAPE_CODEARTS_CONFIG || '').trim()
  const config = join(home, '.codeartsdoer', 'codearts_cli.jsonc')
  const configAlt = join(home, '.codeartsdoer', 'codearts_cli.json')
  const picked = override || (existsSync(config) ? config : existsSync(configAlt) ? configAlt : config)
  return { override, config, configAlt, path: picked }
}

/** 同步指针：grape-kit.mjs officeacePaths()（GRAPE_OFFICEACE_MANIFEST 覆盖点同源） */
function officeacePaths(home, env) {
  const override = String(env.GRAPE_OFFICEACE_MANIFEST || '').trim()
  return { manifest: override || join(home, '.officeace', 'mcp.json') }
}

/** 同步指针：grape-kit.mjs dshPaths()（DSH_HOME / GRAPE_DSH_PATCH 覆盖点同源） */
function dshPaths(home, env) {
  const dshHome = String(env.DSH_HOME || '').trim() || join(home, '.dsh')
  const override = String(env.GRAPE_DSH_PATCH || '').trim()
  return {
    home: dshHome,
    patch: override || join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    skillsDir: join(dshHome, 'skills'),
  }
}

/* ── 托管块标记（同步指针：grape-kit.mjs DSH_BLOCK_START / DSH_BLOCK_END） ── */
const DSH_BLOCK_START = '# Grape Kit DSH integration start'
const DSH_BLOCK_END = '# Grape Kit DSH integration end'

const markerRe = (marker) => new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(?:\\r?\\n|$)`, 'm')

/** 托管块定位：{ start, end, complete }；无起始标记返回 null（同步指针：grape-kit.mjs findDshBlock） */
function findDshBlock(text) {
  const m = markerRe(DSH_BLOCK_START).exec(text)
  if (!m) return null
  const afterStart = m.index + m[0].length
  const em = markerRe(DSH_BLOCK_END).exec(text.slice(afterStart))
  if (!em) return { start: m.index, end: text.length, complete: false }
  return { start: m.index, end: afterStart + em.index + em[0].length, complete: true }
}

/** 顶层 YAML 序列自检（同步指针：grape-kit.mjs isTopLevelSequence） */
function isTopLevelSequence(text) {
  const first = text.split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#') && l !== '---' && !l.startsWith('%'))
  return first === undefined || first.startsWith('- ')
}

const row = (host, state, path, extra = {}) => ({
  host, label: host, state, path, installed: state === HOST_STATE.INSTALLED, ...extra,
})

/** 纯 JSON 宿主（mcpServers 容器）：同步指针：grape-kit.mjs detectJsonEntry
 *  BOM 口径**照抄 CLI 的非对称**（Spec §4.2 要防的就是这种分歧）：纯 JSON 通道 CLI 直接
 *  `JSON.parse(readFileSync(file,'utf8'))`、不剥 BOM → BOM 配置报 damaged；jsonc 通道的
 *  parseLoose 剥 BOM → BOM 的 jsonc 仍可解析。这里若「好心」剥 BOM，就会出现
 *  lifecycle=installed / doctor=damaged 的两侧分歧（AGENTS 已点名 BOM 是本仓现实风险）。 */
function detectJsonEntry(file, rootKey, name, { loose, host, skillsDir, entryLabel }) {
  if (!existsSync(file)) return row(host, HOST_STATE.MISSING, file, { skillsDir, entry: entryLabel })
  let cfg
  try {
    cfg = loose ? parseJsonc(readFileSync(file, 'utf8')) : JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return row(host, HOST_STATE.DAMAGED, file, { skillsDir, entry: entryLabel, error: e.message })
  }
  const container = cfg?.[rootKey]
  const ok = !!(container && typeof container === 'object' && container[name])
  return row(host, ok ? HOST_STATE.INSTALLED : HOST_STATE.ABSENT, file, {
    skillsDir, entry: entryLabel, evidence: ok ? `${entryLabel} 条目存在于 ${file}` : `未发现 ${entryLabel} 条目`,
  })
}

/** opencode：候选 .jsonc 优先、.json 回落；两者可同时存在，任一含 grape 条即装配（同步指针：grape-kit.mjs detectOpencode） */
function detectOpencode({ home }) {
  const p = opencodePaths(home)
  const first = existsSync(p.config) ? p.config : p.configAlt
  const candidates = [first, ...(first === p.config ? [p.configAlt] : [])].filter(existsSync)
  if (!candidates.length) return row('opencode', HOST_STATE.MISSING, first, { skillsDir: p.skillsDir, entry: 'mcp.grape' })
  let error, errorPath
  for (const f of candidates) {
    let cfg
    try { cfg = parseJsonc(readFileSync(f, 'utf8')) } catch (e) { error = e.message; errorPath = f; continue }
    if (cfg?.mcp?.grape) {
      return row('opencode', HOST_STATE.INSTALLED, f, {
        skillsDir: p.skillsDir, entry: 'mcp.grape', evidence: `mcp.grape 条目存在于 ${f}`,
      })
    }
  }
  if (error) return row('opencode', HOST_STATE.DAMAGED, errorPath, { skillsDir: p.skillsDir, entry: 'mcp.grape', error })
  return row('opencode', HOST_STATE.ABSENT, first, { skillsDir: p.skillsDir, entry: 'mcp.grape', evidence: '未发现 mcp.grape 条目' })
}

/** dsh：托管块 + `- id: grape-kit`（同步指针：grape-kit.mjs detectDsh） */
function detectDsh({ home, env }) {
  const p = dshPaths(home, env)
  const base = { skillsDir: p.skillsDir, entry: '托管块 id: grape-kit' }
  if (!existsSync(p.patch)) return row('dsh', HOST_STATE.MISSING, p.patch, base)
  const text = readFileSync(p.patch, 'utf8')
  const block = findDshBlock(text)
  if (!block) return row('dsh', HOST_STATE.ABSENT, p.patch, { ...base, evidence: '未发现托管块标记' })
  if (!block.complete) return row('dsh', HOST_STATE.DAMAGED, p.patch, { ...base, error: '托管块不完整（缺少结束标记）' })
  if (!isTopLevelSequence(text)) return row('dsh', HOST_STATE.DAMAGED, p.patch, { ...base, error: '顶层不是 YAML 序列（托管块无法安全追加）' })
  const ok = text.slice(block.start, block.end).includes('- id: grape-kit')
  return row('dsh', ok ? HOST_STATE.INSTALLED : HOST_STATE.ABSENT, p.patch, {
    ...base, evidence: ok ? `托管块存在于 ${p.patch}` : '托管块存在但无 id: grape-kit',
  })
}

/**
 * 五宿主只读检出（Spec §3.4 / §4.2）。
 * @param {{home?: string, env?: object}} [opts] home/env 可注入——单测据此用临时目录夹具，不读真实 HOME
 * @returns {Array<{host:string,label:string,state:string,installed:boolean,path:string,entry:string,skillsDir?:string,evidence?:string,error?:string}>}
 */
export function detectHostStatus({ home = homedir(), env = process.env } = {}) {
  const ca = codeartsPaths(home, env)
  const oa = officeacePaths(home, env)
  const wb = workbuddyPaths(home)
  return [
    detectOpencode({ home }),
    detectJsonEntry(wb.mcpJson, 'mcpServers', 'grape-kit', {
      loose: false, host: 'workbuddy', skillsDir: wb.skillsDir, entryLabel: 'mcpServers.grape-kit',
    }),
    detectJsonEntry(ca.path, 'mcp', 'grape-kit', {
      loose: true, host: 'codearts', skillsDir: '', entryLabel: 'mcp.grape-kit',
    }),
    detectJsonEntry(oa.manifest, 'mcpServers', 'grape-kit', {
      loose: false, host: 'officeace', skillsDir: '', entryLabel: 'mcpServers.grape-kit',
    }),
    detectDsh({ home, env }),
  ]
}

/** kit 包根目录（本文件在 <pkg>/src/ 下）——安装形态判定与版本读取同源 */
export const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

/* ── S2：安装形态判定（Spec §3.3） ──
 * 只读推断「这个 kit 是怎么装进来的」，据此给升级命令；形态未知/本地依赖时不给命令，只给手动指引——
 * 自动挑包管理器或版本范围属于替用户做决定。 */

export const INSTALL_FORM = { GLOBAL: 'global', NPX: 'npx', CLAWHUB: 'clawhub', LOCAL: 'local', UNKNOWN: 'unknown' }

const RESTART_HINT = '升级/安装完成后需重启宿主会话（opencode / CodeArts / WorkBuddy / dsh 等）才加载新版本'

const formOf = (form, extra) => {
  const base = { form, restartHint: RESTART_HINT, ...extra }
  switch (form) {
    case INSTALL_FORM.GLOBAL:
      return { ...base, upgradeCommand: 'npm i -g @grape-dev/grape-kit',
        guidance: '全局安装形态：执行上面的 npm i -g 升级；升级后重启宿主会话。' }
    case INSTALL_FORM.NPX:
      return { ...base, upgradeCommand: 'npx -y -p @grape-dev/grape-kit@latest grape-kit-mcp',
        guidance: 'npx 缓存运行形态：上面的命令强制拉 @latest；也可转全局安装（npm i -g @grape-dev/grape-kit）后改用本地脚本入口。' }
    case INSTALL_FORM.CLAWHUB:
      return { ...base, upgradeCommand: null,
        guidance: 'ClawHub 市场安装形态：在 ClawHub 上重装/更新 grape-kit 插件（clawhub.ai/grape-dev/plugins/grape-kit），升级后重启宿主会话。' }
    case INSTALL_FORM.LOCAL:
      return { ...base, upgradeCommand: null,
        guidance: '项目本地依赖形态：用项目自身的包管理器升级（npm i @grape-dev/grape-kit@latest，pnpm/yarn 同理），或改 package.json 版本后重装——版本范围由你的项目决定。' }
    default:
      return { ...base, upgradeCommand: null,
        guidance: '未识别安装形态：可执行 npm i -g @grape-dev/grape-kit 全局升级，或 npx -y @grape-dev/grape-kit@latest 直接运行最新版；两者都不改变现状，需你确认。' }
  }
}

/**
 * 安装形态判定（纯函数）。
 * @param {{pkgPath?: string, env?: object, platform?: string}} [opts]
 *   pkgPath 缺省为本包目录（import.meta 同源）；env/platform 可注入以便跨平台单测
 */
export function detectInstallForm({ pkgPath = KIT_ROOT, env = process.env, platform = process.platform } = {}) {
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const lower = (p) => (platform === 'win32' ? norm(p).toLowerCase() : norm(p))
  const path = norm(pkgPath)
  const pathL = lower(pkgPath)

  const explicit = String(env.GRAPE_KIT_INSTALL_FORM || '').trim().toLowerCase()
  if (Object.values(INSTALL_FORM).includes(explicit)) {
    return formOf(explicit, { pkgPath: path, evidence: `env:GRAPE_KIT_INSTALL_FORM=${explicit}` })
  }

  // npx 缓存运行：根目录与 api.mjs 的 npxCacheRoot() 单源（Windows 在 %LocalAppData%\npm-cache\_npx）；
  // 另认 `_npx` 路径形状——npx 缓存根由 homedir() 推导，宿主 env 被清洗（HOME 不生效）时形状匹配仍成立
  const npxRoot = norm(npxCacheRoot(env, platform))
  const npxRootHit = npxRoot && pathL.startsWith(`${lower(npxRoot)}/`)
  if (npxRootHit || pathL.includes('/_npx/')) {
    return formOf(INSTALL_FORM.NPX, { pkgPath: path, evidence: `包路径位于 npx 缓存 ${npxRootHit ? npxRoot : '_npx'} 下（npx 临时安装，非全局）` })
  }

  const clawhub = String(env.CLAWHUB_HOME || '').trim()
  if (/clawhub/i.test(path) || (clawhub && pathL.startsWith(`${lower(clawhub)}/`))) {
    return formOf(INSTALL_FORM.CLAWHUB, { pkgPath: path, evidence: '包路径位于 ClawHub 安装目录下' })
  }

  // 全局前缀：npm 的 prefix 覆盖点优先，其次按平台已知前缀形状匹配
  const prefix = String(env.npm_config_global_prefix || env.npm_config_prefix || '').trim()
  const globalMarkers = ['/lib/node_modules/', '/appdata/roaming/npm/node_modules/', '/npm-global/', '/.bun/install/global/node_modules/']
  const isNpmPrefix = prefix && pathL.startsWith(`${lower(prefix)}/node_modules/`)
  if (isNpmPrefix || globalMarkers.some((m) => pathL.includes(m))) {
    return formOf(INSTALL_FORM.GLOBAL, {
      pkgPath: path,
      evidence: isNpmPrefix ? `包路径位于 npm 全局前缀 ${prefix} 下` : '包路径位于 npm/node 全局前缀（lib/node_modules 或 %APPDATA%\\npm）下',
    })
  }

  if (pathL.includes('/node_modules/')) {
    return formOf(INSTALL_FORM.LOCAL, { pkgPath: path, evidence: '包路径位于项目 node_modules 下（非 npx 缓存、非全局前缀）' })
  }

  return formOf(INSTALL_FORM.UNKNOWN, { pkgPath: path, evidence: '包路径不符合已知安装形态（全局 / npx / ClawHub / 项目依赖）' })
}

/* ── S3：dismiss（拒绝更新）3 天冷却（Spec §3.2） ──
 * 独立状态文件 ~/.grape/grape-kit-dismiss.json（{ version, at }）：
 * 被动提醒（update-check.mjs 的 24h 缓存）与主动查询语义解耦——本模块不读写那份缓存，
 * 只 import 其 semver 纯函数。冷却只对**同一版本**生效：出现新版本立即重新提醒。 */

export const DISMISS_COOLDOWN_MS = 3 * 24 * 3600 * 1000

/** dismiss 状态文件路径：与凭据/缓存同根（api.mjs 的 grapeHome 单源） */
export function dismissStatePath({ env = process.env } = {}) {
  return join(grapeHome(env), 'grape-kit-dismiss.json')
}

/** 读 dismiss 状态；文件缺失/损坏/形状不对一律 null（按「从未拒绝过」处理，冷却绝不误判） */
export function readDismissState({ env = process.env, file } = {}) {
  const target = file || dismissStatePath({ env })
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8').replace(/^\uFEFF/, ''))
    const version = typeof raw?.version === 'string' ? raw.version.trim() : ''
    const at = Number(raw?.at)
    if (!version || !Number.isFinite(at)) return null
    return { version, at }
  } catch {
    return null
  }
}

/** 记录拒绝的版本（唯一写路径：3 天冷却的状态落盘）；目录不存在则创建 */
export function recordDismiss(version, { env = process.env, file, now = Date.now() } = {}) {
  const target = file || dismissStatePath({ env })
  const state = { version: String(version ?? '').trim(), at: now }
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(state))
  } catch { /* 落盘失败不阻断查询结果（下次仍会提醒，属可接受的降级） */ }
  return { ...state, file: target }
}

/**
 * 更新判定（纯函数，无 IO）：把 npm latest、本地版本与 dismiss 状态合成一个结论。
 * state：newer（应提醒）/ latest（已是最新）/ dismissed（同版本冷却期内，不打扰）/ unavailable（查不到）
 */
export function updateDecision({
  currentVersion, latestVersion, dismissState = null, now = Date.now(), cooldownMs = DISMISS_COOLDOWN_MS,
} = {}) {
  const current = String(currentVersion ?? '').trim()
  const latest = String(latestVersion ?? '').trim()
  const base = { currentVersion: current, latestVersion: latest }
  if (!latest) return { ...base, state: 'unavailable', updateAvailable: false, dismissed: false }
  if (!isNewerVersion(latest, current)) return { ...base, state: 'latest', updateAvailable: false, dismissed: false }
  const at = Number(dismissState?.at)
  const dismissedNow = dismissState?.version === latest && Number.isFinite(at) && now - at < cooldownMs
  if (dismissedNow) {
    return {
      ...base, state: 'dismissed', updateAvailable: false, dismissed: true,
      dismissedAt: at, cooldownUntil: at + cooldownMs,
    }
  }
  return { ...base, state: 'newer', updateAvailable: true, dismissed: false }
}

/* ── S4：版本全景（Spec §3.1） ──
 * 一次返回 kit 本地版本 / npm latest / 更新可用性 / grape CLI / 服务端连通性与契约版本 / 凭据来源。
 * 每个外部通道都 best-effort：单一通道失败只把该字段降级为 unavailable，不阻塞其余字段。
 * 幂等只读：本函数不写任何缓存（被动提醒的 24h 缓存归 update-check.mjs，语义解耦）。 */

const NPM_REGISTRY = 'https://registry.npmjs.org'
const REGISTRY_TIMEOUT_MS = 5000
const CLI_HINT = '未安装（可选：pip install git+https://gitcode.com/grape-dev/grape-cli.git）'

/** 本地 kit 版本：与 src/server.mjs 同源（包根 package.json） */
export function readKitVersion() {
  try {
    return JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}

/**
 * npm registry latest（5s 有界超时；任何失败返回 ''，调用方自行降级为 unavailable）。
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  try {
    const r = await fetchImpl(`${NPM_REGISTRY}/@grape-dev/grape-kit/latest`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r || !r.ok) return ''
    const d = await r.json()
    return d && typeof d.version === 'string' ? d.version.trim() : ''
  } catch {
    return ''
  }
}

/** 凭据来源摘要：只给来源与档位，绝不含 token 明文（AGENTS 红线） */
export function credentialSummary(env = process.env) {
  const c = resolveCredentials(env)
  const configured = !!c.token
  const source = c.sourceKind === 'runtime'
    ? '一次性 env GRAPE_API_TOKEN_ONCE'
    : c.sourceKind === 'env'
      ? '环境变量 GRAPE_API_TOKEN'
      : c.sourceKind === 'file'
        ? `文件 ${String(c.source).slice('file:'.length)}`
        : ''
  return {
    configured,
    sourceKind: c.sourceKind || '',
    source,
    hint: configured ? '' : '未配置凭据：export GRAPE_API_TOKEN=grape_你的Key（或写入 ~/.grape/config.json，或用 npx -y @grape-dev/grape-kit auth init 写文件通道）',
  }
}

/** grape CLI 探测：v0.3.0 起原生 HTTP 直连，CLI 仅 401 回退通道——缺失是提示，不是失败 */
function probeGrapeCli({ env = process.env, spawnImpl = nodeSpawnSync } = {}) {
  const bin = String(env.GRAPE_CLI_BIN || '').trim() || 'grape'
  try {
    const r = spawnImpl(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    const version = String(r?.stdout ?? '').trim()
    if (r && r.status === 0) return { status: 'ok', bin, version }
  } catch { /* 未装/不可执行 → 走 missing */ }
  return { status: 'missing', bin, version: '', hint: CLI_HINT }
}

/** 服务端：连通性（api 既有只读调用）+ 契约版本（openapi.json 的 info.version，404/不可达则省略） */
async function probeServer({ env = process.env, fetchImpl = fetch, apiModule, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const baseUrl = getBaseUrl(env)
  const out = { baseUrl, reachable: false }
  const A = apiModule || defaultApi
  // 无凭据时连通性判定必是 401「缺 token」——那不等于「服务端不可达」，
  // 直接跳过鉴权探测并标注未探测（真正的原因在 credentials 行），契约端点照常尽力探测。
  if (!resolveCredentials(env).token) {
    out.probe = 'skipped'
    out.reason = '未配置凭据，跳过连通性探测（需鉴权的只读调用必 401，不代表服务端不可达）'
  } else {
    try {
      await A.scenesMarket()
      out.reachable = true
    } catch (e) {
      out.error = String(e?.message || e)
      if (e?.hint) out.hint = String(e.hint)
    }
  }
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/static/openapi.json`, { signal: AbortSignal.timeout(timeoutMs) })
    if (r && r.ok) {
      const d = await r.json()
      const v = d?.info?.version
      if (v) out.contractVersion = String(v)
    }
  } catch { /* 契约版本是加分项：拿不到就省略，不报错误值 */ }
  return out
}

/** 更新提示文案（按判定分行；dismiss 冷却期内不再说「有新版本」） */
export function updateNoticeFor(decision) {
  switch (decision.state) {
    case 'newer':
      return `有新版本 ${decision.currentVersion} → ${decision.latestVersion}（npm i -g @grape-dev/grape-kit 更新；npx 用户下次拉取即最新）`
    case 'dismissed':
      return `${decision.latestVersion} 已被用户忽略，冷却至 ${new Date(decision.cooldownUntil).toISOString()}（新版本出现会重新提醒）`
    case 'latest':
      return `已是最新（${decision.currentVersion}）`
    default:
      return '检测不可用（npm registry 不可达或响应异常），不影响工具可用性'
  }
}

/**
 * 版本全景聚合（只读）。
 * @param {{
 *   pkgVersion?: string, env?: object, fetchImpl?: Function, spawnImpl?: Function,
 *   apiModule?: object, now?: number, timeoutMs?: number
 * }} [opts]
 */
export async function aggregateVersion({
  pkgVersion, env = process.env, fetchImpl = fetch, spawnImpl = nodeSpawnSync,
  apiModule, now = Date.now(), timeoutMs = REGISTRY_TIMEOUT_MS,
} = {}) {
  const kitVersion = pkgVersion || readKitVersion()
  const [latestVersion, server] = await Promise.all([
    fetchLatestVersion({ fetchImpl, timeoutMs }),
    probeServer({ env, fetchImpl, apiModule, timeoutMs }),
  ])
  const decision = updateDecision({ currentVersion: kitVersion, latestVersion, now })
  return {
    kitVersion,
    latestVersion,
    updateAvailable: decision.updateAvailable,
    updateState: decision.state,
    updateNotice: updateNoticeFor(decision),
    grapeCli: probeGrapeCli({ env, spawnImpl }),
    server,
    credentials: credentialSummary(env),
    checkedAt: new Date(now).toISOString(),
  }
}

/**
 * 主动更新检查（Spec §3.2）：npm 直查 + dismiss 冷却合成一条结论。
 * dismiss=true 是**唯一**写路径（本地 dismiss 状态文件），不涉及服务端或宿主配置。
 * @param {{pkgVersion?: string, env?: object, fetchImpl?: Function, now?: number,
 *   dismiss?: boolean, dismissVersion?: string, timeoutMs?: number}} [opts]
 */
export async function checkForUpdate({
  pkgVersion, env = process.env, fetchImpl = fetch, now = Date.now(),
  dismiss = false, dismissVersion, timeoutMs = REGISTRY_TIMEOUT_MS,
} = {}) {
  const currentVersion = pkgVersion || readKitVersion()
  const latestVersion = await fetchLatestVersion({ fetchImpl, timeoutMs })
  let state = readDismissState({ env })
  let recorded = null
  if (dismiss) {
    // dismissVersion 显式指定优先：registry 不可达时用户点名的版本同样能记住
    const target = String(dismissVersion || latestVersion || currentVersion).trim()
    if (target) {
      recorded = recordDismiss(target, { env, now })
      state = { version: recorded.version, at: recorded.at }
    }
  }
  const decision = updateDecision({ currentVersion, latestVersion, dismissState: state, now })
  return { ...decision, updateNotice: updateNoticeFor(decision), dismiss: recorded }
}
