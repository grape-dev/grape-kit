/**
 * grape API 原生客户端 —— v0.3.0 传输层原生化。
 *
 * 对齐 grape-cli 的认证/错误语义（src/client.py），但纯 Node fetch 实现：
 * - token 优先级：一次性 env > GRAPE_API_TOKEN / GRAPE_AUTH_FILE > ~/.grape/config.json
 * - 错误分类对齐 CLI 的 hint（401/403/超时/网络不可达），MCP 侧可给行动指引
 * - 契约快照内置包内（安装后零网络即可解析端点），运行时按需拉新
 *
 * 与 spawn CLI 通道的关系：tools.mjs 每个工具声明通道（native | cli），
 * native 走本模块直连；cli 仅保留给 grape git 等凭据注入场景。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class GrapeApiError extends Error {
  constructor(message, { status = 0, hint = '' } = {}) {
    super(message)
    this.name = 'GrapeApiError'
    this.status = status
    this.hint = hint
  }
}

export function resolveCredentials(env = process.env) {
  // ① 一次性参数（进程内）
  if (env.GRAPE_API_TOKEN_ONCE) {
    return { token: env.GRAPE_API_TOKEN_ONCE, baseUrl: env.GRAPE_BASE_URL || 'https://www.grapedev.cn' }
  }
  // ② env（标准路径）
  if (env.GRAPE_API_TOKEN) {
    return { token: env.GRAPE_API_TOKEN, baseUrl: env.GRAPE_BASE_URL || 'https://www.grapedev.cn' }
  }
  // ③ 文件通道（hermes 等 env 清洗场景 + GRAPE_AUTH_FILE 显式指向）
  const authFile = env.GRAPE_AUTH_FILE || join(homedir(), '.grape', 'config.json')
  if (existsSync(authFile)) {
    try {
      const cfg = JSON.parse(readFileSync(authFile, 'utf-8'))
      if (cfg.token) {
        return { token: cfg.token, baseUrl: cfg.base_url || env.GRAPE_BASE_URL || 'https://www.grapedev.cn' }
      }
    } catch { /* 损坏文件按未配置处理 */ }
  }
  return { token: '', baseUrl: env.GRAPE_BASE_URL || 'https://www.grapedev.cn' }
}

function hintFor(status) {
  if (status === 401) return 'token 无效或过期：在 Grape WebUI → 设置 → API Keys 重新生成，并更新 GRAPE_API_TOKEN / ~/.grape/config.json'
  if (status === 403) return '可能是 session_only 端点（外部用户 token 不可用，属预期边界）或权限不足'
  return ''
}

/**
 * 调 grape HTTP API。
 * @param {string} method
 * @param {string} path 以 /api 开头
 * @param {{query?: object, body?: object, timeoutMs?: number, env?: object}} [opts]
 */
export async function apiRequest(method, path, opts = {}) {
  const env = opts.env || process.env
  const { token, baseUrl } = resolveCredentials(env)
  if (!token) {
    throw new GrapeApiError('Missing token: 请设置 GRAPE_API_TOKEN，或写入 ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}', { status: 401 })
  }
  const url = new URL(baseUrl.replace(/\/$/, '') + path)
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000)
  let resp
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    })
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? `请求超时（>${Math.round((opts.timeoutMs ?? 30000) / 1000)}s）`
      : `无法连接 ${baseUrl}（${e.message}）`
    throw new GrapeApiError(msg, { status: 0, hint: '检查 GRAPE_BASE_URL 是否正确 / 网络可达' })
  } finally {
    clearTimeout(t)
  }
  const text = await resp.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = undefined }
  if (!resp.ok) {
    const detail = json && (json.detail?.message || json.detail || json.message) ? String(json.detail?.message ?? json.detail ?? json.message).slice(0, 300) : text.slice(0, 300)
    throw new GrapeApiError(`grape API ${resp.status}: ${detail}`, { status: resp.status, hint: hintFor(resp.status) })
  }
  return json
}

/* ── 端点封装：与 tools.mjs 的 31 个工具一一对应 ─────────────── */

export const api = {
  // 流水线
  triggerPipeline: (owner, repo, issueNumber, context = '') =>
    apiRequest('POST', '/api/a2a', { body: { agent: 'vod', payload: { repository: `${owner}/${repo}`, account: owner, issue_number: Number(issueNumber), ...(context ? { context } : {}) } } }),
  taskStatus: (seq) => apiRequest('GET', `/api/events/detail/${seq}`),
  issuePipeline: (owner, repo, number) => apiRequest('GET', `/api/issues/${owner}/${repo}/${number}/pipeline`),
  repoRoadmap: (owner, repo) => apiRequest('GET', `/api/pipeline/${owner}/${repo}`),

  // issues
  listIssues: (owner, repo, status) => apiRequest('GET', `/api/issues/${owner}/${repo}`, { query: status ? { status } : {} }),
  myIssues: (status) => apiRequest('GET', '/api/issues/mine', { query: status ? { status } : {} }),
  issueDetail: (owner, repo, number) => apiRequest('GET', `/api/issues/${owner}/${repo}/${number}`),
  issueEvents: (owner, repo, number) => apiRequest('GET', `/api/issues/${owner}/${repo}/${number}/events`),
  createIssue: (owner, repo, title, description) =>
    apiRequest('POST', `/api/issues/${owner}/${repo}`, { body: { title, ...(description ? { description } : {}) } }),
  cancelIssue: (issueId) => apiRequest('POST', `/api/issues/${issueId}/cancel`),
  resumeIssue: (issueId) => apiRequest('POST', `/api/issues/${issueId}/resume`),
  startIssue: (issueId) => apiRequest('POST', `/api/issues/${issueId}/start`),

  // 场景
  scenesMarket: (q) => apiRequest('GET', '/api/scenes/market', { query: q ? { q } : {} }),
  applyScene: (owner, repo, sceneId) => apiRequest('POST', `/api/scenes/apply/${owner}/${repo}`, { body: { scene_id: sceneId } }),

  // 仓库 / 搜索 / 仪表盘
  managedRepos: () => apiRequest('GET', '/api/repos/managed'),
  memberRepos: () => apiRequest('GET', '/api/repos/member'),
  projectInfo: (owner, repo) => apiRequest('GET', `/api/repos/${owner}/${repo}/project-info`),
  hostRepo: (fullName, provider) => apiRequest('POST', '/api/repos/host', { body: { full_name: fullName }, query: provider ? { provider } : {} }),
  syncRepos: () => apiRequest('POST', '/api/repos/sync'),
  globalSearch: (q, type) => apiRequest('GET', '/api/search', { query: { q, ...(type ? { type } : {}) } }),
  repoDashboard: (owner, repo) => apiRequest('GET', `/api/dashboard/${owner}/${repo}`),

  // skills / knowledge / templates
  skillsList: () => apiRequest('GET', '/api/skills'),
  skillsSearch: (q) => apiRequest('GET', '/api/skills/search', { query: { q } }),
  skillDetail: (skillId) => apiRequest('GET', `/api/skills/by-id/${skillId}`),
  knowledgeList: (repo, q) => apiRequest('GET', '/api/knowledge', { query: { repo, ...(q ? { q } : {}) } }),
  knowledgeDetail: (id) => apiRequest('GET', `/api/knowledge/${id}`),
  templatesList: () => apiRequest('GET', '/api/project-templates'),
  createProject: (templateId, repoName, provider) =>
    apiRequest('POST', '/api/project-templates/create', { body: { template_id: templateId, repo_name: repoName, ...(provider ? { provider } : {}) } }),

  // 端云协同
  takeoverContext: (owner, repo, number) =>
    apiRequest('GET', '/api/runtime/issues/takeover-context', { query: { repo_key: `gitcode:${owner}/${repo}`, issue_number: Number(number) } }),
  workerCredentialCreate: (name, scope = 'user', repoKey = '') =>
    apiRequest('POST', '/api/settings/runtime-credentials', { body: { name, scope, ...(repoKey ? { repo_key: repoKey } : {}) } }),
}

/** 终态集合（与 cli.mjs 一致） */
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error'])

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 原生 waitTask：进程内轮询，无 CLI 冷启动（原 ~200ms/次 → ~30ms/次） */
export async function waitTaskNative(seq, { timeoutSec = 300, intervalSec = 3, onPoll } = {}) {
  const start = Date.now()
  const deadline = start + timeoutSec * 1000
  let last = null
  let polls = 0
  while (Date.now() < deadline) {
    polls += 1
    last = await api.taskStatus(seq)
    const status = String(last?.status ?? '').toLowerCase()
    if (onPoll) onPoll({ polls, status, elapsedMs: Date.now() - start })
    if (TERMINAL.has(status)) return { json: last, polls, elapsedMs: Date.now() - start }
    await sleep(intervalSec * 1000)
  }
  return { json: last, polls, elapsedMs: Date.now() - start, timedOut: true }
}
