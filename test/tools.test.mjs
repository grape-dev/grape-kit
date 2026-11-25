import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TOOLS, toolDefs, findTool } from '../src/tools.mjs'
import * as R from '../src/render.mjs'

test('工具面共 41 个且命名规范', () => {
  assert.equal(TOOLS.length, 41)
  for (const t of TOOLS) {
    assert.match(t.name, /^grape_[a-z_]+$/)
    assert.ok(t.description.length >= 12, `${t.name} 描述过短`)
    assert.equal(t.schema.type, 'object')
  }
  assert.equal(toolDefs().length, 41)
  assert.ok(findTool('grape_trigger_pipeline'))
  assert.equal(findTool('nope'), null)
})

test('高危/越权命令不在工具面', () => {
  const names = new Set(TOOLS.map((t) => t.name))
  for (const banned of ['terminate', 'delete', 'remove', 'git_repo', 'token']) {
    assert.ok(![...names].some((n) => n.includes(banned)), `工具面不应含 ${banned}`)
  }
  // Issue #31：credential 收窄为「一次性本仓券」单一入口，其它 credential 形态仍不得暴露
  for (const n of names) {
    if (n.includes('credential')) assert.equal(n, 'grape_git_credential', `credential 只允许 grape_git_credential，实际 ${n}`)
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
  assert.match(issues, /\| # \| 仓库 \| 标题 \| 状态 \| 进度 \| 节点 \|/, 'issues 表含仓库/进度/节点列')
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

test('render: pipeline segments 事件流形态渲染（真实 API 形态回归）', () => {
  const pipe = R.renderPipeline({
    issue: { number: 45 }, status: 'completed', stalled: true, stalled_minutes: 178,
    segments: [
      { seq: 995049, agent: 'vod', status: 'completed' },
      { seq: 995050, agent: 'issue', status: 'running' },
    ],
  })
  assert.match(pipe, /┌─ 流水线/, '卡片头')
  assert.match(pipe, /✅ vod/, '完成段渲染')
  assert.match(pipe, /🏃 issue/, '运行段渲染')
  assert.match(pipe, /疑似停滞 178 分钟/, '停滞警告透出')
  assert.match(pipe, /```mermaid/, 'Mermaid 图形')
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

/* ── Issue #17：trigger 工具 agent 枚举 + native 透传 ── */

test('trigger 工具 schema 声明 agent 枚举并在 native 透传', async () => {
  const { api } = await import('../src/api.mjs')
  const t = findTool('grape_trigger_pipeline')
  assert.deepEqual(t.schema.properties.agent.enum, ['vod', 'issue', 'coding', 'qa', 'sre'])
  assert.equal(t.schema.properties.agent.default, 'vod')
  const args = t.buildArgs({ owner: 'acme', repo: 'demo', issue_number: 12, agent: 'qa' })
  const body = JSON.parse(args[args.indexOf('--json') + 1])
  assert.equal(body.agent, 'qa', 'CLI 通道同样透传 agent')
  const orig = api.triggerPipeline
  let seen = null
  api.triggerPipeline = async (...a) => { seen = a; return { seq: 1 } }
  try {
    await t.native({ owner: 'acme', repo: 'demo', issue_number: 12, context: '续跑', agent: 'qa' })
  } finally { api.triggerPipeline = orig }
  assert.deepEqual(seen, ['acme', 'demo', 12, '续跑', 'qa'], 'native 必须把 agent 透传给 api.triggerPipeline')
})

test('trigger 工具 CLI 回退通道拒绝非法 agent，与 native 同口径', async () => {
  const { GrapeApiError } = await import('../src/api.mjs')
  const t = findTool('grape_trigger_pipeline')
  const caught = (fn) => { try { fn(); return null } catch (e) { return e } }

  // CLI 通道 buildArgs 若不过枚举校验，会把非法 agent 静默交给服务端（native 已报错，两通道必须一致）
  const cliErr = caught(() => t.buildArgs({ owner: 'acme', repo: 'demo', issue_number: 12, agent: 'pm' }))
  assert.ok(cliErr instanceof GrapeApiError, 'CLI 通道必须在本地就拒绝非法 agent')
  assert.match(cliErr.message, /非法 agent：pm（可用值：vod \/ issue \/ coding \/ qa \/ sre）/)

  // 缺省/空值仍回落到 vod，不因校验把默认路径拒掉
  for (const agent of [undefined, null, '']) {
    const args = t.buildArgs({ owner: 'acme', repo: 'demo', issue_number: 12, agent })
    assert.equal(JSON.parse(args[args.indexOf('--json') + 1]).agent, 'vod', `agent=${agent} 应回落 vod`)
  }

  // native 在发起请求前就报错（校验早于网络），且与 CLI 通道同一份文案，避免两条通道各写一份枚举
  let nativeErr = null
  try { await t.native({ owner: 'acme', repo: 'demo', issue_number: 12, agent: 'pm' }) } catch (e) { nativeErr = e }
  assert.ok(nativeErr instanceof GrapeApiError, 'native 通道必须拒绝非法 agent')
  assert.equal(nativeErr.message, cliErr.message, 'native 与 CLI 回退通道报错必须同源')
})

/* ── Issue #17：审核三工具 native 直调（api.apiRequest 崩溃修复） ── */

function withFakeFetch(handler, fn) {
  const origFetch = globalThis.fetch
  const saved = { tok: process.env.GRAPE_API_TOKEN, base: process.env.GRAPE_BASE_URL, auth: process.env.GRAPE_AUTH_FILE }
  process.env.GRAPE_API_TOKEN = 'grape_fake'
  process.env.GRAPE_BASE_URL = 'https://env.example'
  delete process.env.GRAPE_AUTH_FILE
  globalThis.fetch = handler
  const restore = () => {
    globalThis.fetch = origFetch
    if (saved.tok === undefined) delete process.env.GRAPE_API_TOKEN; else process.env.GRAPE_API_TOKEN = saved.tok
    if (saved.base === undefined) delete process.env.GRAPE_BASE_URL; else process.env.GRAPE_BASE_URL = saved.base
    if (saved.auth === undefined) delete process.env.GRAPE_AUTH_FILE; else process.env.GRAPE_AUTH_FILE = saved.auth
  }
  return Promise.resolve(fn()).finally(restore)
}

test('审核三工具 native 不再崩溃，直调真实端点，描述标注会话级通道', async () => {
  const calls = []
  await withFakeFetch(async (url, opts) => {
    const u = String(url)
    calls.push({ url: u, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
    const payload = u.endsWith('/api/issues/acme/demo') && opts.method === 'GET'
      ? { issues: [{ issue_number: 5, id: 77 }] }
      : { ok: true, issue_number: 5 }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async () => {
    const cases = [
      ['grape_review_pass', { owner: 'acme', repo: 'demo', number: 5, comment: '放行' }, /\/api\/issues\/acme\/demo\/5\/review-pass$/, { comment: '放行' }],
      ['grape_review_reject', { owner: 'acme', repo: 'demo', number: 5, comment: '缺校验' }, /\/api\/issues\/acme\/demo\/5\/review-reject$/, { comment: '缺校验' }],
      ['grape_confirm_done', { owner: 'acme', repo: 'demo', number: 5, confirmation: '已完成' }, /\/api\/issues\/77\/confirm-done$/, { confirmation: '已完成' }],
    ]
    for (const [name, args, pathRe, body] of cases) {
      const t = findTool(name)
      assert.match(t.description, /tk_|会话级/, `${name} 描述必须标注真实可用通道`)
      calls.length = 0
      await t.native(args)
      const post = calls.find((c) => c.method === 'POST')
      assert.ok(post, `${name} 应发出 POST`)
      assert.match(post.url, pathRe, `${name} endpoint`)
      assert.deepEqual(post.body, body, `${name} body`)
    }
  })
})

test('审核工具 403 抛出带修复动作的通道提示', async () => {
  await withFakeFetch(
    async () => new Response(JSON.stringify({ detail: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }),
    async () => {
      const { GrapeApiError } = await import('../src/api.mjs')
      await assert.rejects(
        findTool('grape_review_pass').native({ owner: 'a', repo: 'b', number: 1 }),
        (e) => e instanceof GrapeApiError && e.status === 403 && /tk_|会话级/.test(e.hint),
      )
    },
  )
})

/* ── Issue #29：grape_get_skill_detail 去 3000 字静默截断 ── */

/** 落盘目录快照（前缀 grape-kit-skill-），用于「未超阈值不落盘」的分档断言，与用例顺序无关 */
const dumpSnap = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('grape-kit-skill-')))

test('#29 skill_detail >3000 字全文直出，可读到结尾标记', () => {
  const t = findTool('grape_get_skill_detail')
  const body = `${'技能正文 filler line\n'.repeat(300)}ENDING-MARKER-29`
  assert.ok(body.length > 3000, '用例前提：正文 >3000 字')
  assert.ok(Buffer.byteLength(body, 'utf8') <= 65536, '用例前提：正文 ≤64KB')
  const before = dumpSnap()
  const out = t.render({ skill_id: 's1', name: 'demo-skill', content: body })
  assert.match(out, /^### demo-skill\n\n/, '标题行保持原渲染风格')
  assert.ok(out.includes('ENDING-MARKER-29'), '>3000 字的结尾标记必须可读（不得静默截断）')
  assert.ok(out.includes(body), '≤64KB 应全文直出')
  assert.ok(!out.includes('已截断'), '未截断不得出现截断标注')
  assert.deepEqual(dumpSnap(), before, '≤64KB 不落盘')
})

test('#29 skill_detail >64KB 落盘临时文件，返回路径 + 前 2000 字预览并显式标注', () => {
  const t = findTool('grape_get_skill_detail')
  // 22000 个汉字 = 66000 字节 > 65536，而字符数 < 65536：阈值必须按 UTF-8 字节判定
  const body = `${'技'.repeat(22000)}TAIL-CHN`
  const bytes = Buffer.byteLength(body, 'utf8')
  assert.ok(bytes > 65536 && body.length < 65536, '用例前提：字节超阈值而字符数未超')
  const before = dumpSnap()
  const out = t.render({ skill_id: 'big', name: 'big-skill', content: body })
  const m = /已截断，全文在 (.+?)（共 (\d+) 字节）/.exec(out)
  assert.ok(m, '必须显式标注「已截断，全文在 <path>」并给出字节数')
  const [, path, bytesInNotice] = m
  assert.ok(dumpSnap().size > before.size, '超阈值必须落盘')
  assert.ok(existsSync(path), `临时文件应存在：${path}`)
  assert.equal(bytesInNotice, String(bytes), '标注的字节数口径为 UTF-8 字节')
  assert.equal(readFileSync(path, 'utf8'), body, '落盘内容与 API 返回逐字节一致')
  assert.ok(out.includes(body.slice(0, 2000)), '含前 2000 字预览')
  assert.ok(!out.includes(body.slice(0, 2001)), '预览恰好 2000 字，不全量透出')
})

test('#29 skill_detail 恰为 65536 字节（64KB 边界）全文直出且不落盘', () => {
  const t = findTool('grape_get_skill_detail')
  const body = `${'x'.repeat(65531)}BOUND`
  assert.equal(Buffer.byteLength(body, 'utf8'), 65536, '用例前提：恰好 65536 字节')
  const before = dumpSnap()
  const out = t.render({ skill_id: 'edge', name: 'edge-skill', content: body })
  assert.ok(out.includes(body), '边界值应全文直出')
  assert.ok(!out.includes('已截断'), '边界值不得出现截断标注')
  assert.deepEqual(dumpSnap(), before, '边界值不落盘')
})
