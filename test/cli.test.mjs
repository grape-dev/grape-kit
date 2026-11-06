import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGrape, waitTask, GrapeCliError, TERMINAL_STATUSES } from '../src/cli.mjs'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE = new URL('../scripts/fake-grape.mjs', import.meta.url).pathname
const env = () => ({ ...process.env, GRAPE_CLI_BIN: process.execPath, GRAPE_MCP_TIMEOUT: '10000' })

function fakeBin(dir) {
  const p = join(dir, 'fake-grape')
  writeFileSync(p, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`)
  chmodSync(p, 0o755)
  return p
}

test('runGrape 解析 --json-out 单行 JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-'))
  try {
    const { json } = await runGrape(['issues', 'list', '--owner', 'acme', '--repo', 'demo'], {
      bin: fakeBin(dir), env: env(),
    })
    assert.equal(json.length, 2)
    assert.equal(json[0].number, 23)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runGrape 透传非零退出码与 stderr 末行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-'))
  try {
    const bin = fakeBin(dir)
    // 注：POSIX 退出码会被截断为低 8 位（401 & 0xFF = 145，grape-cli 文档已知行为），
    // 壳层约定：code !== 0 即失败，HTTP 语义从 stderr 文本读取。
    await assert.rejects(
      runGrape(['issues', 'list', '--owner', 'x', '--repo', 'y'], { bin, env: { ...env(), GRAPE_FAKE_FAIL: '401' } }),
      (err) => err instanceof GrapeCliError && err.code !== 0 && /401/.test(err.message),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('runGrape ENOENT 给出安装指引', async () => {
  await assert.rejects(
    runGrape(['issues', 'list'], { bin: '/nonexistent/grape-kit-missing-bin', env: env() }),
    (err) => err.code === 127 && /pip install/.test(err.message),
  )
})

test('runGrape 超时 kill 并报 124', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-'))
  try {
    const slow = join(dir, 'slow')
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n')
    chmodSync(slow, 0o755)
    await assert.rejects(
      runGrape(['anything'], { bin: slow, env: env(), timeoutMs: 200 }),
      (err) => err.code === 124 && /超时/.test(err.message),
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('waitTask 轮询到终态返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-'))
  try {
    const bin = fakeBin(dir)
    const seq = 8000 + Math.floor(Math.random() * 1000) // 随机 seq 避免计数器文件跨次运行污染
    const r = await waitTask(seq, { timeoutSec: 5, intervalSec: 0.05, opts: { bin, env: env() } })
    assert.equal(r.json.seq, seq)
    assert.equal(r.json.status, 'completed')
    assert.ok(r.polls >= 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('waitTask 超时标记 timedOut', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-'))
  try {
    const bin = fakeBin(dir)
    const r = await waitTask(86, { timeoutSec: 0.3, intervalSec: 0.1, opts: { bin, env: { ...env(), GRAPE_FAKE_TASK_STATUS: 'running' } } })
    assert.equal(r.timedOut, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('终态集合覆盖cancelled 变体', () => {
  assert.ok(TERMINAL_STATUSES.has('cancelled') && TERMINAL_STATUSES.has('canceled'))
})
