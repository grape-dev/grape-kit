import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planRcCleanup, scanRcResidues, cleanCredentialChannels, BACKUP_NAMESPACE } from '../src/credential-channels.mjs'

/* Issue #38：win32 的 rc 清理路径此前被两处平台门禁挡死——`scanResidues()` 的 rc 段整体包在
 * `if (process.platform !== 'win32')` 内（win32 下 rcHits 恒空），`cleanEnvVars()` 的 win32 分支
 * 处理完 `reg delete` 就 return（rc 清理循环只属非 win32 路径）。Git Bash 读的是 USERPROFILE 下的
 * rc，于是 Windows 上执行 `uninstall --clean-global` 后三条 rc 凭据行全部留盘。
 * 测试缝落在 src/credential-channels.mjs（纯实现 + 注入 reg 运行器/备份实现），CLI 入口不再导出内部函数。 */

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

/** 用真实 bash source 一次 rc：返回 null 表示本机没有 bash（纯 win32 宿主），调用方跳过该断言 */
function sourceRc(path) {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(path)}`], { encoding: 'utf8', timeout: 10_000 })
  return r.error ? null : r
}

test('Issue #38 planRcCleanup 边界：仅一行凭据且带 BOM → 不留裸 BOM（结果为空，source 无报错）', () => {
  const r = planRcCleanup('\uFEFFexport GRAPE_API_TOKEN=grape_only_line\n', 'posix')

  assert.equal(r.hits, 1, '唯一一行凭据行应计 1 行命中')
  assert.equal(r.cleaned, '', '结果全为空时不得贴 BOM——3 字节裸 BOM 会被 bash 当成命令名')
  const h = home()
  const p = join(h, '.bashrc')
  writeFileSync(p, r.cleaned)
  const s = sourceRc(p)
  if (s) {
    assert.equal(`${s.stdout}${s.stderr}`.trim(), '', `清理后的 rc 被 bash source 必须无输出（PR #36 QA 复审判据），实际: ${s.stdout}${s.stderr}`)
  }
})

test('Issue #38 planRcCleanup 边界：凭据行后紧跟空行 → 首行非裸 BOM，BOM 不落到非首行（source 无报错）', () => {
  const text = '\uFEFFexport GRAPE_API_TOKEN=grape_then_blank\n\nexport PATH=$PATH:/bin\n'
  const r = planRcCleanup(text, 'posix')

  assert.equal(r.hits, 1)
  assert.doesNotMatch(r.cleaned, /grape_then_blank|GRAPE_API_TOKEN/)
  assert.equal(r.cleaned.split('\n')[0].includes('\uFEFF'), false, '首行不得是裸 BOM')
  // BOM 只在文件 offset 0 才是 BOM；贴到中间行会变成命令词里的 U+FEFF，
  // bash 实测 `line 2: export: command not found` 且该行（含 PATH 导出）整行不执行
  assert.equal(r.cleaned, '\nexport PATH=$PATH:/bin\n', '首行为空的场合不迁移 BOM，其余行原样保留')
  const h = home()
  const p = join(h, '.bashrc')
  writeFileSync(p, r.cleaned)
  const s = sourceRc(p)
  if (s) {
    assert.equal(`${s.stdout}${s.stderr}`.trim(), '', `清理后的 rc 被 bash source 必须无输出，实际: ${s.stdout}${s.stderr}`)
  }
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

/* ── 切片 3b：两通道同结果（Spec 风险表：win32 与非 win32 共用一份清理，不得分叉） ── */

test('Issue #38 两通道同结果：同一夹具下 win32 与非 win32 的清理结果逐字节等价', () => {
  const fixture = () => {
    const h = home()
    return { h, paths: seedRc(h, { crlf: true, bom: true }) }
  }
  const a = fixture()
  const b = fixture()
  const scanOf = (h) => () => ({ grapeHome: null, authFileOverride: null, regErrors: [], envKeys: [], ...scanRcResidues(h) })
  const logsA = []
  const logsB = []
  const regCalls = []

  cleanCredentialChannels({
    scan: scanOf(a.h), platform: 'win32', backupOf: backupTo,
    reg: (args) => { regCalls.push(args); return { status: 0, stdout: '', stderr: '' } },
    log: (m) => logsA.push(m), warn: () => {},
  })
  cleanCredentialChannels({
    scan: scanOf(b.h), platform: 'linux', backupOf: backupTo,
    log: (m) => logsB.push(m), warn: () => {},
  })

  const rel = ['.bashrc', '.bash_profile', join('.config', 'fish', 'config.fish')]
  for (const f of rel) {
    assert.equal(Buffer.compare(readFileSync(join(a.h, f)), readFileSync(join(b.h, f))), 0, `${f}: 两通道写回结果必须逐字节等价`)
    const bak = `${f}.bak-grapemcp-test`
    assert.equal(Buffer.compare(readFileSync(join(a.h, bak)), readFileSync(join(b.h, bak))), 0, `${bak}: 两通道掩码备份必须逐字节等价`)
  }
  // 逐条输出也只应差「注册表通道那几行」——rc 行必须同文案（用户/agent 直读的输出同样不得分叉）
  const rcLines = (logs, h) => logs.map((m) => m.split(h).join('<HOME>')).filter((m) => !/用户环境变量|宿主会话读不到/.test(m))
  assert.deepEqual(rcLines(logsA, a.h), rcLines(logsB, b.h), 'rc 通道逐条输出必须同文案')
  assert.deepEqual(regCalls, [], '夹具 envKeys 为空 → win32 分支只报跳过，不盲删注册表')
  assert.ok(logsA.some((m) => /宿主会话读不到删除结果/.test(m)), 'win32 仍走注册表通道（第一条通道未被 rc 取代）')
  assert.equal(logsB.some((m) => /宿主会话读不到删除结果/.test(m)), false, '非 win32 没有注册表通道')
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

/* ── 切片 6：备份命名空间单一来源（QA 复审判断项 3） ──
 * `bak-grapemcp-` 同时硬编码在 grape-kit.mjs 的 backupPathFor 与 src/credential-channels.mjs 的
 * rcBackupPathsOf 时，改一侧即静默漏扫旧版留下的含凭据备份（备份先行、清理却找不到）。 */

test('Issue #38 备份命名空间单一来源：前缀由模块导出、CLI 侧不硬编码', () => {
  assert.equal(BACKUP_NAMESPACE, 'bak-grapemcp-', '命名空间是兼容面：用户盘上旧版备份按此命名，不得随意 rename')
  const cliSrc = readFileSync(SETUP, 'utf8')
  assert.doesNotMatch(cliSrc, /bak-grapemcp-/, 'grape-kit.mjs 不得再出现字面前缀——必须共用模块导出值')
  assert.match(cliSrc, /BACKUP_NAMESPACE/, 'CLI 侧须从 src/credential-channels.mjs 导入备份命名空间')
})

test('Issue #38 备份命名空间单一来源：--clean-global 删旧含凭据备份，新备份同样落在该命名空间', skipOnWin, () => {
  const h = home()
  writeFileSync(join(h, '.bashrc'), 'export PATH=$PATH:/bin\nexport GRAPE_API_TOKEN=grape_ns_seed\n')
  const stale = join(h, `.bashrc.${BACKUP_NAMESPACE}20200101000000`)
  writeFileSync(stale, 'export GRAPE_API_TOKEN=grape_ns_stale\n')

  const r = spawnSync(process.execPath, [SETUP, 'uninstall', '--clean-global'], {
    encoding: 'utf8', cwd: h,
    env: { ...process.env, HOME: h, GRAPE_HOME: '', GRAPE_AUTH_FILE: '', DSH_HOME: '', GRAPE_API_TOKEN: '', GRAPE_BASE_URL: '' },
    timeout: 30_000,
  })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.equal(existsSync(stale), false, '含凭据的旧备份必须按同一命名空间被扫到并删除')

  const fresh = readdirSync(h).filter((f) => f.startsWith(`.bashrc.${BACKUP_NAMESPACE}`) && f !== `.bashrc.${BACKUP_NAMESPACE}20200101000000`)
  assert.equal(fresh.length, 1, `清理应留一份掩码备份，实际: ${JSON.stringify(readdirSync(h))}`)
  assert.doesNotMatch(readFileSync(join(h, fresh[0]), 'utf8'), /grape_ns_seed|GRAPE_API_TOKEN\s*=/, '新备份不得含凭据明文')
})

/* ── 切片 5：扫描侧平台门禁回归（QA 复审判断项 1：门禁在 grape-kit.mjs 的 scanResidues，不在本模块） ──
 * 上面 4 条模块用例即便把 scanResidues 的 rc 段还原成旧 `if (process.platform !== 'win32') { … }`
 * 也照样全绿（模块本身无门禁）——#38 的扫描半边修复此前没有任何断言能挡回退。这里用 CLI 端到端
 * 覆盖：GRAPE_KIT_PLATFORM=win32 时注册表通道与 rc 通道必须同时生效，任一被门禁挡住即红。 */

test('Issue #38 扫描侧无平台门禁：强制 win32 端到端同时走注册表与 rc 两条通道', skipOnWin, () => {
  const h = home()
  writeFileSync(join(h, '.bashrc'), 'export GRAPE_API_TOKEN=grape_scan_gate\n')
  const env = {
    ...process.env, HOME: h, GRAPE_HOME: '', GRAPE_AUTH_FILE: '', DSH_HOME: '',
    GRAPE_API_TOKEN: '', GRAPE_BASE_URL: '',
    GRAPE_KIT_PLATFORM: 'win32',
  }

  const plan = spawnSync(process.execPath, [SETUP, 'uninstall', '--clean-global', '--dry-run'], { encoding: 'utf8', cwd: h, env, timeout: 30_000 })
  assert.equal(plan.status, 0, `${plan.stdout}\n${plan.stderr}`)
  assert.match(plan.stdout, /reg delete 用户级注册表项|无法确认注册表项/, '预览按注入平台走 win32 口径（cleanGlobalPlan 与 scanResidues 同一平台判定）')
  assert.match(plan.stdout, /将从 .*\.bashrc 删除 1 行/, '预览必须看到 rc 命中（rc 扫描无平台门禁）')

  const r = spawnSync(process.execPath, [SETUP, 'uninstall', '--clean-global'], { encoding: 'utf8', cwd: h, env, timeout: 30_000 })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.doesNotMatch(readFileSync(join(h, '.bashrc'), 'utf8'), /GRAPE_API_TOKEN\s*=/, '强制 win32 下 rc 凭据行必须被清理（扫描无门禁 + 清理不提前 return）')
  assert.match(r.stdout, /宿主会话读不到删除结果/, 'win32 第一条通道（注册表）必须被执行，不得只清 rc')
  assert.match(`${r.stdout}${r.stderr}`, /无法确认用户环境变量 GRAPE_API_TOKEN/, '非 win32 宿主上强制 win32：reg 不可用必须如实点名（不谎报零残留；告警走 stderr）')
})