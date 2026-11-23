import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRegQuery, REG_QUERY } from '../src/registry.mjs'

/* ── QA 复审（PR #13 第三批）判断项 4：`reg query` 非零退出必须区分「不存在」与「查询失败」 ──
 * 旧实现把任何非零退出都当成「变量不存在」——reg 不可用、被安全软件拦、拒绝访问时
 * 静默零残留，与 CHANGELOG「不再吞错」相反。win32 实机回归前，这里的分类函数是唯一
 * 能在非 Windows 环境验证该行为的 seam。 */

test('QA#PR13三审 判断项4 reg query 命中（exit 0）→ present', () => {
  const r = classifyRegQuery({ status: 0, stdout: 'HKEY_CURRENT_USER\\Environment\n    GRAPE_API_TOKEN    REG_SZ    grape_x\n', stderr: '' })
  assert.equal(r.state, REG_QUERY.PRESENT)
})

test('QA#PR13三审 判断项4 reg query「找不到该项」（exit 1 + not-found 文案）→ absent', () => {
  for (const stderr of [
    '错误: 系统找不到指定的注册表项或值。',
    'ERROR: The system was unable to find the specified registry key or value.',
  ]) {
    const r = classifyRegQuery({ status: 1, stdout: '', stderr })
    assert.equal(r.state, REG_QUERY.ABSENT, `not-found 应判 absent: ${stderr}`)
  }
})

test('QA#PR13三审 判断项4 reg query 拒绝访问/不可用 → error（不得当成不存在）', () => {
  // 拒绝访问、reg.exe 缺失、超时被 kill 都不等于「变量不存在」
  for (const r of [
    { status: 1, stdout: '', stderr: '错误: 拒绝访问。' },
    { status: 5, stdout: '', stderr: 'ERROR: Access is denied.' },
    { status: null, stdout: '', stderr: '', error: new Error('spawnSync reg ENOENT') },
    { status: null, stdout: '', stderr: '', signal: 'SIGTERM' },
    { status: 1, stdout: '', stderr: '' },
  ]) {
    const got = classifyRegQuery(r)
    assert.equal(got.state, REG_QUERY.ERROR, `查询失败必须判 error: ${JSON.stringify(r)}`)
    assert.ok(got.detail, 'error 必须带可读原因（供残留提示点名人工核对）')
  }
})

test('QA#PR13三审 判断项4 classifyRegQuery 对空/畸形输入不抛错（宁可报 error 不得静默 absent）', () => {
  for (const bad of [undefined, null, {}, { status: '0' }]) {
    const got = classifyRegQuery(bad)
    assert.equal(got.state, REG_QUERY.ERROR, `畸形输入必须收敛为 error: ${JSON.stringify(bad)}`)
  }
})