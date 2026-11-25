/**
 * 测试脚手架可移植性回归（评审发现①）。
 *
 * 背景：scripts/fake-grape.mjs 把 wait 轮询计数器硬编码在 `/tmp/opencode/`。
 * 多用户机器上该目录属主是别的用户（实测 755 + 非属主），其他人跑 `npm test` 时
 * mkdir/write 抛 EACCES → `waitTask 轮询到终态` 必挂，看起来像产品 bug。
 * 现在改为 `os.tmpdir()` 下按 uid 隔离，并支持 GRAPE_FAKE_TMPDIR 覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'scripts/fake-grape.mjs')

test('fake-grape 不再把计数器硬编码到 /tmp/opencode', () => {
  const src = readFileSync(FAKE, 'utf8')
  assert.doesNotMatch(src, /\/tmp\/opencode/, '不允许再出现 /tmp/opencode 硬编码（多用户机器上不可写）')
  assert.match(src, /tmpdir\(\)/, '应使用 os.tmpdir()')
})

test('GRAPE_FAKE_TMPDIR 生效：计数器落在指定目录，第二次查询返回终态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-fake-'))
  const env = { ...process.env, GRAPE_FAKE_TMPDIR: dir }
  const run = () => spawnSync(process.execPath, [FAKE, 'events', 'detail', '--seq', '424242'], { env, encoding: 'utf8' })

  const first = JSON.parse(run().stdout)
  const second = JSON.parse(run().stdout)
  assert.equal(first.status, 'running')
  assert.equal(second.status, 'completed', '同一 seq 第二次查询必须是终态（wait 轮询用例依赖它）')

  const files = readdirSync(dir)
  assert.ok(files.includes('fake-grape-noscope-424242.count'), `计数器应落在 ${dir}，实际: ${files.join(',')}`)
  assert.ok(existsSync(join(dir, 'fake-grape-noscope-424242.count')))
})

test('默认目录按 uid 隔离（互不污染，且当前用户一定可写）', () => {
  const env = { ...process.env }
  delete env.GRAPE_FAKE_TMPDIR
  const out = spawnSync(process.execPath, [FAKE, 'events', 'detail', '--seq', '777'], { env, encoding: 'utf8' })
  assert.equal(out.status, 0)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'win'
  const dir = join(tmpdir(), `grape-fake-${uid}`)
  assert.ok(existsSync(join(dir, 'fake-grape-noscope-777.count')), `默认计数器应在 ${dir}`)
})