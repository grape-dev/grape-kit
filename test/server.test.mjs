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
  assert.equal(tools.length, 13)
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
