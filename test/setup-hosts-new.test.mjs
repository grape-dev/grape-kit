import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname
const isWin = process.platform === 'win32'
const skipOnWin = { skip: isWin ? 'win32: HOME 隔离对 homedir() 无效' : false }

const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-host-'))
  homes.push(h)
  return h
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** 默认 cwd = 临时 HOME，避免 trae 项目级 .trae/mcp.json 落到仓库工作树 */
function run(args, h, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    cwd: h,
    env: {
      ...process.env,
      HOME: h,
      GRAPE_CODEARTS_CONFIG: '',
      GRAPE_OFFICEACE_MANIFEST: '',
      GRAPE_HOME: '',
      GRAPE_AUTH_FILE: '',
      GRAPE_CODEX_CONFIG: '',
      GRAPE_OPENCLAW_CONFIG: '',
      GRAPE_HERMES_CONFIG: '',
      GRAPE_TRAE_CONFIG: '',
      HERMES_HOME: '',
      ATOMCODE_HOME: '',
      DSH_HOME: '',
      ...extraEnv,
    },
    timeout: 30_000,
  })
}

const backupsIn = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-grapemcp-')).sort()

/* ---------- 目标清单 ---------- */

test('#26 --target 全量 10 宿主：help 与未知 target 报错均列出全部', () => {
  const h = home()
  const expected = ['opencode', 'workbuddy', 'dsh', 'openclaw', 'codearts', 'officeace', 'codex', 'hermes', 'atomcode', 'trae']
  const help = run(['help'], h)
  assert.equal(help.status, 0)
  for (const t of expected) assert.match(`${help.stdout}${help.stderr}`, new RegExp(`\\b${t}\\b`), `help 应列出 ${t}`)

  const bad = run(['install', '--target', 'nope'], h)
  assert.notEqual(bad.status, 0)
  for (const t of expected) assert.match(bad.stderr, new RegExp(`\\b${t}\\b`), `报错应列出 ${t}`)
})

/* ---------- codex（TOML） ---------- */

test('codex 安装写入 [mcp_servers.grape-kit] + env 子表，保注释与他人表；幂等；dry-run 不动盘；卸载只删自身', () => {
  const h = home()
  const dir = join(h, '.codex')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.toml')
  const seed = [
    '# 用户注释必须保留',
    'model = "gpt-5"',
    '',
    '[profiles.fast]',
    'model = "gpt-5-mini"',
    '',
  ].join('\n')
  writeFileSync(cfg, seed)

  const inst = run(['install', '--target', 'codex'], h)
  assert.equal(inst.status, 0, inst.stderr)
  const first = readFileSync(cfg, 'utf8')
  assert.match(first, /# 用户注释必须保留/)
  assert.match(first, /\[profiles\.fast\]/)
  assert.match(first, /\[mcp_servers\.grape-kit\]/)
  assert.match(first, /\[mcp_servers\.grape-kit\.env\]/)
  assert.match(first, /command = "npx"/)
  assert.match(first, /@grape-dev\/grape-kit/)
  assert.equal((first.match(/\[mcp_servers\.grape-kit\]/g) || []).length, 1)
  assert.equal(backupsIn(dir).length, 1, '首次写入应留一份改动前备份')
  assert.equal(readFileSync(join(dir, backupsIn(dir)[0]), 'utf8'), seed)

  const second = run(['install', '--target', 'codex'], h)
  assert.equal(second.status, 0, second.stderr)
  const again = readFileSync(cfg, 'utf8')
  assert.equal(again, first, '重复安装必须逐字节幂等')
  assert.equal((again.match(/\[mcp_servers\.grape-kit\]/g) || []).length, 1)

  const doctor = run(['doctor', '--target', 'codex'], h)
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.match(doctor.stdout, /\[ok\][^\n]*codex/i)

  const dry = run(['uninstall', '--target', 'codex', '--dry-run'], h)
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /dry-run|预览/)
  assert.equal(readFileSync(cfg, 'utf8'), again, 'dry-run 不得改动配置文件')

  const un = run(['uninstall', '--target', 'codex'], h)
  assert.equal(un.status, 0, un.stderr)
  const after = readFileSync(cfg, 'utf8')
  assert.doesNotMatch(after, /\[mcp_servers\.grape-kit\]/)
  assert.match(after, /# 用户注释必须保留/)
  assert.match(after, /\[profiles\.fast\]/)
})

test('codex 已有用户手写 grape-kit 表：安装去重为单一托管条目', () => {
  const h = home()
  const dir = join(h, '.codex')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.toml')
  writeFileSync(cfg, '[mcp_servers.grape-kit]\ncommand = "node"\nargs = ["old.mjs"]\n\n[other]\nkeep = true\n')
  assert.equal(run(['install', '--target', 'codex'], h).status, 0)
  const text = readFileSync(cfg, 'utf8')
  assert.equal((text.match(/\[mcp_servers\.grape-kit\]/g) || []).length, 1)
  assert.match(text, /\[other\]\nkeep = true/, '他人表必须保留')
  assert.doesNotMatch(text, /old\.mjs/)
})

/* ---------- openclaw（JSON，mcp.servers / mcpServers 兼容） ---------- */

test('openclaw 安装写入 mcp.servers.grape-kit，他人连接器保留；doctor/幂等/dry-run/卸载', () => {
  const h = home()
  const dir = join(h, '.openclaw')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'openclaw.json')
  writeFileSync(cfg, JSON.stringify({ theme: 'dark', mcp: { servers: { other: { command: 'node', args: ['other.mjs'] } } } }, null, 2) + '\n')

  assert.equal(run(['install', '--target', 'openclaw'], h).status, 0)
  const first = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(first.theme, 'dark')
  assert.ok(first.mcp.servers.other)
  assert.equal(first.mcp.servers['grape-kit'].command, 'npx')
  assert.match(first.mcp.servers['grape-kit'].args.join(' '), /@grape-dev\/grape-kit/)

  assert.equal(run(['install', '--target', 'openclaw'], h).status, 0)
  assert.equal(Object.keys(JSON.parse(readFileSync(cfg, 'utf8')).mcp.servers).filter((k) => k === 'grape-kit').length, 1)

  const doctor = run(['doctor', '--target', 'openclaw'], h)
  assert.match(doctor.stdout, /\[ok\][^\n]*openclaw/i)

  const before = readFileSync(cfg, 'utf8')
  const dry = run(['uninstall', '--target', 'openclaw', '--dry-run'], h)
  assert.equal(dry.status, 0)
  assert.equal(readFileSync(cfg, 'utf8'), before, 'dry-run 不得改动配置')

  assert.equal(run(['uninstall', '--target', 'openclaw'], h).status, 0)
  const after = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(after.mcp.servers['grape-kit'], undefined)
  assert.ok(after.mcp.servers.other)
})

test('openclaw 兼容旧 mcpServers 键：安装与卸载都落在既有容器', () => {
  const h = home()
  const dir = join(h, '.openclaw')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'openclaw.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2) + '\n')
  assert.equal(run(['install', '--target', 'openclaw'], h).status, 0)
  const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(cfg1.mcpServers['grape-kit'])
  assert.equal(cfg1.mcp, undefined, '既有 mcpServers 容器不应被替换成 mcp.servers')
  assert.equal(run(['uninstall', '--target', 'openclaw'], h).status, 0)
  const cfg2 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(cfg2.mcpServers['grape-kit'], undefined)
  assert.ok(cfg2.mcpServers.other)
})

/* ---------- hermes（YAML + skills） ---------- */

test('hermes 安装写入 mcp_servers.grape-kit 并复制 skill，保注释与他人条目；幂等；dry-run；卸载清条目与 skill', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  writeFileSync(cfg, [
    '# 用户注释',
    'model: deepseek-v4-pro',
    '',
    'mcp_servers:',
    '  other:',
    '    command: "node"',
    '    args: ["other.mjs"]',
    '',
    'hooks:',
    '  pre_tool_call: []',
    '',
  ].join('\n'))

  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const first = readFileSync(cfg, 'utf8')
  assert.match(first, /# 用户注释/)
  assert.match(first, /^  other:/m)
  assert.match(first, /^  grape-kit:/m)
  assert.match(first, /command: npx/)
  assert.match(first, /- '@grape-dev\/grape-kit'/)
  assert.match(first, /hooks:/)
  assert.ok(existsSync(join(dir, 'skills', 'grape-remote', 'SKILL.md')), 'skill 副本应落位')

  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const again = readFileSync(cfg, 'utf8')
  assert.equal(again, first, '重复安装必须逐字节幂等')
  assert.equal((again.match(/^  grape-kit:/gm) || []).length, 1)

  const doctor = run(['doctor', '--target', 'hermes'], h)
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.match(doctor.stdout, /\[ok\][^\n]*hermes[^\n]*mcp_servers/i)

  const dry = run(['uninstall', '--target', 'hermes', '--dry-run'], h)
  assert.equal(dry.status, 0)
  assert.equal(readFileSync(cfg, 'utf8'), again, 'dry-run 不得改动配置')
  assert.ok(existsSync(join(dir, 'skills', 'grape-remote', 'SKILL.md')), 'dry-run 不得删除 skill')

  assert.equal(run(['uninstall', '--target', 'hermes'], h).status, 0)
  const after = readFileSync(cfg, 'utf8')
  assert.doesNotMatch(after, /^  grape-kit:/m)
  assert.match(after, /^  other:/m)
  assert.match(after, /# 用户注释/)
  assert.ok(!existsSync(join(dir, 'skills', 'grape-remote')), '卸载应删除 skill 副本')
})

test('hermes 已有手写 grape-kit 条目：安装去重为单一托管条目', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  writeFileSync(cfg, 'mcp_servers:\n  grape-kit:\n    command: node\n    args: ["old.mjs"]\n  keep:\n    command: node\n')
  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const text = readFileSync(cfg, 'utf8')
  assert.equal((text.match(/^  grape-kit:/gm) || []).length, 1)
  assert.match(text, /^  keep:/m)
  assert.doesNotMatch(text, /old\.mjs/)
})

/* ---------- atomcode（JSON，ATOMCODE_HOME 覆盖） ---------- */

test('atomcode 安装写入 mcpServers.grape-kit，ATOMCODE_HOME 覆盖根路径；doctor/dry-run/卸载', () => {
  const h = home()
  const root = join(h, 'custom-atomcode')
  mkdirSync(root, { recursive: true })
  const cfg = join(root, 'mcp.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2) + '\n')

  const env = { ATOMCODE_HOME: root }
  assert.equal(run(['install', '--target', 'atomcode'], h, env).status, 0)
  const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(cfg1.mcpServers.other)
  assert.equal(cfg1.mcpServers['grape-kit'].command, 'npx')
  assert.ok(!existsSync(join(h, '.atomcode', 'mcp.json')), 'ATOMCODE_HOME 覆盖时不应写默认目录')

  const doctor = run(['doctor', '--target', 'atomcode'], h, env)
  assert.match(doctor.stdout, /\[ok\][^\n]*atomcode/i)

  const before = readFileSync(cfg, 'utf8')
  assert.equal(run(['uninstall', '--target', 'atomcode', '--dry-run'], h, env).status, 0)
  assert.equal(readFileSync(cfg, 'utf8'), before, 'dry-run 不得改动配置')

  assert.equal(run(['uninstall', '--target', 'atomcode'], h, env).status, 0)
  const cfg2 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(cfg2.mcpServers['grape-kit'], undefined)
  assert.ok(cfg2.mcpServers.other)
})

/* ---------- trae（项目级 .trae/mcp.json） ---------- */

test('trae 项目级 .trae/mcp.json 安装/doctor/幂等/dry-run/卸载，detect 选中 trae', () => {
  const h = home()
  const cfg = join(h, '.trae', 'mcp.json')
  mkdirSync(join(h, '.trae'), { recursive: true })
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2) + '\n')

  assert.equal(run(['install', '--target', 'trae'], h).status, 0)
  const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(cfg1.mcpServers.other)
  assert.match(cfg1.mcpServers['grape-kit'].args.join(' '), /@grape-dev\/grape-kit/)

  const doctor = run(['doctor', '--target', 'trae'], h)
  assert.match(doctor.stdout, /\[ok\][^\n]*trae/i)

  // 只有 .trae 痕迹时，不带 --target 的 install 自动命中 trae（detectHosts）
  const auto = run(['install'], h)
  assert.equal(auto.status, 0, auto.stderr)
  assert.match(auto.stdout, /\.trae\/mcp\.json/)

  const before = readFileSync(cfg, 'utf8')
  assert.equal(run(['uninstall', '--target', 'trae', '--dry-run'], h).status, 0)
  assert.equal(readFileSync(cfg, 'utf8'), before, 'dry-run 不得改动配置')

  assert.equal(run(['uninstall', '--target', 'trae'], h).status, 0)
  const cfg2 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(cfg2.mcpServers['grape-kit'], undefined)
  assert.ok(cfg2.mcpServers.other)
})

test('trae 不回退用户级：仅存在 ~/.trae/mcp.json 时安装写入项目级，且不改写用户级文件', () => {
  const project = home()
  const userHome = join(project, 'home')
  const userCfg = join(userHome, '.trae', 'mcp.json')
  mkdirSync(dirname(userCfg), { recursive: true })
  const userOriginal = JSON.stringify({ mcpServers: { user: { command: 'x' } } }, null, 2) + '\n'
  writeFileSync(userCfg, userOriginal)

  const r = run(['install', '--target', 'trae'], project, { HOME: userHome })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(userCfg, 'utf8'), userOriginal, '用户级文件不得被改写')

  const projectCfg = join(project, '.trae', 'mcp.json')
  assert.ok(existsSync(projectCfg), '应写入项目级 .trae/mcp.json')
  const cfg = JSON.parse(readFileSync(projectCfg, 'utf8'))
  assert.match(cfg.mcpServers['grape-kit'].args.join(' '), /@grape-dev\/grape-kit/)
})

test('detectHosts 的 trae 探测要求 .trae/mcp.json 文件存在（空目录不误判）', () => {
  const h = home()
  mkdirSync(join(h, '.trae'), { recursive: true })
  const r = run(['install'], h)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /未检测到/)
})

test('hermes 4 空格缩进的合法手写条目：安装去重为单一托管条目，doctor 检出，卸载只删自身', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  writeFileSync(cfg, 'mcp_servers:\n    grape-kit:\n        command: node\n        args: ["old.mjs"]\n    keep:\n        command: node\n')

  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const text = readFileSync(cfg, 'utf8')
  assert.equal((text.match(/^\s+grape-kit:/gm) || []).length, 1, '不得出现重复 grape-kit 键')
  assert.doesNotMatch(text, /old\.mjs/)
  assert.match(text, /^    keep:/m)
  assert.match(text, /^    grape-kit:/m, '新条目应与既有段落同缩进')

  const doctor = run(['doctor', '--target', 'hermes'], h)
  assert.match(doctor.stdout, /\[ok\][^\n]*hermes[^\n]*mcp_servers/i)

  assert.equal(run(['uninstall', '--target', 'hermes'], h).status, 0)
  const after = readFileSync(cfg, 'utf8')
  assert.doesNotMatch(after, /grape-kit:/)
  assert.match(after, /^    keep:/m)
})

test('hermes mcp_servers 为非空 inline map 时安装中止并保持文件原样', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  const original = 'mcp_servers: {other: 1}\nhooks: {}\n'
  writeFileSync(cfg, original)

  const r = run(['install', '--target', 'hermes'], h)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /inline|内联|mcp_servers/i)
  assert.equal(readFileSync(cfg, 'utf8'), original, '中止时不得改动配置')
  assert.ok(!existsSync(join(dir, 'skills', 'grape-remote')), '中止时不得复制 skill')
})

test('codex 仅剩托管条目时 dry-run 披露将删除整个文件，且与执行一致', () => {
  const h = home()
  const dir = join(h, '.codex')
  const cfg = join(dir, 'config.toml')
  assert.equal(run(['install', '--target', 'codex'], h).status, 0)

  const dry = run(['uninstall', '--target', 'codex', '--dry-run'], h)
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /删除/)
  assert.ok(existsSync(cfg), 'dry-run 不得删文件')

  const un = run(['uninstall', '--target', 'codex'], h)
  assert.equal(un.status, 0)
  assert.ok(!existsSync(cfg), '执行时应删除仅剩托管条目的文件')
})

/* ---------- 汇总自检覆盖全部 10 宿主 ---------- */

test('#26 裸 doctor 汇总覆盖全部 10 宿主，新装 5 宿主均报 [ok]', skipOnWin, () => {
  const h = home()
  for (const t of ['codex', 'openclaw', 'hermes', 'atomcode', 'trae']) {
    const r = run(['install', '--target', t], h)
    assert.equal(r.status, 0, `${t}: ${r.stderr}`)
  }
  const doctor = run(['doctor'], h)
  assert.equal(doctor.status, 0, doctor.stderr)
  for (const t of ['codex', 'openclaw', 'hermes', 'atomcode', 'trae']) {
    assert.match(doctor.stdout, new RegExp(`\\[ok\\][^\\n]*${t}`, 'i'), `汇总自检应检出 ${t}`)
  }
  const hostLines = doctor.stdout.split('\n').filter((l) => /条目（/.test(l))
  assert.ok(hostLines.length >= 10, `裸 doctor 应覆盖 10 宿主，实际 ${hostLines.length} 行`)
})