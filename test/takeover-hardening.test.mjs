import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
