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
import { hostname } from 'node:os'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipDirectory } from './zip.mjs'
import { api, apiRequest, getBaseUrl, AGENT_TYPES, normalizeTriggerAgent, GrapeApiError } from './api.mjs'

/** kit 安装根（发布包含 skills/，Node 版接管脚本随 skill 副本分发） */
const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const fillCwd = (text, cwd) => String(text ?? '').replaceAll('{{CWD}}', cwd)
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

const str = (desc) => ({ type: 'string', description: desc })
const num = (desc) => ({ type: 'number', description: desc })
const bool = (desc) => ({ type: 'boolean', description: desc })

const WARNING_HINTS = {
  remote_may_still_run: '远程分支可能已被云端 worker 推送并开过 MR：先查远端分支与 issue/MR，避免破坏性强推（分支/MR 冲突必须先裁决）。',
  node_already_advanced: '链已交棒至下一节点：本次接管与下一节点并行，交回前先看 issue 事件，避免重复实现。',
  next_node_pending_dispatch: '下一节点未被派发：确认远端/节点状态后调 grape_trigger_pipeline(agent=…) 补发，或用 grape_takeover_status 复查会话。',
}
const warningHint = (w) => WARNING_HINTS[String(w).split(':')[0].trim()] || ''

/* ── Issue #19：交回后按场景链确保下一节点被派发（「链不断」不能只在描述里） ── */

/**
 * 客户端兜底派发的范围：**仅** Spec 指定的 coding→qa。
 * vod→issue / issue→coding / qa→sre 的派发行为属其它节点，Spec「Out of Scope」明确排除——
 * 这里不留宽：场景链外扩会让 qa 交回自动派发 sre，越界且副作用不可撤回。
 */
const DISPATCH_SCOPE = { coding: 'qa' }

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
function resolveNextTarget(json = {}) {
  const sess = json.session || {}
  const rj = resultJsonOf(json)
  const declared = [json.next_agent, sess.next_agent, rj.next_agent]
    .map((v) => String(v ?? '').trim())
    .find(Boolean)
  if (declared !== undefined) {
    const agent = asAgentType(declared)
    return agent ? { agent, unknown: '' } : { agent: '', unknown: declared }
  }
  const stepAgent = asAgentType(rj.next_step)
  if (stepAgent) return { agent: stepAgent, unknown: '' }
  const current = asAgentType(sess.agent_type) || asAgentType(json.agent_type)
  return { agent: DISPATCH_SCOPE[current] || '', unknown: '' }
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
  let base = json && typeof json === 'object' ? json : { raw: json }
  let sess = base.session || {}
  const { agent: nextAgent, unknown: unknownNextAgent } = resolveNextTarget(base)
  let current = asAgentType(sess.agent_type) || asAgentType(base.agent_type)
  const nextSeq = seqOf(base, 'next_seq')
  const handoffSeq = seqOf(base, 'handoff_seq')
  let target = resolveDispatchTarget(base, args)
  // 交回响应常常不带仓库/issue 标识（实测 shape：next_agent + handoff_seq，无 repo_key），
  // 于是兜底派发误判「缺少仓库/issue 标识」→ 假警报 pending_dispatch（测试报告 P6）。
  // 会话记录里 repo_key/issue_number 是权威的：缺标识时回读一次会话再解析，不靠猜测。
  const sid = String(base.session?.id || base.session_id || args.session_id || '').trim()
  if ((!target.owner || !target.repo || !target.issue_number) && sid && typeof apiMod?.takeoverGet === 'function') {
    try {
      const fresh = await apiMod.takeoverGet(sid)
      const s = fresh?.session || fresh || {}
      base = { ...base, session: { ...sess, ...s } }
      sess = base.session
      // 会话记录是活跃节点的权威来源：回读后重算，避免交回响应缺 agent_type 时误判「兜底范围外」
      current = asAgentType(sess.agent_type) || asAgentType(base.agent_type) || current
    } catch { /* 读不到会话就保留原判：仍按 no_target 显式告警 */ }
    target = resolveDispatchTarget(base, args)
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
  if (nextSeq > 0) {
    // next_seq 指向平台已写入的下一节点派发事件：重复派发会重跑下一节点，跳过
    return {
      ...base,
      next_agent: nextAgent || base.next_agent || '',
      next_seq: nextSeq,
      dispatch: { status: 'already_dispatched', agent: nextAgent, seq: nextSeq, warnings: [] },
    }
  }
  if (unknownNextAgent) {
    // 平台给了白名单外的节点名：不是「平台未给」，不得按场景链改写为 qa 顶掉平台决定
    return {
      ...base,
      next_agent: unknownNextAgent,
      next_seq: 0,
      pending_dispatch: { agent: unknownNextAgent, ...target, reason: `平台指定的下一节点「${unknownNextAgent}」不在已知节点内，未按场景链改写` },
      dispatch: {
        status: 'pending', agent: unknownNextAgent, seq: 0, cause: 'unknown_next_agent',
        warnings: [`next_node_pending_dispatch: 平台指定的下一节点「${unknownNextAgent}」不在已知节点（${AGENT_TYPES.join('/')}）内，未按场景链改写、未派发，需人工裁决`],
      },
    }
  }
  if (!nextAgent) {
    // 场景链尾（如 sre）或平台未指定下一节点：不是故障，无需派发
    return { ...base, next_agent: '', next_seq: 0, dispatch: { status: 'no_next_node', agent: '', seq: 0, warnings: [] } }
  }
  if (DISPATCH_SCOPE[current] !== nextAgent) {
    // 兜底范围外（vod/issue/qa 等节点）：不改其它节点派发行为，只如实披露
    return {
      ...base,
      next_agent: nextAgent,
      next_seq: 0,
      dispatch: { status: 'out_of_scope', agent: nextAgent, seq: 0, warnings: [] },
    }
  }
  // handoff_seq>0 而 next_seq=0：交回事件已写、派发未证实，按未派发处理并留痕
  const unconfirmed = handoffSeq > 0
    ? `handoff_seq=${handoffSeq} 仅为交回事件序号、未见派发指针 next_seq：按「交回已写、派发未证实」兜底补发`
    : ''
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
  // 派发前先看平台事实：finish 回执常常只给 next_agent+handoff_seq，而平台其实已派发
  // （实测 #22908 qa 已 running）。查事件确认已派发就只报事实，不再客户端补发——
  // 既消掉假警报（测试报告 P6），也避免同一节点被重复派发跑两遍。
  const sinceSeq = handoffSeq || seqOf(base, 'seq')
  const platformSeq = await findDispatchedSeq(apiMod, target, nextAgent, sinceSeq)
  if (platformSeq) {
    return {
      ...base,
      next_agent: nextAgent,
      next_seq: platformSeq,
      dispatch: { status: 'already_dispatched', agent: nextAgent, seq: platformSeq, verified_by: 'issue_events', warnings: unconfirmed ? [unconfirmed] : [] },
    }
  }
  try {
    const r = await apiMod.triggerPipeline(target.owner, target.repo, target.issue_number, dispatchContext(base, nextAgent), nextAgent)
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
      dispatch: { status: 'dispatched', agent: nextAgent, seq, warnings: unconfirmed ? [unconfirmed] : [] },
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

/** 检出状态的人类可读标签（damaged 必须显式「先修复」，否则用户会照装一遍再踩同样的坑） */
const STATE_LABEL = {
  installed: '已装配',
  absent: '未装配（文件在、无条目）',
  missing: '未装配（无配置文件）',
  damaged: '配置损坏（先修复）',
}

const WRITE_GATE = '⚠️ 决策门：以上命令只生成、未执行。请先把命令块与影响范围交给用户确认，确认后再执行（可随时 Ctrl-C 打断）。'
const NO_TERMINAL_HINT = '无终端工具的宿主：把命令与需要编辑的文件路径原样给用户，由用户手动执行/编辑。'

/**
 * install / uninstall 共用的计划构建：逐宿主只读检出 → 需要动作的宿主才生成命令。
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
    const r = rows.find((x) => x.host === host) || { host, state: 'missing', installed: false, path: '', skillsDir: '', entry: '' }
    const needsAction = action === 'install' ? !r.installed : !!r.installed
    return {
      host,
      state: r.state || 'missing',
      path: r.path || '',
      entry: r.entry || '',
      skillsDir: r.skillsDir || '',
      installed: !!r.installed,
      evidence: r.evidence || r.error || '',
      command: needsAction ? `npx -y @grape-dev/grape-kit ${action} --target ${host}` : '',
    }
  })
  const active = hosts.filter((h) => h.command)
  const plan = {
    action,
    target,
    hosts,
    commands: active.map((h) => h.command),
    skipped: hosts.filter((h) => !h.command).map((h) => h.host),
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
    lines.push('', '_本次没有需要生成的命令（目标宿主均为相反状态）。_')
  }
  lines.push('', isUninstall
    ? '⚠️ 强决策门：卸载会移除宿主配置条目与 skill 副本（不可自动回滚），以上命令只生成、未执行——执行前必须向用户逐条确认影响范围。'
    : '⚠️ 决策门：安装会改写宿主 MCP 配置（installer 自带备份），以上命令只生成、未执行——执行前必须向用户确认目标宿主。',
  NO_TERMINAL_HINT)
  return lines.join('\n')
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
        const body = String(json.content ?? json.skill_md ?? json.description ?? '')
        return `### ${json.name ?? json.skill_id ?? ''}\n\n${body.slice(0, 3000)}`
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
      '⚠️ push 能力边界：tko_ 仅 repo_session 能力，**不含 git 凭据注入**；洁净机器的回推路径见返回体。' +
      '⚠️ 需要平台支持 takeover API（404/无该工具能力时回退 grape_takeover_context + cancel 老路径）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        number: num('issue 编号'),
        agent_type: str('要接管的节点（可选，默认当前运行节点，如 coding）'),
      },
      required: ['owner', 'repo', 'number'],
    },
    async native(a) { return api.takeoverStart(a.owner, a.repo, a.number, a.agent_type) },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `接管发起失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const sid = json.takeover_id ?? json.session_id ?? json.id ?? ''
      const b = json.bundle || {}
      const env = b.env || {}
      const lines = ['### 接管会话已建立', '']
      lines.push(`- 会话: \`${sid}\`${json.reused ? '（复用已有会话）' : ''}`)
      if (env.GRAPE_SESSION_TOKEN) lines.push(`- 接管凭据: \`${String(env.GRAPE_SESSION_TOKEN).slice(0, 8)}…\`（完整值在 env.GRAPE_SESSION_TOKEN，12h TTL）`)
      if (b.task && b.task.id) lines.push(`- 让渡的云端任务: ${b.task.id}（已停止）`)
      if (json.token_expires_at) lines.push(`- 凭据到期 epoch: ${json.token_expires_at}`)
      const ws = b.workspace || {}
      const cwd = String(ws.cwd_hint || process.cwd())
      if (ws.cwd_hint) lines.push(`- 本地工作目录: ${ws.cwd_hint}`)
      if (env.GRAPE_AUTH_FILE) lines.push(`- 凭据文件（路径占位符已渲染）: ${fillCwd(env.GRAPE_AUTH_FILE, cwd)}`)
      lines.push('', '**push 能力边界（先读）**', '')
      lines.push('- `tko_` 只覆盖 repo_session：可继续该节点工作、回报进度、`request-finish`；**不含 git 凭据注入**，不能直接 push。')
      lines.push('- 本机已有用户级凭据（`grape git` 注入 / 自有 PAT / SSH key）→ 正常 commit & push；洁净机器必须先由用户配置其中一种。')
      lines.push('- 洁净机器回推路径：① 用户在本机配置用户级 PAT 或 SSH key；② `grape git push origin <branch>`（凭据注入通道）；③ 或让用户在其已有凭据的机器上推送同一提交。不要假设 tko_ 能 push。')
      const bundleScripts = renderBundleScripts(b.assets?.scripts ?? b.scripts, cwd)
      if (bundleScripts) {
        lines.push('', '**接管脚本（平台渲染，路径占位符已本地替换为实际路径）**', '', '```bash', ...bundleScripts, '```')
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
      'finished + next_agent 有值 + 派发指针 next_seq=0 即「交回已写、派发未证实」（仅有 handoff_seq 时同样不判已派发），渲染给出目标/原因/补发指引。' +
      '判据注明：客户端兜底派发只写事件、不回填会话记录的 next_seq，故 next_seq=0 不构成「未派发」证据——需查事件核实（grape_get_issue_events）后再决定是否补发。',
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
       * 已结束会话的 durable 事实只有会话字段本身。判据与 finish 同口径——**派发指针是 next_seq**：
       * next_seq>0 即已派发；next_seq=0 时 handoff_seq 只是平台侧「交回事件序号」，不作派发证据，
       * 仅有 handoff_seq 时措辞降级为「交回事件已写、派发未证实，请核实事件」。 */
      const nextA = String(sess.next_agent ?? '').trim()
      // 判据与 finish 同源：一律走 seqOf（session 优先、仅 nullish 回落顶层），不再各自重算——
      // 内联 `Number(sess.next_seq ?? json.next_seq)` 与 seqOf 两套取值顺序迟早漂移成互斥结论。
      const nextSeq = seqOf(json, 'next_seq')
      const handoffSeq = seqOf(json, 'handoff_seq')
      const finished = String(sess.status).toLowerCase() === 'finished'
      const issue = issueLabel(sess)
      if (finished && nextA && nextSeq > 0) {
        lines.push('', `- 下一节点 ${nextA} 已派发（next_seq=${nextSeq}）：派发指针成立`)
      }
      if (finished && nextA && !nextSeq) {
        const repoKey = String(sess.repo_key ?? '').split(':').pop()
        const warns = Array.isArray(sess.warnings) ? sess.warnings
          : (() => { try { return JSON.parse(sess.warnings_json || '[]') } catch { return [] } })()
        const skipped = seqOf(json, 'skipped_dispatches')
        lines.push('', handoffSeq
          ? '**⚠️ 待派发标记（派发未证实）**'
          : '**⚠️ 待派发标记（派发指针缺失）**', '')
        lines.push(handoffSeq
          ? `- 下一节点 ${nextA} 仅有交回事件 handoff_seq=${handoffSeq}、未见派发指针 next_seq=0：交回事件已写、派发未证实，请核实下一节点是否已有事件`
          : `- 下一节点 ${nextA} 未见派发指针（next_seq=0、handoff_seq=0）：交回已写、派发未证实`)
        if (repoKey) lines.push(`- 目标仓库: ${repoKey}${issue ? ` · issue: ${issue}` : ''}`)
        if (warns.length) lines.push(`- 会话警告: ${warns.join('；')}`)
        if (skipped > 0) lines.push(`- 平台跳过派发: skipped_dispatches=${skipped}`)
        // 客户端兜底派发只写事件、不回填会话记录：会话里 next_seq=0 不能反证「没派」
        lines.push(`- 口径: 客户端兜底派发不回填会话记录的 next_seq（只写事件），故本行 next_seq=0 不构成「未派发」证据——交回时若提示「已自动派发」，需查事件核实（grape_get_issue_events）再决定是否补发`)
        lines.push('', `_补发前先 grape_get_issue_events 确认下一节点无事件（客户端兜底补发不会回填会话里的 next_seq），确认后 grape_trigger_pipeline(agent=${nextA}) 补发。_`)
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
      '平台写入 events.structured_output（与 worker 同格式），并按场景链确保下一节点（coding→qa）被派发，链不断：' +
      '**派发指针是 `next_seq`**——`next_seq>0` 即平台已派发，不重复派发；`handoff_seq` 只是平台侧交回事件序号，不据此判已派发。' +
      '平台漏派（`next_seq=0`）时按场景链**兜底补发**（复用 trigger 同源 A2A 通道，兜底范围仅 coding→qa），并回填 `next_seq`；' +
      '因 remote_may_still_run 等警告码阻塞、缺仓库/issue 标识或补发失败时，返回**显式告警 + 待派发标记（pending_dispatch）**，' +
      '标记随交回结果返回（平台对已结束会话拒绝 progress 写入——409 not_active，不走 task_messages），' +
      '事后经 `grape_takeover_status` 复查会话记录同样可见派发指针缺失（next_agent + next_seq=0，仅 handoff_seq 不算已派发）与补发指引，不再静默。' +
      '下一节点推导顺序：平台 next_agent > 结构化 next_step（**整串** agent 名如 `qa`，散文如「qa：请复查 PR #10」不解析）> 场景链 coding→qa。' +
      '三个不放行的边界：交回未成功（平台 `ok=false` 或 `changed=false`）时**不派发**下一节点（否则下一节点会接手一个未交回的任务），落待派发并渲染「交回未成功」；' +
      '平台给了白名单外节点名（如 `reviewer`）时**不按场景链改写**为 qa，原样上报「未知节点」待人工裁决；' +
      '补发响应缺事件 `seq` 时判「派发未证实」（不渲染 `seq=0`、不宣称已派发），需查事件核实。' +
      '⚠️ 用户决策层动作：确认本地成果可交回后再调用。' +
      '两阶段确认流：先 request-finish（仅报告完成，等用户确认），用户确认后再本工具 finish。',
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
      },
      required: ['session_id', 'summary'],
    },
    async native(a) {
      const payload = {
        summary: a.summary,
        evidence: a.evidence || '',
        files_written: a.files_written || [],
        actions: a.actions || [],
        artifacts: a.artifacts || [],
        next_step: a.next_step || '',
        issue_summary: a.issue_summary || '',
      }
      if (a.request_only) return api.takeoverRequestFinish(a.session_id, payload)
      const json = await api.takeoverFinish(a.session_id, { ...payload, outcome: 'completed', handoff: 'a2a' })
      return ensureNextNodeDispatched(json, a)
    },
    render(json) {
      if (!json || typeof json !== 'object') return R.fallbackJson(json)
      if (json.detail) return `交回失败：${typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)}`
      const lines = []
      const isRequestOnly = json.changed === undefined && !json.event_status && !json.next_agent
        && (json.awaiting_confirmation || json.requested || json.session?.finish_requested_at)
      if (isRequestOnly) lines.push('### 已报告完成，等待用户确认', '', '用户确认后再次调用本工具（request_only=false）正式交回。')
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
        const handoffSeq = seqOf(json, 'handoff_seq')
        if (handoffSeq) {
          // handoff_seq 只是平台侧交回事件序号；是否已派发一律看 next_seq（判据唯一，避免措辞互斥）
          lines.push(`- 平台 handoff_seq=${handoffSeq}（交回侧事件序号，不作为派发证据）`)
        }
        const d = json.dispatch || {}
        if (d.status === 'dispatched') {
          lines.push(`- 下一节点已自动派发：事件 seq=${d.seq}（平台未给派发指针 next_seq，客户端按场景链兜底补发）`)
          for (const w of (d.warnings || [])) lines.push(`- ⚠️ ${w}`)
          lines.push('', '_链不断：下一节点已收到派发事件，无需手动 trigger。_')
        } else if (d.status === 'already_dispatched') {
          lines.push(`- 下一节点 ${d.agent || '-'} 已由平台派发（next_seq=${d.seq}），未重复派发`)
          lines.push('', '_链不断：下一节点已被派发，无需手动 trigger。_')
        } else if (d.status === 'out_of_scope') {
          lines.push(`- 下一节点 ${d.agent || '-'} 的派发不由本工具兜底（兜底范围仅 coding→qa），保持平台原行为`)
          lines.push('', '_平台若未派发该节点，链会停在当前节点；确认无事件后再手动 grape_trigger_pipeline 补发。_')
        } else if (d.status === 'pending') {
          const pd = json.pending_dispatch || {}
          if (d.cause === 'finish_not_ok' || d.cause === 'finish_not_changed') {
            // 交回没成功就派发下一节点，会把下一节点拉去接手一个未交回的任务
            lines.push('', '**⚠️ 交回未成功：未派发下一节点**', '')
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', '_先解决交回本身（修完再调 grape_takeover_finish 正式交回），成功后再由本工具兜底派发。本次未派发，链可能停在当前节点。_')
          } else if (d.cause === 'unknown_next_agent') {
            lines.push('', '**⚠️ 下一节点未被派发（平台指定的节点名不认识）**', '')
            lines.push(`- 平台指定的节点: ${d.agent || '-'}（未知节点名，未按场景链改写）`)
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', '_场景链兜底只覆盖 coding→qa，白名单外节点名不被静默顶掉：请核实场景链后手动派发。_')
          } else if (d.cause === 'dispatch_unconfirmed') {
            // 补发响应缺事件 seq：不能把「请求发出去了」当成「派发发生了」
            lines.push('', '**⚠️ 下一节点派发未证实（补发响应缺事件 seq）**', '')
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push('', `_补发请求已发出但平台未返回事件序号：先 \`grape_get_issue_events\` 核实下一节点是否已有事件，确认无事件再 \`grape_trigger_pipeline(agent=${d.agent})\` 补发。_`)
          } else {
            lines.push('', '**⚠️ 下一节点未被派发（待派发，pending_dispatch）**', '')
            lines.push(`- 目标节点: ${d.agent || '-'}${pd.owner ? ` · 仓库: ${pd.owner}/${pd.repo}` : ''}${pd.issue_number ? ` · issue: #${pd.issue_number}` : ''}`)
            for (const w of (d.warnings || [])) lines.push(`- ${w}`)
            lines.push(`- 标记随本次交回结果返回；事后用 grape_takeover_status 复查会话（finished + next_agent=${d.agent || '-'} + next_seq=0 即派发未证实）`)
            lines.push('', `_链未自动接续：先 grape_get_issue_events 确认下一节点无事件，再调 \`grape_trigger_pipeline(agent=${d.agent})\` 补发。_`)
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
      },
      required: ['session_id'],
    },
    async native(a) { return api.takeoverAbort(a.session_id, a.redispatch !== false, a.reason || '') },
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
          v: json.updateState === 'unavailable' ? '检测不可用' : json.updateAvailable ? '⬆️ 有可用更新' : '已是最新',
          note: json.updateNotice || '',
        },
        {
          k: 'grape CLI',
          v: cli.status === 'ok' ? `ok（${cli.version || cli.bin || ''}）` : '未安装',
          note: cli.status === 'ok' ? '可选回退通道（v0.3.0 起原生 HTTP 直连，CLI 仅 401 回退用）' : (cli.hint || ''),
        },
        {
          k: '服务端',
          v: srv.reachable ? `可达 ${srv.baseUrl || ''}` : `不可达 ${srv.baseUrl || ''}`,
          note: srv.reachable
            ? (srv.contractVersion ? `契约版本 ${srv.contractVersion}` : '契约版本未取到（404/不可达时省略）')
            : (srv.error || '') + (srv.hint ? `（${srv.hint}）` : ''),
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
        newer: '⬆️ 有新版本',
        latest: '✅ 已是最新',
        dismissed: '🙈 已按用户要求忽略（冷却中）',
        unavailable: '❔ 检测不可用（npm registry 不可达或响应异常）',
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
      if (json.dismiss) {
        lines.push('', `已记录忽略版本 \`${json.dismiss.version}\`：3 天内不再提示，出现新版本会重新提醒。`)
      }
      return lines.join('\n')
    },
  },

  {
    name: 'grape_kit_upgrade',
    description:
      '升级 grape-kit 自身：只读检出安装形态（全局 npm / npx 缓存 / ClawHub / 项目本地依赖 / 未知）并生成对应升级命令。' +
      '⚠️ 用户决策层：执行前必须征得用户同意；本工具只生成命令、不执行。升级完成后需重启宿主会话才加载新版本。',
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
