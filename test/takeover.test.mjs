import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
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
  const done = t.render({ ok: true, changed: true, next_agent: 'qa', event_status: 'completed', issue_stage: 'qa', session: { handoff: { seq: 42 } } })
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


test('CLI：install --target workbuddy 支持（P0-1/P0-2，WorkBuddy 报告）', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process')
  const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir, homedir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'wk-test-'))
  const fakeHome = join(dir, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const { fileURLToPath } = await import('node:url')
  const bin = join(join(fileURLToPath(import.meta.url)), '..', '..', 'grape-kit.mjs')
  // HOME 重定向（workbuddyPaths 用 homedir()）
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome }
  const r = spawnSync(process.execPath, [bin, 'install', '--target', 'workbuddy'], { encoding: 'utf8', env, timeout: 20000 })
  assert.equal(r.status, 0, `install 应成功，实际输出: ${r.stderr || r.stdout}`)
  const mcpPath = join(fakeHome, '.workbuddy', 'mcp.json')
  assert.ok(existsSync(mcpPath), 'mcp.json 应被写入')
  const cfg = JSON.parse(readFileSync(mcpPath, 'utf8'))
  assert.ok(cfg.mcpServers && cfg.mcpServers['grape-kit'], 'mcpServers.grape-kit 应存在')
  assert.equal(cfg.mcpServers['grape-kit'].command, 'npx', '默认走 npx')
  assert.deepEqual(cfg.mcpServers['grape-kit'].args, ['-y', '-p', '@grape-dev/grape-kit', 'grape-kit-mcp'])
  const skillPath = join(fakeHome, '.workbuddy', 'skills', 'grape-remote', 'SKILL.md')
  assert.ok(existsSync(skillPath), 'skill 应落地 ~/.workbuddy/skills/grape-remote/')
  // 幂等：重复 install 不炸
  const r2 = spawnSync(process.execPath, [bin, 'install', '--target', 'workbuddy'], { encoding: 'utf8', env, timeout: 20000 })
  assert.equal(r2.status, 0, '重复 install 应幂等')
  // 卸载
  const r3 = spawnSync(process.execPath, [bin, 'uninstall', '--target', 'workbuddy'], { encoding: 'utf8', env, timeout: 20000 })
  assert.equal(r3.status, 0, 'uninstall 应成功')
  const cfg2 = JSON.parse(readFileSync(mcpPath, 'utf8'))
  assert.ok(!cfg2.mcpServers || !cfg2.mcpServers['grape-kit'], '卸载后条目应移除')
  rmSync(dir, { recursive: true, force: true })
})

test('工具：4 个写操作有确认标注（P1-1，WorkBuddy 报告）', () => {
  for (const name of ['grape_trigger_pipeline', 'grape_create_issue', 'grape_sync_repos', 'grape_worker_onboard']) {
    const t = findTool(name)
    assert.ok(/确认|决策|用户/.test(t.description), `${name} 描述应含确认语义`)
  }
})

test('工具：worker_onboard 不输出明文 token（P1-2）', async () => {
  const t = findTool('grape_worker_onboard')
  // run() 会真调 API 创建凭据——mock api 模块的 workerCredentialCreate，只验证输出形状
  const apiMod = await import('../src/api.mjs')
  const orig = apiMod.api.workerCredentialCreate
  apiMod.api.workerCredentialCreate = async () => ({ token: 'rta_FAKE_for_test_000000000', name: 'test-dev' })
  try {
    const j = await t.run({ device_name: 'test-dev' }, {})
    assert.ok(j.install_command, '应有 install_command')
    assert.ok(!j.install_command.includes('rta_FAKE_for_test_000000000'), 'install_command 不应含真实 token')
    assert.ok(j.install_command.includes('<TOKEN>') || j.install_command.includes('RUNTIME_TOKEN='), '应以占位符/env 方式引导')
  } finally {
    apiMod.api.workerCredentialCreate = orig
  }
})

/* ── Issue #37：本地接管 workspace 覆盖（物化 / AUTH_FILE 不再被云端 cwd_hint 锁死） ── */

test('W1 三态优先级：args.workspace > bundle.workspace.cwd_hint > 基目录', async () => {
  const { resolveLocalWorkspace } = await import('../src/tools.mjs')
  const { join } = await import('node:path')
  const bundle = { workspace: { cwd_hint: '/cloud/ws' } }
  assert.equal(resolveLocalWorkspace({ workspace: '/local/ws', bundle, cwd: '/proc/cwd' }), '/local/ws', '入参必须优先于 cwd_hint')
  assert.equal(resolveLocalWorkspace({ bundle, cwd: '/proc/cwd' }), '/cloud/ws', '缺入参时回落 cwd_hint')
  assert.equal(resolveLocalWorkspace({ bundle: {}, cwd: '/proc/cwd' }), '/proc/cwd', '两者皆缺时回落当前目录')
  assert.equal(resolveLocalWorkspace({ workspace: '   ', bundle, cwd: '/proc/cwd' }), '/cloud/ws', '空白入参视同缺省')
  assert.equal(resolveLocalWorkspace({ workspace: 'proj/sub', bundle: {}, cwd: '/base' }), join('/base', 'proj', 'sub'), '相对路径按基目录归一')
})

test('W2 native wiring：显式 workspace 优先物化，返回 workspace_effective + 不一致披露', async () => {
  const { mkdtempSync, rmSync, existsSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { api } = await import('../src/api.mjs')
  const local = mkdtempSync(join(tmpdir(), 'gk-ws37-'))
  const original = api.takeoverStart
  try {
    api.takeoverStart = async () => ({
      takeover_id: 'tkos_ws37',
      bundle: {
        workspace: { cwd_hint: '/cloud/does-not-exist' },
        assets: { skill: { skill: 'coding-cli', files: [{ path: 'SKILL.md', content: '# wired' }] } },
      },
    })
    const json = await findTool('grape_takeover_start').native({ owner: 'o', repo: 'r', number: 37, workspace: local })
    assert.equal(json.workspace_effective, local, '返回体应携带解析后的本地工作区')
    assert.equal(json.skillMaterialization.status, 'ok', json.skillMaterialization.reason)
    assert.equal(json.skillMaterialization.path, join(local, '.grape-takeover-skills', 'coding-cli'), '物化必须落到入参目录')
    assert.equal(readFileSync(join(local, '.grape-takeover-skills', 'coding-cli', 'SKILL.md'), 'utf8'), '# wired')
    assert.ok(existsSync(json.skillMaterialization.path))
    assert.match(json.workspace_note, /云端工作区路径在本机不存在/, '与 cwd_hint 不一致时必须显式披露')
    assert.match(json.workspace_note, /\/cloud\/does-not-exist/)
  } finally {
    api.takeoverStart = original
    rmSync(local, { recursive: true, force: true })
  }
})

test('W3 render：以本地 workspace 渲染 {{CWD}}，披露云端 hint 并本地化 AUTH_FILE', () => {
  const out = findTool('grape_takeover_start').render({
    takeover_id: 'tkos_ws37',
    workspace_effective: '/local/ws',
    bundle: {
      env: { GRAPE_SESSION_TOKEN: 'tko_fake', GRAPE_AUTH_FILE: '/cloud/ws/.grape-takeover-token' },
      workspace: { cwd_hint: '/cloud/ws' },
      assets: { scripts: [{ filename: 'env.sh', content: 'cd "{{CWD}}" && node run.mjs' }] },
    },
  })
  assert.match(out, /本地工作目录: \/local\/ws/, '本地工作目录必须是解析值')
  assert.match(out, /云端工作区路径在本机不存在[^\n]*\/cloud\/ws/, '不一致必须显式披露')
  assert.match(out, /cd "\/local\/ws" && node run\.mjs/, '脚本占位符按本地 workspace 渲染')
  assert.match(out, /\/local\/ws\/\.grape-takeover-token/, 'AUTH_FILE 应前缀替换为本地工作区')
  const authLine = out.split('\n').find((l) => l.includes('凭据文件（路径占位符已渲染）'))
  assert.ok(authLine && authLine.includes('/local/ws/.grape-takeover-token'), '凭据文件行必须是本地路径')
  assert.ok(authLine && !authLine.includes('/cloud/ws'), '凭据文件行不得残留云端路径')
  assert.ok(!out.includes('{{CWD}}'))
})

test('W4 render：AUTH_FILE 不在 cwd_hint 根内时保持原路径并提示 source', () => {
  const out = findTool('grape_takeover_start').render({
    takeover_id: 'tkos_ws37',
    workspace_effective: '/local/ws',
    bundle: { env: { GRAPE_AUTH_FILE: '/opt/creds/grape.json' }, workspace: { cwd_hint: '/cloud/ws' } },
  })
  assert.match(out, /\/opt\/creds\/grape\.json/, '不在 hint 根内的自定义路径不得被改写')
  assert.match(out, /本机可能不可读|source/, '无法安全重写时必须给 source 提示')
})

test('W5 render：无显式 workspace 时保持 cwd_hint 旧口径（不回退）', () => {
  const out = findTool('grape_takeover_start').render({
    takeover_id: 'tkos_ws37',
    bundle: { env: { GRAPE_AUTH_FILE: '{{CWD}}/.grape/config.json' }, workspace: { cwd_hint: '/cloud/ws' } },
  })
  assert.match(out, /本地工作目录: \/cloud\/ws/)
  assert.match(out, /\/cloud\/ws\/\.grape\/config\.json/)
  assert.ok(!/云端工作区路径在本机不存在/.test(out), '一致时不得告警')
})

test('W8 AUTH_FILE 本地化：自定义绝对路径与相对路径不改写（不丢子目录、不误改用户路径）', async () => {
  const { localizeAuthFile } = await import('../src/tools.mjs')
  const custom = localizeAuthFile('/opt/creds/.grape-takeover-token', { workspace: '/local/ws', cwdHint: '/cloud/ws' })
  assert.equal(custom.path, '/opt/creds/.grape-takeover-token', '自定义绝对路径不得被 basename 启发式改写')
  assert.equal(custom.rewritten, false)
  assert.match(custom.note, /本机可能不可读|source/)
  const relative = localizeAuthFile('creds/.grape-takeover-token', { workspace: '/local/ws', cwdHint: '/cloud/ws' })
  assert.equal(relative.path, 'creds/.grape-takeover-token', '相对路径不得被改写（否则丢子目录）')
  assert.equal(relative.rewritten, false)
  const underHint = localizeAuthFile('/cloud/ws/.grape-takeover-token', { workspace: '/local/ws', cwdHint: '/cloud/ws' })
  assert.equal(underHint.path, join('/local/ws', '.grape-takeover-token'), 'cwd_hint 内的平台默认 token 仍应前缀替换')
  assert.equal(underHint.rewritten, true)
})

test('W9 路径归一：Windows 盘根不丢分隔符', async () => {
  const { resolveLocalWorkspace } = await import('../src/tools.mjs')
  assert.equal(resolveLocalWorkspace({ workspace: 'C:\\' }), 'C:\\', '盘根 C:\\ 不得剥成 C:')
  assert.equal(resolveLocalWorkspace({ workspace: 'C:/' }), 'C:/', '盘根 C:/ 保持')
  assert.equal(resolveLocalWorkspace({ workspace: '/' }), '/', 'POSIX 根保持')
})
