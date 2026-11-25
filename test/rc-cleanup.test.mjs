import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planRcCleanup, scanRcResidues, cleanCredentialChannels } from '../src/rc-cleanup.mjs'

/* Issue #38：win32 的 rc 清理路径此前被两处平台门禁挡死——`scanResidues()` 的 rc 段整体包在
 * `if (process.platform !== 'win32')` 内（win32 下 rcHits 恒空），`cleanEnvVars()` 的 win32 分支
 * 处理完 `reg delete` 就 return（rc 清理循环只属非 win32 路径）。Git Bash 读的是 USERPROFILE 下的
 * rc，于是 Windows 上执行 `uninstall --clean-global` 后三条 rc 凭据行全部留盘。
 * 测试缝落在 src/rc-cleanup.mjs（纯实现 + 注入 reg 运行器/备份实现），CLI 入口不再导出内部函数。 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SETUP = join(ROOT, 'grape-kit.mjs')

const dirs = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-rc-'))
  dirs.push(h)
  return h
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** win32 的 HOME 隔离对 homedir()（读 USERPROFILE）无效，走实机回归 */
const skipOnWin = { skip: process.platform === 'win32' ? 'win32: HOME 隔离对 homedir() 无效，走实机回归' : false }

/** 备份替身：与 grape-kit.mjs 的 backupOf 同语义（写入同名前缀 .bak 并返回路径），供模块用例断言掩码 */
function backupTo(file, text) {
  const b = `${file}.bak-grapemcp-test`
  writeFileSync(b, text)
  return b
}

/** rc 三形态夹具：.bashrc（export + declare -x）、.bash_profile（仅登录 shell 读）、config.fish（set -x） */
function seedRc(h, { crlf = false, bom = false } = {}) {
  const eol = crlf ? '\r\n' : '\n'
  const prefix = bom ? '\uFEFF' : ''
  writeFileSync(join(h, '.bashrc'), `${prefix}export PATH=$PATH:/bin${eol}export GRAPE_API_TOKEN=grape_win_bashrc${eol}declare -x GRAPE_BASE_URL=https://win.example${eol}`)
  writeFileSync(join(h, '.bash_profile'), `${prefix}export GRAPE_API_TOKEN=grape_win_profile${eol}export KEEP_ME=1${eol}`)
  const fish = join(h, '.config', 'fish', 'config.fish')
  mkdirSync(dirname(fish), { recursive: true })
  writeFileSync(fish, `${prefix}set -x GRAPE_API_TOKEN grape_win_fish${eol}set -gx EDITOR vim${eol}`)
  return { bashrc: join(h, '.bashrc'), profile: join(h, '.bash_profile'), fish }
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})

/* ── 切片 1：BOM 保真（边界缺陷） ── */

test('Issue #38 planRcCleanup：首行即凭据行时 BOM 迁移到新首行，CRLF 与无关行原样保留', () => {
  const text = '\uFEFFexport GRAPE_API_TOKEN=grape_seed_first\r\nexport PATH=$PATH:/bin\r\n'
  const r = planRcCleanup(text, 'posix')

  assert.equal(r.hits, 1, '首行凭据行应计 1 行命中')
  assert.doesNotMatch(r.cleaned, /GRAPE_API_TOKEN|grape_seed_first/, '清理结果不得残留凭据行')
  assert.equal(r.cleaned.charCodeAt(0), 0xFEFF, 'BOM 必须迁移到新首行——不能随被删首行一起丢失')
  assert.equal(r.cleaned, '\uFEFFexport PATH=$PATH:/bin\r\n', '无关行与 CRLF 行尾必须原样保留')
  assert.equal(r.masked.charCodeAt(0), 0xFEFF, '备份同为原文件编码风格（BOM 保真）')
  assert.doesNotMatch(r.masked, /grape_seed_first/, '备份不得含凭据明文')
  assert.match(r.masked, /已移除凭据行\] GRAPE_API_TOKEN/, '备份应以注释掩码保留凭据行位置')
})

/* ── 切片 2：rc 扫描不再有平台门禁（#38 主修复的单一扫描源） ── */

test('Issue #38 scanRcResidues：rc 三形态全部命中，无平台门禁', () => {
  const h = home()
  seedRc(h)

  const s = scanRcResidues(h)
  assert.equal(s.rcHits.length, 3, `三形态都应命中，实际: ${JSON.stringify(s.rcHits)}`)
  assert.ok(s.rcHits.some((x) => x.path.endsWith('.bashrc') && x.hits === 2), '.bashrc 的 export + declare -x 两条应计为 2 行')
  assert.ok(s.rcHits.some((x) => x.kind === 'fish'), 'config.fish 应走 fish 判据')
})

/* ── 切片 3：win32 两条通道并列（注册表清理后不得提前 return） ── */

test('Issue #38 cleanCredentialChannels：win32 删完注册表仍清理 Git Bash rc 三形态', () => {
  const h = home()
  const paths = seedRc(h, { crlf: true, bom: true })
  // win32 的 scanResidues 结果是唯一扫描源：注册表命中 + rc 命中同时存在
  const scan = () => ({ grapeHome: null, authFileOverride: null, regErrors: [], ...scanRcResidues(h), envKeys: ['GRAPE_API_TOKEN'] })
  const regCalls = []

  cleanCredentialChannels({
    scan,
    platform: 'win32',
    backupOf: backupTo,
    reg: (args) => { regCalls.push(args); return { status: 0, stdout: '', stderr: '' } },
    log: () => {},
    warn: () => {},
  })

  assert.deepEqual(regCalls, [['delete', 'HKCU\\Environment', '/v', 'GRAPE_API_TOKEN', '/f']], 'win32 仍须执行注册表删除（第一条通道）')
  const bashrc = readFileSync(paths.bashrc, 'utf8')
  assert.doesNotMatch(bashrc, /grape_win_bashrc|GRAPE_API_TOKEN\s*=|GRAPE_BASE_URL\s*=/, 'rc 凭据行必须同时清理（第二条通道，不得提前 return）')
  assert.match(bashrc, /export PATH=\$PATH:\/bin/, '.bashrc 无关行必须保留')
  assert.equal(bashrc.charCodeAt(0), 0xFEFF, '原 BOM 必须保留')
  assert.equal(bashrc.replace(/\r\n/g, '').includes('\n'), false, '原 CRLF 行尾必须保留')
  assert.doesNotMatch(readFileSync(paths.profile, 'utf8'), /grape_win_profile|GRAPE_API_TOKEN\s*=/, '.bash_profile 凭据行必须清理')
  assert.match(readFileSync(paths.profile, 'utf8'), /export KEEP_ME=1/, '.bash_profile 无关行必须保留')
  assert.doesNotMatch(readFileSync(paths.fish, 'utf8'), /grape_win_fish|GRAPE_API_TOKEN/, 'config.fish 凭据行必须清理')
  assert.match(readFileSync(paths.fish, 'utf8'), /set -gx EDITOR vim/, 'config.fish 无关行必须保留')

  const backups = walk(h).filter((p) => p.includes('.bak-grapemcp-'))
  assert.equal(backups.length, 3, 'rc 三形态改动前都应留备份')
  for (const b of backups) {
    const text = readFileSync(b, 'utf8')
    assert.doesNotMatch(text, /grape_win_bashrc|grape_win_profile|grape_win_fish|GRAPE_API_TOKEN\s*=|GRAPE_BASE_URL\s*=/, `备份不得含凭据明文: ${b}`)
    assert.match(text, /已移除凭据行\] GRAPE_/, `备份应保留凭据行掩码标注: ${b}`)
  }
})

test('Issue #38 cleanCredentialChannels：win32 注册表查询失败仍如实告警（不吞错），rc 照常清理', () => {
  const h = home()
  const paths = seedRc(h)
  const scan = () => ({ grapeHome: null, authFileOverride: null, envKeys: [], regErrors: [{ key: 'GRAPE_API_TOKEN', detail: '拒绝访问' }], ...scanRcResidues(h) })
  const warns = []

  cleanCredentialChannels({
    scan,
    platform: 'win32',
    backupOf: backupTo,
    reg: () => { throw new Error('查询失败时不得盲删') },
    log: () => {},
    warn: (m) => { warns.push(m) },
  })

  assert.ok(warns.some((m) => /无法确认用户环境变量 GRAPE_API_TOKEN/.test(m)), `查询失败必须告警，实际: ${JSON.stringify(warns)}`)
  assert.doesNotMatch(readFileSync(paths.bashrc, 'utf8'), /grape_win_bashrc/, '注册表受阻不影响 rc 通道清理')
})

/* ── 切片 4：CLI 端到端（用户可见行为：盘面无凭据残留） ── */

test('Issue #38 uninstall --clean-global：rc 首行凭据 + BOM + CRLF，清理后盘面零残留且编码风格不变', skipOnWin, () => {
  const h = home()
  writeFileSync(join(h, '.bashrc'), '\uFEFFexport GRAPE_API_TOKEN=grape_cli_seed\r\nexport PATH=$PATH:/bin\r\n')

  const r = spawnSync(process.execPath, [SETUP, 'uninstall', '--target', 'opencode', '--clean-global'], {
    encoding: 'utf8',
    cwd: h,
    env: { ...process.env, HOME: h, GRAPE_HOME: '', GRAPE_AUTH_FILE: '', DSH_HOME: '' },
    timeout: 30_000,
  })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)

  const text = readFileSync(join(h, '.bashrc'), 'utf8')
  assert.doesNotMatch(text, /grape_cli_seed|GRAPE_API_TOKEN\s*=/, 'rc 凭据行必须删除')
  assert.equal(text.charCodeAt(0), 0xFEFF, '用户可见：rc 的 BOM 不得因首行被删而丢失')
  assert.equal(text, '\uFEFFexport PATH=$PATH:/bin\r\n', '无关行与 CRLF 必须原样保留')
})