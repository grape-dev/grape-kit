import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, INSTRUCTIONS } from '../src/server.mjs'
import { GrapeApiError, api } from '../src/api.mjs'
import { GrapeCliError } from '../src/cli.mjs'

async function pair(deps) {
  // 环境隔离：屏蔽宿主真实凭据（真实机器会让 native 通道直连成功、绕开注入 mock）
  const savedAuth = process.env.GRAPE_AUTH_FILE
  const savedTok = process.env.GRAPE_API_TOKEN
  process.env.GRAPE_AUTH_FILE = '/nonexistent/grape-kit-test-auth.json'
  delete process.env.GRAPE_API_TOKEN
  const server = createServer(deps)
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [cT, sT] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(sT), client.connect(cT)])
  const origClose = client.close.bind(client)
  client.close = async () => {
    if (savedAuth) process.env.GRAPE_AUTH_FILE = savedAuth; else delete process.env.GRAPE_AUTH_FILE
    if (savedTok) process.env.GRAPE_API_TOKEN = savedTok
    return origClose()
  }
  return client
}

test('initialize 返回 instructions（零调用自举）', async () => {
  const client = await pair()
  const info = client.getServerVersion()
  assert.equal(info.name, 'grape-kit')
  assert.match(INSTRUCTIONS, /只触发、只观察/)
  await client.close()
})

test('tools/list 返回 36 个精选工具', async () => {
  const client = await pair()
  const { tools } = await client.listTools()
  assert.equal(tools.length, 36)
  assert.ok(tools.some((t) => t.name === 'grape_wait_task'))
  await client.close()
})

test('tools/call 走注入的 runGrape 并渲染 Markdown', async () => {
  const client = await pair({
    runGrape: async (args) => {
      assert.deepEqual(args, ['issues', 'list', '--owner', 'acme', '--repo', 'demo'])
      return { json: [{ number: 23, title: '实现登录功能', state: 'open', pipeline_status: 'coding' }] }
    },
  })
  const res = await client.callTool({ name: 'grape_list_issues', arguments: { owner: 'acme', repo: 'demo' } })
  assert.equal(res.isError, undefined)
  assert.match(res.content[0].text, /\| 23 \| 实现登录功能/)
  await client.close()
})

test('tools/call wait 工具带 polls 元信息与超时提示', async () => {
  const client = await pair({
    waitTask: async () => ({ json: { seq: 85, status: 'running' }, polls: 7, elapsedMs: 300, timedOut: true }),
  })
  const res = await client.callTool({ name: 'grape_wait_task', arguments: { seq: 85 } })
  assert.match(res.content[0].text, /超时/)
  assert.match(res.content[0].text, /\\[(RUN|running)\\]|执行中/)
  await client.close()
})

test('未知工具与 native 401（CLI 回退失败）都走 isError 文本', async () => {
  const client = await pair({
    runGrape: async () => { const e = new Error('HTTP 403'); e.code = 403; throw e },
  })
  const unknown = await client.callTool({ name: 'grape_nope', arguments: {} })
  assert.equal(unknown.isError, true)
  // CLI 回退失败不再吞掉 native 401：仍如实上抛 401（而非 CLI 侧 403 文案）
  const denied = await client.callTool({ name: 'grape_list_issues', arguments: { owner: 'a', repo: 'b' } })
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /Missing token|401/)
  await client.close()
})

test('cancel_issue 走原生 apiModule（undefined 回归 + 新传输层）', async () => {
  const client = await pair({
    runGrape: async () => { throw new Error('CLI 不应被调用（native 通道优先）') },
  })
  const res = await client.callTool({ name: 'grape_cancel_issue', arguments: { owner: 'a', repo: 'b', number: 4 } })
  // 无真实凭据 → native 抛 401，回退 CLI → CLI 不可用 → isError 如实上抛
  // 本测试验证派发优先级：错误信息应来自 native（Missing token）而非 CLI
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Missing token|401/)
  await client.close()
})

test('cancel_issue 有凭据时原生直调成功', async () => {
  // 注入 mock api：绕开真实网络
  const serverMod = await import('../src/server.mjs')
  const fakeApi = {
    issueDetail: async () => ({ issue_id: 11079, number: 4, title: 't' }),
    cancelIssue: async (id) => ({ ok: true, issue_id: id }),
    resumeIssue: async (id) => ({ ok: true, issue_id: id }),
    startIssue: async (id) => ({ ok: true, issue_id: id }),
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const server = serverMod.createServer({})
  const client = new Client({ name: 't', version: '0' })
  const [cT, sT] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(sT), client.connect(cT)])
  // monkeypatch tools.mjs 内部 dynamic import 不可行——改为直接验证 run() 的 apiModule 注入路径
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_cancel_issue')
  const r = await t.run({ owner: 'a', repo: 'b', number: 4 }, { runGrape: null, apiModule: fakeApi })
  assert.deepEqual(r, { ok: true, issue_id: 11079 })
  await client.close()
})

async function withNative(method, impl, fn) {
  const orig = api[method]
  api[method] = impl
  try {
    return await fn()
  } finally {
    api[method] = orig
  }
}

test('native 401 且 CLI 缺失时回抛原始 401：输出 token 指引，不误导安装 CLI', async () => {
  await withNative('taskStatus', async () => {
    throw new GrapeApiError('grape API 401: invalid token', {
      status: 401,
      hint: 'token 无效或过期：在 Grape WebUI → 设置 → API Keys 重新生成，并更新 GRAPE_API_TOKEN / ~/.grape/config.json',
    })
  }, async () => {
    let cliCalled = 0
    const client = await pair({
      runGrape: async () => {
        cliCalled += 1
        throw new GrapeCliError('找不到 grape CLI（bin=grape）', { code: 127 })
      },
    })
    const res = await client.callTool({ name: 'grape_get_task_status', arguments: { seq: 1 } })
    assert.equal(cliCalled, 1)
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /401/)
    assert.match(res.content[0].text, /WebUI → 设置 → API Keys 重新生成/)
    assert.doesNotMatch(res.content[0].text, /安装|pip install/)
    await client.close()
  })
})

test('native 401 且 CLI 可用时沿用 CLI 结果', async () => {
  await withNative('taskStatus', async () => {
    throw new GrapeApiError('Missing token: 请设置 GRAPE_API_TOKEN', { status: 401 })
  }, async () => {
    const client = await pair({
      runGrape: async (args) => {
        assert.deepEqual(args, ['events', 'detail', '--seq', '5'])
        return { json: { seq: 5, status: 'running' } }
      },
    })
    const res = await client.callTool({ name: 'grape_get_task_status', arguments: { seq: 5 } })
    assert.equal(res.isError, undefined)
    assert.match(res.content[0].text, /RUN|running|执行中/)
    await client.close()
  })
})

test('URL 不可达（status 0）不回退 CLI，原错误上抛', async () => {
  await withNative('taskStatus', async () => {
    throw new GrapeApiError('无法连接 https://unreachable.test（ECONNREFUSED）', {
      status: 0,
      hint: '检查 GRAPE_BASE_URL 是否正确 / 网络可达',
    })
  }, async () => {
    let cliCalled = 0
    const client = await pair({
      runGrape: async () => {
        cliCalled += 1
        return { json: { seq: 1, status: 'completed' } }
      },
    })
    const res = await client.callTool({ name: 'grape_get_task_status', arguments: { seq: 1 } })
    assert.equal(cliCalled, 0)
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /grape API 失败（0）/)
    assert.match(res.content[0].text, /网络可达/)
    await client.close()
  })
})
