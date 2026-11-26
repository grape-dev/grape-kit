import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Issue #38 / PR #36 QA P0：`package.json` 的 `bin.grape-kit` 指向 `./grape-kit.mjs`，
 * POSIX 全局安装后用户真正执行的是 `node_modules/.bin/grape-kit`——一个指向本文件的符号链接。
 * 任何「入口路径 vs import.meta.url 比较」的守卫都必须解链后比较：Node 的 `process.argv[1]`
 * 保留链接路径，而 `import.meta.url` 已是 realpath，字符串 resolve() 比不相等 →
 * 整块 main 被跳过 → 静默 `exit=0`、无任何输出（比报错更难排查）。
 * 本用例是唯一能暴露该形态的回归：其余用例全部用真实路径直接调起。 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ENTRY = join(ROOT, 'grape-kit.mjs')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** win32 建符号链接需开发者模式/管理员权限，跳过并按实机回归覆盖 */
const skipOnWin = { skip: process.platform === 'win32' ? 'win32 建符号链接需额外权限，实机回归覆盖' : false }

function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, HOME: cwd, GRAPE_HOME: '', GRAPE_AUTH_FILE: '' },
    timeout: 30_000,
  })
}

test('Issue #38 bin 符号链接入口与真实路径入口输出一致（.bin 调用不得静默 exit=0）', skipOnWin, () => {
  const d = mkdtempSync(join(tmpdir(), 'grape-kit-bin-'))
  dirs.push(d)
  // 与 POSIX npm 安装后的 .bin 同形：符号链接指向真实的 grape-kit.mjs
  const link = join(d, 'grape-kit')
  symlinkSync(ENTRY, link)

  const direct = runNode(ENTRY, ['--version'], d)
  assert.equal(direct.status, 0, direct.stderr)
  assert.equal(direct.stdout.trim(), VERSION, '直接路径调用应打印版本号')

  const viaLink = runNode(link, ['--version'], d)
  assert.equal(viaLink.status, 0, viaLink.stderr)
  assert.equal(
    viaLink.stdout.trim(),
    VERSION,
    `符号链接入口必须与直接入口同输出；实际 stdout=${JSON.stringify(viaLink.stdout)} stderr=${JSON.stringify(viaLink.stderr)}（静默无输出 = main 被入口守卫跳过）`,
  )
})