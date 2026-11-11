import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCredentials, apiRequest, GrapeApiError, waitTaskNative, api } from '../src/api.mjs'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
