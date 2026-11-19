import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, toolDefs, findTool } from '../src/tools.mjs'
import * as R from '../src/render.mjs'

test('工具面共 36 个且命名规范', () => {
  assert.equal(TOOLS.length, 36)
  for (const t of TOOLS) {
    assert.match(t.name, /^grape_[a-z_]+$/)
    assert.ok(t.description.length >= 12, `${t.name} 描述过短`)
    assert.equal(t.schema.type, 'object')
  }
  assert.equal(toolDefs().length, 36)
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
  assert.match(issues, /\| # \| 标题 \| 状态 \| 进度 \| 节点 \|/, 'issues 表含新进度/节点列')
  assert.match(issues, /\| 23 \|/, '行数据仍在')
  assert.match(issues, /●/, '进度点阵渲染')
  const pipe = R.renderPipeline({ scene: 'default', nodes: [
    { tag: 'vod', status: 'completed' }, { tag: 'coding', status: 'running' },
  ] })
  assert.match(pipe, /┌─ 流水线：default/, '竖排状态卡头')
  assert.match(pipe, /✅ vod .*\[OK\]/, '完成节点图标+标签')
  assert.match(pipe, /🏃 coding .*\[RUN\]/, '运行节点图标+标签')
  assert.match(pipe, /当前：coding 执行中/, '判读行')
  assert.match(pipe, /```mermaid/, '附 Mermaid 图形')
  const ev = R.renderEventTimeline([{ seq: 91, type: 'issue_comment', agent_type: 'qa', summary: 'PR 打回' }])
  assert.match(ev, /#91.*issue_comment.*qa/)
})

test('render: 非预期结构回退 JSON 不抛错', () => {
  assert.match(R.renderIssues({ weird: 1 }), /```json/)
  assert.doesNotThrow(() => R.fallbackJson(undefined))
})

test('决策层工具描述强制「需用户确认」', () => {
  for (const name of ['grape_cancel_issue', 'grape_resume_issue', 'grape_start_issue', 'grape_host_repo', 'grape_apply_scene', 'grape_create_project']) {
    const t = findTool(name)
    assert.ok(t, `${name} 存在`)
    assert.match(t.description, /用户决策层.*确认|必须向用户确认|未选择不得执行/, `${name} 描述缺确认纪律`)
  }
})

test('takeover 渲染：归一化日志 + 无任务提示', () => {
  const t = findTool('grape_takeover_context')
  const withTask = t.render({
    task_id: 't1', agent_type: 'coding', skill: 'implementation', status: 'running',
    messages: [
      { type: 'step_start', content: '节点开始' },
      { type: 'tool_use', tool: 'shell', content: 'npm test' },
      { type: 'step_finish' },
    ],
    prompt: '实现登录',
  })
  assert.match(withTask, /接管上下文（task t1）/)
  assert.match(withTask, /\[工具调用\] shell: npm test/)
  assert.ok(!withTask.includes('step_finish'), '噪声类型应被剔除')
  const empty = t.render({ error: '没有找到正在运行的任务' })
  assert.match(empty, /无正在运行的任务/)
})

test('worker_onboard 渲染出可见安装命令', () => {
  const t = findTool('grape_worker_onboard')
  const out = t.render({
    onboard: 'ready', device: 'grape-kit-x',
    install_command: 'curl -sSL https://grapedev.cn/api/runtime/install | bash -s -- --token RTA --device grape-kit-x',
    note: 'note-text',
  })
  assert.match(out, /```bash/)
  assert.match(out, /--token RTA/)
})
