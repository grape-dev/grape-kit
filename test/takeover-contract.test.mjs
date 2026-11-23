import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiRequest, api, resolveCredentials, hintFor, hostInfo } from '../src/api.mjs'
import { findTool } from '../src/tools.mjs'

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

/** 挂起 api.takeoverFinish / api.triggerPipeline / api.takeoverProgress：记录调用顺序、注入平台响应 */
async function stubFinish({ finish, trigger, progress }) {
  const mod = await import('../src/api.mjs')
  const calls = []
  const orig = {
    finish: mod.api.takeoverFinish, trigger: mod.api.triggerPipeline, progress: mod.api.takeoverProgress,
  }
  mod.api.takeoverFinish = async (...a) => { calls.push(['finish', ...a]); return finish }
  mod.api.triggerPipeline = async (...a) => {
    calls.push(['trigger', ...a])
    if (trigger instanceof Error) throw trigger
    return trigger
  }
  mod.api.takeoverProgress = async (...a) => {
    calls.push(['progress', ...a])
    if (progress instanceof Error) throw progress
    return progress ?? { written: 1 }
  }
  return {
    calls,
    triggers: () => calls.filter((c) => c[0] === 'trigger'),
    progresses: () => calls.filter((c) => c[0] === 'progress'),
    restore: () => {
      mod.api.takeoverFinish = orig.finish
      mod.api.triggerPipeline = orig.trigger
      mod.api.takeoverProgress = orig.progress
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

test('#19 平台已派发（handoff_seq>0）：不重复派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa', session: {
        id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62,
        handoff_seq: 42, next_seq: 42,
      },
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, '平台已写入指向 qa 的事件，不得重复派发')
    assert.equal(j.dispatch.status, 'already_dispatched')
    assert.equal(j.next_seq, 42, '已派发时 next_seq 应沿用平台事件 seq')
    const out = t.render(j)
    assert.match(out, /未重复派发/)
    assert.match(out, /seq=42/)
  } finally { stub.restore() }
})
/* ── PR #10 QA 复审（S1–S6）：判据隔离 / 派发目标 / 兜底范围 / 待派发可查询 ── */

const sessOf = (over = {}) => ({
  id: 'tkos_19', agent_type: 'coding', repo_key: 'gitcode:acme/demo', issue_number: 62, handoff_seq: 0, ...over,
})

test('#19/S1 handoff_seq>0 且 next_seq=0（交回事件已写、派发未证实）：兜底补发并告警', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ handoff_seq: 42, next_seq: 0 }) },
    trigger: { seq: 71, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.notEqual(j.dispatch.status, 'already_dispatched', 'handoff_seq 不是派发证据，不得据此判已派发')
    assert.equal(stub.triggers().length, 1, '未见派发指针 next_seq 时必须兜底补发')
    assert.equal(j.dispatch.status, 'dispatched')
    assert.equal(j.next_seq, 71)
    assert.match(j.dispatch.warnings.join('\n'), /handoff_seq=42/, '兜底补发须显式说明「交回已写、派发未证实」')
    const out = t.render(j)
    assert.match(out, /handoff_seq=42/)
    assert.match(out, /不作为派发证据/, 'handoff_seq 的语义只留一种说法，不再与「已派发」混用')
    assert.match(out, /兜底补发/)
    assert.doesNotMatch(out, /已由平台派发/, '未证实派发时不得渲染成平台已派发')
  } finally { stub.restore() }
})

test('#19/S1 next_seq>0 且 handoff_seq=0：派发指针成立，不重复派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ handoff_seq: 0, next_seq: 77 }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'next_seq 已指向下一节点事件，不得重复派发')
    assert.equal(j.dispatch.status, 'already_dispatched')
    assert.equal(j.next_seq, 77)
    const out = t.render(j)
    assert.match(out, /next_seq=77/)
    assert.doesNotMatch(out, /handoff_seq=/, 'handoff_seq=0 时不得凭空渲染交回侧 seq')
  } finally { stub.restore() }
})

test('#19/S2 issue_id 不得当 issue_number 兜底：仅带 issue_id 时宁可不派', async () => {
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

test('#19/S2 派发目标取 issue_number（19）而非 issue_id（18808）', async () => {
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

test('#19/S3 兜底范围收窄到 coding→qa：qa 交回不越界派发 sre', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'sre', session: sessOf({ agent_type: 'qa' }) },
    trigger: { seq: 99, agent: 'sre', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0, 'Spec Out of Scope 排除 qa→sre 等其它节点派发行为改造')
    assert.equal(j.dispatch.status, 'out_of_scope')
    assert.match(t.render(j), /仅 coding→qa/)
  } finally { stub.restore() }
})

test('#19/S3 场景链不再推导 vod→issue：非 coding 节点无 next_agent 时不派发', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, session: sessOf({ agent_type: 'vod', next_agent: '' }) },
    trigger: { seq: 99, agent: 'issue', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(stub.triggers().length, 0)
    assert.equal(j.dispatch.status, 'no_next_node')
  } finally { stub.restore() }
})

test('#19/S4 待派发标记经 takeover_progress 落 task_message（会话结束后可查）', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: {
      ok: true, changed: true, next_agent: 'qa',
      warnings: ['remote_may_still_run: 云端 worker 可能已推送分支'],
      session: sessOf(),
    },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    const pg = stub.progresses()
    assert.equal(pg.length, 1, '待派发必须落一条进度，否则只有本次返回值、事后无从核查')
    assert.equal(pg[0][1], 'tkos_19', '进度写回本接管会话')
    const msg = (pg[0][2] || []).join('\n')
    assert.match(msg, /待派发/)
    assert.match(msg, /qa/)
    assert.equal(j.pending_dispatch.recorded, true)
    assert.match(t.render(j), /已写入接管会话进度/)
  } finally { stub.restore() }
})

test('#19/S4 progress 写入失败不影响交回结果：降级为仅返回态并明示', async () => {
  const t = finishTool()
  const stub = await stubFinish({
    finish: { ok: true, changed: true, next_agent: 'qa', session: sessOf({ skipped_dispatches: 1 }) },
    trigger: { seq: 99, agent: 'qa', status: 'running' },
    progress: new Error('403: takeover session finished'),
  })
  try {
    const j = await t.native({ session_id: 'tkos_19', summary: '完成' })
    assert.equal(j.dispatch.status, 'pending', '进度落盘失败不得掩盖待派发结论')
    assert.equal(j.pending_dispatch.recorded, false)
    const out = t.render(j)
    assert.match(out, /待派发/)
    assert.match(out, /仅随本次返回/, '落盘失败时须说明标记不持久化')
  } finally { stub.restore() }
})

test('#19/S6 next_step 只认整串 agent 名：散文不解析，靠场景链兜底', async () => {
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

test('#19/S5 文档措辞与实现一致：判据 next_seq / 兜底回填 next_seq / 待派发可查询', () => {
  const doc = readFileSync(new URL('../docs/20261114-takeover-architecture.md', import.meta.url), 'utf8')
  assert.match(doc, /`next_seq`[^\n]*派发指针|派发指针[^\n]*`next_seq`/, 'docs 3.2 应写明以 next_seq 为派发指针判据')
  assert.match(doc, /回填[^\n]*`next_seq`/, 'docs 3.2 应写明兜底路径只回填 next_seq')
  assert.match(doc, /takeover_progress|task_messages/, 'docs 3.2 应写明待派发标记的落盘/查询通道')
  const skill = readFileSync(new URL('../skills/grape-remote/SKILL.md', import.meta.url), 'utf8')
  assert.match(skill, /next_seq/, 'skill 副本应说明派发指针是 next_seq')
})
