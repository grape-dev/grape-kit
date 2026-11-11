import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer, INSTRUCTIONS } from '../src/server.mjs'

async function pair(deps) {
  const server = createServer(deps)
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [cT, sT] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(sT), client.connect(cT)])
  return client
}

test('initialize 返回 instructions（零调用自举）', async () => {
  const client = await pair()
  const info = client.getServerVersion()
  assert.equal(info.name, 'grape-kit')
  assert.match(INSTRUCTIONS, /只触发、只观察/)
  await client.close()
})

test('tools/list 返回 13 个精选工具', async () => {
  const client = await pair()
  const { tools } = await client.listTools()
  assert.equal(tools.length, 31)
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
  assert.match(res.content[0].text, /running/)
  await client.close()
})

test('未知工具与 CLI 错误都走 isError 文本', async () => {
  const client = await pair({
    runGrape: async () => { const e = new Error('HTTP 403'); e.code = 403; throw e },
  })
  const unknown = await client.callTool({ name: 'grape_nope', arguments: {} })
  assert.equal(unknown.isError, true)
  const denied = await client.callTool({ name: 'grape_list_issues', arguments: { owner: 'a', repo: 'b' } })
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /session_only|403/)
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
