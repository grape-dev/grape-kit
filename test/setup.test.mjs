import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname

/* 临时 HOME 统一登记，文件级 after 钩子收尾（用例中途失败也不残留临时目录） */
const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-home-'))
  homes.push(h)
  return h
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

function run(args, h, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: h, ...extraEnv },
    timeout: 30_000,
  })
}

function seedConfig(h) {
  // 模拟用户既有 opencode.jsonc：含注释 + 一个既有 MCP 条目
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.jsonc'), `{
  "$schema": "x",
  // 用户注释必须保留
  "mcp": {
    "existing": {
      "type": "local",
      "command": ["echo", "hi"],
      "enabled": true
    }
  }
}
`)
}

test('install 幂等插入且保留既有条目与注释', () => {
  const h = home()
  seedConfig(h)
  const r1 = run(['install', '--target', 'opencode'], h)
  assert.equal(r1.status, 0, r1.stderr)
  const text1 = readFileSync(join(h, '.config', 'opencode', 'opencode.jsonc'), 'utf8')
  assert.match(text1, /"grape"\s*:\s*\{/)
  assert.match(text1, /"existing"/)
  assert.match(text1, /用户注释必须保留/)
  assert.ok(existsSync(join(h, '.config', 'opencode', 'skills', 'grape-remote', 'SKILL.md')))

  const r2 = run(['install', '--target', 'opencode'], h)
  assert.equal(r2.status, 0, r2.stderr)
  const text2 = readFileSync(join(h, '.config', 'opencode', 'opencode.jsonc'), 'utf8')
  assert.equal(text2.match(/"grape"\s*:\s*\{/g).length, 1, '重复安装不应产生重复条目')
  assert.match(text2, /"existing"/)
  // 结构合法性：去注释后必须可解析（防匿名大括号/残缺块回归）
  const stripped = (t) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, ''))
  stripped(text1)
  stripped(text2)
})

test('uninstall 移除条目与 skill，保留他人内容', () => {
  const h = home()
  seedConfig(h)
  run(['install', '--target', 'opencode'], h)
  const r = run(['uninstall', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  const text = readFileSync(join(h, '.config', 'opencode', 'opencode.jsonc'), 'utf8')
  assert.doesNotMatch(text, /"grape"\s*:\s*\{/)
  assert.match(text, /"existing"/)
  assert.ok(!existsSync(join(h, '.config', 'opencode', 'skills', 'grape-remote')))
})

test('install 在无 mcp 块的纯 JSON 配置上自动新建块', () => {
  const h = home()
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'deepseek/glm-5.3',
  }, null, 2))
  const r = run(['install', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(cfg.mcp.grape.type, 'local')
  assert.equal(cfg.model, 'deepseek/glm-5.3')
  // uninstall 后 mcp 块保留（空）且 model 不丢
  run(['uninstall', '--target', 'opencode'], h)
  const after = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.equal(after.model, 'deepseek/glm-5.3')
  assert.equal(after.mcp.grape, undefined)
})

test('doctor 在干净 HOME 下逐项报告', () => {
  const h = home()
  const r = run(['doctor'], h, { GRAPE_KIT_SKIP_UPDATE_CHECK: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /node >= 20/)
  assert.match(r.stdout, /GRAPE_BASE_URL/)
})

test('install 升级「grape 为唯一条目」的配置不产生悬挂逗号', () => {
  const h = home()
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
    model: 'm',
    mcp: { grape: { type: 'local', command: ['node', '/old/path.mjs'], enabled: true, timeout: 600000 } },
  }, null, 2))
  const r = run(['install', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  const text = readFileSync(join(dir, 'opencode.json'), 'utf8')
  const cfg = JSON.parse(text) // 旧路径升级后必须仍是合法 JSON（悬挂逗号回归）
  assert.match(cfg.mcp.grape.command[1], /grape-kit-mcp\.mjs$/)
})

test('install 升级位于 mcp 块中间的 grape 条目不破坏兄弟条目', () => {
  const h = home()
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
    model: 'm',
    mcp: {
      before: { type: 'local', command: ['echo', 'before'] },
      grape: { type: 'local', command: ['node', '/old/path.mjs'], enabled: true, timeout: 600000 },
      after: { type: 'local', command: ['echo', 'after'] },
    },
  }, null, 2))
  const r = run(['install', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  // 回归 P0：中段条目重插后逗号错位 → 非法 JSON
  const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ['after', 'before', 'grape'])
  assert.deepEqual(cfg.mcp.before.command, ['echo', 'before'])
  assert.deepEqual(cfg.mcp.after.command, ['echo', 'after'])
  assert.match(cfg.mcp.grape.command[1], /grape-kit-mcp\.mjs$/)
})

/* ---------- Issue #4：doctor 版本更新检查 ---------- */

const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const UPDATE_CACHE = (h) => join(h, '.grape', 'grape-kit-update-check.json')

function seedUpdateCache(h, latest, notified) {
  mkdirSync(join(h, '.grape'), { recursive: true })
  const data = { checkedAt: Date.now(), latest }
  if (notified !== undefined) data.notified = notified
  writeFileSync(UPDATE_CACHE(h), JSON.stringify(data))
}

test('doctor 在本地版本落后时输出升级提示与更新命令', () => {
  const h = home()
  seedUpdateCache(h, '9.9.9')
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[!!\] 版本更新: 有新版本 \d+\.\d+\.\d+ → 9\.9\.9/)
  assert.match(r.stdout, /npm i -g @grape-dev\/grape-kit/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 已是最新版本时不提示升级', () => {
  const h = home()
  seedUpdateCache(h, PKG_VERSION)
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /有新版本/)
  assert.match(r.stdout, /\[ok\] 版本更新: ok（已是最新/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 在 GRAPE_KIT_NO_UPDATE_CHECK=1 别名开关下静默', () => {
  const h = home()
  seedUpdateCache(h, '9.9.9')
  const r = run(['doctor'], h, { GRAPE_KIT_NO_UPDATE_CHECK: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /有新版本/)
  assert.match(r.stdout, /\[ok\] 版本更新: ok（提示已关闭/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 在 GRAPE_KIT_SKIP_UPDATE_CHECK=1 下静默', () => {
  const h = home()
  seedUpdateCache(h, '9.9.9')
  const r = run(['doctor'], h, { GRAPE_KIT_SKIP_UPDATE_CHECK: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /有新版本/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 24h 缓存内同一新版本不重复打扰', () => {
  const h = home()
  seedUpdateCache(h, '9.9.9')
  const first = run(['doctor'], h)
  assert.match(first.stdout, /有新版本/)
  const second = run(['doctor'], h)
  assert.doesNotMatch(second.stdout, /有新版本/)
  assert.match(second.stdout, /\[ok\] 版本更新: ok（已提示过 9\.9\.9/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 对已被 MCP 消费过的提示显示「已提示过」而非「已是最新」', () => {
  const h = home()
  // 模拟 MCP 先启动并消费提示：notified 已等于 latest
  seedUpdateCache(h, '9.9.9', '9.9.9')
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /已是最新/)
  assert.match(r.stdout, /\[ok\] 版本更新: ok（已提示过 9\.9\.9/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 在检测不可用时明确提示，不冒充「已是最新」', () => {
  const h = home()
  seedUpdateCache(h, '')
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /已是最新/)
  assert.match(r.stdout, /\[ok\] 版本更新: ok（检测不可用/)
  rmSync(h, { recursive: true, force: true })
})

test('doctor 升级提示与 MCP 共用文案：两个等价开关都列出', () => {
  const h = home()
  seedUpdateCache(h, '9.9.9')
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /GRAPE_KIT_SKIP_UPDATE_CHECK=1 或 GRAPE_KIT_NO_UPDATE_CHECK=1 关闭提醒/)
  rmSync(h, { recursive: true, force: true })
})

/* ── Issue #17：doctor base_url 双通道（env + 文件），消除假阳性 FAIL ── */

test('Issue #17 仅 ~/.grape/config.json 配 base_url 时 doctor PASS 标注文件通道且探针照常执行', () => {
  const h = home()
  mkdirSync(join(h, '.grape'), { recursive: true })
  writeFileSync(join(h, '.grape', 'config.json'), JSON.stringify({ token: 'grape_file', base_url: 'http://127.0.0.1:9' }))
  const r = run(['doctor', '--probe'], h, {
    GRAPE_KIT_SKIP_UPDATE_CHECK: '1', GRAPE_BASE_URL: '', GRAPE_AUTH_FILE: '',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\[ok\] GRAPE_BASE_URL: .*文件通道/, '文件通道必须 PASS 并标注来源')
  assert.match(r.stdout, /契约连通性/, '解析到地址后探针必须执行（不再依赖 env）')
})

/* ── Issue #20：auth init 单入口 + doctor 完整优先级视图 ── */

const cleanCredEnv = {
  GRAPE_AUTH_FILE: '', GRAPE_BASE_URL: '', GRAPE_API_TOKEN: '', GRAPE_API_TOKEN_ONCE: '',
}

test('Issue #20 auth init 写入 GRAPE_HOME/config.json（权限 600）并打印 env 通道命令', () => {
  const h = home()
  const grapeHome = join(h, 'grapehome')
  const r = run(['auth', 'init', '--token', 'grape_fake_init', '--base-url', 'https://self.example'], h, { ...cleanCredEnv, GRAPE_HOME: grapeHome })
  assert.equal(r.status, 0, r.stderr)
  const cfgPath = join(grapeHome, 'config.json')
  assert.ok(existsSync(cfgPath), `应写入 ${cfgPath}`)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(cfg.token, 'grape_fake_init')
  assert.equal(cfg.base_url, 'https://self.example')
  assert.equal(statSync(cfgPath).mode & 0o777, 0o600, '凭据文件权限应为 600')
  assert.match(r.stdout, /export GRAPE_API_TOKEN=/, 'POSIX 应打印 export 设置命令')
  assert.match(r.stdout, /GRAPE_BASE_URL/)
  assert.match(r.stdout, /GRAPE_API_TOKEN_ONCE[\s\S]*GRAPE_API_TOKEN[\s\S]*(GRAPE_AUTH_FILE|config\.json)/, '应说明优先级链')
})

test('Issue #20 auth init 拒绝非 grape_ 前缀 token 且不落盘', () => {
  const h = home()
  const grapeHome = join(h, 'grapehome')
  const r = run(['auth', 'init', '--token', 'tko_nope'], h, { ...cleanCredEnv, GRAPE_HOME: grapeHome })
  assert.notEqual(r.status, 0, '非 grape_ 前缀用户凭据应被拒绝')
  assert.match(`${r.stderr}${r.stdout}`, /grape_/)
  assert.ok(!existsSync(join(grapeHome, 'config.json')), '拒绝时不得写入文件通道')
})

/* ── QA 复审（PR #11）P1：auth init 写入目标必须与 resolveCredentials 解析目标一致 ── */

test('QA#P1 auth init 尊重 GRAPE_AUTH_FILE：写入目标=解析目标，一次写入后文件通道即生效', () => {
  const h = home()
  const grapeHome = join(h, 'grapehome')
  const authFile = join(h, 'custom-auth.json')
  // 预置旧凭据：旧实现只写 GRAPE_HOME/config.json，resolveCredentials 读 GRAPE_AUTH_FILE 旧值——单入口不成立
  writeFileSync(authFile, JSON.stringify({ token: 'grape_old_secret', base_url: 'https://old.example' }))
  const r = run(['auth', 'init', '--token', 'grape_new_secret', '--base-url', 'https://new.example'], h,
    { ...cleanCredEnv, GRAPE_HOME: grapeHome, GRAPE_AUTH_FILE: authFile })
  assert.equal(r.status, 0, r.stderr)
  const written = JSON.parse(readFileSync(authFile, 'utf8'))
  assert.equal(written.token, 'grape_new_secret', '应写入 GRAPE_AUTH_FILE 指向的文件')
  assert.equal(written.base_url, 'https://new.example')
  assert.ok(!existsSync(join(grapeHome, 'config.json')), 'GRAPE_AUTH_FILE 已设置时不得另写 GRAPE_HOME/config.json')
  // 写入目标与解析目标一致：doctor 生效来源=文件通道 authFile，base_url 取新值（不回显 token）
  const d = run(['doctor'], h, {
    ...cleanCredEnv, GRAPE_HOME: grapeHome, GRAPE_AUTH_FILE: authFile, GRAPE_KIT_SKIP_UPDATE_CHECK: '1',
  })
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, new RegExp(`当前生效凭据来源[^\\n]*文件 ${authFile}`), '生效凭据来源应命中 GRAPE_AUTH_FILE')
  assert.match(d.stdout, /https:\/\/new\.example/, '生效 base_url 应为新写入值')
})

test('Issue #20 doctor 展示 runtime > env > file 完整优先级链且不回显 token', () => {
  const h = home()
  const grapeHome = join(h, 'grapehome')
  mkdirSync(grapeHome, { recursive: true })
  writeFileSync(join(grapeHome, 'config.json'), JSON.stringify({ token: 'grape_file_secret', base_url: 'https://file.example' }))
  const r = run(['doctor'], h, {
    ...cleanCredEnv, GRAPE_HOME: grapeHome, GRAPE_API_TOKEN: 'grape_env_secret', GRAPE_BASE_URL: 'https://env.example',
    GRAPE_KIT_SKIP_UPDATE_CHECK: '1',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /凭据优先级[^\n]*runtime/, '应列出 runtime 档')
  assert.match(r.stdout, /凭据优先级[^\n]*env/, '应列出 env 档')
  assert.match(r.stdout, /凭据优先级[^\n]*file/, '应列出 file 档')
  assert.doesNotMatch(r.stdout, /grape_env_secret|grape_file_secret/, '不得回显 token')
})

/* ── QA 复审（PR #11）P1：doctor 解析失败不得把文件内容透传进输出 ── */

test('QA#P1 doctor 文件通道解析失败：报错固定为「解析失败」，不回显 JSON.parse 携带的文件原文片段', () => {
  const h = home()
  const grapeHome = join(h, 'grapehome')
  mkdirSync(grapeHome, { recursive: true })
  // 非法 JSON：JSON.parse 的 e.message 会带出原文（实测 `Unexpected token 'k', "tk_9…"`），
  // 凭据片段由此进入 doctor 输出——违反 Spec「never echo the token」
  writeFileSync(join(grapeHome, 'config.json'), 'tk_9leaked_fragment_not_json')
  const r = run(['doctor'], h, { ...cleanCredEnv, GRAPE_HOME: grapeHome, GRAPE_KIT_SKIP_UPDATE_CHECK: '1' })
  assert.equal(r.status, 0, '解析失败按未配置处理，doctor 不非零退出', r.stderr)
  const out = `${r.stdout}${r.stderr}`
  assert.match(out, /解析失败/, '应提示解析失败')
  assert.doesNotMatch(out, /tk_9leaked/, '不得回显文件内容片段')
})
