import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { aggregateVersion, checkForUpdate, detectHostStatus, detectInstallForm, readDismissState, recordDismiss, updateDecision, HOST_NAMES, SYNC_POINTERS, fetchLatestVersion } from '../src/lifecycle.mjs'
import { fetchLatestVersion as ucFetchLatestVersion, REGISTRY_URL, REGISTRY_TIMEOUT_MS } from '../src/update-check.mjs'

/* Issue #27 · 自管理 5 工具的公开 seam：
 * S1  detectHostStatus —— 五宿主只读检出（纯函数 + 显式 home/env 注入，不读进程真实 HOME）
 * S2  detectInstallForm —— 安装形态判定（全局 npm / npx 缓存 / 本地 / 未知）
 * S3  dismiss 状态 —— ~/.grape/grape-kit-dismiss.json 3 天冷却
 * S4  aggregateVersion —— 版本全景（fetch / spawn / api 全注入）
 * 夹具一律临时目录，不联网、不写真实 ~/.grape（AGENTS：不提交真实凭据，测试用 fake 值）。 */

const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-lifecycle-'))
  homes.push(h)
  return h
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** 只给显式 home，所有路径覆盖点显式清空——避免读到跑测机器上的真实宿主配置 */
const baseEnv = () => ({
  GRAPE_CODEARTS_CONFIG: '',
  GRAPE_OFFICEACE_MANIFEST: '',
  GRAPE_DSH_PATCH: '',
  DSH_HOME: '',
  GRAPE_HOME: '',
})

function writeFileAt(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const OC = (h) => join(h, '.config', 'opencode')
const WB = (h) => join(h, '.workbuddy')
const CA = (h) => join(h, '.codeartsdoer')
const OA = (h) => join(h, '.officeace')
const DSH = (h) => join(h, '.dsh')

/** 五宿主全装夹具（手写配置，不经过 CLI——与 grape-kit.mjs 的写入路径解耦） */
function seedAllHosts(h) {
  writeFileAt(join(OC(h), 'opencode.jsonc'), `{
  // 用户注释：grape 条目由 installer 写入
  "mcp": {
    "grape": { "type": "local", "command": ["node", "/x/grape-kit-mcp.mjs"] },
  }
}
`)
  writeFileAt(join(WB(h), 'mcp.json'), JSON.stringify({ mcpServers: { 'grape-kit': { command: 'npx' } } }, null, 2))
  writeFileAt(join(CA(h), 'codearts_cli.jsonc'), `{\n  // 码道全局 MCP\n  "mcp": { "grape-kit": { "type": "local", "command": "npx" } }\n}\n`)
  writeFileAt(join(OA(h), 'mcp.json'), JSON.stringify({ mcpServers: { 'grape-kit': { command: 'npx' } } }, null, 2))
  writeFileAt(join(DSH(h), 'profiles', 'web', 'cordis.patch.yml'), `# Grape Kit DSH integration start
- insert:
    - id: grape-kit
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
# Grape Kit DSH integration end
`)
}

const rowOf = (rows, host) => rows.find((r) => r.host === host)

/* ── S1：五宿主只读检出 ── */

test('S1 全新 HOME：五宿主均报未装配，且各自给出配置路径', () => {
  const h = home()
  const rows = detectHostStatus({ home: h, env: baseEnv() })
  assert.deepEqual(rows.map((r) => r.host).sort(), [...HOST_NAMES].sort(), '五宿主逐行返回')
  for (const r of rows) {
    assert.equal(r.state, 'missing', `${r.host} 应是 missing（无配置文件）`)
    assert.ok(r.path.startsWith(h), `${r.host} 路径必须落在注入的 home 下（不读真实 HOME）：${r.path}`)
    assert.equal(r.installed, false)
  }
})

test('S1 装配后：五宿主均检出已装配（jsonc 注释/尾随逗号、YAML 托管块都能认）', () => {
  const h = home()
  seedAllHosts(h)
  const rows = detectHostStatus({ home: h, env: baseEnv() })
  for (const host of HOST_NAMES) {
    const r = rowOf(rows, host)
    assert.equal(r.state, 'installed', `${host} 应检出 installed（evidence=${r.evidence}）`)
    assert.equal(r.installed, true, `${host} installed 布尔与 state 同口径`)
    assert.ok(r.evidence, `${host} 必须给出检出依据（给人复核）`)
  }
  assert.match(rowOf(rows, 'opencode').evidence, /mcp\.grape/, 'opencode 条目名是 mcp.grape')
  assert.match(rowOf(rows, 'dsh').evidence, /grape-kit/, 'dsh 依据是托管块 id')
})

test('S1 opencode 配置存在但无 grape 条目 → absent（与 missing 区分开）', () => {
  const h = home()
  writeFileAt(join(OC(h), 'opencode.json'), JSON.stringify({ mcp: { other: { type: 'local' } } }, null, 2))
  const r = rowOf(detectHostStatus({ home: h, env: baseEnv() }), 'opencode')
  assert.equal(r.state, 'absent', '文件在、条目不在 → 未装配但可修（不是 missing）')
  assert.match(r.path, /opencode\.json$/, '无 .jsonc 时回落到 .json')
})

test('S1 配置损坏不得误报「未装配」：损坏优先暴露（含排障线索）', () => {
  const h = home()
  writeFileAt(join(WB(h), 'mcp.json'), '{ 这不是 JSON')
  const r = rowOf(detectHostStatus({ home: h, env: baseEnv() }), 'workbuddy')
  assert.equal(r.state, 'damaged', '解析失败必须报 damaged')
  assert.ok(r.error, 'damaged 必须带 error 供排障')
})

test('S1 dsh 托管块不完整（有 start 缺 end）→ damaged，不得静默当未装配', () => {
  const h = home()
  writeFileAt(join(DSH(h), 'profiles', 'web', 'cordis.patch.yml'), `# Grape Kit DSH integration start
- insert:
    - id: grape-kit
`)
  const r = rowOf(detectHostStatus({ home: h, env: baseEnv() }), 'dsh')
  assert.equal(r.state, 'damaged')
  assert.match(r.error, /不完整|结束标记/, '应点名缺结束标记')
})

/* ── QA 复审（PR #21）Q1：BOM 口径必须与 CLI 同源，否则同一个配置两侧判定分歧（Spec §4.2 要防的漂移） ──
 * CLI 侧 `JSON.parse(readFileSync(file,'utf8'))`（detectJsonEntry）**不剥 BOM** → BOM 配置报 damaged；
 * CLI 侧 jsonc 通道的 parseLoose **剥 BOM** → BOM 的 jsonc 仍能解析。两处口径不同，非对称必须照抄：
 * AGENTS「Windows 宿主注意 2」明确 BOM 是本仓现实风险，实测踩过的正是这两条。 */
test('S1 BOM：纯 JSON 宿主不得私自剥 BOM（CLI doctor 报 damaged，lifecycle 必须同口径）', () => {
  const h = home()
  const bomText = `\uFEFF${JSON.stringify({ mcpServers: { 'grape-kit': { command: 'npx' } } }, null, 2)}`
  writeFileAt(join(WB(h), 'mcp.json'), bomText)
  const r = rowOf(detectHostStatus({ home: h, env: baseEnv() }), 'workbuddy')
  assert.equal(r.state, 'damaged', 'BOM 的纯 JSON 配置在 CLI 侧解析失败 → 必须报 damaged（不得剥 BOM 后报 installed）')
  assert.ok(r.error, 'damaged 要带 error，让用户知道是 BOM 问题')
})

test('S1 BOM：jsonc 宿主照 CLI parseLoose 口径剥 BOM（codearts 报 installed，不误报 damaged）', () => {
  const h = home()
  const bomText = `\uFEFF{\n  // 码道全局 MCP\n  "mcp": { "grape-kit": { "type": "local", "command": "npx" } }\n}\n`
  writeFileAt(join(CA(h), 'codearts_cli.jsonc'), bomText)
  const r = rowOf(detectHostStatus({ home: h, env: baseEnv() }), 'codearts')
  assert.equal(r.state, 'installed', 'jsonc 通道的 CLI parseLoose 剥 BOM，条目本身在 → installed')
})

test('S1 检出是纯只读：不改配置字节、不在空 HOME 里造目录', () => {
  const h = home()
  seedAllHosts(h)
  const target = join(WB(h), 'mcp.json')
  const before = readFileSync(target, 'utf8')
  const empty = home()
  detectHostStatus({ home: h, env: baseEnv() })
  assert.equal(readFileSync(target, 'utf8'), before, '检出不得改动配置内容（doctor 只读纪律）')
  assert.deepEqual(readdirSync(empty), [], '空 HOME 检出后不得留下任何文件/目录')
  assert.ok(!existsSync(join(empty, '.workbuddy')), '未装配宿主不创建目录')
})
/* ── S1b：检出判定必须与 CLI doctor 同夹具一致（Spec §4.2 成对维护约束） ──
 * 这条断言是「防止两份逻辑漂移」的护栏：改 grape-kit.mjs 的路径/判定但不同步 lifecycle.mjs，
 * 这里立刻变红。win32 下 homedir() 读 USERPROFILE、HOME 注入无效，按 setup-targets 同口径跳过。 */

const isWin = process.platform === 'win32'
const skipOnWin = { skip: isWin ? 'win32：CLI 侧 homedir() 不吃 HOME 注入，一致性断言走实机回归' : false }
const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname

/** 与 detectHostStatus 注入的 env 完全同源：CLI 子进程用的就是这一份（外加 HOME） */
function cliEnv(h) {
  return {
    ...baseEnv(),
    HOME: h,
    // 依赖安装走 best-effort：注入必失败的 node 调用，避免用例访问网络（对齐 setup-dsh 用例）
    GRAPE_DSH_DEP_CMD: process.execPath,
  }
}

function runCli(args, h) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...cliEnv(h) },
    timeout: 60_000,
  })
}

/** doctor 检出行的锚点：每宿主一条，取自 grape-kit.mjs 各 doctorXxx 的 entryCheck 标签 */
const DOCTOR_ANCHOR = {
  opencode: /opencode mcp\.grape 条目/,
  workbuddy: /workbuddy mcpServers\.grape-kit/,
  codearts: /codearts mcp\.grape-kit/,
  officeace: /officeace mcpServers\.grape-kit/,
  dsh: /dsh 托管块/,
}

/** CLI 侧判定归一成与 detectHostStatus 同词表（installed / absent / damaged） */
function cliVerdict(host, h) {
  const r = runCli(['doctor', '--target', host], h)
  const line = r.stdout.split('\n').find((l) => DOCTOR_ANCHOR[host].test(l))
  assert.ok(line, `${host} doctor 应有检出行（stdout=${r.stdout.slice(0, 400)}）`)
  if (/^\s*\[ok\]/.test(line)) return 'installed'
  if (/配置损坏/.test(line)) return 'damaged'
  if (/未安装/.test(line)) return 'absent'
  return 'unexpected'
}

const normState = (state) => (state === 'installed' ? 'installed' : state === 'damaged' ? 'damaged' : 'absent')

function assertConsistent(h, hosts, note) {
  const rows = detectHostStatus({ home: h, env: cliEnv(h) })
  for (const host of hosts) {
    const ours = normState(rowOf(rows, host).state)
    const cli = cliVerdict(host, h)
    assert.equal(ours, cli, `${note}：${host} 检出判定与 CLI doctor 不一致（lifecycle=${ours} / doctor=${cli}）`)
  }
}

test('S1b 未装配夹具：detectHostStatus 与 doctor 五宿主一致', skipOnWin, () => {
  assertConsistent(home(), HOST_NAMES, '全新 HOME')
})

test('S1b 装配夹具：CLI 装完后 detectHostStatus 与 doctor 五宿主一致', skipOnWin, () => {
  const h = home()
  const inst = runCli(['install', '--target', 'all'], h)
  assert.equal(inst.status, 0, `install --target all 应成功：${inst.stderr}`)
  assertConsistent(h, HOST_NAMES, 'CLI 全装后')
})

test('S1b 配置损坏夹具：workbuddy mcp.json 非法 → 两侧都报 damaged', skipOnWin, () => {
  const h = home()
  writeFileAt(join(WB(h), 'mcp.json'), '{ 坏掉的 JSON')
  assert.equal(cliVerdict('workbuddy', h), 'damaged')
  assert.equal(normState(rowOf(detectHostStatus({ home: h, env: cliEnv(h) }), 'workbuddy').state), 'damaged')
})

test('S1b 单条漂移夹具：手删 mcp.grape 条目（保留 mcp 块）→ 两侧都报 absent', skipOnWin, () => {
  const h = home()
  assert.equal(runCli(['install', '--target', 'opencode'], h).status, 0)
  writeFileAt(join(OC(h), 'opencode.jsonc'), '{ "mcp": { "other": { "type": "local" } } }\n')
  assert.equal(cliVerdict('opencode', h), 'absent')
  assert.equal(normState(rowOf(detectHostStatus({ home: h, env: cliEnv(h) }), 'opencode').state), 'absent')
})

test('S1b BOM 夹具（纯 JSON 宿主 workbuddy）：两侧都报 damaged，不得一侧 installed', skipOnWin, () => {
  const h = home()
  writeFileAt(join(WB(h), 'mcp.json'), `\uFEFF${JSON.stringify({ mcpServers: { 'grape-kit': { command: 'npx' } } }, null, 2)}`)
  assert.equal(cliVerdict('workbuddy', h), 'damaged', 'CLI detectJsonEntry 不剥 BOM → 解析失败即 damaged')
  assertConsistent(h, ['workbuddy'], 'BOM 纯 JSON 夹具')
})

test('S1b BOM 夹具（jsonc 宿主 codearts）：两侧都报 installed（BOM 由 parseLoose 剥掉）', skipOnWin, () => {
  const h = home()
  writeFileAt(
    join(CA(h), 'codearts_cli.jsonc'),
    `\uFEFF{\n  // 码道全局 MCP\n  "mcp": { "grape-kit": { "type": "local", "command": "npx" } }\n}\n`,
  )
  assert.equal(cliVerdict('codearts', h), 'installed', 'CLI parseLoose 剥 BOM → jsonc 照常解析')
  assertConsistent(h, ['codearts'], 'BOM jsonc 夹具')
})

/* ── S2：安装形态判定（升级命令按形态生成，Spec §3.3） ── */

const PKG = '/pkg/@grape-dev/grape-kit'

test('S2 npx 缓存运行（posix / win32）→ 生成强拉最新的 npx 升级命令', () => {
  const posix = detectInstallForm({
    pkgPath: '/home/u/.npm/_npx/a1b2/node_modules/@grape-dev/grape-kit',
    env: { HOME: '/home/u' }, platform: 'linux',
  })
  assert.equal(posix.form, 'npx')
  assert.match(posix.evidence, /_npx/, '依据应点名 npx 缓存路径')
  assert.match(posix.upgradeCommand, /^npx -y -p @grape-dev\/grape-kit@latest /, 'npx 形态必须强制拉 @latest')
  assert.match(posix.upgradeCommand, /grape-kit-mcp/, '入口 bin 为 grape-kit-mcp')

  const win = detectInstallForm({
    pkgPath: 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\a1b2\\node_modules\\@grape-dev\\grape-kit',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32',
  })
  assert.equal(win.form, 'npx', 'Windows 的 _npx 在 %LocalAppData%\\npm-cache 下，不能漏')
})

test('S2 全局安装（posix prefix / win32 npm 前缀）→ npm i -g', () => {
  const posix = detectInstallForm({ pkgPath: `/usr/local/lib/node_modules/@grape-dev/grape-kit`, env: {}, platform: 'linux' })
  assert.equal(posix.form, 'global')
  assert.equal(posix.upgradeCommand, 'npm i -g @grape-dev/grape-kit')

  const win = detectInstallForm({
    pkgPath: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@grape-dev\\grape-kit',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, platform: 'win32',
  })
  assert.equal(win.form, 'global', 'Windows 全局前缀 %APPDATA%\\npm 也要认')
})

test('S2 项目本地依赖 → local，不给自动升级命令，只给手动指引', () => {
  const r = detectInstallForm({ pkgPath: '/work/proj/node_modules/@grape-dev/grape-kit', env: {}, platform: 'linux' })
  assert.equal(r.form, 'local')
  assert.equal(r.upgradeCommand, null, '本地依赖不得替用户决定包管理器/版本范围')
  assert.match(r.guidance, /npm i|package\.json|pnpm|yarn/, '必须给出手动升级指引')
})

test('S2 无法判定的路径 → unknown（不猜、不硬给命令）', () => {
  const r = detectInstallForm({ pkgPath: '/tmp/somewhere/grape-kit', env: {}, platform: 'linux' })
  assert.equal(r.form, 'unknown')
  assert.equal(r.upgradeCommand, null)
  assert.ok(r.guidance, '未知形态必须给手动指引，而不是沉默')
})

test('S2 ClawHub 市场安装 → clawhub 形态（手动重装指引）', () => {
  const r = detectInstallForm({ pkgPath: '/home/u/.clawhub/plugins/grape-kit', env: {}, platform: 'linux' })
  assert.equal(r.form, 'clawhub')
  assert.match(r.guidance, /clawhub/i)
})

test('S2 显式覆盖 GRAPE_KIT_INSTALL_FORM 优先于路径推断（实机/测试逃生口）', () => {
  const r = detectInstallForm({ pkgPath: '/tmp/whatever', env: { GRAPE_KIT_INSTALL_FORM: 'global' }, platform: 'linux' })
  assert.equal(r.form, 'global')
  assert.match(r.evidence, /GRAPE_KIT_INSTALL_FORM/)
})

/* ── S3：dismiss 3 天冷却（独立状态文件，不读写 update-check 的 24h 缓存，Spec §3.2） ── */

const DAY = 24 * 3600 * 1000
const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)

test('S3 拒绝后 3 天内同版本不再报「有新版本」', () => {
  const d = updateDecision({
    currentVersion: '0.4.0', latestVersion: '0.5.0',
    dismissState: { version: '0.5.0', at: T0 - 1 * DAY }, now: T0,
  })
  assert.equal(d.state, 'dismissed')
  assert.equal(d.updateAvailable, false, '冷却期内不得再报更新')
  assert.equal(d.latestVersion, '0.5.0', '信息仍可见（只是不打扰）')
})

test('S3 冷却恰好到期（3 天整）→ 重新提醒', () => {
  const d = updateDecision({
    currentVersion: '0.4.0', latestVersion: '0.5.0',
    dismissState: { version: '0.5.0', at: T0 - 3 * DAY }, now: T0,
  })
  assert.equal(d.state, 'newer')
  assert.equal(d.updateAvailable, true, '满 3 天应恢复提醒（<3 天才是冷却期）')
})

test('S3 拒绝了旧版本、新版本出现 → 重新提醒（冷却只对同一版本）', () => {
  const d = updateDecision({
    currentVersion: '0.4.0', latestVersion: '0.6.0',
    dismissState: { version: '0.5.0', at: T0 - 1 * DAY }, now: T0,
  })
  assert.equal(d.state, 'newer')
  assert.equal(d.updateAvailable, true)
})

test('S3 已是最新 / registry 不可达：都不报更新', () => {
  assert.equal(updateDecision({ currentVersion: '0.4.0', latestVersion: '0.4.0', now: T0 }).state, 'latest')
  const unavailable = updateDecision({ currentVersion: '0.4.0', latestVersion: '', now: T0 })
  assert.equal(unavailable.state, 'unavailable')
  assert.equal(unavailable.updateAvailable, false, '不可达不得伪装成「已是最新」')
})

test('S3 recordDismiss 落盘到 GRAPE_HOME 下的独立文件（不碰 update-check 缓存）', () => {
  const h = home()
  const env = { ...baseEnv(), GRAPE_HOME: join(h, '.grape') }
  const written = recordDismiss('0.5.0', { env, now: T0 })
  assert.equal(written.version, '0.5.0')
  assert.ok(existsSync(join(h, '.grape', 'grape-kit-dismiss.json')), '文件落在 ~/.grape/grape-kit-dismiss.json')
  assert.ok(!existsSync(join(h, '.grape', 'grape-kit-update-check.json')), '不得写 update-check 的 24h 缓存')
  const back = readDismissState({ env })
  assert.equal(back.version, '0.5.0')
  assert.equal(back.at, T0)
})

test('S3 状态文件缺失/损坏 → 读成 null（不抛错，不误判冷却）', () => {
  const h = home()
  const env = { ...baseEnv(), GRAPE_HOME: join(h, '.grape') }
  assert.equal(readDismissState({ env }), null)
  writeFileAt(join(h, '.grape', 'grape-kit-dismiss.json'), '{坏')
  assert.equal(readDismissState({ env }), null, '损坏文件按「没拒绝过」处理')
})

test('S3 dismissVersion 显式指定优先于 npm latest（用户点名的版本被记住）', () => {
  const h = home()
  const env = { ...baseEnv(), GRAPE_HOME: join(h, '.grape') }
  recordDismiss('0.7.1', { env, now: T0 })
  const d = updateDecision({
    currentVersion: '0.4.0', latestVersion: '0.7.1',
    dismissState: readDismissState({ env }), now: T0 + DAY,
  })
  assert.equal(d.state, 'dismissed', '显式 dismissVersion 与 latest 相同 → 冷却生效')
})

/* ── S4：版本全景 aggregateVersion（fetch / spawn / api 全注入，Spec §3.1） ── */

/** 注入用桩：npm registry latest + 服务端 openapi.json 两条 fetch 分流 */
function stubFetch({ latest = '0.5.0', openapi = { status: 200, body: { info: { version: '2.1.0' } } }, npmThrows = false, openapiThrows = false, seen = [] } = {}) {
  return async (url, opts = {}) => {
    seen.push({ url: String(url), signal: opts.signal })
    if (String(url).includes('registry.npmjs.org')) {
      if (npmThrows) throw new Error('registry unreachable')
      return { ok: true, status: 200, json: async () => ({ version: latest }) }
    }
    if (String(url).includes('/static/openapi.json')) {
      if (openapiThrows) throw new Error('connect ECONNREFUSED')
      return { ok: openapi.status === 200, status: openapi.status, json: async () => openapi.body }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

const okSpawn = () => ({ status: 0, stdout: 'grape 0.3.4\n', stderr: '' })
const missingSpawn = () => ({ status: 127, stdout: '', stderr: 'not found' })
const okApi = () => ({ scenesMarket: async () => [{ scene_id: 'default' }] })

test('S4 全景：kit 版本 / npm latest / 更新可用 / CLI / 服务端连通+契约版本 / 凭据来源', async () => {
  const seen = []
  const r = await aggregateVersion({
    pkgVersion: '0.4.0',
    env: { GRAPE_BASE_URL: 'https://grape.test', GRAPE_API_TOKEN: 'grape_fake', GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch({ latest: '0.5.0', seen }),
    spawnImpl: okSpawn,
    apiModule: okApi(),
  })
  assert.equal(r.kitVersion, '0.4.0')
  assert.equal(r.latestVersion, '0.5.0')
  assert.equal(r.updateAvailable, true)
  assert.equal(r.updateState, 'newer')
  assert.equal(r.grapeCli.status, 'ok')
  assert.equal(r.grapeCli.version, 'grape 0.3.4')
  assert.equal(r.server.reachable, true)
  assert.equal(r.server.contractVersion, '2.1.0', '契约版本取自 {base_url}/static/openapi.json 的 info.version')
  assert.equal(r.server.baseUrl, 'https://grape.test')
  assert.equal(r.credentials.sourceKind, 'env', '凭据来源结构化标注（不回显 token）')
  assert.ok(!JSON.stringify(r).includes('grape_fake'), '工具结果绝不能回显凭据明文')
  assert.ok(seen.some((s) => s.url.startsWith('https://grape.test/static/openapi.json')), 'base_url 来自 env 单源')
  assert.ok(seen.every((s) => s.signal), '每个请求都要带超时 signal（5s 上限，不能挂死）')
})

test('S4 npm registry 不可达：标记 unavailable，且不阻塞 CLI / 服务端字段', async () => {
  const r = await aggregateVersion({
    pkgVersion: '0.4.0',
    env: { GRAPE_BASE_URL: 'https://grape.test', GRAPE_API_TOKEN: 'grape_fake', GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch({ npmThrows: true }),
    spawnImpl: okSpawn,
    apiModule: okApi(),
  })
  assert.equal(r.latestVersion, '')
  assert.equal(r.updateState, 'unavailable')
  assert.equal(r.updateAvailable, false)
  assert.equal(r.grapeCli.status, 'ok', 'registry 挂了不影响 CLI 探测')
  assert.equal(r.server.reachable, true, 'registry 挂了不影响服务端连通')
})

test('S4 grape CLI 未安装：可选回退通道提示 + pip 安装指引（与 doctor 同文案口径）', async () => {
  const r = await aggregateVersion({
    pkgVersion: '0.4.0', env: {}, fetchImpl: stubFetch(), spawnImpl: missingSpawn, apiModule: okApi(),
  })
  assert.equal(r.grapeCli.status, 'missing')
  assert.match(r.grapeCli.hint, /pip install git\+https:\/\/gitcode\.com\/grape-dev\/grape-cli\.git/)
})

test('S4 服务端不可达 / 契约端点 404：不阻塞其余字段，不伪造契约版本', async () => {
  const downApi = { scenesMarket: async () => { const e = new Error('无法连接 https://grape.test'); e.status = 0; e.hint = '检查 GRAPE_BASE_URL 是否正确 / 网络可达'; throw e } }
  const down = await aggregateVersion({
    pkgVersion: '0.4.0',
    env: { GRAPE_BASE_URL: 'https://grape.test', GRAPE_API_TOKEN: 'grape_fake', GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch({ openapiThrows: true }), spawnImpl: okSpawn, apiModule: downApi,
  })
  assert.equal(down.server.reachable, false)
  assert.ok(down.server.error)
  assert.equal(down.server.contractVersion, undefined)
  assert.equal(down.kitVersion, '0.4.0', '服务端挂了照样报本地版本')

  const noContract = await aggregateVersion({
    pkgVersion: '0.4.0',
    env: { GRAPE_BASE_URL: 'https://grape.test', GRAPE_API_TOKEN: 'grape_fake', GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch({ openapi: { status: 404, body: {} } }),
    spawnImpl: okSpawn, apiModule: okApi(),
  })
  assert.equal(noContract.server.reachable, true)
  assert.equal(noContract.server.contractVersion, undefined, '404 时省略契约版本，不报错误值')
})

test('S4 无凭据：版本查询照常可用（只读诊断不该被凭据卡住）', async () => {
  const r = await aggregateVersion({
    pkgVersion: '0.4.0', env: { GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch(), spawnImpl: okSpawn, apiModule: okApi(),
  })
  assert.equal(r.kitVersion, '0.4.0')
  assert.equal(r.credentials.configured, false)
  assert.match(r.credentials.hint, /GRAPE_API_TOKEN/, '缺凭据要给可执行指引')
})

/* ── S5a：check_update 的 dismiss 组合行为（npm 查询 + 状态记录 + 冷却判定一条链） ── */

test('S5a checkForUpdate：dismiss=true 记录被忽略版本，并立即抑制「有新版本」', async () => {
  const env = { ...baseEnv(), GRAPE_HOME: join(home(), '.grape') }
  const r = await checkForUpdate({ pkgVersion: '0.4.0', env, fetchImpl: stubFetch({ latest: '0.5.0' }), now: T0, dismiss: true })
  assert.equal(r.state, 'dismissed')
  assert.equal(r.dismiss.version, '0.5.0')
  assert.equal(r.updateAvailable, false)
  assert.equal(readDismissState({ env }).version, '0.5.0', '状态已落盘')
  assert.match(r.updateNotice, /冷却|忽略/, '提示要说清「忽略中」而不是「有新版本」')
})

test('S5a checkForUpdate：忽略后出现更新版本 → 重新提醒', async () => {
  const env = { ...baseEnv(), GRAPE_HOME: join(home(), '.grape') }
  await checkForUpdate({ pkgVersion: '0.4.0', env, fetchImpl: stubFetch({ latest: '0.5.0' }), now: T0, dismiss: true })
  const r = await checkForUpdate({ pkgVersion: '0.4.0', env, fetchImpl: stubFetch({ latest: '0.6.0' }), now: T0 + DAY })
  assert.equal(r.state, 'newer')
  assert.equal(r.updateAvailable, true)
})

test('S5a checkForUpdate：dismissVersion 显式指定优先（registry 不可达也能记录）', async () => {
  const env = { ...baseEnv(), GRAPE_HOME: join(home(), '.grape') }
  const r = await checkForUpdate({
    pkgVersion: '0.4.0', env, fetchImpl: stubFetch({ npmThrows: true }), now: T0,
    dismiss: true, dismissVersion: '0.9.9',
  })
  assert.equal(r.dismiss.version, '0.9.9')
  assert.equal(readDismissState({ env }).version, '0.9.9')
})

test('S5a checkForUpdate：无 dismiss 时不写状态文件（只读查询不产生副作用）', async () => {
  const base = home()
  const env = { ...baseEnv(), GRAPE_HOME: join(base, '.grape') }
  const r = await checkForUpdate({ pkgVersion: '0.4.0', env, fetchImpl: stubFetch({ latest: '0.5.0' }), now: T0 })
  assert.equal(r.state, 'newer')
  assert.equal(r.dismiss, null)
  assert.ok(!existsSync(join(base, '.grape')), '未 dismiss 时不得创建任何目录/文件')
})

test('S4 无凭据不得把「未探测」说成「不可达」：跳过连通性探测但仍可取契约版本', async () => {
  let apiCalls = 0
  const r = await aggregateVersion({
    pkgVersion: '0.4.0',
    env: { GRAPE_BASE_URL: 'https://grape.test', GRAPE_AUTH_FILE: '/nonexistent/x.json' },
    fetchImpl: stubFetch(), spawnImpl: okSpawn,
    apiModule: { scenesMarket: async () => { apiCalls++; throw new Error('不该被调用') } },
  })
  assert.equal(apiCalls, 0, '无凭据时不得打需要鉴权的端点（必 401，徒增误导）')
  assert.equal(r.server.probe, 'skipped')
  assert.match(r.server.reason, /凭据/)
  assert.equal(r.server.reachable, false)
  assert.equal(r.server.contractVersion, '2.1.0', '契约端点是公开的，无凭据也应尽力探测')
})

/* ── QA 复审（PR #21）P3/SJ1：同步指针只留函数名锚，漂移由校验测试兜住 ──
 * 行号指针在「CLI 侧任何无关改动」后立即失真（实测 7/14 已失准），而名字是稳定锚点：
 * 真正的漂移风险是**重命名/删除**（成对维护的那一侧没了），因此断言每个指针名在 grape-kit.mjs 中仍有定义。 */
const CLI_SRC = new URL('../grape-kit.mjs', import.meta.url)
const cliSource = () => readFileSync(CLI_SRC, 'utf8')
const lifecycleSource = () => readFileSync(new URL('../src/lifecycle.mjs', import.meta.url), 'utf8')

test('P3/SJ1 SYNC_POINTERS：每个同步指针在 grape-kit.mjs 中仍有定义（重命名/删除即变红）', () => {
  const src = cliSource()
  assert.ok(SYNC_POINTERS.length >= 14, `同步指针应覆盖全部成对维护点（当前 ${SYNC_POINTERS.length}）`)
  const names = SYNC_POINTERS.map((p) => p.symbol)
  assert.equal(new Set(names).size, names.length, '同步指针不得重复登记')
  for (const { symbol } of SYNC_POINTERS) {
    const re = new RegExp(`(?:function\\s+${symbol}\\s*\\(|(?:const|let|class)\\s+${symbol}\\s*=)`)
    assert.match(src, re, `同步指针 ${symbol} 在 grape-kit.mjs 中已不存在（CLI 侧改名/删除 → lifecycle 必须同改）`)
  }
})

test('P3/SJ1 同步指针不得回退成行号（行号随无关改动漂移，实测 7/14 已失准）', () => {
  const src = lifecycleSource()
  assert.doesNotMatch(src, /grape-kit\.mjs:\d+/, '不得写 grape-kit.mjs:<行号>（改为函数名锚 + SYNC_POINTERS 校验）')
  assert.doesNotMatch(src, /grape-kit\.mjs:\d+-\d+/, '不得写行号区间')
  // 函数名锚必须真实写在注释里：至少覆盖指针表里的每个名字，人读注释即可定位
  for (const { symbol } of SYNC_POINTERS) {
    assert.ok(src.includes(symbol), `lifecycle.mjs 注释应点名 ${symbol}（否则指针等于没有）`)
  }
})

/* ── QA 复审（PR #21）SJ2：registry 访问与 src/update-check.mjs 单源，不再两份常量/两份 fetch ──
 * 两份实现漂移过一次的表面症状是「同一台机器两种超时/两种 URL」，而单源只需 import。 */
test('SJ2 registry 取数单源：lifecycle 复用 update-check 的实现与常量，不自带第二份', () => {
  assert.equal(fetchLatestVersion, ucFetchLatestVersion, 'lifecycle 必须复用 update-check 的 fetchLatestVersion（同引用）')
  assert.equal(REGISTRY_URL, 'https://registry.npmjs.org', 'registry URL 常量应由 update-check 导出单源')
  assert.equal(REGISTRY_TIMEOUT_MS, 5000, '5s 有界超时单源')
  const src = lifecycleSource()
  assert.doesNotMatch(src, /registry\.npmjs\.org/, 'lifecycle 不得再自带 registry URL 字面量')
  assert.doesNotMatch(src, /AbortSignal\.timeout\(/, 'lifecycle 不得再自带一份带超时的 fetch')
})

test('SJ2 fetchLatestVersion：成功取 version（去空白），非 2xx / 抛错 / 无 version 一律空串', async () => {
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: ' 0.5.0 ' }) }) }), '0.5.0')
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }), '')
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw new Error('network down') } }), '')
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), '')
})
