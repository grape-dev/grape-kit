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
  constructor(message, { status = 0, hint = '', code = '' } = {}) {
    super(message)
    this.name = 'GrapeApiError'
    this.status = status
    this.hint = hint
    this.code = code
  }
}

/**
 * 宿主平台信息：让服务端按 host_os 渲染接管脚本资产。
 * 平台 StartBody 已接 host_os/host_arch/host_shell（缺省 linux），不上报就永远拿 posix 脚本。
 */
export function hostInfo() {
  const host_os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const host_shell = host_os === 'windows'
    ? String(process.env.ComSpec || 'powershell').split('\\').pop()
    : String(process.env.SHELL || '').split('/').pop() || 'sh'
  return { host_os, host_arch: process.arch, host_shell }
}

/**
 * 凭据/缓存根目录单源实现（默认 ~/.grape）：grape-kit.mjs、update-check 缓存路径与本模块
 * 的文件通道共用同一表达式（QA P2：此前三处各写一份已现漂移风险；takeover _lib.mjs 为无依赖
 * skill 副本，保留逐字一致的本地表达式并注释同源）。
 * GRAPE_HOME 覆盖点既是测试隔离前提，也是自部署容器的共用配置入口。
 */
export function grapeHome(env = process.env) {
  return String(env.GRAPE_HOME || '').trim() || join(homedir(), '.grape')
}

/**
 * npm _npx 缓存根目录（按平台分流）：Windows 的 npm 缓存在 %LocalAppData%\npm-cache\_npx
 * （QA 复审：实现只扫 ~/.npm/_npx 在 Windows 是残留盲区）；POSIX/macOS 保持 ~/.npm/_npx。
 * 供 grape-kit.mjs 的残留扫描与清理共用（单源，防扫描/清理各写一份后漂移）。
 */
export function npxCacheRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = String(env.LOCALAPPDATA || '').trim() || join(homedir(), 'AppData', 'Local')
    return join(base, 'npm-cache', '_npx')
  }
  return join(homedir(), '.npm', '_npx')
}

/**
 * 文件通道单源解析（QA P2：config.json 解析此前四处各写一份）：
 * 返回 { authFile, exists, parseError, cfg }，doctor 优先级视图与 auth init 共用。
 * 解析失败只置 parseError 标志、不携带 e.message——JSON.parse 的报错消息会带出
 * 文件原文片段，凭据文件会因此泄露 token（QA 安全回归）。
 */
export function readAuthChannel(env = process.env) {
  const authFile = env.GRAPE_AUTH_FILE || join(grapeHome(env), 'config.json')
  if (!existsSync(authFile)) return { authFile, exists: false, parseError: false, cfg: null }
  try {
    // 剥 BOM：Windows 记事本保存会带 UTF-8 BOM，JSON.parse 直接抛错（P2 实修，不只写文档）
    return { authFile, exists: true, parseError: false, cfg: JSON.parse(readFileSync(authFile, 'utf-8').replace(/^\uFEFF/, '')) }
  } catch {
    return { authFile, exists: true, parseError: true, cfg: null }
  }
}

/** 文件通道配置（剥 BOM；损坏文件按未配置处理），readAuthChannel 的薄封装。 */
function readFileConfig(env = process.env) {
  const { authFile, cfg } = readAuthChannel(env)
  return { authFile, cfg }
}

/**
 * 平台地址单一事实源：env > ~/.grape/config.json（base_url/baseUrl）> 默认生产实例。
 * 运行时 API、doctor 显示层、worker_onboard、takeover 脚本必须同源，否则「显示层裁掉文件
 * 通道」会把已可用实例误报成 FAIL（Issue #17 假阳性根因）。
 */
export function getBaseUrl(env = process.env) {
  if (env.GRAPE_BASE_URL) return String(env.GRAPE_BASE_URL)
  const { cfg } = readFileConfig(env)
  if (cfg && (cfg.base_url || cfg.baseUrl)) return String(cfg.base_url || cfg.baseUrl)
  return 'https://www.grapedev.cn'
}

export function resolveCredentials(env = process.env) {
  const baseUrl = getBaseUrl(env)
  // ① 一次性参数（进程内）
  if (env.GRAPE_API_TOKEN_ONCE) {
    return { token: env.GRAPE_API_TOKEN_ONCE, baseUrl, source: 'env:GRAPE_API_TOKEN_ONCE', sourceKind: 'runtime' }
  }
  // ② env（标准路径）
  if (env.GRAPE_API_TOKEN) {
    return { token: env.GRAPE_API_TOKEN, baseUrl, source: 'env:GRAPE_API_TOKEN', sourceKind: 'env' }
  }
  // ③ 文件通道（hermes 等 env 清洗场景 + GRAPE_AUTH_FILE 显式指向）
  const { authFile, cfg } = readFileConfig(env)
  if (cfg && cfg.token) {
    // sourceKind 结构化标注命中档：doctor 优先级视图据此渲染，不做 source 字符串反推（QA 判断项）
    return { token: cfg.token, baseUrl, source: `file:${authFile}`, sourceKind: 'file' }
  }
  return { token: '', baseUrl, source: '', sourceKind: '' }
}

/**
 * 错误行动指引（按实际 baseUrl 生成，自部署实例不再被指向生产域名）。
 * @param {number} status
 * @param {{path?: string, detail?: string, baseUrl?: string, code?: string}} [ctx]
 *   code：平台统一错误体的 {ok:false, code, message}——`agent_mismatch` 的 message 是中文散文，
 *   不含 code 字样，只按 detail 匹配会漏（真实响应里 detail = "该任务属于 vod 节点，不是 coding"）。
 */
export function hintFor(status, ctx = {}) {
  const base = String(ctx.baseUrl || 'https://www.grapedev.cn').replace(/\/$/, '')
  if (status === 401) {
    return `token 无效或过期：打开 ${base}/app/#account/profile 生成/重置 API Key（自部署实例即本地址），再更新 GRAPE_API_TOKEN 环境变量或 ~/.grape/config.json 的 token。`
      + '凭据优先级：GRAPE_API_TOKEN_ONCE > GRAPE_API_TOKEN > GRAPE_AUTH_FILE > ~/.grape/config.json；'
      + '更新后需重启宿主会话（已运行的进程读不到新 env，Windows setx 同理）。'
  }
  if (status === 403) {
    if (/\/git-credential\b/.test(String(ctx.path || ''))) {
      return 'git-credential 只接受会话级凭据（tk_ / tko_）：用户级 grape_ / JWT 调用必 403，属预期边界。'
        + '请在接管会话（tko_）或 worker 会话（tk_）内用 grape_git_credential 换一次性本仓凭据，不要更换 token 绕行。'
    }
    if (/\/finish\b|request-finish/.test(String(ctx.path || ''))) {
      return 'finish 是用户的授权点：需用户级凭据（grape_），接管凭据 tko_ 仅 repo_session、不推进流水线，调用必被 403 拒绝——这是角色分工，不是权限缺失，不要重试。'
        + '标准路径：request-finish（agent）→ 用户在对话中授权 → 由持有用户级 token 的会话执行 finish。'
    }
    if (/\/skills\/by-id\/.+\/download\b/.test(String(ctx.path || ''))) {
      return '技能下载端点 scope=user_only：会话级凭据（tko_ / tk_）调用必 403，属预期边界——'
        + '在配置了用户级 grape_ 凭据（GRAPE_API_TOKEN / ~/.grape/config.json）的环境重试，或请服务端把该技能转 inline/zip_url 下发。'
    }
    return '可能是 session_only 端点（外部用户 token 不可用，属预期边界）或权限不足'
  }
  const isMismatch = String(ctx.code || '') === 'agent_mismatch' || /agent_mismatch/i.test(String(ctx.detail || ''))
  if (status === 409 && isMismatch) {
    return '接管只能对准当前活跃节点：目标节点已不是当前活跃阶段（409 agent_mismatch）。先 grape_get_pipeline_info / grape_takeover_status 确认当前活跃节点；目标尚未激活时按 60-120s 轮询后再试，不要连打开 start。'
  }
  if (status === 409 && String(ctx.code || '') === 'taken_by_other') return '另一个接管请求正在处理该任务：等 10-30s 重试，或用 grape_takeover_status 取回自己已开的会话。'
  return ''
}

/**
 * 调 grape HTTP API。
 * `opts.binary`（Issue #39）：技能下载端点等二进制通道——响应不是合法 JSON 时原样回 Buffer，
 * 交由调用方按字节处理（zip 解压）；JSON 响应（如 OBS 短签 `{url, expires_in}`）行为不变。
 * @param {string} method
 * @param {string} path 以 /api 开头
 * @param {{query?: object, body?: object, timeoutMs?: number, env?: object, binary?: boolean}} [opts]
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
        ...(opts.headers || {}),
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
  // binary 通道只读一次 body：先取字节再从中解文本，避免 text()/arrayBuffer() 二次消费同一流
  const raw = opts.binary ? Buffer.from(await resp.arrayBuffer()) : null
  const text = raw ? raw.toString('utf8') : await resp.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = undefined }
  if (!resp.ok) {
    // 平台 takeover 错误体：{ok:false, code, message}（route 层 _err），code 才是可判别的排障键
    const code = json && typeof json.code === 'string' ? json.code : ''
    const detail = json && (json.detail?.message || json.detail || json.message || json.code) ? String(json.detail?.message ?? json.detail ?? json.message ?? json.code).slice(0, 300) : text.slice(0, 300)
    throw new GrapeApiError(`grape API ${resp.status}: ${detail}`, {
      status: resp.status,
      code,
      hint: hintFor(resp.status, { path, detail, baseUrl, code }),
    })
  }
  if (opts.binary && json === undefined && raw) return raw
  return json
}

/**
 * multipart 上传（技能 ZIP）。apiRequest 只发 JSON，这条通道单独走 FormData：
 * Content-Type 必须交给 fetch 自动生成 boundary（手写 application/json 会 422）。
 * 错误体解析与 apiRequest 同源（401/403 hint 一致），但 detail.errors 原样保留——
 * 技能校验失败时服务端一次返回多条 errors，截断第一条正是宿主反复试错的根因。
 */
export async function apiUpload(path, formData, opts = {}) {
  const env = opts.env || process.env
  const { token, baseUrl } = resolveCredentials(env)
  if (!token) {
    throw new GrapeApiError('Missing token: 请设置 GRAPE_API_TOKEN，或写入 ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}', { status: 401 })
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000)
  let resp
  try {
    resp = await fetch(new URL(baseUrl.replace(/\/$/, '') + path), {
      method: 'POST',
      headers: { Authorization: 'Bea' + 'rer ' + token },
      body: formData,
      signal: ctrl.signal,
    })
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? `上传超时（>${Math.round((opts.timeoutMs ?? 120000) / 1000)}s）`
      : `无法连接 ${baseUrl}（${e.message}）`
    throw new GrapeApiError(msg, { status: 0, hint: '检查 GRAPE_BASE_URL / 网络' })
  } finally {
    clearTimeout(t)
  }
  const text = await resp.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = undefined }
  if (!resp.ok) {
    const code = json && typeof json.code === 'string' ? json.code : ''
    const d = json && json.detail
    const message = (d && typeof d === 'object')
      ? String(d.message ?? JSON.stringify(d))
      : String(d ?? json?.message ?? text).slice(0, 400)
    const errors = (d && typeof d === 'object' && Array.isArray(d.errors)) ? d.errors : []
    const err = new GrapeApiError(`grape API ${resp.status}: ${message}`, {
      status: resp.status, code, hint: hintFor(resp.status, { path, detail: message, baseUrl, code }),
    })
    err.detailErrors = errors
    throw err
  }
  return json
}

/**
 * 客户端能力声明（Issue #32）：随握手请求上报，供新服务端在 session 建立时
 * 拦截未声明支持的旧客户端。当前 kit 已支持多技能渲染/判据，故声明 skills.multi。
 */
export const CLIENT_CAPABILITIES = { 'skills.multi': true }

/**
 * `GET /api/health` 握手（Issue #32）：5s 超时；404（旧服务端尚未提供）与网络不可达
 * 返回 `{ reachable:false }` 而非抛错，交由 capabilities 层归一化为 unknown。
 * 401 等其余错误照常上抛，由 capabilities 层统一兜底为 unknown。
 */
export async function health(opts = {}) {
  try {
    return await apiRequest('GET', '/api/health', {
      timeoutMs: opts.timeoutMs ?? 5000,
      env: opts.env,
      headers: { 'X-Grape-Client-Capabilities': 'skills.multi=true' },
    })
  } catch (e) {
    if (e instanceof GrapeApiError && (e.status === 404 || e.status === 0)) {
      return { reachable: false, status: e.status, error: e.message }
    }
    throw e
  }
}

/* ── 端点封装：与 tools.mjs 的工具面一一对应 ─────────────── */

/** A2A 节点枚举：与平台 pipelines.json 的 agent tag 对齐 */
export const AGENT_TYPES = ['vod', 'issue', 'coding', 'qa', 'sre']

/**
 * agent 归一 + 枚举校验：native 与 CLI 回退通道共用同一份，两通道报错逐字一致。
 * 缺省/空值回落 vod（不传即从流水线首节点起步）；非法值在发请求前就拒掉，
 * 否则 CLI 通道会把非法 agent 静默交给服务端，等到平台侧才失败。
 */
export function normalizeTriggerAgent(agent) {
  const a = agent === undefined || agent === null || agent === '' ? 'vod' : String(agent)
  if (!AGENT_TYPES.includes(a)) {
    throw new GrapeApiError(`非法 agent：${a}（可用值：${AGENT_TYPES.join(' / ')}）`, {
      status: 400,
      hint: '不传 agent 时缺省从 vod 起步；仅当上游节点已完成、需要断点续跑时才显式指定后续节点。',
    })
  }
  return a
}

export const api = {
  // 握手 / 能力发现（Issue #32）
  health: (opts) => health(opts),

  // 流水线
  triggerPipeline: async (owner, repo, issueNumber, context = '', agent) => {
    const a = normalizeTriggerAgent(agent)
    return apiRequest('POST', '/api/a2a', { body: { agent: a, payload: { repository: `${owner}/${repo}`, account: owner, issue_number: Number(issueNumber), ...(context ? { context } : {}) } } })
  },
  /**
   * 按自定义场景链派发下一节点（#30）：场景节点 tag 可不在内置 AGENT_TYPES 内（如 review），
   * 此时不能走 normalizeTriggerAgent 的枚举校验。仅在目标已在场景链内时由 tools 调用。
   */
  dispatchPipeline: async (owner, repo, issueNumber, context = '', agent) => {
    const a = String(agent ?? '').trim()
    if (!a) throw new GrapeApiError('派发节点为空：无法确定 A2A 目标', { status: 400 })
    return apiRequest('POST', '/api/a2a', { body: { agent: a, payload: { repository: `${owner}/${repo}`, account: owner, issue_number: Number(issueNumber), ...(context ? { context } : {}) } } })
  },
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
  //
  // 三条通道语义不同，别再混用（grape-kit 测试报告 P3/P4/P5 实锤）：
  // - POST /api/scenes/market/{market_id}/apply?owner=&repo=  → 在仓库内“创建”场景副本
  //   （返回新 scene_id=custom-xxxx；同模板重复应用幂等复用）。这是“应用场景”。
  // - POST /api/scenes/apply/{owner}/{repo}                   → 只把场景节点的技能/引擎绑定
  //   刷进 devops_agent_session，**不改仓库场景归属**，响应里也没有 scene_id。
  // - PUT  /api/repos/{owner}/{repo}/default-scene             → 写 managed_repos.dev_scene，
  //   这才是“新建 issue 默认走哪个场景”。（平台此前没有这个通用端点，kit 只能靠猜）
  scenesMarket: (q) => apiRequest('GET', '/api/scenes/market', { query: { ...(q ? { q } : {}), limit: 200 } }),
  /** 仓库内场景列表（id 形如 custom-xxxxxxxx）——判断“应到/应用了”的唯一事实源 */
  repoScenes: (owner, repo) => apiRequest('GET', '/api/scenes', { query: { repo: `${owner}/${repo}` } }),
  /** 应用市场场景到仓库：创建场景副本，返回 {scene_id, reused} */
  marketApply: (owner, repo, marketId, displayName) =>
    apiRequest('POST', `/api/scenes/market/${marketId}/apply`, {
      query: { owner, repo },
      body: displayName ? { display_name: displayName } : {},
    }),
  /** 设为仓库默认场景（写 dev_scene；空串=清空回智能推荐）。写后由服务端回读验证 */
  setDefaultScene: (owner, repo, sceneId) =>
    apiRequest('PUT', `/api/repos/${owner}/${repo}/default-scene`, { body: { scene_id: sceneId || '' } }),
  sceneRecommendConfig: (owner, repo) => apiRequest('GET', `/api/repos/${owner}/${repo}/scene-recommend-config`),
  setSceneRecommendFallback: (owner, repo, fallbackScene, rules = []) =>
    apiRequest('PUT', `/api/repos/${owner}/${repo}/scene-recommend-config`,
      { body: { fallback_scene: fallbackScene, rules } }),
  /** 场景详情：节点链的权威来源（每节点带 next），客户端兜底派发据此推导下一节点 */
  scenesDetail: (sceneId) => apiRequest('GET', `/api/scenes/${encodeURIComponent(String(sceneId ?? '').trim())}`),

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
  /**
   * 技能包下载（Issue #39 引用形态解析的唯一契约端点）。该端点 scope=user_only：会话级凭据
   * （tko_/tk_）调用必 403——需用户级 grape_ 凭据环境，或由服务端把技能转 inline/zip_url 下发。
   * 响应两类：OBS 形态回 `{url, expires_in}` 短签 URL（拉 zip 的第二步不带凭据，直接 GET 该 URL）；
   * 其余形态直出 zip 二进制——apiRequest 的 binary 通道把非 JSON 响应原样回传 Buffer，
   * 由 `zipSourceOf` 的二进制分支承接。`timeoutMs` 与 zip 拉取共用同一旋钮（缺省 15s，
   * 引用解析全程有上界，不再吃 apiRequest 的 30s 默认）。
   * `repo` 只对 repo scope 技能有意义（官方 / 个人技能留空）。
   */
  skillDownload: (skillId, repo, env, timeoutMs) =>
    apiRequest('GET', `/api/skills/by-id/${encodeURIComponent(String(skillId ?? '').trim())}/download`, {
      query: repo ? { repo: String(repo) } : {},
      env,
      timeoutMs,
      binary: true,
    }),
  /**
   * 上传技能 ZIP。scope=user 个人技能；scope=repo 需 repo + agent_type（必填）。
   * 服务端校验失败返回 detail.errors 列表（apiUpload 会保留全部错误）。
   */
  skillUpload: (zipBuffer, filename, fields = {}) => {
    const fd = new FormData()
    fd.append('file', new Blob([zipBuffer], { type: 'application/zip' }), filename || 'skill.zip')
    fd.append('scope', fields.scope || 'user')
    if (fields.repo) fd.append('repo', fields.repo)
    fd.append('agent_type', fields.agent_type || '')
    if (fields.tags) fd.append('tags', fields.tags)
    if (fields.summary) fd.append('summary', fields.summary)
    if (fields.change_note) fd.append('change_note', fields.change_note)
    return apiUpload('/api/skills/upload', fd)
  },
  /** 按 skill_id 覆盖既有技能包（= 技能升级，保留 id/场景引用/点赞） */
  skillUpdate: (zipBuffer, skillId, fields = {}) => {
    const fd = new FormData()
    fd.append('file', new Blob([zipBuffer], { type: 'application/zip' }), fields.filename || 'skill.zip')
    if (fields.agent_type) fd.append('agent_type', fields.agent_type)
    if (fields.tags) fd.append('tags', fields.tags)
    if (fields.summary) fd.append('summary', fields.summary)
    if (fields.change_note) fd.append('change_note', fields.change_note)
    return apiUpload(`/api/skills/by-id/${skillId}/update`, fd)
  },
  /** 跨 scope 复制技能（user ↔ repo；原记录保留，不是移动） */
  skillConvert: (skillName, repoKey, sourceScope = 'user') =>
    apiRequest('POST', '/api/skills/convert', { body: { skill_name: skillName, repo: repoKey, source_scope: sourceScope } }),
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

  // git 写回（Issue #31）：一次性本仓凭据 + PR 薄代理（tk_/tko_ 会话级通道；用户级 grape_ 403 属预期）
  gitCredential: (owner, repo) =>
    apiRequest('GET', `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git-credential`),
  createPull: (owner, repo, payload) =>
    apiRequest('POST', `/api/git-repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { body: payload }),

  // 端云协同 · takeover 会话（weekly-11+，PR #1268 一等接管资源）
  takeoverStart: (owner, repo, issueNumber, agentType) =>
    apiRequest('POST', '/api/takeover/sessions', { body: { owner, repo, issue_number: String(issueNumber), ...(agentType ? { agent_type: agentType } : {}), platform: 'grape-kit', ...hostInfo() } }),
  takeoverList: (owner, repo, issueNumber, activeOnly = true) =>
    apiRequest('GET', '/api/takeover/sessions', { query: { repo_key: `gitcode:${owner}/${repo}`, ...(issueNumber ? { issue_number: String(issueNumber) } : {}), ...(activeOnly ? {} : { all: 1 }) } }),
  takeoverGet: (sessionId, renew = false) =>
    apiRequest('GET', `/api/takeover/sessions/${sessionId}`, { query: renew ? { renew: 1 } : {} }),
  takeoverAttach: (sessionId, clientSession) =>
    apiRequest('POST', `/api/takeover/sessions/${sessionId}/attach`, { body: { client_session: clientSession || '' } }),
  takeoverProgress: (sessionId, messages, summary = '') =>
    apiRequest('POST', `/api/takeover/sessions/${sessionId}/progress`, { body: { messages: messages || [], ...(summary ? { summary } : {}) } }),
  takeoverRequestFinish: (sessionId, payload) =>
    apiRequest('POST', `/api/takeover/sessions/${sessionId}/request-finish`, { body: payload || {} }),
  takeoverFinish: (sessionId, payload) =>
    apiRequest('POST', `/api/takeover/sessions/${sessionId}/finish`, { body: payload || {} }),
  takeoverAbort: (sessionId, redispatch = true, reason = '') =>
    apiRequest('POST', `/api/takeover/sessions/${sessionId}/abort`, { body: { redispatch, ...(reason ? { reason } : {}) } }),
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
