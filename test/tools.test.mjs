import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOLS, toolDefs, findTool } from '../src/tools.mjs'
import * as R from '../src/render.mjs'

test('工具面共 45 个且命名规范', () => {
  assert.equal(TOOLS.length, 45)
  for (const t of TOOLS) {
    assert.match(t.name, /^grape_[a-z_]+$/)
    assert.ok(t.description.length >= 12, `${t.name} 描述过短`)
    assert.equal(t.schema.type, 'object')
  }
  assert.equal(toolDefs().length, 45)
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
  // Issue #27 的三个写工具（upgrade/install/uninstall）同属用户决策层，必须纳入同一张断言表，
  // 否则「新增写工具」只需绕开这张表就能省掉确认纪律（QA SJ8）。
  for (const name of [
    'grape_cancel_issue', 'grape_resume_issue', 'grape_start_issue', 'grape_host_repo', 'grape_apply_scene', 'grape_create_project',
    'grape_kit_upgrade', 'grape_kit_install', 'grape_kit_uninstall',
  ]) {
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

/* ── Issue #27：自管理五工具（读直执行 / 写只生成命令） ──
 * Seam = MCP 工具公开面（tools/list 定义 + run() 返回值 + render() Markdown），
 * 全部走注入 fake lifecycle，不联网、不读真实宿主配置。 */

const LIFECYCLE_TOOLS = ['grape_kit_version', 'grape_kit_check_update', 'grape_kit_upgrade', 'grape_kit_install', 'grape_kit_uninstall']

/** 注入用 fake lifecycle：默认给「一切正常」的答案，用例按需覆盖单个函数 */
function fakeLifecycle(over = {}) {
  const calls = { aggregateVersion: 0, checkForUpdate: 0, detectInstallForm: 0, detectHostStatus: 0, readKitVersion: 0 }
  const base = {
    readKitVersion: () => { calls.readKitVersion++; return '0.4.0' },
    async aggregateVersion() { calls.aggregateVersion++; return {
      kitVersion: '0.4.0', latestVersion: '0.5.0', updateAvailable: true, updateState: 'newer',
      updateNotice: '有新版本 0.4.0 → 0.5.0（npm i -g @grape-dev/grape-kit 更新；npx 用户下次拉取即最新）',
      grapeCli: { status: 'ok', bin: 'grape', version: 'grape 0.3.4' },
      server: { baseUrl: 'https://grape.test', reachable: true, contractVersion: '2.1.0' },
      credentials: { configured: true, sourceKind: 'env', source: '环境变量 GRAPE_API_TOKEN', hint: '' },
    } },
    async checkForUpdate(a) { calls.checkForUpdate++; return {
      currentVersion: '0.4.0', latestVersion: '0.5.0', state: a?.dismiss ? 'dismissed' : 'newer',
      updateAvailable: !a?.dismiss, dismissed: !!a?.dismiss,
      dismiss: a?.dismiss ? { version: a.dismissVersion || '0.5.0', at: 0, file: '~/.grape/grape-kit-dismiss.json' } : null,
      updateNotice: a?.dismiss ? '0.5.0 已被用户忽略，冷却至 3 天后（新版本出现会重新提醒）' : '有新版本 0.4.0 → 0.5.0',
    } },
    detectInstallForm() { calls.detectInstallForm++; return {
      form: 'npx', pkgPath: '/h/.npm/_npx/a/node_modules/@grape-dev/grape-kit',
      evidence: '包路径位于 npx 缓存下（npx 临时安装，非全局）',
      upgradeCommand: 'npx -y -p @grape-dev/grape-kit@latest grape-kit-mcp',
      guidance: 'npx 缓存运行形态：上面的命令强制拉 @latest',
      restartHint: '升级/安装完成后需重启宿主会话才加载新版本',
    } },
    detectHostStatus() { calls.detectHostStatus++; return [
      { host: 'opencode', label: 'opencode', state: 'installed', installed: true, path: '/h/.config/opencode/opencode.jsonc', entry: 'mcp.grape', skillsDir: '/h/.config/opencode/skills', evidence: 'mcp.grape 条目存在' },
      { host: 'workbuddy', label: 'workbuddy', state: 'absent', installed: false, path: '/h/.workbuddy/mcp.json', entry: 'mcpServers.grape-kit', skillsDir: '/h/.workbuddy/skills' },
      { host: 'codearts', label: 'codearts', state: 'missing', installed: false, path: '/h/.codeartsdoer/codearts_cli.jsonc', entry: 'mcp.grape-kit', skillsDir: '' },
      { host: 'officeace', label: 'officeace', state: 'missing', installed: false, path: '/h/.officeace/mcp.json', entry: 'mcpServers.grape-kit', skillsDir: '' },
      { host: 'dsh', label: 'dsh', state: 'missing', installed: false, path: '/h/.dsh/profiles/web/cordis.patch.yml', entry: '托管块 id: grape-kit', skillsDir: '/h/.dsh/skills' },
    ] },
  }
  return Object.assign(base, over, { calls })
}

test('S5 自管理五工具已注册，命名与既有 grape_ 前缀分区一致', () => {
  for (const name of LIFECYCLE_TOOLS) {
    const t = findTool(name)
    assert.ok(t, `${name} 应已注册`)
    assert.equal(typeof t.run, 'function', `${name} 走 run() 自持通道（不占用 buildArgs/native）`)
    assert.equal(typeof t.render, 'function')
    assert.ok(t.description.length >= 12)
  }
  // 写工具必须在描述里写明用户确认纪律（与既有决策层工具同口径）
  for (const name of ['grape_kit_upgrade', 'grape_kit_install', 'grape_kit_uninstall']) {
    assert.match(findTool(name).description, /用户确认|征得用户同意|决策层/, `${name} 描述缺确认纪律`)
  }
})

test('S5 grape_kit_version：单次调用返回版本全景（只读直执行）', async () => {
  const L = fakeLifecycle()
  const t = findTool('grape_kit_version')
  const out = await t.run({}, { lifecycle: L })
  assert.equal(L.calls.aggregateVersion, 1, '必须一次聚合拿全量字段')
  const md = t.render(out)
  assert.match(md, /版本全景/)
  assert.match(md, /0\.4\.0/)
  assert.match(md, /0\.5\.0/)
  assert.match(md, /grape 0\.3\.4/, 'CLI 版本透出')
  assert.match(md, /2\.1\.0/, '契约版本透出')
  assert.match(md, /环境变量 GRAPE_API_TOKEN/, '凭据来源档位透出')
  assert.match(md, /只读/, '明确标注只读，避免被当变更入口')
})

test('S5 grape_kit_check_update：dismiss 透传并把「已忽略」讲清楚', async () => {
  const L = fakeLifecycle()
  const t = findTool('grape_kit_check_update')
  const newer = t.render(await t.run({}, { lifecycle: L }))
  assert.match(newer, /有新版本/)
  const dismissed = t.render(await t.run({ dismiss: true, dismissVersion: '0.5.0' }, { lifecycle: L }))
  assert.match(dismissed, /忽略/, '忽略后不得再说「有新版本」')
  assert.equal(L.calls.checkForUpdate, 2)
})

test('S5 grape_kit_upgrade：只生成可复制命令 + 决策门 + 重启提示，不执行', async () => {
  const L = fakeLifecycle()
  let execCount = 0
  const spy = async () => { execCount++; throw new Error('写工具不得执行任何命令') }
  const t = findTool('grape_kit_upgrade')
  const json = await t.run({}, { lifecycle: L, runGrape: spy, apiModule: spy })
  const md = t.render(json)
  assert.match(md, /```bash/)
  assert.match(md, /npx -y -p @grape-dev\/grape-kit@latest grape-kit-mcp/)
  assert.match(md, /⚠️/)
  assert.match(md, /重启宿主会话/)
  assert.match(md, /npx 缓存/, '安装形态与检出依据要透出')
  assert.equal(execCount, 0, '写工具不得有静默执行路径')
})

test('S5 grape_kit_upgrade：本地依赖/未知形态不给自动命令，只给手动指引', async () => {
  const L = fakeLifecycle({
    detectInstallForm: () => ({
      form: 'local', pkgPath: '/p/node_modules/@grape-dev/grape-kit', evidence: '项目 node_modules 下',
      upgradeCommand: null, guidance: '用项目自身包管理器升级（npm i @grape-dev/grape-kit@latest）', restartHint: '升级后重启宿主会话',
    }),
  })
  const t = findTool('grape_kit_upgrade')
  const md = t.render(await t.run({}, { lifecycle: L }))
  assert.match(md, /项目自身包管理器|npm i @grape-dev\/grape-kit@latest/)
  assert.doesNotMatch(md, /```bash/, '没有可靠命令时不得凭空给命令块')
})

test('S5 grape_kit_install：已装配跳过，只为未装配生成命令', async () => {
  const L = fakeLifecycle()
  const t = findTool('grape_kit_install')
  const json = await t.run({ target: 'all' }, { lifecycle: L })
  assert.deepEqual(json.commands, [
    'npx -y @grape-dev/grape-kit install --target workbuddy',
    'npx -y @grape-dev/grape-kit install --target codearts',
    'npx -y @grape-dev/grape-kit install --target officeace',
    'npx -y @grape-dev/grape-kit install --target dsh',
  ], '只给未装配宿主生成命令（opencode 已装 → 跳过）')
  assert.deepEqual(json.skipped, ['opencode'])
  const md = t.render(json)
  assert.match(md, /宿主/)
  assert.match(md, /已装配|跳过/)
  assert.match(md, /```bash/)
  assert.match(md, /install --target codearts/)
  assert.match(md, /用户确认/, '必须带决策门')
})

test('S5 grape_kit_install：单一 target 与非法 target', async () => {
  const L = fakeLifecycle()
  const t = findTool('grape_kit_install')
  const one = await t.run({ target: 'codearts' }, { lifecycle: L })
  assert.deepEqual(one.commands, ['npx -y @grape-dev/grape-kit install --target codearts'])
  const bad = await t.run({ target: 'nope' }, { lifecycle: L })
  assert.match(t.render(bad), /不支持的宿主|可用/, '非法 target 要给出可用值，不静默回落')
})

test('S5 grape_kit_uninstall：强决策门 + 影响预览（只列不删）+ --dry-run 指引', async () => {
  const L = fakeLifecycle({
    detectHostStatus: () => ([
      { host: 'opencode', label: 'opencode', state: 'installed', installed: true, path: '/h/.config/opencode/opencode.jsonc', entry: 'mcp.grape', skillsDir: '/h/.config/opencode/skills' },
      { host: 'workbuddy', label: 'workbuddy', state: 'absent', installed: false, path: '/h/.workbuddy/mcp.json', entry: 'mcpServers.grape-kit', skillsDir: '/h/.workbuddy/skills' },
    ]),
  })
  const t = findTool('grape_kit_uninstall')
  const json = await t.run({ target: 'opencode' }, { lifecycle: L })
  assert.deepEqual(json.commands, ['npx -y @grape-dev/grape-kit uninstall --target opencode'])
  assert.ok(json.effects.some((e) => /mcp\.grape/.test(e) && /opencode\.jsonc/.test(e)), '影响预览要指名条目与文件')
  assert.ok(json.effects.some((e) => /skills/.test(e)), 'skill 副本也要列出')
  const md = t.render(json)
  assert.match(md, /--dry-run/, '附手动预览指引')
  assert.match(md, /卸载会移除|逐条确认/, '强决策门文案')
  assert.match(md, /```bash/)
})

/* ── QA 复审（PR #21）Q3：damaged 宿主不得照给命令（表内写「先修复」、命令块却照给，实跑必被 CLI 拒） ──
 * CLI 侧 install 对解析失败的配置 `exit 1`（`请先修复或移走该文件后重试`），
 * 所以生成的命令是「用户照抄必失败」的假动作——计划必须把 damaged 单列成「先修复」而不是可执行命令。 */

const DAMAGED_ROW = {
  host: 'workbuddy', label: 'workbuddy', state: 'damaged', installed: false,
  path: '/h/.workbuddy/mcp.json', entry: 'mcpServers.grape-kit', skillsDir: '/h/.workbuddy/skills',
  error: 'Unexpected token } in JSON at position 12',
}
const INSTALLED_OPENCODE = {
  host: 'opencode', label: 'opencode', state: 'installed', installed: true,
  path: '/h/.config/opencode/opencode.jsonc', entry: 'mcp.grape', skillsDir: '/h/.config/opencode/skills', evidence: 'mcp.grape 条目存在',
}
/** 五宿主全量夹具（target=all 逐宿主处理，缺行会走 missing 默认值 → 断言不确定，故一律给全） */
const fiveRows = ({ workbuddy = DAMAGED_ROW } = {}) => ([
  INSTALLED_OPENCODE,
  workbuddy,
  { host: 'codearts', label: 'codearts', state: 'absent', installed: false, path: '/h/.codeartsdoer/codearts_cli.jsonc', entry: 'mcp.grape-kit', skillsDir: '' },
  { host: 'officeace', label: 'officeace', state: 'missing', installed: false, path: '/h/.officeace/mcp.json', entry: 'mcpServers.grape-kit', skillsDir: '' },
  { host: 'dsh', label: 'dsh', state: 'missing', installed: false, path: '/h/.dsh/profiles/web/cordis.patch.yml', entry: '托管块 id: grape-kit', skillsDir: '/h/.dsh/skills' },
])

test('Q3 grape_kit_install：damaged 宿主不生成命令，单列「先修复」并带出解析错误', async () => {
  const L = fakeLifecycle({ detectHostStatus: () => fiveRows() })
  const t = findTool('grape_kit_install')
  const json = await t.run({ target: 'all' }, { lifecycle: L })
  assert.deepEqual(json.commands, [
    'npx -y @grape-dev/grape-kit install --target codearts',
    'npx -y @grape-dev/grape-kit install --target officeace',
    'npx -y @grape-dev/grape-kit install --target dsh',
  ], '只给真正可装配的宿主生成命令（damaged 的 workbuddy 不得在列——实跑必被 CLI 拒）')
  assert.deepEqual((json.blocked || []).map((b) => b.host), ['workbuddy'], 'damaged 宿主单列 blocked')
  assert.ok(!json.skipped.includes('workbuddy'), 'damaged 不算「已装配跳过」，否则用户以为无需动作')
  assert.deepEqual(json.skipped, ['opencode'], '已装配的宿主才是 skipped')
  assert.match(json.blocked[0].error, /Unexpected token/, 'blocked 要带出解析错误，用户才知道修什么')
  const md = t.render(json)
  assert.match(md, /先修复/, '渲染要给出先修复的动作')
  assert.match(md, /Unexpected token/, '渲染要透出解析错误')
  assert.doesNotMatch(md, /install --target workbuddy/, '命令块不得出现被 CLI 拒绝的命令')
})

test('Q3 grape_kit_uninstall：damaged 宿主同样不生成命令（无从判定条目，先修复）', async () => {
  const L = fakeLifecycle({ detectHostStatus: () => fiveRows() })
  const t = findTool('grape_kit_uninstall')
  const json = await t.run({ target: 'all' }, { lifecycle: L })
  assert.deepEqual(json.commands, ['npx -y @grape-dev/grape-kit uninstall --target opencode'])
  assert.deepEqual((json.blocked || []).map((b) => b.host), ['workbuddy'])
  assert.deepEqual(json.skipped, ['codearts', 'officeace', 'dsh'], '未装配的宿主照旧跳过')
  const md = t.render(json)
  assert.match(md, /先修复/)
  assert.doesNotMatch(md, /uninstall --target workbuddy/)
})

/* ── QA 复审（PR #21）SJ4：版本全景「服务端」一行的四层三元链抽成小函数 ──
 * 先补三个分支的渲染特征（未探测/不可达/可达无契约版本），重构时用它守住文案不漂。 */
const SERVER_VARIANTS = [
  {
    name: '无凭据跳过探测：说「未探测（缺凭据）」，不说「不可达」',
    server: { baseUrl: 'https://grape.test', reachable: false, probe: 'skipped', reason: '未配置凭据，跳过连通性探测', contractVersion: '2.3.0' },
    v: /未探测（缺凭据）https:\/\/grape\.test/,
    note: [/未配置凭据/, /契约版本 2\.3\.0/],
    noNote: [/不可达/],
  },
  {
    name: '不可达：带错误与 hint，契约版本照常透出',
    server: { baseUrl: 'https://grape.test', reachable: false, error: 'connect ECONNREFUSED', hint: '检查 GRAPE_BASE_URL', contractVersion: '2.3.0' },
    v: /不可达 https:\/\/grape\.test/,
    note: [/connect ECONNREFUSED/, /（检查 GRAPE_BASE_URL）/, /契约版本 2\.3\.0/],
    noNote: [/未探测/],
  },
  {
    name: '可达但契约端点拿不到：明说「未取到」，不伪造版本',
    server: { baseUrl: 'https://grape.test', reachable: true },
    v: /可达 https:\/\/grape\.test/,
    note: [/契约版本未取到/],
    // 第三分支的备注本就含「（404/不可达时省略）」字样，故不在此断言 noNote
    noNote: [],
  },
]

for (const variant of SERVER_VARIANTS) {
  test(`SJ4 grape_kit_version 服务端行：${variant.name}`, async () => {
    const L = fakeLifecycle({
      aggregateVersion: async () => ({
        kitVersion: '0.4.0', latestVersion: '0.5.0', updateAvailable: true, updateState: 'newer',
        updateNotice: '有新版本 0.4.0 → 0.5.0',
        grapeCli: { status: 'missing', bin: 'grape', version: '', hint: '未安装（可选：pip install grape-cli）' },
        server: variant.server,
        credentials: { configured: true, sourceKind: 'env', source: '环境变量 GRAPE_API_TOKEN', hint: '' },
      }),
    })
    const t = findTool('grape_kit_version')
    const md = t.render(await t.run({}, { lifecycle: L }))
    assert.match(md, variant.v, '值列文案')
    for (const re of variant.note) assert.match(md, re, '备注列必须带出该分支的信息')
    for (const re of variant.noNote) assert.doesNotMatch(md, re, '不得混入其它分支的文案')
  })
}

/* ── QA 第 3 轮（PR #21）Q4/Q5/Q6：dismiss 状态在渲染面必须如实 ── */

test('Q4 grape_kit_check_update：落盘失败渲染「记录失败（路径不可写）」，不得虚报「已记录」', async () => {
  const L = fakeLifecycle({
    async checkForUpdate() {
      return {
        currentVersion: '0.4.0', latestVersion: '0.5.0', state: 'newer', updateAvailable: true, dismissed: false,
        dismiss: { version: '0.5.0', at: 0, file: '/h/.grape/grape-kit-dismiss.json', ok: false, error: 'ENOTDIR: not a directory, mkdir /h/not-a-dir/.grape' },
        updateNotice: '有新版本 0.4.0 → 0.5.0（npm i -g @grape-dev/grape-kit 更新）',
      }
    },
  })
  const t = findTool('grape_kit_check_update')
  const md = t.render(await t.run({ dismiss: true }, { lifecycle: L }))
  assert.match(md, /记录失败/, '写盘失败必须显式报失败')
  assert.match(md, /路径不可写|ENOTDIR/, '带出失败原因与路径')
  assert.doesNotMatch(md, /已记录忽略版本/, '虚报成功会让用户下次启动被同样提醒')
  assert.doesNotMatch(md, /3 天内不再提示/, '未生效的冷却不得承诺')
})

test('Q5 grape_kit_check_update：无版本可记时渲染「未记录」并给 dismissVersion 指引', async () => {
  const L = fakeLifecycle({
    async checkForUpdate() {
      return {
        currentVersion: '0.4.0', latestVersion: '', state: 'unavailable', updateAvailable: false, dismissed: false,
        dismiss: null,
        dismissSkipped: '未取到 npm 最新版且未指定 dismissVersion：registry 不可达时请显式传 dismissVersion 再试',
        updateNotice: '检测不可用（npm registry 不可达或响应异常），不影响工具可用性',
      }
    },
  })
  const t = findTool('grape_kit_check_update')
  const md = t.render(await t.run({ dismiss: true }, { lifecycle: L }))
  assert.match(md, /未记录/, '没记成就不能沉默，否则用户以为已忽略')
  assert.match(md, /dismissVersion/, '给出可执行的补救参数')
  assert.doesNotMatch(md, /3 天内不再提示/, '不得承诺未落盘的冷却')
})

test('Q6 grape_kit_version：dismiss 冷却中渲染「已忽略」，不得再说「有可用更新」或「已是最新」', () => {
  const t = findTool('grape_kit_version')
  const md = t.render({
    kitVersion: '0.4.0', latestVersion: '0.5.0', updateAvailable: false, updateState: 'dismissed',
    updateNotice: '0.5.0 已被用户忽略，冷却至 2026-11-27T12:00:00.000Z（新版本出现会重新提醒）',
    grapeCli: { status: 'ok', bin: 'grape', version: 'grape 0.3.4' },
    server: { baseUrl: 'https://grape.test', reachable: true, contractVersion: '2.1.0' },
    credentials: { configured: true, sourceKind: 'env', source: '环境变量 GRAPE_API_TOKEN', hint: '' },
  })
  assert.match(md, /已忽略|忽略/, 'dismiss 后全景与 check_update 必须同口径')
  assert.doesNotMatch(md, /有可用更新/, '已忽略的版本不得再标「有可用更新」')
  assert.doesNotMatch(md, /已是最新/, '被忽略不等于已是最新：两者是不同结论')
})

/* ── QA 第 3 轮（PR #21）SJ5/SJ8：命令生成面与决策门口径 ── */

test('SJ5 目标宿主全为 damaged：空命令文案说「配置损坏待修复」，不再说「均为相反状态」', async () => {
  const L = fakeLifecycle({ detectHostStatus: () => fiveRows() })
  const t = findTool('grape_kit_install')
  const json = await t.run({ target: 'workbuddy' }, { lifecycle: L })
  assert.deepEqual(json.commands, [], 'damaged 宿主不生成命令')
  assert.deepEqual((json.blocked || []).map((b) => b.host), ['workbuddy'])
  const md = t.render(json)
  assert.doesNotMatch(md, /均为相反状态/, '真实原因是 blocked（配置损坏），不是「状态相反」')
  assert.match(md, /配置损坏|先修复/, '空命令时必须指出真正的阻塞原因与修复动作')
})


