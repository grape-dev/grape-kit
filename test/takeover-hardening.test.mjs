import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/* ── M1（P0-2）：finish 两阶段语义在 SKILL / README / 架构文档 / 403 文案四处一致 ── */

const FINISH_DOCS = [
  ['skills/grape-remote/SKILL.md', /用户级凭据|用户凭据/],
  ['README.zh.md', /用户级凭据|用户凭据/],
  ['README.md', /user-level credential/i],
  ['docs/20261114-takeover-architecture.md', /用户级凭据|用户凭据/],
]

test('M1 文档口径一致：finish 需用户级凭据（四份文档）', () => {
  for (const [file, re] of FINISH_DOCS) {
    const text = read(file)
    assert.match(text, re, `${file} 应写明 finish 需用户级凭据`)
    assert.match(text, /request-finish/, `${file} 应写明 request-finish 阶段`)
  }
})

test('M1 文档删除「前端确认按钮」指路', () => {
  for (const [file] of FINISH_DOCS) {
    const text = read(file)
    assert.ok(!/前端点|前端.{0,4}确认按钮|click the confirm button/i.test(text), `${file} 不应再指路前端确认按钮`)
  }
})

test('M1 403 文案：finish 路径提示需用户级凭据', async () => {
  const { hintFor } = await import('../src/api.mjs')
  const hint = hintFor(403, { path: '/api/takeover/sessions/tkos_x/finish' })
  assert.match(hint, /用户级凭据/, 'finish 403 应说明需用户级凭据')
  assert.match(hint, /tko_/, '应说明 tko_ 的能力边界')
})

/* ── M2（P0-1）：takeover_start 必须显式披露 push 能力边界 ── */

test('M2 takeover_start 描述与渲染披露 git 凭据边界', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_takeover_start')
  assert.match(t.description, /git 凭据/, '工具描述应写明 tko_ 不含 git 凭据注入')
  assert.match(t.description, /tko_/)
  const out = t.render({
    takeover_id: 'tkos_abc123',
    bundle: { env: { GRAPE_SESSION_TOKEN: 'tko_fake_for_test' }, workspace: { cwd_hint: '/work/x' } },
  })
  assert.match(out, /push 能力边界/, '渲染应单列 push 能力边界')
  assert.match(out, /不含 git 凭据注入/, '应写明不含 git 凭据注入')
  assert.match(out, /洁净机器/, '应给出洁净机器回推路径')
  assert.ok(!out.includes('tko_fake_for_test'), '完整 token 不得出现在渲染结果')
})

/* ── M3（P0-3）：warnings 全量透出 + 分支/MR 分叉裁决 playbook ── */

test('M3 warnings 全量透出、不截断，并成前置检查清单', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_takeover_start')
  const long = 'remote_may_still_run: ' + '云端 worker 在被杀前可能已推送分支并开 MR，'.repeat(8) + 'TAIL_MARKER'
  const warnings = [
    'w1', 'w2', 'w3', 'w4', 'w5', 'w6', long,
    'node_already_advanced: 链已交棒至下一节点（更新事件 seq=99 qa）',
    'w9_LAST_MARKER',
  ]
  const out = t.render({ takeover_id: 'tkos_x', warnings, bundle: {} })
  assert.match(out, /前置检查清单/, '应把 warnings 呈现为前置检查清单')
  assert.match(out, /w6/, '第 6 条警告必须透出（不得只取前 5 条）')
  assert.match(out, /w9_LAST_MARKER/, '末尾警告必须透出')
  assert.match(out, /TAIL_MARKER/, '长警告不得被截断')
  assert.match(out, /远程分支可能已被云端 worker|分支\/MR 冲突/, 'remote_may_still_run 应给裁决说明')
  assert.match(out, /分叉裁决 playbook/, '应指向分叉裁决 playbook')
  assert.match(out, /docs\/20261114-takeover-architecture\.md/, '应给出 playbook 文档位置')
})

test('M3 架构文档含分叉裁决 playbook', () => {
  const doc = read('docs/20261114-takeover-architecture.md')
  assert.match(doc, /分叉裁决/)
  assert.match(doc, /remote_may_still_run/)
  assert.match(doc, /已有 MR|已开 MR|MR 列表/)
})

/* ── M4（P1-4 / P1-5）：409 agent_mismatch 友好提示 + bundle 脚本渲染与 {{CWD}} ── */

test('M4 409 agent_mismatch 给友好提示与轮询建议', async () => {
  const { hintFor } = await import('../src/api.mjs')
  const hint = hintFor(409, { detail: 'agent_mismatch: 目标节点不是当前活跃节点' })
  assert.match(hint, /只能对准当前活跃节点|当前活跃节点/, '应解释节点对准约束')
  assert.match(hint, /轮询/, '应给轮询建议')
  assert.match(hint, /pipeline_info|takeover_status/, '应给出确认当前节点的工具')
  assert.equal(hintFor(409, { detail: 'other conflict' }), '', '非 agent_mismatch 的 409 不套用该提示')
})

test('M4 takeover_start 渲染内置 Node 脚本（report / request-finish / finish）', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_script1',
    bundle: { env: { GRAPE_SESSION_TOKEN: 'tko_fake_for_test' }, workspace: { cwd_hint: '/work/proj' } },
  })
  assert.match(out, /接管脚本/, '应渲染脚本段')
  assert.match(out, /scripts\/takeover\/report\.mjs/, '应给出 report 脚本')
  assert.match(out, /scripts\/takeover\/request-finish\.mjs/, '应给出 request-finish 脚本')
  assert.match(out, /scripts\/takeover\/finish\.mjs/, '应给出 finish 脚本')
  assert.match(out, /--session tkos_script1/, '脚本应带会话 id')
  assert.match(out, /用户级凭据/, 'finish 脚本应标注凭据要求')
})

test('M4 bundle 脚本与 GRAPE_AUTH_FILE 的 {{CWD}} 本地渲染', async () => {
  const { findTool } = await import('../src/tools.mjs')
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_cwd1',
    bundle: {
      env: { GRAPE_SESSION_TOKEN: 'tko_fake', GRAPE_AUTH_FILE: '{{CWD}}/.grape/config.json' },
      workspace: { cwd_hint: 'C:\\work\\proj' },
      scripts: { node: 'cd "{{CWD}}" && node run.mjs' },
    },
  })
  assert.match(out, /C:\\work\\proj\/\.grape\/config\.json/, 'GRAPE_AUTH_FILE 的占位符应被渲染')
  assert.match(out, /cd "C:\\work\\proj" && node run\.mjs/, 'bundle 脚本的占位符应被渲染')
  assert.ok(!out.includes('{{CWD}}'), '渲染结果不应残留字面量占位符')
})

test('M4 Node 版接管脚本可执行（--help 自述用法）', async () => {
  const { spawnSync } = await import('node:child_process')
  for (const name of ['report', 'request-finish', 'finish']) {
    const p = join(ROOT, 'skills/grape-remote/scripts/takeover', `${name}.mjs`)
    const r = spawnSync(process.execPath, [p, '--help'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(r.status, 0, `${name}.mjs --help 应成功：${r.stderr}`)
    assert.match(r.stdout, /用法|usage/i, `${name}.mjs 应输出用法`)
  }
})

/* ── M5（P1-6 / P2）：doctor 凭据来源、401 动态 baseUrl、Windows 文档 ── */

test('M5 resolveCredentials 标注当前生效凭据来源', async () => {
  const { resolveCredentials } = await import('../src/api.mjs')
  const ISO = { GRAPE_AUTH_FILE: '/nonexistent/gk-test-auth.json' }
  assert.equal(resolveCredentials({ ...ISO, GRAPE_API_TOKEN: 'grape_fake' }).source, 'env:GRAPE_API_TOKEN')
  assert.equal(resolveCredentials({ ...ISO, GRAPE_API_TOKEN_ONCE: 'grape_once_fake' }).source, 'env:GRAPE_API_TOKEN_ONCE')
  const dir = mkdtempSync(join(tmpdir(), 'gk-src-'))
  try {
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, '{"token":"grape_from_file","base_url":"https://file.example"}')
    const byFile = resolveCredentials({ GRAPE_AUTH_FILE: cfg })
    assert.equal(byFile.source, `file:${cfg}`)
    assert.equal(byFile.baseUrl, 'https://file.example')
    assert.equal(resolveCredentials(ISO).source, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('M5 401 提示按实际 GRAPE_BASE_URL 生成', async () => {
  const { hintFor } = await import('../src/api.mjs')
  const hint = hintFor(401, { baseUrl: 'https://grape.internal.example/' })
  assert.match(hint, /https:\/\/grape\.internal\.example\/app\/#account\/profile/, '应指向实际实例地址')
  assert.ok(!hint.includes('www.grapedev.cn'), '自部署实例不应被指向生产域名')
})

test('M5 doctor 输出当前生效凭据来源（env / 文件 / 未配置）', () => {
  const { spawnSync } = require('node:child_process')
  const h = mkdtempSync(join(tmpdir(), 'gk-doc-'))
  try {
    const base = { HOME: h, GRAPE_KIT_SKIP_UPDATE_CHECK: '1', GRAPE_BASE_URL: 'https://self.example' }
    const byEnv = spawnSync(process.execPath, [join(ROOT, 'grape-kit.mjs'), 'doctor'], {
      encoding: 'utf8', env: { ...base, GRAPE_API_TOKEN: 'grape_fake_for_test' },
    })
    assert.equal(byEnv.status, 0, byEnv.stderr)
    assert.match(byEnv.stdout, /当前生效凭据来源/)
    assert.match(byEnv.stdout, /环境变量 GRAPE_API_TOKEN/)

    const cfg = join(h, 'auth.json')
    writeFileSync(cfg, '{"token":"grape_from_file","base_url":"https://file.example"}')
    const byFile = spawnSync(process.execPath, [join(ROOT, 'grape-kit.mjs'), 'doctor'], {
      encoding: 'utf8', env: { ...base, GRAPE_AUTH_FILE: cfg },
    })
    assert.match(byFile.stdout, /当前生效凭据来源/, '文件通道同样要给出来源')
    assert.match(byFile.stdout, new RegExp(cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '应显示生效的配置文件路径')

    const none = spawnSync(process.execPath, [join(ROOT, 'grape-kit.mjs'), 'doctor'], {
      encoding: 'utf8', env: { ...base, GRAPE_AUTH_FILE: join(h, 'missing.json') },
    })
    assert.match(none.stdout, /当前生效凭据来源/)
    assert.match(none.stdout, /未配置/)
  } finally { rmSync(h, { recursive: true, force: true }) }
})

test('M5 Windows 文档三条：编码 / BOM / setx（README + AGENTS）', () => {
  for (const file of ['README.zh.md', 'README.md', 'AGENTS.md']) {
    const text = read(file)
    assert.match(text, /GBK/, `${file} 应说明 GBK 解码乱码`)
    assert.match(text, /BOM/, `${file} 应说明 config.json BOM`)
    assert.match(text, /setx/, `${file} 应说明 setx 不传播需重启会话`)
  }
})
