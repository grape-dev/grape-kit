import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCredentials, apiRequest, GrapeApiError, waitTaskNative, api, getBaseUrl, grapeHome, readAuthChannel, npxCacheRoot, AGENT_TYPES } from '../src/api.mjs'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

test('凭据解析优先级：env > auth file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-api-'))
  try {
    const cfg = join(dir, 'config.json')
    const ISO = { GRAPE_AUTH_FILE: '/nonexistent/gk-test-auth.json' }  // 屏蔽宿主机真实 ~/.grape/config.json
    writeFileSync(cfg, '{"token":"grape_from_file","base_url":"https://from-file.example"}')
    // ① 无 env → 文件
    const byFile = resolveCredentials({ ...ISO, GRAPE_AUTH_FILE: cfg })
    assert.equal(byFile.token, 'grape_from_file')
    assert.equal(byFile.baseUrl, 'https://from-file.example')
    // ② env 优先于文件
    const byEnv = resolveCredentials({ ...ISO, GRAPE_AUTH_FILE: cfg, GRAPE_API_TOKEN: 'grape_from_env', GRAPE_BASE_URL: 'https://from-env' })
    assert.equal(byEnv.token, 'grape_from_env')
    assert.equal(byEnv.baseUrl, 'https://from-env')
    // ③ 都没有 → 空 token
    const none = resolveCredentials({ ...ISO })
    assert.equal(none.token, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('凭据缺失时 apiRequest 抛 401 带指引', async () => {
  await assert.rejects(
    apiRequest('GET', '/api/issues/mine', { env: { GRAPE_AUTH_FILE: '/nonexistent/gk-test-auth.json' } }),
    (e) => e instanceof GrapeApiError && e.status === 401 && /GRAPE_API_TOKEN|config\.json/.test(e.message),
  )
})

test('无凭据时 cancel_issue 的 run 走 native 401（不静默编造结果）', async () => {
  const savedAuthFile = process.env.GRAPE_AUTH_FILE
  const savedToken = process.env.GRAPE_API_TOKEN
  process.env.GRAPE_AUTH_FILE = '/nonexistent/gk-test-auth.json'   // 隔离宿主凭据
  delete process.env.GRAPE_API_TOKEN
  try {
    const { findTool } = await import('../src/tools.mjs')
    const t = findTool('grape_cancel_issue')
    await assert.rejects(
      t.run({ owner: 'a', repo: 'b', number: 1 }, { runGrape: null, apiModule: api }),
      (e) => e.status === 401,
    )
  } finally {
    if (savedAuthFile) process.env.GRAPE_AUTH_FILE = savedAuthFile; else delete process.env.GRAPE_AUTH_FILE
    if (savedToken) process.env.GRAPE_API_TOKEN = savedToken
  }
})

test('worker_onboard 无 runGrape 时走 native 通道（v0.3.0 CLI 可选）', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_worker_onboard')
  // ① native 成功路径：mock 返回 token → 生成完整安装命令（含 F10 的 --server）
  const ok = await t.run({ device_name: 'probe' }, { runGrape: null, apiModule: {
    workerCredentialCreate: async () => ({ token: 'rta_ok', id: 1, name: 'probe' }),
  } })
  assert.equal(ok.onboard, 'ready')
  assert.match(ok.install_command, /--server \S+ --device probe/)
  // ② native 失败（401）→ 如实上抛，不静默编造结果
  await assert.rejects(
    t.run({ device_name: 'probe' }, { runGrape: null, apiModule: {
      workerCredentialCreate: async () => { throw new GrapeApiError('Missing token', { status: 401 }) },
    } }),
    (e) => e.status === 401,
  )
})

test('F10 回归：onboard 命令必须带 --server', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_worker_onboard')
  const out = t.render({
    onboard: 'ready', device: 'x',
    install_command: 'curl -sSL https://www.grapedev.cn/api/runtime/install | bash -s -- --token rta_x --server https://www.grapedev.cn --device x',
    note: '',
  })
  assert.match(out, /--server https:\/\/www\.grapedev\.cn/)
})

test('waitTaskNative 轮询到终态', async () => {
  let n = 0
  const orig = api.taskStatus
  api.taskStatus = async () => { n += 1; return n < 2 ? { seq: 1, status: 'running' } : { seq: 1, status: 'completed' } }
  try {
    const r = await waitTaskNative(1, { timeoutSec: 5, intervalSec: 0.01 })
    assert.equal(r.json.status, 'completed')
    assert.equal(r.polls, 2)
  } finally { api.taskStatus = orig }
})

test('#2-2 回归：search 响应 {events:[...]} 正确渲染 + type 枚举', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_search')
  assert.deepEqual(t.schema.properties.type.enum, ['all', 'event', 'repo', 'agent'])
  const out = t.render({ events: [{ seq: 1, title: '相册', repo_key: 'gitcode:a/b', event_type: 'a2a_event' }] })
  assert.match(out, /相册/)
  assert.match(out, /gitcode:a\/b/)
  const empty = t.render({ events: [] })
  assert.match(empty, /（空）|json/)  // 空结果不崩
})

test('#1-3 回归：resume 后自动复核，返回 verified_stage', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_resume_issue')
  const r = await t.run({ owner: 'a', repo: 'b', number: 5 }, { runGrape: null, apiModule: {
    issueDetail: async () => ({ issue_id: 99 }),
    resumeIssue: async () => ({ ok: true }),
    issuePipeline: async () => ({ stage: 'issue', task_status: 'processing' }),
  } })
  assert.equal(r.verified_stage, 'issue')
  assert.match(r.verify_note, /resume 已生效/)
})

test('#1-1 回归：cancel 描述含三选决策门', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const d = findTool('grape_cancel_issue').description
  assert.match(d, /终止.*整条流水线/)
  assert.match(d, /让渡接管/)
  assert.match(d, /未选择不得执行/)
})

test('#2-5 回归：wait 超时返回复查引导', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_wait_task')
  const out = t.render({ seq: 85, status: 'running', polls: 100, timedOut: true })
  assert.match(out, /grape_get_task_status/)
  assert.match(out, /别死等/)
})

/* ── Issue #17：地址单一事实源 getBaseUrl() + trigger agent 透传 ── */

test('getBaseUrl 优先级：env > ~/.grape/config.json > 默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-base-'))
  try {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ token: 't', base_url: 'https://file.example' }))
    assert.equal(getBaseUrl({ GRAPE_AUTH_FILE: cfg, GRAPE_BASE_URL: 'https://env.example' }), 'https://env.example')
    assert.equal(getBaseUrl({ GRAPE_AUTH_FILE: cfg }), 'https://file.example')
    assert.equal(getBaseUrl({ GRAPE_AUTH_FILE: join(dir, 'missing.json') }), 'https://www.grapedev.cn')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Issue #20 GRAPE_HOME 覆盖文件通道路径（测试隔离 + 自部署）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-home-'))
  try {
    mkdirSync(join(dir, '.grape'), { recursive: true })
    writeFileSync(join(dir, '.grape', 'config.json'), JSON.stringify({ token: 'grape_home', base_url: 'https://home.example' }))
    // 无 GRAPE_AUTH_FILE 时，文件通道应落在 GRAPE_HOME/config.json
    const env = { GRAPE_HOME: join(dir, '.grape') }
    assert.equal(resolveCredentials(env).token, 'grape_home')
    assert.equal(resolveCredentials(env).source, `file:${join(dir, '.grape', 'config.json')}`)
    assert.equal(resolveCredentials(env).sourceKind, 'file', 'sourceKind 结构化标注命中档（doctor 据此渲染，不做字符串反推）')
    assert.equal(getBaseUrl(env), 'https://home.example')
    // GRAPE_AUTH_FILE 显式指定优先级高于 GRAPE_HOME 默认路径
    const explicit = join(dir, 'explicit.json')
    writeFileSync(explicit, JSON.stringify({ token: 'grape_explicit' }))
    assert.equal(resolveCredentials({ ...env, GRAPE_AUTH_FILE: explicit }).token, 'grape_explicit')
    // sourceKind 三档结构化（QA 判断项：priorityChecks 不得用字符串反推命中档）
    assert.equal(resolveCredentials({ GRAPE_API_TOKEN_ONCE: 'grape_once', GRAPE_API_TOKEN: 'grape_env' }).sourceKind, 'runtime')
    assert.equal(resolveCredentials({ GRAPE_API_TOKEN: 'grape_env' }).sourceKind, 'env')
    assert.equal(resolveCredentials({ GRAPE_AUTH_FILE: '/nonexistent/gk-none.json' }).sourceKind, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/* ── QA 复审（PR #11）P2：GRAPE_HOME 表达式与 config.json 解析单源化 ── */

test('QA#P2 grapeHome 单源导出：GRAPE_HOME 覆盖 + 默认 ~/.grape（全文唯一实现）', () => {
  assert.equal(grapeHome({ GRAPE_HOME: '  ' }), join(homedir(), '.grape'), '空白 GRAPE_HOME 视为未设置')
  assert.equal(grapeHome({ GRAPE_HOME: '/custom/grape' }), '/custom/grape')
  assert.equal(grapeHome({}), join(homedir(), '.grape'))
})

/* ── QA 复审（合入后 dev 基线）win32 盲区：_npx 缓存路径按平台分流（%LocalAppData%） ── */

test('QA#win32 npxCacheRoot：Windows 走 %LocalAppData%\\npm-cache\\_npx（LOCALAPPDATA 缺省回落 homedir），POSIX 走 ~/.npm/_npx', () => {
  assert.equal(npxCacheRoot({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32'), join('C:\\Users\\u\\AppData\\Local', 'npm-cache', '_npx'), 'Windows npm 缓存实际在 %LocalAppData%\\npm-cache\\_npx')
  assert.equal(npxCacheRoot({}, 'win32'), join(join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx'), 'LOCALAPPDATA 缺省回落 homedir/AppData/Local')
  assert.equal(npxCacheRoot({}, 'linux'), join(homedir(), '.npm', '_npx'), 'POSIX 保持 ~/.npm/_npx')
  assert.equal(npxCacheRoot({}, 'darwin'), join(homedir(), '.npm', '_npx'), 'macOS 与 POSIX 同路径')
})

test('QA#P2 readAuthChannel 单源解析：GRAPE_AUTH_FILE 优先 / BOM 剥除 / 解析失败只置标志不透传原文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-authch-'))
  try {
    const cfg = join(dir, 'auth.json')
    writeFileSync(cfg, '\uFEFF' + JSON.stringify({ token: 'grape_x', base_url: 'https://a.example' }))
    const ok = readAuthChannel({ GRAPE_AUTH_FILE: cfg })
    assert.equal(ok.cfg.token, 'grape_x', 'BOM 应被剥除')
    assert.equal(ok.exists, true)
    assert.equal(ok.parseError, false)

    const home = join(dir, '.grape')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({ token: 'grape_home' }))
    const fallback = readAuthChannel({ GRAPE_HOME: home })
    assert.equal(fallback.cfg.token, 'grape_home', '无 GRAPE_AUTH_FILE 时回落 GRAPE_HOME/config.json')
    assert.equal(fallback.authFile, join(home, 'config.json'))

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, 'tk_9oops_not_json')
    const fail = readAuthChannel({ GRAPE_AUTH_FILE: broken })
    assert.equal(fail.parseError, true, '解析失败应置 parseError 标志')
    assert.equal(fail.cfg, null)
    // 契约：不携带 e.message（JSON.parse 报错含文件原文，凭据文件会因此泄露片段）
    assert.deepEqual(Object.keys(fail).sort(), ['authFile', 'cfg', 'exists', 'parseError'])

    const missing = readAuthChannel({ GRAPE_AUTH_FILE: join(dir, 'nope.json') })
    assert.equal(missing.exists, false)
    assert.equal(missing.cfg, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('getBaseUrl 支持 baseUrl 驼峰别名与 BOM 文件通道', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-base-'))
  try {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, '\uFEFF' + JSON.stringify({ token: 't', baseUrl: 'https://camel.example' }))
    assert.equal(getBaseUrl({ GRAPE_AUTH_FILE: cfg }), 'https://camel.example')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('triggerPipeline agent：默认 vod / 指定 qa 透传 / 非法值可读错误', async () => {
  const origFetch = globalThis.fetch
  const saved = { tok: process.env.GRAPE_API_TOKEN, base: process.env.GRAPE_BASE_URL, auth: process.env.GRAPE_AUTH_FILE }
  let captured = null
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), method: opts.method, body: JSON.parse(opts.body) }
    return new Response(JSON.stringify({ seq: 90, agent: captured.body.agent, status: 'running' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  process.env.GRAPE_API_TOKEN = 'grape_fake'
  process.env.GRAPE_BASE_URL = 'https://env.example'
  delete process.env.GRAPE_AUTH_FILE
  try {
    assert.deepEqual(AGENT_TYPES, ['vod', 'issue', 'coding', 'qa', 'sre'])
    await api.triggerPipeline('acme', 'demo', 12, '')
    assert.equal(captured.body.agent, 'vod', '不传 agent 时缺省 vod')
    assert.match(captured.url, /\/api\/a2a$/)
    await api.triggerPipeline('acme', 'demo', 12, '', 'qa')
    assert.equal(captured.body.agent, 'qa', 'agent 必须透传到 POST /api/a2a')
    await assert.rejects(
      api.triggerPipeline('acme', 'demo', 12, '', 'nope'),
      (e) => e instanceof GrapeApiError && /非法 agent/.test(e.message) && /vod/.test(e.message),
    )
  } finally {
    globalThis.fetch = origFetch
    if (saved.tok === undefined) delete process.env.GRAPE_API_TOKEN; else process.env.GRAPE_API_TOKEN = saved.tok
    if (saved.base === undefined) delete process.env.GRAPE_BASE_URL; else process.env.GRAPE_BASE_URL = saved.base
    if (saved.auth === undefined) delete process.env.GRAPE_AUTH_FILE; else process.env.GRAPE_AUTH_FILE = saved.auth
  }
})

test('Issue #17：worker_onboard 地址与 getBaseUrl() 同源（env / 文件通道，无需 GRAPE_BASE_URL）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-onboard-'))
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, JSON.stringify({ token: 'grape_file', base_url: 'https://file.example' }))
  const saved = { tok: process.env.GRAPE_API_TOKEN, base: process.env.GRAPE_BASE_URL, auth: process.env.GRAPE_AUTH_FILE }
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_worker_onboard')
  const apiModule = { workerCredentialCreate: async () => ({ token: 'rta_x' }) }
  try {
    // 文件通道：只有 token+base_url，没有 GRAPE_BASE_URL
    process.env.GRAPE_AUTH_FILE = cfg
    delete process.env.GRAPE_BASE_URL
    delete process.env.GRAPE_API_TOKEN
    const byFile = await t.run({ device_name: 'probe' }, { runGrape: null, apiModule })
    assert.match(byFile.install_command, /curl -sSL https:\/\/file\.example\/api\/runtime\/install/)
    assert.match(byFile.install_command, /--server https:\/\/file\.example/)

    // env 通道：显式 GRAPE_BASE_URL 优先
    process.env.GRAPE_BASE_URL = 'https://env.example'
    const byEnv = await t.run({ device_name: 'probe' }, { runGrape: null, apiModule })
    assert.match(byEnv.install_command, /--server https:\/\/env\.example/)
    assert.equal(getBaseUrl(), 'https://env.example')
  } finally {
    if (saved.tok === undefined) delete process.env.GRAPE_API_TOKEN; else process.env.GRAPE_API_TOKEN = saved.tok
    if (saved.base === undefined) delete process.env.GRAPE_BASE_URL; else process.env.GRAPE_BASE_URL = saved.base
    if (saved.auth === undefined) delete process.env.GRAPE_AUTH_FILE; else process.env.GRAPE_AUTH_FILE = saved.auth
    rmSync(dir, { recursive: true, force: true })
  }
})
