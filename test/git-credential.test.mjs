import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { findTool, TOOLS } from '../src/tools.mjs'
import { api } from '../src/api.mjs'

/* Issue #31：git 写回（tko_ 换券 + GIT_ASKPASS + PR 薄代理） */

const POSIX = process.platform !== 'win32'
// 用真实当前时间：askpass 脚本按真实 epoch 自检，固定过去值会让「未过期」用例直接失败
const NOW = Math.floor(Date.now() / 1000)
const PASSWORD = 'secret_password_0001'

/** fake api：默认会话绑定 acme/demo，工作区由 __ws 注入（over 中其余键覆盖同名端点） */
function fakeApi(over = {}) {
  const ws = over.__ws || ''
  const rest = Object.fromEntries(Object.entries(over).filter(([k]) => k !== '__ws'))
  return {
    takeoverGet: async () => ({ session: { id: 'tkos_1', agent_type: 'coding', repo_key: 'gitcode:acme/demo', workspace: { cwd_hint: ws } } }),
    gitCredential: async () => ({
      provider: 'gitcode', username: 'x-access-token', password: PASSWORD,
      clone_url: 'https://gitcode.com/acme/demo.git', expires_in: '600',
    }),
    ...rest,
  }
}

const tmpWs = () => mkdtempSync(join(tmpdir(), 'gk-cred-'))
const askpassOf = (ws) => join(ws, '.grape', POSIX ? 'git-askpass.sh' : 'git-askpass.cmd')
const runCred = (args, deps = {}) => findTool('grape_git_credential').run(args, deps)

test('工具面 50：新增 git 写回两工具', () => {
  assert.equal(TOOLS.length, 50)
  for (const name of ['grape_git_credential', 'grape_create_pull']) assert.ok(findTool(name), `缺 ${name}`)
})

test('换券写 askpass（0600）、内嵌到期 epoch，返回值/渲染不回显口令', async () => {
  const ws = tmpWs()
  try {
    const t = findTool('grape_git_credential')
    const j = await runCred(
      { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws },
      { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' },
    )
    const p = askpassOf(ws)
    assert.ok(existsSync(p), 'askpass 应写出')
    if (POSIX) assert.equal(statSync(p).mode & 0o777, 0o600, 'askpass 权限必须 0600')
    const body = readFileSync(p, 'utf8')
    assert.match(body, new RegExp(`GRAPE_ASKPASS_EXPIRES=${NOW + 600}`), '内嵌到期 epoch')
    assert.match(body, /重新换券/, '过期自检文案')
    assert.equal(j.expires_at, NOW + 600)
    assert.equal(j.askpass_path, p)
    assert.ok(!JSON.stringify(j).includes(PASSWORD), '返回值不得含明文口令')
    const out = t.render(j)
    assert.match(out, /git-askpass\.sh/)
    assert.match(out, /0600/)
    assert.match(out, /GIT_ASKPASS/)
    assert.ok(!out.includes(PASSWORD), '渲染不得含明文口令')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('askpass 按 prompt 输出用户名/口令；过期后非零退出且 stderr 含「重新换券」', async () => {
  if (!POSIX) return
  const ws = tmpWs()
  try {
    await runCred(
      { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws },
      { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' },
    )
    const p = askpassOf(ws)
    const user = spawnSync('sh', [p, 'Username for https://gitcode.com:'], { encoding: 'utf8' })
    assert.equal(user.status, 0)
    assert.equal(user.stdout.trim(), 'x-access-token')
    const pass = spawnSync('sh', [p, 'Password for https://gitcode.com:'], { encoding: 'utf8' })
    assert.equal(pass.status, 0)
    assert.equal(pass.stdout.trim(), PASSWORD)
    // 把内嵌到期 epoch 改成 1（已过期），验证脚本自检不静默回退
    const expired = readFileSync(p, 'utf8').replace(/GRAPE_ASKPASS_EXPIRES=\d+/, 'GRAPE_ASKPASS_EXPIRES=1')
    writeFileSync(p, expired, { mode: 0o600 })
    const dead = spawnSync('sh', [p, 'Password for https://gitcode.com:'], { encoding: 'utf8' })
    assert.notEqual(dead.status, 0, '过期必须非零退出')
    assert.match(dead.stderr, /重新换券/)
    assert.equal(dead.stdout.trim(), '', '过期不得输出凭据')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('非本仓 owner/repo 被拒且不生成任何文件', async () => {
  const ws = tmpWs()
  try {
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'other', workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' }),
      (e) => /不一致/.test(e.message) && /未写入/.test(e.hint || e.message),
    )
    assert.ok(!existsSync(join(ws, '.grape')), '被拒时不得创建 .grape 目录')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('工作区外路径被拒且不落盘', async () => {
  const root = tmpWs()
  const outside = tmpWs()
  try {
    await assert.rejects(
      runCred(
        { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: outside },
        { apiModule: fakeApi({ __ws: root }), now: () => NOW, platform: 'linux', workspaceRoot: root },
      ),
      (e) => /工作区/.test(e.message),
    )
    assert.ok(!existsSync(join(outside, '.grape')), '越界目录不得生成文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('过期/无到期券不写盘，错误提示重新换券', async () => {
  for (const cred of [
    { provider: 'gitcode', username: 'x', password: PASSWORD, expires_in: '0' },
    { provider: 'gitcode', username: 'x', password: PASSWORD, expires_in: '-5' },
    { provider: 'gitcode', username: 'x', password: PASSWORD },
  ]) {
    const ws = tmpWs()
    try {
      await assert.rejects(
        runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws }, {
          apiModule: fakeApi({ __ws: ws, gitCredential: async () => cred }), now: () => NOW, platform: 'linux',
        }),
        (e) => /重新换券/.test(`${e.message} ${e.hint || ''}`),
      )
      assert.ok(!existsSync(join(ws, '.grape')), '过期券不得写盘')
    } finally { rmSync(ws, { recursive: true, force: true }) }
  }
})

test('cleanup=true 删除 askpass（幂等）', async () => {
  const ws = tmpWs()
  try {
    const deps = { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' }
    await runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws }, deps)
    assert.ok(existsSync(askpassOf(ws)))
    const c = await runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws, cleanup: true }, deps)
    assert.ok(!existsSync(askpassOf(ws)), 'cleanup 应删除文件')
    assert.equal(c.cleaned.length, 1)
    const again = await runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws, cleanup: true }, deps)
    assert.equal(again.cleaned.length, 0, '重复清理幂等')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('owner/repo 路径注入与无仓库绑定的会话一律拒绝', async () => {
  const ws = tmpWs()
  try {
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: '../etc', repo: 'demo', workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW }),
      /非法仓库/,
    )
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws }, {
        apiModule: fakeApi({ __ws: ws, takeoverGet: async () => ({ session: { id: 'x' } }) }), now: () => NOW,
      }),
      /未带仓库绑定/,
    )
    assert.ok(!existsSync(join(ws, '.grape')))
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('create_pull 薄代理：字段映射与 PR 渲染', async () => {
  const orig = api.createPull
  let seen = null
  api.createPull = async (o, r, p) => {
    seen = { o, r, p }
    return { number: 42, html_url: 'https://gitcode.com/acme/demo/pull/42' }
  }
  try {
    const t = findTool('grape_create_pull')
    const j = await t.native({ owner: 'acme', repo: 'demo', title: 'T', head: 'feat/issue-31', base: 'main', body: 'B', issue_number: 31 })
    assert.equal(seen.o, 'acme')
    assert.deepEqual(seen.p.related_issue_nums, [31])
    assert.ok(!('auto_close_issues' in seen.p), '默认不擅自关闭 Issue')
    const out = t.render(j)
    assert.match(out, /42/)
    assert.match(out, /pull\/42/)
  } finally { api.createPull = orig }
})

test('finish：coding 缺 branch/commit/PR 时拒绝并列出缺失项', async () => {
  const t = findTool('grape_takeover_finish')
  await assert.rejects(
    t.native({ session_id: 'tkos_1', summary: '完成', agent_type: 'coding' }),
    (e) => /branch/.test(e.message) && /commit/.test(e.message) && /PR/.test(e.message),
  )
})

test('finish：补齐 branch/commit/PR 通过；allow_incomplete 覆写留痕', async () => {
  const t = findTool('grape_takeover_finish')
  const orig = api.takeoverFinish
  let payload = null
  api.takeoverFinish = async (_sid, p) => { payload = p; return { ok: true, changed: true, next_agent: 'qa', next_seq: 9, handoff: { seq: 9, reason: 'dispatched' } } }
  try {
    const ok = await t.native({ session_id: 'tkos_1', summary: '完成', agent_type: 'coding', branch: 'feat/issue-31', commit: 'abc1234', pr_number: '7' })
    assert.equal(payload.branch, undefined, 'branch 是本地校验入参，不塞进平台 body')
    assert.equal(ok.dispatch.status, 'already_dispatched')
    const over = await t.native({ session_id: 'tkos_1', summary: '完成', agent_type: 'coding', branch: 'feat/issue-31', allow_incomplete: true })
    assert.deepEqual(over.incomplete_override.missing, ['commit sha', 'PR 编号/链接'])
    assert.ok(payload.actions.some((x) => /allow_incomplete/.test(x)), '覆写必须在结构化产物留痕')
  } finally { api.takeoverFinish = orig }
})

test('request-finish：coding 缺项只强 warning 不拒绝', async () => {
  const t = findTool('grape_takeover_finish')
  const orig = api.takeoverRequestFinish
  api.takeoverRequestFinish = async () => ({ ok: true, requested: true, session: { finish_requested_at: '2026-11-25T00:00:00Z' } })
  try {
    const j = await t.native({ session_id: 'tkos_1', summary: '完成', request_only: true, agent_type: 'coding' })
    assert.equal(j.coding_evidence_warning.missing.length, 3)
    const out = t.render(j)
    assert.match(out, /等待用户确认/)
    assert.match(out, /branch/)
    assert.match(out, /PR/)
  } finally { api.takeoverRequestFinish = orig }
})

test('finish/abort 清理本次进程写出的 askpass', async () => {
  const ws = tmpWs()
  const origFinish = api.takeoverFinish
  const origAbort = api.takeoverAbort
  api.takeoverFinish = async () => ({ ok: true, changed: true })
  api.takeoverAbort = async () => ({ ok: true, redispatched: true })
  try {
    const deps = { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' }
    await runCred({ session_id: 'tkos_fin', owner: 'acme', repo: 'demo', workspace: ws }, deps)
    assert.ok(existsSync(askpassOf(ws)))
    const j = await findTool('grape_takeover_finish').native({ session_id: 'tkos_fin', summary: '完成' })
    assert.ok(!existsSync(askpassOf(ws)), 'finish 后 askpass 应清理')
    assert.ok(!existsSync(join(ws, '.grape')), '空 .grape 目录也应清理')
    assert.equal(j.askpass_cleanup.length, 1)

    await runCred({ session_id: 'tkos_abort', owner: 'acme', repo: 'demo', workspace: ws }, deps)
    assert.ok(existsSync(askpassOf(ws)))
    const a = await findTool('grape_takeover_abort').native({ session_id: 'tkos_abort', reason: 'r' })
    assert.ok(!existsSync(askpassOf(ws)), 'abort 后 askpass 应清理')
    assert.equal(a.askpass_cleanup.length, 1)
  } finally {
    api.takeoverFinish = origFinish
    api.takeoverAbort = origAbort
    rmSync(ws, { recursive: true, force: true })
  }
})

/* ── QA PR #27 复审修复：提交防泄漏 / coding 门禁 / symlink / 交付留痕 ── */

test('Critical：git 仓库内写入 .git/info/exclude 的 /.grape/，check-ignore 复核通过且不出现在待提交列表', async () => {
  const ws = tmpWs()
  try {
    execFileSync('git', ['init', '-q', ws])
    const j = await runCred(
      { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws },
      { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' },
    )
    assert.equal(j.git_ignore.excluded, true)
    const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\/\.grape\/$/m, 'exclude 必须含 /.grape/')
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', '.grape/git-askpass.sh'], { cwd: ws })
    assert.equal(ignored.status, 0, 'check-ignore 必须判定 .grape 已排除')
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ws, encoding: 'utf8' })
    assert.ok(!status.stdout.includes('.grape'), `.grape 不得出现在待提交列表：${status.stdout}`)
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('Critical：无法确认 .grape 被排除（伪 git 目录）时拒绝写盘', async () => {
  const ws = tmpWs()
  try {
    writeFileSync(join(ws, '.git'), 'not a real git dir')
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' }),
      (e) => /排除|exclude|check-ignore/i.test(`${e.message} ${e.hint || ''}`),
    )
    assert.ok(!existsSync(askpassOf(ws)), '复核未通过不得写出 askpass')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('Required：askpass 目标文件为 symlink 时拒绝（不跟随写到工作区外）', async () => {
  if (!POSIX) return
  const ws = tmpWs()
  const outside = tmpWs()
  try {
    const target = join(outside, 'victim.txt')
    writeFileSync(target, 'untouched')
    mkdirSync(join(ws, '.grape'), { recursive: true })
    symlinkSync(target, askpassOf(ws))
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'linux' }),
      (e) => /符号链接/.test(e.message),
    )
    assert.equal(readFileSync(target, 'utf8'), 'untouched', '工作区外目标不得被写入/改权限')
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('Required：未声明 agent_type 且无产物时按会话记录的 coding 判定并拒绝', async () => {
  const t = findTool('grape_takeover_finish')
  const orig = api.takeoverGet
  api.takeoverGet = async () => ({ session: { id: 'tkos_1', agent_type: 'coding' } })
  try {
    await assert.rejects(
      t.native({ session_id: 'tkos_1', summary: '完成' }),
      (e) => /branch/.test(e.message) && /commit/.test(e.message) && /PR/.test(e.message),
    )
  } finally { api.takeoverGet = orig }
})

test('Required：会话为非 coding（qa）时未声明产物不触发 coding 门禁', async () => {
  const t = findTool('grape_takeover_finish')
  const origGet = api.takeoverGet
  const origFinish = api.takeoverFinish
  api.takeoverGet = async () => ({ session: { id: 'tkos_1', agent_type: 'qa' } })
  api.takeoverFinish = async () => ({ ok: true, changed: true })
  try {
    const j = await t.native({ session_id: 'tkos_1', summary: '完成' })
    assert.equal(j.incomplete_override, undefined)
  } finally {
    api.takeoverGet = origGet
    api.takeoverFinish = origFinish
  }
})

test('Required：校验通过的 branch/commit/PR 追加进 artifacts 留痕（顶层字段不变）', async () => {
  const t = findTool('grape_takeover_finish')
  const orig = api.takeoverFinish
  let payload = null
  api.takeoverFinish = async (_sid, p) => { payload = p; return { ok: true, changed: true } }
  try {
    await t.native({ session_id: 'tkos_1', summary: '完成', agent_type: 'coding', branch: 'feat/issue-31', commit: 'abc1234', pr_number: '27' })
    assert.equal(payload.branch, undefined, 'branch 不写平台顶层字段')
    assert.equal(payload.commit, undefined)
    assert.ok(payload.artifacts.some((x) => /branch: feat\/issue-31/.test(x)), 'branch 必须留痕')
    assert.ok(payload.artifacts.some((x) => /commit: abc1234/.test(x)), 'commit 必须留痕')
    assert.ok(payload.artifacts.some((x) => /PR: 27/.test(x)), 'PR 必须留痕')
  } finally { api.takeoverFinish = orig }
})

test('Optional：owner/repo 为 . 或 .. 段一律拒绝', async () => {
  const ws = tmpWs()
  try {
    for (const bad of ['.', '..']) {
      await assert.rejects(
        runCred({ session_id: 'tkos_1', owner: bad, repo: 'demo', workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW }),
        /非法仓库/,
      )
      await assert.rejects(
        runCred({ session_id: 'tkos_1', owner: 'acme', repo: bad, workspace: ws }, { apiModule: fakeApi({ __ws: ws }), now: () => NOW }),
        /非法仓库/,
      )
    }
    await assert.rejects(
      findTool('grape_create_pull').native({ owner: '..', repo: 'demo', title: 'T', head: 'h', base: 'b' }),
      /非法仓库/,
    )
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('Optional：Windows .cmd 使用 set "VAR=..." 且时间非法即非零退出；含 cmd 元字符的券拒绝写盘', async () => {
  const ws = tmpWs()
  try {
    await runCred(
      { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws },
      { apiModule: fakeApi({ __ws: ws }), now: () => NOW, platform: 'win32' },
    )
    const body = readFileSync(join(ws, '.grape', 'git-askpass.cmd'), 'utf8')
    assert.match(body, /set "GRAPE_ASKPASS_PASSWORD=secret_password_0001"/)
    assert.match(body, /if not defined NOW goto expired_guard/)
    assert.match(body, /findstr \/r "\^\[0-9\]\[0-9\]\*\$"/)
    assert.match(body, /:expired_guard[\s\S]*exit \/b 1/)
  } finally { rmSync(ws, { recursive: true, force: true }) }

  const ws2 = tmpWs()
  try {
    await assert.rejects(
      runCred({ session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws2 }, {
        apiModule: fakeApi({ __ws: ws2, gitCredential: async () => ({ provider: 'gitcode', username: 'x', password: 'a&b%c^d', expires_in: '600' }) }),
        now: () => NOW, platform: 'win32',
      }),
      (e) => /cmd 元字符/.test(e.message),
    )
    assert.ok(!existsSync(join(ws2, '.grape', 'git-askpass.cmd')), '危险口令不得落盘')
  } finally { rmSync(ws2, { recursive: true, force: true }) }
})

test('Optional：进程重启（registry 为空）时 finish 传入 workspace 仍能清理 askpass', async () => {
  const ws = tmpWs()
  const origGet = api.takeoverGet
  const origFinish = api.takeoverFinish
  api.takeoverGet = async () => ({ session: { id: 'tkos_x', agent_type: 'qa', workspace: { cwd_hint: ws } } })
  api.takeoverFinish = async () => ({ ok: true, changed: true })
  try {
    // 模拟另一进程留下的 askpass（不经过 registry）
    mkdirSync(join(ws, '.grape'), { recursive: true })
    writeFileSync(askpassOf(ws), '#!/bin/sh\n', { mode: 0o600 })
    const j = await findTool('grape_takeover_finish').native({ session_id: 'tkos_x', summary: '完成', workspace: ws })
    assert.ok(!existsSync(askpassOf(ws)), '显式 workspace 时必须清理')
    assert.equal(j.askpass_cleanup.length, 1)
  } finally {
    api.takeoverGet = origGet
    api.takeoverFinish = origFinish
    rmSync(ws, { recursive: true, force: true })
  }
})

/* ── Issue #37：换券会话根对齐 workspace 解析优先级（云端 cwd_hint 不再锁死本地接管） ── */

test('W6 云端 cwd_hint 在本机不存在时，显式 workspace 作会话根并换券落盘', async () => {
  const ws = tmpWs()
  const cloud = join(tmpdir(), `gk-cloud-${Date.now()}-nonexistent`)
  try {
    const j = await runCred(
      { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: ws },
      { apiModule: fakeApi({ __ws: cloud }), now: () => NOW, platform: 'linux' },
    )
    assert.ok(existsSync(askpassOf(ws)), '显式 workspace 在云端 hint 下必须可落盘')
    assert.equal(j.workspace, ws)
    assert.equal(j.session_root, ws, '本机视角的会话根 = 显式 workspace')
    assert.match(j.session_root_note, /云端 cwd_hint/, '应披露 cwd_hint 因本机不存在被忽略')
  } finally { rmSync(ws, { recursive: true, force: true }) }
})

test('W7 本机存在的 cwd_hint 仍作越界边界：工作区外路径拒绝且不落盘', async () => {
  const root = tmpWs()
  const outside = tmpWs()
  try {
    await assert.rejects(
      runCred(
        { session_id: 'tkos_1', owner: 'acme', repo: 'demo', workspace: outside },
        { apiModule: fakeApi({ __ws: root }), now: () => NOW, platform: 'linux' },
      ),
      (e) => /工作区/.test(e.message),
    )
    assert.ok(!existsSync(join(outside, '.grape')), '越界目录不得生成文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
