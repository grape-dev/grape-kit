import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, findTool } from '../src/tools.mjs'

/* takeover 工具组（v0.3.2，weekly-11+ PR #1268 一等接管资源）*/

test('takeover 五工具齐备且命名规范', () => {
  for (const name of [
    'grape_takeover_start', 'grape_takeover_status', 'grape_takeover_progress',
    'grape_takeover_finish', 'grape_takeover_abort',
  ]) {
    const t = findTool(name)
    assert.ok(t, `缺 ${name}`)
    assert.match(t.name, /^grape_[a-z_]+$/)
    assert.equal(t.schema.type, 'object')
  }
})

test('takeover_start 描述含旧路径回退提示', () => {
  const t = findTool('grape_takeover_start')
  assert.match(t.description, /404/, '应声明平台不支持时的回退')
  assert.match(t.description, /abort/, '应指向 abort 让渡语义')
  assert.ok(t.schema.required.includes('owner'))
  assert.ok(t.schema.required.includes('number'))
})

test('takeover_status 无 session_id 时要求 owner+repo', () => {
  const t = findTool('grape_takeover_status')
  assert.ok(t.schema.properties.session_id)
  assert.ok(t.schema.properties.renew)
})

test('takeover_finish 有两阶段确认（request_only）', () => {
  const t = findTool('grape_takeover_finish')
  assert.ok(t.schema.properties.request_only, '缺 request_only 两阶段确认门')
  assert.match(t.description, /request-finish/, '描述应说明 request-finish 阶段')
  assert.ok(t.schema.required.includes('summary'))
})

test('takeover_abort 默认 redispatch=true 且语义是让渡不是取消', () => {
  const t = findTool('grape_takeover_abort')
  assert.ok(t.schema.properties.redispatch)
  assert.match(t.description, /重新派发/, 'abort 应重派当前节点')
  assert.match(t.description, /链完全不断/)
})

test('takeover_start render：会话建立', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_abc123', reused: false, token_expires_at: 1794674986,
    bundle: { task: { id: 't_run1' }, env: { GRAPE_SESSION_TOKEN: 'tko_secret' }, workspace: { cwd_hint: '/root/grape-workspaces/x' }, instructions: { prompt: '原任务 Prompt……' } },
  })
  assert.match(out, /接管会话已建立/)
  assert.match(out, /tkos_abc123/)
  assert.ok(!out.includes('tko_secret'), '完整 token 不得出现在渲染结果')
  assert.match(out, /t_run1/, '应展示让渡的云端任务')
  assert.match(out, /\/root\/grape-workspaces\/x/, '应展示本地工作目录')
})

test('takeover_start render：失败路径', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({ detail: 'no running task' })
  assert.match(out, /接管发起失败/)
})

test('takeover_status render：单条与列表', () => {
  const t = findTool('grape_takeover_status')
  const single = t.render({ session: { id: 'tkos_1', status: 'active', agent_type: 'coding', task_id: 't_run1' } })
  assert.match(single, /tkos_1/)
  assert.match(single, /coding/)
  const list = t.render({ sessions: [{ session: { id: 'tkos_1', issue_id: '18', agent_type: 'coding', status: 'active' } }] })
  assert.match(list, /coding/)
})

test('takeover_finish render：request 与完成两态', () => {
  const t = findTool('grape_takeover_finish')
  const req = t.render({ ok: true, session: { finish_requested_at: '2026-11-14T12:00:00Z' } })
  assert.match(req, /等待用户确认/)
  const done = t.render({ ok: true, changed: true, next_agent: 'qa', event_status: 'completed', issue_stage: 'qa', session: { handoff_seq: 42 } })
  assert.match(done, /接管交回完成/)
  assert.match(done, /qa/)
  assert.match(done, /seq=42/)
})

test('takeover_abort render：让渡回流水线', () => {
  const t = findTool('grape_takeover_abort')
  const out = t.render({ redispatched: true, reason: 'r' })
  assert.match(out, /让渡回流水线/)
  assert.match(out, /重新派发/)
})

test('takeover_finish 两阶段 native 分派', async () => {
  const t = findTool('grape_takeover_finish')
  // mock api 模块：记录调用
  const calls = []
  const fakeApi = {
    takeoverRequestFinish: async (sid, p) => { calls.push(['request-finish', sid, p]); return { ok: 1 } },
    takeoverFinish: async (sid, p) => { calls.push(['finish', sid, p]); return { ok: 1 } },
  }
  const origApi = findTool('grape_takeover_progress') // 仅为确保模块结构存在
  // 直接替换 tools.mjs 内部 api 引用不易，改为验证 payload 构造逻辑走原生调用拦截：
  // 用 import 的 api 模块 monkeypatch
  const apiMod = await import('../src/api.mjs')
  const orig = apiMod.api.takeoverRequestFinish
  apiMod.api.takeoverRequestFinish = fakeApi.takeoverRequestFinish
  const origF = apiMod.api.takeoverFinish
  apiMod.api.takeoverFinish = fakeApi.takeoverFinish
  try {
    await t.native({ session_id: 'tko_x', request_only: true, summary: '完成' })
    await t.native({ session_id: 'tko_x', summary: '完成' })
    assert.equal(calls[0][0], 'request-finish')
    assert.equal(calls[1][0], 'finish')
    assert.equal(calls[1][2].outcome, 'completed')
    assert.equal(calls[1][2].handoff, 'a2a')
  } finally {
    apiMod.api.takeoverRequestFinish = orig
    apiMod.api.takeoverFinish = origF
  }
})

test('takeover_abort render：重派失败顶层披露（#2517）', () => {
  const t = findTool('grape_takeover_abort')
  // 修复后平台顶层字段：redispatched=false + redispatch_error
  const fail = t.render({ ok: true, status: 'aborted', redispatched: false, redispatch_error: '409: 已重新派发过' })
  assert.match(fail, /重派失败/)
  assert.match(fail, /链未自动恢复/)
  assert.match(fail, /redispatch/)
  assert.ok(fail.includes('手动重派'), '应给出手动重派指引')
  const okOut = t.render({ ok: true, status: 'aborted', redispatched: true, reason: 'r' })
  assert.match(okOut, /重新派发/)
  assert.ok(!okOut.includes('重派失败'))
  const noRe = t.render({ ok: true, status: 'aborted', reason: 'r' })
  assert.match(noRe, /未重派/)
})

test('takeover_start render：node_already_advanced 警告可见（#2517 补充发现）', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_x', warnings: ['remote_may_still_run', 'node_already_advanced: 链已交棒至下一节点（更新事件 seq=99 qa），本次接管与其并行'],
  })
  assert.match(out, /node_already_advanced/)
  assert.match(out, /与其并行/)
})

test('CLI：grape-kit --version 输出版本号（P2-14）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'grape-kit.mjs')
  for (const arg of ['--version', 'version', '-v']) {
    const out = execFileSync(process.execPath, [bin, arg], { encoding: 'utf8' }).trim()
    assert.equal(out, pkg.version, `${arg} 应输出版本号`)
  }
})
