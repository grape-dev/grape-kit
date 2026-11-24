import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { detectHostStatus, detectInstallForm, HOST_NAMES } from '../src/lifecycle.mjs'

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
