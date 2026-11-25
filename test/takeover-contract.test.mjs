import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiRequest, api, resolveCredentials, hintFor, hostInfo } from '../src/api.mjs'
import { findTool } from '../src/tools.mjs'

/*
 * 接管任务由平台注入 GRAPE_SCENE_ID（takeover.py 组 env 时写入）；#30 起 kit 不再内置
 * 默认场景链猜链，场景链用例必须显式提供场景。这里按真实任务环境建模，避免 CI 无 env
 * 时把「场景链兜底」误判为失败。
 */
process.env.GRAPE_SCENE_ID = process.env.GRAPE_SCENE_ID || 'custom-test-scene'

/*
 * 真实平台契约回归（Issue #12 补强）
 *
 * 几条用例刻意用「平台真实响应形状」而不是手搓的友好形状：
 *  - takeover 错误体是 {ok:false, code, message}，message 是中文散文（不含 agent_mismatch 字样）
 *  - bundle 脚本资产在 bundle.assets.scripts（不是 bundle.scripts），元素是 {filename, ext, mode, exec, content}
 *  - StartBody 认 host_os/host_arch/host_shell（缺省 linux），不上报就拿不到 PowerShell 版脚本
 */

function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

const ISO = { GRAPE_AUTH_FILE: '/nonexistent/takeover-contract-test.json' }

test('409 真实错误体：按 code=agent_mismatch 命中友好提示（message 里没有该字样）', async () => {
  const { srv, port } = await serve((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'agent_mismatch', message: '该任务属于 vod 节点，不是 coding' }))
  })
  try {
    await assert.rejects(
      apiRequest('POST', '/api/takeover/sessions', {
        env: { ...ISO, GRAPE_API_TOKEN: 'grape_fake', GRAPE_BASE_URL: `http://127.0.0.1:${port}` },
        body: {},
      }),
      (e) => {
        assert.equal(e.status, 409)
        assert.equal(e.code, 'agent_mismatch', '平台 code 必须透传到 Error')
        assert.match(e.hint, /当前活跃节点/)
        assert.match(e.hint, /60-120s/)
        return true
      },
    )
  } finally { srv.close() }
})

test('takeover_start 上报宿主 OS/架构/shell（否则服务端永远渲染 posix 脚本）', async () => {
  let body = null
  const { srv, port } = await serve((req, res) => {
    let buf = ''
    req.on('data', (d) => { buf += d })
    req.on('end', () => {
      body = JSON.parse(buf || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, takeover_id: 'tkos_x', bundle: {} }))
    })
  })
  const saved = { ...process.env }
  try {
    process.env.GRAPE_API_TOKEN = 'grape_fake'
    process.env.GRAPE_BASE_URL = `http://127.0.0.1:${port}`
    process.env.GRAPE_AUTH_FILE = ISO.GRAPE_AUTH_FILE
    delete process.env.GRAPE_API_TOKEN_ONCE
    await api.takeoverStart('acme', 'demo', 12, 'coding')
    assert.ok(body, '应发出 start 请求')
    assert.equal(body.platform, 'grape-kit')
    assert.equal(body.host_os, hostInfo().host_os)
    assert.equal(body.host_arch, hostInfo().host_arch)
    assert.ok(body.host_shell, '应上报 host_shell')
  } finally {
    for (const k of ['GRAPE_API_TOKEN', 'GRAPE_BASE_URL', 'GRAPE_AUTH_FILE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
    srv.close()
  }
})

test('takeover_start 渲染平台真实脚本资产：bundle.assets.scripts + {{CWD}} 本地替换', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_x',
    bundle: {
      takeover_id: 'tkos_x',
      workspace: { cwd_hint: '/work/demo' },
      platform: { host_os: 'windows' },
      assets: {
        scripts: [
          { name: 'env', filename: '.grape-takeover-env.ps1', ext: 'ps1', mode: '0600', exec: 'dot-source', content: "$env:GRAPE_AUTH_FILE = '{{CWD}}\\.grape-takeover-token'" },
          { name: 'report', filename: '.grape-takeover-report.ps1', ext: 'ps1', mode: '0700', exec: 'pwsh -File', content: 'param([string]$Message) # {{CWD}}' },
        ],
      },
    },
  })
  assert.match(out, /\.grape-takeover-env\.ps1/, '应渲染平台资产的文件名')
  assert.match(out, /\.grape-takeover-report\.ps1/)
  assert.ok(!out.includes('{{CWD}}'), '不得把字面量占位符留给执行者')
  assert.match(out, /\/work\/demo\\\.grape-takeover-token/, '应替换为实际 CWD')
})

test('文件通道：带 UTF-8 BOM 的 config.json 仍能解析（Windows 记事本）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-bom-'))
  try {
    const f = join(dir, 'config.json')
    writeFileSync(f, '\uFEFF' + JSON.stringify({ token: 'tko_fake_from_bom', base_url: 'https://self.example' }))
    const c = resolveCredentials({ GRAPE_AUTH_FILE: f })
    assert.equal(c.token, 'tko_fake_from_bom')
    assert.equal(c.baseUrl, 'https://self.example')
    assert.match(c.source, /^file:/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hintFor 409 同时认 code 与 detail（兼容旧平台只给散文）', () => {
  assert.match(hintFor(409, { code: 'agent_mismatch' }), /当前活跃节点/)
  assert.match(hintFor(409, { detail: 'agent_mismatch: 非活跃节点' }), /当前活跃节点/)
  assert.equal(hintFor(409, { detail: 'other conflict' }), '')
  assert.match(hintFor(409, { code: 'taken_by_other' }), /10-30s/)
})

/* ── Issue #19：takeover 交回后按场景链派发下一节点（coding→qa「链不断」） ── */

const finishTool = () => findTool('grape_takeover_finish')

/** 真实场景接口形状（`grape scenes detail`）：节点带 next 链接。测试默认给通用开发链。 */
const SCENE_DEFAULT = {
  id: 'custom-test-scene',
  nodes: [
    { id: 'vod', tag: 'vod', next: 'issue' },
    { id: 'issue', tag: 'issue', next: 'coding' },
    { id: 'coding', tag: 'coding', next: 'qa' },
    { id: 'qa', tag: 'qa', next: 'sre' },
    { id: 'sre', tag: 'sre', next: 'done' },
  ],
}

/** 挂起 api.takeoverFinish / api.triggerPipeline / api.takeoverProgress：记录调用顺序、注入平台响应 */
async function stubFinish({ finish, trigger, progress, events, dispatch, scenes = SCENE_DEFAULT }) {
  const mod = await import('../src/api.mjs')
  const calls = []
  const orig = {
    finish: mod.api.takeoverFinish, trigger: mod.api.triggerPipeline, progress: mod.api.takeoverProgress,
    events: mod.api.issueEvents, dispatch: mod.api.dispatchPipeline, scenes: mod.api.scenesDetail,
  }
  mod.api.takeoverFinish = async (...a) => { calls.push(['finish', ...a]); return finish }
  mod.api.triggerPipeline = async (...a) => {
    calls.push(['trigger', ...a])
    if (trigger instanceof Error) throw trigger
    return trigger
  }
  mod.api.dispatchPipeline = async (...a) => {
    calls.push(['dispatch', ...a])
    if (dispatch instanceof Error) throw dispatch
    return dispatch
  }
  mod.api.issueEvents = async (...a) => {
    calls.push(['events', ...a])
    if (events instanceof Error) throw events
    return events ?? []
  }
  mod.api.scenesDetail = async (...a) => {
    calls.push(['scenes', ...a])
    if (scenes instanceof Error) throw scenes
    return scenes
  }
  mod.api.takeoverProgress = async (...a) => {
    calls.push(['progress', ...a])
    if (progress instanceof Error) throw progress
    return progress ?? { written: 1 }
  }
  return {
    calls,
    triggers: () => calls.filter((c) => c[0] === 'trigger' || c[0] === 'dispatch'),
    readbacks: () => calls.filter((c) => c[0] === 'events'),
    sceneLookups: () => calls.filter((c) => c[0] === 'scenes'),
    progresses: () => calls.filter((c) => c[0] === 'progress'),
    restore: () => {
      mod.api.takeoverFinish = orig.finish
      mod.api.triggerPipeline = orig.trigger
      mod.api.takeoverProgress = orig.progress
      mod.api.issueEvents = orig.events
      mod.api.dispatchPipeline = orig.dispatch
      mod.api.scenesDetail = orig.scenes
    },
  }
}

test('#19 平台漏派（handoff_seq=0）：交回后按场景链自动补发 coding→qa', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa', issue_stage: 'qa', event_status: 'completed',
      session: {
        id: 'tkos_19', status: 'finished', agent_type: 'coding',
        repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0, next_seq: 0, skipped_dispatches: 0,
      },
    },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成', evidence: 'npm test 全绿' })
    const trig = stub.triggers()
    assert.equal(trig.length, 1, '平台漏派时必须补发一次')
    assert.deepEqual(trig[0].slice(1, 4), ['acme', 'demo', 62], '派发应落到会话所属仓库与 issue')
    assert.equal(trig[0][5], 'qa', '派发目标必须是场景链下一节点 qa')
    assert.equal(j.next_agent, 'qa')
    assert.equal(j.next_seq, 71, 'next_seq 应为补发事件 seq')
    assert.equal(j.dispatch.status, 'dispatched')
    const out = t.render(j)
    assert.match(out, /已自动派发/)
    assert.match(out, /seq=71/)
    assert.doesNotMatch(out, /待派发/)
  } finally { stub.restore() }
})

test('#19 平台不给 next_agent 时按会话节点推导场景链（coding→qa）', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, session: { agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0 } },
    trigger: { seq: 12, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1)
    assert.equal(stub.triggers()[0][5], 'qa', '场景链 coding→qa 必须被推导出来')
    assert.equal(j.next_agent, 'qa')
  } finally { stub.restore() }
})

test('#19 remote_may_still_run 阻塞：显式告警 + 待派发标记，不静默 grace', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['remote_may_still_run: 云端 worker 在被杀前可能已推送分支并开 MR'],
      session: { id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0, skipped_dispatches: 0 },
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '平台警告远端仍在跑时不得立即派发')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.pending_dispatch.agent, 'qa')
    assert.match(j.dispatch.warnings.join('\n'), /remote_may_still_run/)
    const out = t.render(j)
    assert.match(out, /待派发/)
    assert.match(out, /remote_may_still_run/)
    assert.match(out, /grape_trigger_pipeline/)
    assert.doesNotMatch(out, /无需手动 trigger/, '待派发时不得再宣称无需 trigger')
  } finally { stub.restore() }
})

test('#19 补发失败：pending_dispatch 携带失败原因（不静默）', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      session: { id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0 },
    },
    trigger: new Error('502: upstream unavailable'),
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j.dispatch.status, 'pending')
    assert.match(String(j.pending_dispatch.reason), /502/)
    const out = t.render(j)
    assert.match(out, /待派发/)
    assert.match(out, /502/)
  } finally { stub.restore() }
})

test('#19 会话缺仓库标识：不瞎派，返回待派发标记并提示可用入参补齐', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: { id: 'tkos_19', agent_type: 'coding', handoff_seq: 0 } },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '缺少 owner/repo/issue 时不得发出错派')
    assert.equal(j.dispatch.status, 'pending')
    assert.match(j.dispatch.warnings.join('\n'), /owner\/repo\/issue_number/)
    // 入参补齐后同一路径可正常兜底派发
    const j2 = await t.native({ session_id: 'tkos_19', summary: '完成', owner: 'acme', repo: 'demo', issue_number: 62 })
    assert.deepEqual(stub.triggers()[0].slice(1, 4), ['acme', 'demo', 62])
    assert.equal(j2.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#19 skipped_dispatches>0（平台主动跳过）：标记待派发，不盲目补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      session: { id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0, skipped_dispatches: 1 },
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '平台声明跳过派发时不得盲目补发')
    assert.equal(j.dispatch.status, 'pending')
    assert.match(j.dispatch.warnings.join('\n'), /skipped_dispatches=1/)
    assert.match(t.render(j), /待派发/)
  } finally { stub.restore() }
})

test('#19 工具描述与行为一致：兜底补发 / 不重复 / 待派发告警', () => {
  const d = finishTool().description
  assert.match(d, /兜底|补发/)
  assert.match(d, /不重复/)
  assert.match(d, /待派发/)
  assert.match(d, /remote_may_still_run/)
})

test('#19 仅 handoff_seq>0：回读本轮事件命中才判已派发，不重复派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa', session: {
        id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62,
        handoff_seq: 42, next_seq: 42,
      },
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    events: [{ seq: 42, event_type: 'a2a_event', agent_type: 'qa', status: 'running' }],
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.readbacks().length, 1, '仅 handoff_seq 时必须回读本轮事件核实')
    assert.equal(stub.triggers().length, 0, '本轮事件已命中 qa 派发，不得重复派发')
    assert.equal(j.dispatch.status, 'already_dispatched')
    assert.equal(j.next_seq, 42, '已派发时 next_seq 应沿用事件 seq')
    const out = t.render(j)
    assert.match(out, /未重复派发/)
    assert.match(out, /seq=42/)
  } finally { stub.restore() }
})
test('#19 handoff 为对象（平台侧派发失败）：透出 error 原文并给手动补发指引，不渲染 [object Object]', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      handoff: { ok: false, error: 'HTTP 405: Method Not Allowed' },
      session: sessOf({}),
    },
    trigger: new Error('502: upstream unavailable'),
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    const out = t.render(j)
    assert.doesNotMatch(out, /\[object Object\]/, 'handoff 对象不得直接插值')
    assert.match(out, /HTTP 405: Method Not Allowed/, '平台 handoff 失败原文必须透出')
    assert.match(out, /handoff=结构化/, '对象按结构化口径渲染，不把对象本身插进模板串')
    assert.match(out, /grape_trigger_pipeline\(agent=qa\)/, 'handoff 失败时给出手动补发指引')
  } finally { stub.restore() }
})

test('#19 handoff 为字符串：原样作为渲染标签', () => {
  const t = finishTool()
  const out = t.render({ ok: true, next_agent: 'qa', handoff: 'a2a', dispatch: { status: 'dispatched', agent: 'qa', seq: 71 } })
  assert.match(out, /handoff=a2a/)
})

/* ── 待派发标记：判据隔离 / 派发目标 / 兜底范围 / 可查询性 ──
 * 可查询性依据（平台 mgmt 路由源码实测）：POST progress 对已结束会话一律 409 not_active
 * （「接管会话已结束（finished）」），finish 在服务端同步关会话——交回后补写 progress 必然失败。
 * 因此待派发标记不再走 task_messages，改由会话记录（next_agent + 派发指针 next_seq=0）派生，
 * grape_takeover_status 对 finished 会话仍可查（GET 无状态门），渲染给出目标/原因/补发指引。 */

const sessOf = (over = {}) => ({
  id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0, ...over,
})

test('#30 结构化 handoff.seq>0 且 next_seq=0：以 handoff.seq 判已派发，不补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ handoff: { seq: 42 }, next_seq: 0 }) },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'handoff.seq>0 即平台已派发，不得补发')
    assert.equal(j.dispatch.status, 'already_dispatched')
    assert.equal(j.next_seq, 42)
    const out = t.render(j)
    assert.match(out, /handoff\.seq=42/, '已派发须披露权威判据 handoff.seq')
    assert.match(out, /未重复派发/)
    assert.doesNotMatch(out, /待派发/, '已派发不得告待派发')
  } finally { stub.restore() }
})

test('#30 next_seq>0 但 handoff.seq=0：next_seq 不作证据，回读事件无命中才补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ handoff_seq: 0, next_seq: 77 }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    events: [],
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.readbacks().length, 1, '双判据缺失时必须回读 issue 事件')
    assert.equal(stub.triggers().length, 1, '事件回读无下一节点 a2a_event 才补发一次')
    assert.equal(j.dispatch.status, 'dispatched')
    assert.equal(j.next_seq, 99)
  } finally { stub.restore() }
})

test('#30 判据组合契约：结构化 handoff.seq × handoff_seq 下界 × 本轮事件', async () => {
  const cases = [
    { name: 'handoff.seq>0 + next_seq>0', session: { handoff: { seq: 42 }, next_seq: 77 }, events: [], status: 'already_dispatched', triggers: 0, readbacks: 0 },
    { name: 'handoff.seq>0 + next_seq=0', session: { handoff: { seq: 42 }, next_seq: 0 }, events: [], status: 'already_dispatched', triggers: 0, readbacks: 0 },
    { name: '无结构化证据 + 无 handoff_seq 下界', session: { next_seq: 77, handoff_seq: 0 }, events: [], status: 'dispatched', triggers: 1, readbacks: 1 },
    { name: '无结构化证据 + 本轮事件已命中下一节点', session: { next_seq: 0, handoff_seq: 50 }, events: [{ seq: 60, event_type: 'a2a_event', agent_type: 'qa', status: 'running' }], status: 'already_dispatched', triggers: 0, readbacks: 1 },
    { name: '无结构化证据 + 仅历史事件', session: { next_seq: 0, handoff_seq: 50 }, events: [{ seq: 20, event_type: 'a2a_event', agent_type: 'qa', status: 'running' }], status: 'dispatched', triggers: 1, readbacks: 1 },
  ]
  for (const c of cases) {
    const t = finishTool()
    const stub = await stubFinish({
      finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf(c.session) },
      trigger: { seq: 71, agent: 'qa', status: 'running' },
      events: c.events,
    })
    try {
      const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
      assert.equal(j.dispatch.status, c.status, `${c.name} 判据`)
      assert.equal(stub.triggers().length, c.triggers, `${c.name} 补发次数`)
      assert.equal(stub.readbacks().length, c.readbacks, `${c.name} 事件回读次数`)
    } finally { stub.restore() }
  }
})

test('#30 Critical 回归：历史 a2a_event 存在但本轮无派发 → 仍补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ next_seq: 0, handoff_seq: 100 }) },
    trigger: { seq: 120, agent: 'qa', status: 'running' },
    events: [
      { seq: 40, event_type: 'a2a_event', agent_type: 'qa', status: 'completed' },
      { seq: 80, event_type: 'a2a_event', agent_type: 'qa', status: 'running' },
      { seq: 99, event_type: 'a2a_event', agent_type: 'coding', status: 'completed' },
    ],
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1, '本轮（seq>=100）无 qa 派发事件，必须补发')
    assert.equal(j.dispatch.status, 'dispatched')
    assert.equal(j.next_seq, 120)
  } finally { stub.restore() }
})

test('#30 Critical 回归：仅 failed 的 a2a_event 不算已派发 → 仍补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ next_seq: 0, handoff_seq: 50 }) },
    trigger: { seq: 70, agent: 'qa', status: 'running' },
    events: [
      { seq: 60, event_type: 'a2a_event', agent_type: 'qa', status: 'failed' },
    ],
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1, 'failed 的 a2a_event 不得当成功证据')
    assert.equal(j.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#30 负向用例：本轮事件回读命中下一节点 a2a_event 时补发次数为 0', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ next_seq: 0, handoff_seq: 50 }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    events: [{ seq: 88, event_type: 'a2a_event', agent_type: 'qa', status: 'running' }],
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j.dispatch.status, 'already_dispatched', '本轮事件回读命中即已派发')
    assert.equal(j.next_seq, 88, '已派发应沿用事件 seq')
    assert.equal(stub.triggers().length, 0, '已派发时补发次数必须为 0')
  } finally { stub.restore() }
})

test('#30 Optional 回归：事件回读被分页截断（total>返回条数）不判无事件、落 pending', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ next_seq: 0, handoff_seq: 50 }) },
    trigger: { seq: 70, agent: 'qa', status: 'running' },
    events: { events: [{ seq: 10, event_type: 'a2a_event', agent_type: 'coding', status: 'completed' }], total: 5 },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '窗口被截断时不得判「无事件」重复派发')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.dispatch.cause, 'readback_incomplete')
  } finally { stub.restore() }
})

test('#30 Optional 回归：api 模块缺 issueEvents 时不崩、落 pending', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ next_seq: 0, handoff_seq: 0 }) },
    trigger: { seq: 70, agent: 'qa', status: 'running' },
  })
  const mod = await import('../src/api.mjs')
  const saved = mod.api.issueEvents
  try {
    mod.api.issueEvents = undefined
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '无法回读事件时不得盲目补发')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.dispatch.cause, 'readback_failed')
  } finally {
    mod.api.issueEvents = saved
    stub.restore()
  }
})

test('#30 自定义场景链 coding→review→sre：按场景接口节点 next 派发 review', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: '', session: sessOf({ agent_type: 'coding' }) },
    dispatch: { seq: 88, agent: 'review', status: 'running' },
    events: [],
    scenes: {
      id: 'custom-review-chain',
      nodes: [
        { id: 'coding', tag: 'coding', next: 'review' },
        { id: 'review', tag: 'review', next: 'sre' },
        { id: 'sre', tag: 'sre', next: 'done' },
      ],
    },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.sceneLookups().length, 1, '响应未带链时应查场景接口取节点链')
    const dispatched = stub.calls.filter((c) => c[0] === 'dispatch')
    assert.equal(dispatched.length, 1, '场景链外置节点 review 应走 dispatchPipeline 派发')
    assert.equal(dispatched[0][5], 'review', '目标必须是场景节点 next')
    assert.equal(j.next_agent, 'review')
    assert.equal(j.dispatch.status, 'dispatched')
    assert.equal(j.next_seq, 88)
  } finally { stub.restore() }
})

test('#30 场景链不可用且响应未带链：不猜默认链，落 pending', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: '', session: sessOf({ agent_type: 'coding' }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    scenes: null,
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '场景链不可用时不得猜默认链派发')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.dispatch.cause, 'no_scene_chain')
    assert.match(t.render(j), /未派发/)
  } finally { stub.restore() }
})

test('#30 场景链外节点名（reviewer）不改写、落 pending 待人工裁决', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'reviewer', session: sessOf({ scene_agents: ['coding', 'qa'] }) },
    trigger: { seq: 99, agent: 'reviewer', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '场景链外节点名不得静默派发或改写')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.dispatch.cause, 'unknown_next_agent')
    assert.match(String(j.pending_dispatch.reason), /reviewer/)
  } finally { stub.restore() }
})
test('#19 issue_id 不得当 issue_number 兜底：仅带 issue_id 时宁可不派', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ issue_number: undefined, issue_id: 18808 }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'issue_id 是平台内部主键（#18808），当 issue_number 派发会打错 issue')
    assert.equal(j.dispatch.status, 'pending')
    assert.match(j.dispatch.warnings.join('\n'), /owner\/repo\/issue_number/)
    assert.match(t.render(j), /待派发/)
  } finally { stub.restore() }
})

test('#19 派发目标取 issue_number（19）而非 issue_id（18808）', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ issue_id: 18808, issue_number: 19 }) },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.deepEqual(stub.triggers()[0].slice(1, 4), ['acme', 'demo', 19], '派发必须落在 issue_number=19')
    assert.equal(j.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#30 场景链 qa→sre：部署类节点保留用户确认门，不自动派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'sre', session: sessOf({ agent_type: 'qa' }) },
    trigger: { seq: 99, agent: 'sre', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '部署类节点不得无确认自动派发')
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(j.dispatch.cause, 'confirmation_required')
    assert.equal(j.pending_dispatch.agent, 'sre')
    const out = t.render(j)
    assert.match(out, /部署/)
    assert.match(out, /确认/)
    assert.match(out, /grape_trigger_pipeline\(agent=sre\)/)
  } finally { stub.restore() }
})

test('#30 场景链推导 vod→issue：平台未给 next_agent 时按场景链 next 派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, session: sessOf({ agent_type: 'vod', next_agent: '' }) },
    trigger: { seq: 99, agent: 'issue', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1, '默认场景链 vod→issue 应被推导')
    assert.equal(stub.triggers()[0][5], 'issue')
    assert.equal(j.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#19 平台拒绝向已结束会话写 progress（409 not_active）：待派发流程不再发起必败写入', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['remote_may_still_run: 云端 worker 可能已推送分支'],
      session: sessOf(),
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    progress: { written: 1 },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j.dispatch.status, 'pending')
    assert.equal(stub.progresses().length, 0, 'finish 在服务端同步关会话，事后再写 progress 必 409 not_active——不得发起该写入')
    assert.equal('recorded' in (j.pending_dispatch || {}), false, '不再有 recorded 持久化承诺（task_messages 通道对已结束会话不可用）')
    assert.equal(j.pending_dispatch.agent, 'qa')
    assert.match(j.pending_dispatch.reason, /remote_may_still_run/)
  } finally { stub.restore() }
})

test('#30 takeover_status 从会话记录派生待派发标记：finished+next_agent+无 handoff 证据可查目标/原因/指引', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa', handoff_seq: 0, next_seq: 0,
      repo_key: 'gitcode:acme/demo', issue_id: '#62', task_id: 't_x',
      warnings_json: '["remote_may_still_run"]', skipped_dispatches: 0, summary: '已完成',
    },
  })
  assert.match(out, /待派发/, 'finished 会话缺 handoff 证据必须可查出待派发标记')
  assert.match(out, /qa/, '标记必须带目标节点')
  assert.match(out, /acme\/demo/, '标记必须带目标仓库')
  assert.match(out, /#62/, '标记必须带 issue')
  assert.match(out, /next_seq=0/, 'next_seq 作辅助信号也须如实披露')
  assert.match(out, /handoff\.seq|handoff\.reason/, '待派发口径须说明权威判据是 handoff.seq/reason')
  assert.match(out, /remote_may_still_run/, '会话警告作为待派发原因必须可查')
  assert.match(out, /grape_trigger_pipeline\(agent=qa\)/, '必须给可执行补发指引')
  assert.match(out, /grape_get_issue_events/, '补发前必须先核实事件，防止兜底已成功时重复派发')
})

test('#30 takeover_status：结构化 handoff.seq>0 判已派发（next_seq 不作唯一判据）', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa',
      next_seq: 42, handoff: { seq: 37 }, handoff_seq: 0, repo_key: 'gitcode:acme/demo', issue_number: 62,
    },
  })
  assert.doesNotMatch(out, /待派发/, 'handoff.seq=37 成立即已派发，不得再告待派发')
  assert.match(out, /handoff\.seq=37/, '已派发必须披露权威判据 handoff.seq')
  assert.doesNotMatch(out, /next_seq=42/, 'next_seq 仅辅助展示，不再作为已派发判据')
})

test('#30 takeover_status：handoff.reason=already_dispatched 判已派发，不告待派发', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa',
      handoff: { reason: 'already_dispatched' }, repo_key: 'gitcode:acme/demo', issue_number: 62,
    },
  })
  assert.doesNotMatch(out, /待派发/, 'reason=already_dispatched 即平台已派发，不得告待派发')
  assert.match(out, /already_dispatched/, '已派发须披露 reason 判据')
})

test('#30 takeover_status：双判据缺失（next_seq>0 也无 handoff 证据）仍标待派发', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa',
      next_seq: 42, handoff_seq: 0, repo_key: 'gitcode:acme/demo', issue_number: 62,
    },
  })
  assert.match(out, /待派发/, 'next_seq 不是已派发证据，缺 handoff 证据必须标待派发')
  assert.match(out, /next_seq=42/, '辅助信号需如实披露')
  assert.match(out, /核实|查事件/, '需提示回读事件核实')
})

test('#19 takeover_status：issue 展示取 issue_number，issue_id 标注内部主键', () => {
  const t = findTool('grape_takeover_status')
  const both = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa', next_seq: 0, handoff_seq: 0,
      repo_key: 'gitcode:acme/demo', issue_number: 19, issue_id: 18808,
    },
  })
  assert.match(both, /issue: #19/, '单号 issue_number 优先展示')
  assert.doesNotMatch(both, /18808/, '内部主键不得占据 issue 展示位')
  const onlyId = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa', next_seq: 0, handoff_seq: 0,
      repo_key: 'gitcode:acme/demo', issue_id: 18808,
    },
  })
  assert.match(onlyId, /内部主键/, '缺 issue_number 时 issue_id 必须标注为内部主键')
  const list = t.render({ ok: true, sessions: [{ id: 'tkos_19', issue_number: 19, issue_id: 18808, agent_type: 'coding', status: 'active' }] })
  assert.match(list, /#19/, '列表同样以 issue_number 为单号')
  assert.doesNotMatch(list, /18808/, '列表不得把内部主键当单号展示')
})

test('#19 takeover_status：skipped_dispatches 与已派发会话不误告警', () => {
  const t = findTool('grape_takeover_status')
  const skipped = t.render({ ok: true, session: { id: 'tkos_19', status: 'finished', next_agent: 'qa', handoff_seq: 0, repo_key: 'gitcode:acme/demo', issue_id: '#62', skipped_dispatches: 2 } })
  assert.match(skipped, /skipped_dispatches=2/, '平台跳过派发的会话必须渲染为待派发')
  const dispatched = t.render({ ok: true, session: { id: 'tkos_19', status: 'finished', next_agent: 'qa', next_seq: 37, handoff: { seq: 37 }, handoff_seq: 0, repo_key: 'gitcode:acme/demo', issue_id: '#62' } })
  assert.doesNotMatch(dispatched, /待派发/, '派发指针 next_seq>0 不得再告待派发')
  const active = t.render({ ok: true, session: { id: 'tkos_19', status: 'active', next_agent: '', handoff_seq: 0 } })
  assert.doesNotMatch(active, /待派发/, '进行中会话不适用待派发标记')
})

test('#19 finish 待派发渲染：不再宣称写入会话进度，改为会话记录可查口径', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['remote_may_still_run: 云端 worker 可能已推送分支'],
      session: sessOf({ skipped_dispatches: 1 }),
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    const out = t.render(j)
    assert.match(out, /待派发/)
    assert.match(out, /grape_trigger_pipeline\(agent=qa\)/)
    assert.match(out, /grape_takeover_status/, '必须给事后复查通道')
    assert.doesNotMatch(out, /已写入接管会话进度/, 'progress 对已结束会话 409，不得宣称已写入')
    assert.doesNotMatch(out, /task_messages/, '同上')
    assert.doesNotMatch(out, /无需手动 trigger/)
  } finally { stub.restore() }
})

test('#19 阻塞判据只认稳定告警码：散文「远端无冲突」不误阻塞，branch_conflict 码阻塞', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['branch_sync: 远端无冲突'],
      session: sessOf(),
    },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j.dispatch.status, 'dispatched', '「远端无冲突」是散文，不是冲突告警码，不得误阻塞派发')
    assert.equal(stub.triggers().length, 1)
  } finally { stub.restore() }
  const stub2 = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['branch_conflict: 目标分支存在未解决冲突'],
      session: sessOf(),
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j2 = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j2.dispatch.status, 'pending', 'branch_conflict 稳定码必须阻塞派发')
    assert.match(j2.dispatch.warnings.join('\n'), /branch_conflict/)
  } finally { stub2.restore() }
})

test('#30 判据取值单一口径：session 结构化 handoff.seq 优先，顶层 0 不遮蔽，判据与渲染一致', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa', next_seq: 0, handoff_seq: 0,
      session: sessOf({ handoff: { seq: 42 }, next_seq: 77 }),
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'session handoff.seq=42 已证明平台派发，顶层 0 不得遮蔽导致重复补发')
    assert.equal(stub.readbacks().length, 0, '已有 handoff 证据时无需回读事件')
    assert.equal(j.dispatch.status, 'already_dispatched')
    assert.equal(j.next_seq, 42)
    const out = t.render(j)
    assert.match(out, /handoff\.seq=42/, '渲染与判据同一 getter：session handoff.seq=42 必须如实披露')
  } finally { stub.restore() }
})

test('#30 平台给 next_agent 时按已知节点派发（会话缺 agent_type 也可派）', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      session: { id: 'tkos_19', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0 },
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1, '平台明确 next_agent=qa 是已知节点，回读无事件后应补发')
    assert.equal(j.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#19 模块导出面收敛：派发收口为内部实现，外部仍只有 TOOLS/TOOL_NAMES/findTool/toolDefs', async () => {
  const mod = await import('../src/tools.mjs')
  for (const name of ['resolveNextAgent', 'resolveDispatchTarget', 'ensureNextNodeDispatched']) {
    assert.equal(mod[name], undefined, `${name} 仓库内无外部消费者（用例经 findTool 公开面），不得扩大导出面`)
  }
  for (const name of ['TOOLS', 'TOOL_NAMES', 'findTool', 'toolDefs']) {
    assert.ok(mod[name], `${name} 属既有导出面，必须保留`)
  }
})

test('#19 next_step 只认整串 agent 名：散文不解析，靠场景链兜底', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: '',
      session: sessOf({ result_json: { next_step: 'qa：请复查 PR #10' } }),
    },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1)
    assert.equal(stub.triggers()[0][5], 'qa', '散文 next_step 不解析，只能由场景链 coding→qa 兜底')
    assert.equal(j.dispatch.status, 'dispatched')
    assert.match(t.description, /散文/, '描述须写明散文不解析，避免用户以为支持自然语言 next_step')
  } finally { stub.restore() }
})

test('#30 文档措辞与实现一致：handoff.seq 判据 / 场景链兜底 / 待派发可查询', () => {
  const doc = readFileSync(new URL('../docs/20261114-takeover-architecture.md', import.meta.url), 'utf8')
  assert.match(doc, /`handoff\.seq>0`[^\n]*`handoff\.reason=already_dispatched`|已派发[^\n]*`handoff\.seq>0`/, 'docs 3.2 应写明以 handoff.seq / already_dispatched 为派发判据')
  assert.match(doc, /`next_seq`[^\n]*(降级|辅助)/, 'docs 3.2 应写明 next_seq 降级为辅助信号')
  assert.match(doc, /场景链 `next`|场景链 next/, 'docs 3.2 应写明兜底按场景链 next 推导')
  assert.match(doc, /takeover_progress|task_messages/, 'docs 3.2 应写明待派发标记的落盘/查询通道')
  assert.match(doc, /finished \+ next_agent \+ 未见 handoff\.seq/, 'docs 3.2 的派生判据须以未见 handoff.seq 为准')
  assert.doesNotMatch(doc, /派发指针是 `next_seq`/, 'docs 3.2 不得再把 next_seq 当派发指针判据')
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, /#30|Issue #30/, 'CHANGELOG Unreleased 应登记 #30 变更')
  assert.match(changelog, /handoff\.seq/, 'CHANGELOG 应写明 handoff.seq 权威判据')
  const skill = readFileSync(new URL('../skills/grape-remote/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /handoff\.seq/, 'skill 副本应说明派发判据是 handoff.seq')
})

test('#19 README 双语设计原则：不再宣称「永不干预」，如实写明客户端兜底范围', () => {
  const en = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const zh = readFileSync(new URL('../README.zh.md', import.meta.url), 'utf8')
  assert.doesNotMatch(en, /never interferes with node hand-offs/, '交回路径已有 coding→qa 客户端兜底，不得再宣称 never interferes')
  assert.doesNotMatch(zh, /永不干预节点交接/, '同上（中文）')
  for (const txt of [en, zh]) {
    assert.match(txt, /默认服务端驱动|server-driven by default/, '必须写明默认仍是服务端驱动')
    assert.match(txt, /coding→qa/, '必须写明客户端兜底范围仅 coding→qa')
  }
  assert.match(en, /takeover[\s\S]{0,80}coding→qa[\s\S]{0,200}fallback|fallback[\s\S]{0,200}coding→qa/i, '英文版应说明 takeover 交回漏派时客户端兜底')
  assert.match(zh, /兜底/, '中文版应写「兜底」')
})

test('#19 CHANGELOG 登记 finish 新增可选入参（§7 工具面/参数变化）', () => {
  const cl = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  // #19 变更已随 0.3.10 发布：按**发布节**取段（发版后 Unreleased 段为空，按 `## Unreleased` 切段会取到空串）
  const at = cl.search(/^## 0\.3\.10 \(/m)
  assert.ok(at >= 0, 'CHANGELOG 应有 0.3.10 发布节')
  const next = cl.slice(at + 1).search(/^## /m)
  const section = next === -1 ? cl.slice(at) : cl.slice(at, at + 1 + next)
  assert.match(section, /新增可选[^\n]*owner\/repo\/issue_number[^\n]*(兜底派发|用于兜底)/, '0.3.10 发布节应含一句可选入参说明')
})

test('#19 handoff 失败但客户端已兜底派发：透出原文并标注覆盖，不再要求手动补发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      handoff: { ok: false, error: 'HTTP 405: Method Not Allowed' },
      session: sessOf({}),
    },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    const out = t.render(j)
    assert.match(out, /HTTP 405: Method Not Allowed/, '平台失败原文必须透出')
    assert.match(out, /已由客户端兜底派发覆盖/, '兜底派发成功后须说明失败已被覆盖')
    assert.doesNotMatch(out, /手动补发/, '已派发时不得再要求手动补发（与「无需手动 trigger」互斥）')
  } finally { stub.restore() }
})

/* ── QA 终态复审（MR !14）追加项：交回未成功不得派发 / 未知节点名不改写 / 补发缺 seq 未证实 ── */

test('#19 交回未成功（ok=false）：不得派发下一节点，落 pending 并渲染「交回未成功」', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: false, error: 'HTTP 409: not_active：接管会话已结束', next_agent: 'qa', handoff_seq: 0,
      session: sessOf({ status: 'active' }),
    },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '交回未成功不得派发下一节点——下一节点会接手一个未交回的任务')
    assert.equal(j.dispatch.status, 'pending')
    assert.match(String(j.pending_dispatch.reason), /交回未成功/)
    assert.match(String(j.pending_dispatch.reason), /not_active/, '平台错误原文必须透出，便于判断该重试还是改判')
    const out = t.render(j)
    assert.match(out, /交回未成功/)
    assert.doesNotMatch(out, /链不断/, '交回未成功时不得再宣称链不断')
    assert.doesNotMatch(out, /无需手动 trigger/)
    assert.doesNotMatch(out, /已自动派发/)
  } finally { stub.restore() }
})

test('#19 交回未生效（changed=false）：同样不派发，按未成功处理', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: false, next_agent: 'qa', session: sessOf({ status: 'active' }) },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'changed=false 说明平台未真正落账，与 ok=false 同等处理')
    assert.equal(j.dispatch.status, 'pending')
    const out = t.render(j)
    assert.match(out, /交回未成功/)
    assert.doesNotMatch(out, /链不断/)
  } finally { stub.restore() }
})

test('#19 平台给白名单外 next_agent（reviewer）：不回落场景链改写为 qa，标注未知并待人工裁决', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'reviewer', session: sessOf() },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '平台给了不认识的节点名时不得静默改写为场景链下一节点 qa')
    assert.equal(j.dispatch.status, 'pending')
    assert.match(String(j.pending_dispatch.reason), /reviewer/, '未知节点名必须原样点名')
    assert.notEqual(j.next_agent, 'qa', 'next_agent 不得被改写成 qa')
    const out = t.render(j)
    assert.match(out, /reviewer/, '渲染须让读者看到平台原本指定的节点名')
    assert.match(out, /未知/, '须说明是「不认识的节点名」而不是「平台未给」')
  } finally { stub.restore() }
})

test('#19 平台未给 next_agent（空串/缺省）仍按场景链兜底：区分「未给」与「不认识」', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: '', session: sessOf() },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 1, '「平台未给」不是故障，仍按场景链 coding→qa 兜底补发')
    assert.equal(j.next_agent, 'qa')
    assert.equal(j.dispatch.status, 'dispatched')
  } finally { stub.restore() }
})

test('#19 补发响应缺 seq：不得判 dispatched，落 pending 且不渲染 seq=0', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf() },
    trigger: {},
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.notEqual(j.dispatch.status, 'dispatched', '响应缺 seq 时派发未证实，不得判成功')
    assert.equal(j.dispatch.status, 'pending')
    const out = t.render(j)
    assert.doesNotMatch(out, /seq=0/, '不得把缺失的 seq 渲染成 seq=0 当作已派发证据')
    assert.doesNotMatch(out, /已自动派发/, '未证实成功不得宣称已自动派发')
    assert.match(out, /核实/, '须给出查事件核实/补发的可执行路径')
  } finally { stub.restore() }
})

test('#30 takeover_status：客户端兜底不回填会话字段，须以事件回读核实', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa', next_seq: 0, handoff_seq: 0,
      repo_key: 'gitcode:acme/demo', issue_number: 62,
    },
  })
  assert.match(out, /不回填/, '须说明客户端兜底派发不回填会话记录')
  assert.match(out, /grape_get_issue_events/, '须注明确认派发要回读事件而不是只看会话字段')
  assert.match(out, /handoff\.seq/, '须写明权威判据是 handoff.seq')
})

test('#19 takeover_status 派发指针与 finish 同源 seqOf：session 优先，顶层值不遮蔽', () => {
  const t = findTool('grape_takeover_status')
  const out = t.render({
    ok: true,
    next_seq: 99, skipped_dispatches: 0,
    session: {
      id: 'tkos_19', status: 'finished', agent_type: 'coding', next_agent: 'qa', next_seq: 0, handoff_seq: 0,
      repo_key: 'gitcode:acme/demo', issue_number: 62,
    },
  })
  assert.match(out, /待派发/, 'session 是会话记录的权威形态：顶层 next_seq 不得遮蔽 session 的 next_seq=0')
  assert.doesNotMatch(out, /next_seq=99/, '不得把顶层值当成派发指针')
})

test('#19 描述与行为一致：交回未成功不派发 / 未知节点名不改写 / 缺 seq 未证实（§7 工具面同步）', () => {
  const d = finishTool().description
  assert.match(d, /交回未成功/, '描述须写明交回未成功时不派发下一节点')
  assert.match(d, /白名单外|不认识|未知/, '描述须写明白名单外节点名不被改写')
  assert.match(d, /缺事件 `seq`|未证实/, '描述须写明缺 seq 时判派发未证实')
  const s = findTool('grape_takeover_status').description
  assert.match(s, /不回填/, '状态工具描述须写明兜底派发不回填会话 next_seq')
  assert.match(s, /核实/, '状态工具描述须给出查事件核实的通道')
})

test('#19 旧响应形状（无 dispatch 字段）且 handoff 失败：仍给出手动补发指引', () => {
  const t = finishTool()
  const out = t.render({ ok: true, changed: true, next_agent: 'qa', handoff: { ok: false, error: 'HTTP 405: Method Not Allowed' } })
  assert.doesNotMatch(out, /\[object Object\]/, 'handoff 对象不得直接插值')
  assert.match(out, /平台 handoff 派发失败/)
  assert.match(out, /平台 handoff 未成功/)
  assert.match(out, /grape_trigger_pipeline\(agent=qa\)/, '未派发时须给出手动补发指引')
})
