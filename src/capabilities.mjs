/**
 * 服务端能力握手与节点技能门槛（Issue #32）。
 *
 * 目的：多技能节点不再「看似承接、实际只跑 skills[0]」——required 技能数 > 1 且服务端
 * 未声明 `skills.multi` 时 fail-closed，返回稳定错误码与可升级指引。
 *
 * 设计要点（见 docs/issue-32/plan.md）：
 * - `takeover_bundle.v2` 与 `skills.multi` **正交**：v2 只描述 bundle 结构，不隐含多技能支持。
 * - 握手失败不得伪造能力：`source=unknown`、`capabilities=[]`，且不做长负缓存（下次重试）；
 *   TTL 过期后重取失败可回退 `stale-cache`（保留上一份真实握手结果）。
 * - 拒绝以结构化 payload 交给 render，不抛 MCP error（错误通道会丢结构字段）。
 */
import { api } from './api.mjs'

export const CAP_SKILLS_MULTI = 'skills.multi'
export const E_CAP_UNSUPPORTED_MULTI_SKILL = 'E_CAP_UNSUPPORTED_MULTI_SKILL'

const DEFAULT_TTL_MS = 300_000

/** 进程内握手缓存（单例）：{ data, fetchedAt }；失败不写入。 */
let cache = null

/** 测试/排障用：清空进程内握手缓存。 */
export function resetCapabilitiesCache() {
  cache = null
}

/**
 * 能力归一化：兼容 `string[]`、`{ name: boolean }` 映射、`{ items:[...] }` / `{ capabilities:[...] }` 三类形态。
 * 元素支持字符串或 `{ name, enabled }`；缺字段一律返回 `[]`。
 */
export function normalizeCapabilities(raw) {
  let list = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.items)) list = raw.items
    else if (Array.isArray(raw.capabilities)) list = raw.capabilities
    else list = Object.entries(raw).map(([name, enabled]) => ({ name, enabled }))
  }
  const out = []
  for (const it of list) {
    if (typeof it === 'string') {
      const s = it.trim()
      if (s) out.push(s)
      continue
    }
    if (!it || typeof it !== 'object') continue
    const name = it.name ?? it.capability ?? it.id ?? ''
    const enabled = it.enabled ?? it.supported ?? it.active ?? it.value
    if (name && enabled !== false) out.push(String(name))
  }
  return [...new Set(out)]
}

function unknownCaps(handshakeError, nowIso) {
  return {
    version: '',
    capabilities: [],
    source: 'unknown',
    fetched_at: '',
    handshake_at: nowIso,
    handshake_error: handshakeError || '',
  }
}

function versionOf(raw) {
  return String(raw?.version ?? raw?.service_version ?? raw?.server_version ?? '')
}

/**
 * 读取服务端 capabilities（带进程内 TTL 缓存）。
 * @param {{force?: boolean, env?: object}} [opts] force 或 env.GRAPE_CAPABILITIES_REFRESH=1 强制重取；
 *   env.GRAPE_CAPABILITIES_TTL_MS 覆盖默认 300s（测试注入用）。
 * @returns {Promise<{version:string, capabilities:string[], source:'server'|'stale-cache'|'unknown', fetched_at:string, handshake_at:string, handshake_error?:string}>}
 */
export async function getServerCapabilities(opts = {}) {
  const env = opts.env || process.env
  const rawTtl = Number(env.GRAPE_CAPABILITIES_TTL_MS ?? DEFAULT_TTL_MS)
  const ttlMs = Number.isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : DEFAULT_TTL_MS
  const force = opts.force === true || String(env.GRAPE_CAPABILITIES_REFRESH ?? '') === '1'
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  if (cache && !force && now - cache.fetchedAt < ttlMs) {
    return { ...cache.data, cached: true }
  }

  let errorText = ''
  try {
    const raw = await api.health({ env })
    if (!raw || raw.reachable === false) {
      errorText = raw?.error || 'health unreachable'
    } else {
      const hasCapsField = raw && (Array.isArray(raw.capabilities) || Array.isArray(raw.items) || Array.isArray(raw.capability) || (raw.capabilities && typeof raw.capabilities === 'object'))
      const hasVersion = Boolean(versionOf(raw))
      if (!hasCapsField && !hasVersion) {
        // 旧服务端 200 但缺 version/capabilities：视同握手不可用，不伪造、不缓存。
        return unknownCaps('health 缺少 version/capabilities 字段', nowIso)
      }
      const data = {
        version: versionOf(raw),
        capabilities: normalizeCapabilities(raw.capabilities ?? raw.capability ?? raw.items),
        source: 'server',
        fetched_at: nowIso,
        handshake_at: nowIso,
      }
      cache = { data, fetchedAt: now }
      return data
    }
  } catch (e) {
    errorText = String(e?.message || e || 'handshake failed')
  }

  if (cache && cache.data) {
    return {
      ...cache.data,
      source: 'stale-cache',
      stale: true,
      handshake_at: nowIso,
      handshake_error: errorText,
    }
  }
  return unknownCaps(errorText, nowIso)
}

function skillName(x) {
  if (!x) return ''
  if (typeof x === 'string') return x.trim()
  return String(x.name ?? x.skill ?? x.id ?? '').trim()
}

/**
 * 技能清单解析单一入口（与 #28 共享）：
 * 来源优先级 `skills[]` > `assets.skill` 单条 > `env.GRAPE_BOUND_SKILL`；
 * 元素名取 `name` / `skill` / 字符串。`required` 字段缺失保留 `undefined`，由 gate 统一口径。
 */
export function normalizeSkills(source) {
  if (!source) return []
  let items = []
  if (Array.isArray(source)) {
    items = source
  } else if (typeof source === 'object') {
    const bundle = source.bundle && typeof source.bundle === 'object' ? source.bundle : source
    if (Array.isArray(bundle.skills) && bundle.skills.length) items = bundle.skills
    else if (bundle.assets?.skill) items = [bundle.assets.skill]
    else if (bundle.env?.GRAPE_BOUND_SKILL) items = [bundle.env.GRAPE_BOUND_SKILL]
    else if (bundle.skill) items = [bundle.skill]
  }
  const out = []
  for (const it of items) {
    const name = skillName(it)
    if (!name) continue
    const required = it && typeof it === 'object' && 'required' in it ? it.required : undefined
    out.push({ name, required })
  }
  return out
}

/**
 * 接管门槛判定：required 技能数 > 1 且 capabilities 不含 `skills.multi` → 拒绝。
 * required 字段整体缺失且技能数 > 1 时按「全部 required」保守计数。
 */
export function evaluateTakeoverGate(skills, caps = {}) {
  const list = Array.isArray(skills) ? skills : normalizeSkills(skills)
  const requiredSkills = list.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean)
  const hasRequiredField = list.some((s) => s && typeof s === 'object' && s.required !== undefined)
  const requiredCount = hasRequiredField
    ? list.filter((s) => s && typeof s === 'object' && s.required === true).length
    : requiredSkills.length > 1 ? requiredSkills.length : requiredSkills.length ? 1 : 0
  const capabilities = Array.isArray(caps.capabilities) ? caps.capabilities : []
  const allowed = requiredCount <= 1 || capabilities.includes(CAP_SKILLS_MULTI)
  if (allowed) {
    return { allowed: true, required_skills: requiredSkills, required_count: requiredCount }
  }
  const version = String(caps.version ?? '')
  const source = String(caps.source ?? 'unknown')
  const label = version || '未知版本'
  return {
    allowed: false,
    required_skills: requiredSkills,
    required_count: requiredCount,
    payload: {
      ok: false,
      refused: true,
      code: E_CAP_UNSUPPORTED_MULTI_SKILL,
      message: `接管被拒绝：节点要求 ${requiredCount} 个技能（${requiredSkills.join(',')}），服务端 ${label} 仅支持单技能（${CAP_SKILLS_MULTI} 未声明）。`,
      required_skills: requiredSkills,
      required_count: requiredCount,
      service_version: version,
      supported_capabilities: capabilities,
      capabilities_source: source,
      handshake_at: String(caps.handshake_at ?? ''),
      remediation: [
        `升级服务端至声明 ${CAP_SKILLS_MULTI} 的版本`,
        '升级 kit 至支持 capabilities 握手的版本',
        '将节点改为单技能',
      ],
      retryable: source === 'unknown',
    },
  }
}