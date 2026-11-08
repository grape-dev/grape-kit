import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, toolDefs, findTool } from '../src/tools.mjs'
import * as R from '../src/render.mjs'

test('工具面共 13 个且命名规范', () => {
  assert.equal(TOOLS.length, 13)
  for (const t of TOOLS) {
    assert.match(t.name, /^grape_[a-z_]+$/)
    assert.ok(t.description.length > 20, `${t.name} 描述过短`)
    assert.equal(t.schema.type, 'object')
  }
  assert.equal(toolDefs().length, 13)
  assert.ok(findTool('grape_trigger_pipeline'))
  assert.equal(findTool('nope'), null)
})

test('高危/越权命令不在工具面', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const banned of ['terminate', 'delete', 'remove', 'git_repo', 'credential', 'token']) {
    assert.ok(![...names].some((n) => n.includes(banned)), `工具面不应含 ${banned}`)
  }
})

test('trigger 构造 a2a handoff body', () => {
  const t = findTool('grape_trigger_pipeline')
  const args = t.buildArgs({ owner: 'acme', repo: 'demo', issue_number: 12, context: '做登录' })
  assert.deepEqual(args.slice(0, 2), ['a2a', 'handoff'])
  const body = JSON.parse(args[args.indexOf('--json') + 1])
  assert.equal(body.agent, 'vod')
  assert.equal(body.payload.repository, 'acme/demo')
  assert.equal(body.payload.issue_number, 12)
  assert.equal(body.payload.context, '做登录')
})

test('create_issue body 字段为 title/description（服务端契约字段名）', () => {
  const t = findTool('grape_create_issue')
  const args = t.buildArgs({ owner: 'a', repo: 'b', title: 'T', description: '正文' })
  const body = JSON.parse(args[args.indexOf('--json') + 1])
  assert.deepEqual(Object.keys(body), ['title', 'description'])
  assert.ok(!('body' in body), '不得使用 body 字段（服务端 400）')
})

test('wait_task 声明 waitBased', () => {
  assert.equal(findTool('grape_wait_task').waitBased, true)
})

test('render: issues 表格 / pipeline 节点链 / 打回事件', () => {
  const issues = R.renderIssues([{ number: 23, title: '实现登录', state: 'open', pipeline_status: 'coding' }])
  assert.match(issues, /\| # \| 标题 \| 状态 \| 流水线 \|/)
  assert.match(issues, /\| 23 \| 实现登录 \| open \| coding \|/)
  const pipe = R.renderPipeline({ scene: 'default', nodes: [
    { tag: 'vod', status: 'completed' }, { tag: 'coding', status: 'running' },
  ] })
  assert.match(pipe, /\[OK\] vod\(completed\) → \[RUN\] coding\(running\)/)
  const ev = R.renderEventTimeline([{ seq: 91, type: 'issue_comment', agent_type: 'qa', summary: 'PR 打回' }])
  assert.match(ev, /#91.*issue_comment.*qa/)
})

test('render: 非预期结构回退 JSON 不抛错', () => {
  assert.match(R.renderIssues({ weird: 1 }), /```json/)
  assert.doesNotThrow(() => R.fallbackJson(undefined))
})
