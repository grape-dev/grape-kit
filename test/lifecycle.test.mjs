import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { detectHostStatus, HOST_NAMES } from '../src/lifecycle.mjs'

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