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

test('codex 仅注释行提到表头：不误判已安装（doctor 非 ok、卸载不谎报已移除、文件不动）', () => {
  const h = home()
  const dir = join(h, '.codex')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.toml')
  const original = '# [mcp_servers.grape-kit] 旧配置已停用（注释保留）\nmodel = "gpt-5"\n'
  writeFileSync(cfg, original)

  const doctor = run(['doctor', '--target', 'codex'], h)
  assert.doesNotMatch(doctor.stdout, /\[ok\][^\n]*codex/i, '注释掉的表头不算已安装')

  const dry = run(['uninstall', '--target', 'codex', '--dry-run'], h)
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /将移除/, '无真实表头时不得预告移除')

  const un = run(['uninstall', '--target', 'codex'], h)
  assert.equal(un.status, 0, un.stderr)
  assert.doesNotMatch(un.stdout, /已移除/, '不得谎报已移除')
  assert.match(un.stdout, /未发现|跳过/)
  assert.equal(readFileSync(cfg, 'utf8'), original, '文件必须逐字节不变')
  assert.equal(backupsIn(dir).length, 0, '未改动就不得产生备份')
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
  const proj = join(h, 'proj')   // trae 是项目级宿主：cwd 必须是项目目录（≠ $HOME）
  mkdirSync(proj, { recursive: true })
  const cfg = join(proj, '.trae', 'mcp.json')
  mkdirSync(join(proj, '.trae'), { recursive: true })
  writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'node' } } }, null, 2) + '\n')
  const env = { HOME: h }

  assert.equal(run(['install', '--target', 'trae'], proj, env).status, 0)
  const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(cfg1.mcpServers.other)
  assert.match(cfg1.mcpServers['grape-kit'].args.join(' '), /@grape-dev\/grape-kit/)

  const doctor = run(['doctor', '--target', 'trae'], proj, env)
  assert.match(doctor.stdout, /\[ok\][^\n]*trae/i)

  // 只有 .trae 痕迹时，不带 --target 的 install 自动命中 trae（detectHosts）
  const auto = run(['install'], proj, env)
  assert.equal(auto.status, 0, auto.stderr)
  assert.match(auto.stdout, /\.trae\/mcp\.json/)

  const before = readFileSync(cfg, 'utf8')
  assert.equal(run(['uninstall', '--target', 'trae', '--dry-run'], proj, env).status, 0)
  assert.equal(readFileSync(cfg, 'utf8'), before, 'dry-run 不得改动配置')

  assert.equal(run(['uninstall', '--target', 'trae'], proj, env).status, 0)
  const cfg2 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(cfg2.mcpServers['grape-kit'], undefined)
  assert.ok(cfg2.mcpServers.other)
})

test('trae cwd 等于 $HOME：安装拒绝并指路项目目录，不写用户级 ~/.trae/mcp.json', () => {
  const h = home()
  // run 默认 cwd = HOME：此时项目级路径 == 用户级路径，Spec Out of Scope（不做用户级）
  const r = run(['install', '--target', 'trae'], h)
  assert.notEqual(r.status, 0, 'cwd==$HOME 必须拒绝（否则等同用户级落盘）')
  assert.match(`${r.stderr}${r.stdout}`, /项目目录/, '应提示到项目目录执行')
  assert.ok(!existsSync(join(h, '.trae', 'mcp.json')), '不得写用户级 ~/.trae/mcp.json')
})

test('--target all 跳过 trae（项目级宿主），不静默创建 .trae/', () => {
  const homeDir = home()
  const proj = join(homeDir, 'proj')
  mkdirSync(join(homeDir, '.codex'), { recursive: true })
  mkdirSync(proj, { recursive: true })

  const r = run(['install', '--target', 'all'], proj, { HOME: homeDir, GRAPE_DSH_DEP_CMD: process.execPath })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(proj, '.trae', 'mcp.json')), '--target all 不得在任意目录静默创建 .trae/')
  assert.match(r.stdout, /跳过项目级宿主[^\n]*trae/, '应披露跳过 trae 及原因（不静默跳过）')
  assert.ok(existsSync(join(homeDir, '.codex', 'config.toml')), '其余宿主仍应装配')
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

test('hermes 手写条目：同层用户注释保留（重装/卸载都不吞），条目内部更深注释随条目替换', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  const original = [
    'mcp_servers:',
    '  grape-kit:',
    '    command: node',
    '    # 条目内部注释（属于该条目，随条目替换）',
    '    args: ["old.mjs"]',
    '  # my other server',
    '  other:',
    '    command: node',
    '',
  ].join('\n')
  writeFileSync(cfg, original)

  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const installed = readFileSync(cfg, 'utf8')
  assert.match(installed, /^  # my other server/m, '同层用户注释必须保留（README 承诺 comments preserved）')
  assert.match(installed, /^  other:/m, '他人条目必须保留')
  assert.doesNotMatch(installed, /条目内部注释/, '被替换条目内部的注释随条目一并移除，不留悬挂注释')

  assert.equal(run(['uninstall', '--target', 'hermes'], h).status, 0)
  const after = readFileSync(cfg, 'utf8')
  assert.match(after, /^  # my other server/m, '卸载不得吞掉同层用户注释')
  assert.match(after, /^  other:/m)
  assert.doesNotMatch(after, /grape-kit/)
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

/* ---------- QA 复审（PR #22 · P2）：其它 server 下的同名嵌套键 / 多行 flow map ---------- */

const HERMES_START_MARK = '# >>> grape-kit managed block (hermes mcp_servers) >>>'

test('hermes 不完整托管块：dry-run 与执行同判「拒绝卸载」，执行 exit 1 且不动配置与 skill', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(join(dir, 'skills', 'grape-remote'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'grape-remote', 'SKILL.md'), '# skill\n')
  const cfg = join(dir, 'config.yaml')
  const broken = `mcp_servers:\n  other:\n    command: node\n  ${HERMES_START_MARK}\n  grape-kit:\n    command: npx\n`
  writeFileSync(cfg, broken)

  const dry = run(['uninstall', '--target', 'hermes', '--dry-run'], h)
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /将移除 mcp_servers\.grape-kit/, 'dry-run 不得承诺一个执行时会拒绝的动作')
  assert.match(dry.stdout, /不完整托管块/, 'dry-run 应披露不完整托管块')
  assert.equal(readFileSync(cfg, 'utf8'), broken, 'dry-run 不得改动配置')

  const un = run(['uninstall', '--target', 'hermes'], h)
  assert.equal(un.status, 1, '不完整托管块必须拒绝卸载')
  assert.match(un.stderr, /不完整托管块/)
  assert.equal(readFileSync(cfg, 'utf8'), broken, '拒绝卸载时不得改动配置')
  assert.ok(existsSync(join(dir, 'skills', 'grape-remote', 'SKILL.md')), '拒绝卸载时不得清理 skill（与预览口径一致）')
})

test('hermes 其它 server 下的同名嵌套 grape-kit 键：不误判已安装、不误删、安装后仍保留', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  const original = '# 用户注释\nmcp_servers:\n  other:\n    grape-kit:\n      command: node\n      args: ["keep.mjs"]\n  keep:\n    command: node\n'
  writeFileSync(cfg, original)

  const doctor = run(['doctor', '--target', 'hermes'], h)
  assert.doesNotMatch(doctor.stdout, /\[ok\][^\n]*hermes[^\n]*mcp_servers/i, '嵌套同名键不算已安装')

  const dry = run(['uninstall', '--target', 'hermes', '--dry-run'], h)
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /将移除 mcp_servers\.grape-kit/, '无同层条目时不得预告移除')

  const un = run(['uninstall', '--target', 'hermes'], h)
  assert.equal(un.status, 0, un.stderr)
  assert.equal(readFileSync(cfg, 'utf8'), original, '其它 server 下的嵌套同名键不得被删除')

  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)
  const text = readFileSync(cfg, 'utf8')
  assert.match(text, /keep\.mjs/, '安装不得吞掉他人嵌套条目')
  assert.equal((text.match(/^  grape-kit:/gm) || []).length, 1, '同层托管条目应有且只有一个')
  assert.equal((text.match(/^\s{4}grape-kit:/gm) || []).length, 1, '嵌套条目应原位保留')

  assert.equal(run(['uninstall', '--target', 'hermes'], h).status, 0)
  assert.match(readFileSync(cfg, 'utf8'), /keep\.mjs/, '卸载只删自己的托管条目')
})

test('hermes mcp_servers 非块映射取值（多行 flow map / 空序列 / 块序列 / 标量）：安装中止并保持文件原样', () => {
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')

  // 裸 `mcp_servers:` 头后跟序列项 / 标量：追加 `  grape-kit:` 会产出 mapping+sequence 混层（yaml ParserError）
  const nonBlock = [
    'mcp_servers: {\n  other: {command: node}\n}\nhooks: {}\n',
    'mcp_servers: []\n',
    'mcp_servers:\n  - a\n',
    'mcp_servers:\n  foo\n',
  ]
  for (const original of nonBlock) {
    writeFileSync(cfg, original)
    const r = run(['install', '--target', 'hermes'], h)
    assert.notEqual(r.status, 0, `非块格式 mcp_servers 必须中止安装：${original}`)
    assert.match(r.stderr, /mcp_servers/, '应点名 mcp_servers 与修复方式')
    assert.equal(readFileSync(cfg, 'utf8'), original, '中止时不得改动配置')
    assert.ok(!existsSync(join(dir, 'skills', 'grape-remote')), '中止时不得复制 skill')
  }
})

test('JSON 宿主（openclaw）含注释/尾随逗号：宽松解析后安装/卸载可用，且写前备份原文', () => {
  const h = home()
  const dir = join(h, '.openclaw')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'openclaw.json')
  const jsonc = '{\n  // 用户注释\n  "mcp": { "servers": { "other": { "command": "node" }, }, },\n}\n'
  writeFileSync(cfg, jsonc)

  const inst = run(['install', '--target', 'openclaw'], h)
  assert.equal(inst.status, 0, `含注释/尾随逗号的 JSON 不得直接 exit 1：${inst.stderr}`)
  assert.match(inst.stderr, /宽松|注释/, '应披露宽松解析与写入规范化')
  const cfg1 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.ok(cfg1.mcp.servers.other, '他人连接器必须保留')
  assert.equal(cfg1.mcp.servers['grape-kit'].command, 'npx')
  assert.equal(backupsIn(dir).length, 1, '规范化写入前应留一份原文备份')
  assert.equal(readFileSync(join(dir, backupsIn(dir)[0]), 'utf8'), jsonc)

  const un = run(['uninstall', '--target', 'openclaw'], h)
  assert.equal(un.status, 0, `卸载不得把 jsonc 判成配置损坏：${un.stderr}`)
  const cfg2 = JSON.parse(readFileSync(cfg, 'utf8'))
  assert.equal(cfg2.mcp.servers['grape-kit'], undefined)
  assert.ok(cfg2.mcp.servers.other)
})

test('detectHosts 的 hermes 探测以 HERMES_HOME 覆盖路径为准（无 --target 也能命中）', () => {
  const h = home()
  const custom = join(h, 'custom-hermes')
  mkdirSync(custom, { recursive: true })

  const r = run(['install'], h, { HERMES_HOME: custom })
  assert.equal(r.status, 0, `HERMES_HOME 有痕迹时应自动命中 hermes：${r.stderr}`)
  assert.match(r.stdout, /hermes/)
  assert.ok(existsSync(join(custom, 'config.yaml')), '配置应写入 HERMES_HOME 覆盖路径')
  assert.ok(!existsSync(join(h, '.hermes')), '不得写到默认 ~/.hermes')
})

test('卸载仅剩空容器：hermes / JSON 宿主删除空文件（写前备份），dry-run 同样披露', skipOnWin, () => {
  // hermes：只剩 `mcp_servers:`（解析为 null）不得留在盘上
  const h = home()
  const dir = join(h, '.hermes')
  mkdirSync(dir, { recursive: true })
  const cfg = join(dir, 'config.yaml')
  assert.equal(run(['install', '--target', 'hermes'], h).status, 0)

  const dry = run(['uninstall', '--target', 'hermes', '--dry-run'], h)
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /删除[^\n]*文件/, 'dry-run 应披露将删除仅剩空容器的文件')
  assert.ok(existsSync(cfg), 'dry-run 不得删文件')

  const un = run(['uninstall', '--target', 'hermes'], h)
  assert.equal(un.status, 0, un.stderr)
  assert.ok(!existsSync(cfg), 'hermes 仅剩空 mcp_servers 段时应删除整个文件')
  assert.ok(backupsIn(dir).length >= 1, '删除前必须写一份原文备份')

  // JSON 宿主：{"mcp": {"servers": {}}} / {"mcpServers": {}} 同样不得残留
  const jsonHosts = [['openclaw', ['.openclaw', 'openclaw.json']], ['atomcode', ['.atomcode', 'mcp.json']]]
  for (const [t, parts] of jsonHosts) {
    const hj = home()
    const file = join(hj, ...parts)
    mkdirSync(dirname(file), { recursive: true })
    assert.equal(run(['install', '--target', t], hj).status, 0, `${t} 安装失败`)
    const d = run(['uninstall', '--target', t, '--dry-run'], hj)
    assert.equal(d.status, 0, d.stderr)
    assert.match(d.stdout, /删除[^\n]*文件/, `${t} dry-run 应披露将删除仅剩空容器的文件`)
    assert.ok(existsSync(file), `${t} dry-run 不得删文件`)
    assert.equal(run(['uninstall', '--target', t], hj).status, 0, `${t} 卸载失败`)
    assert.ok(!existsSync(file), `${t} 仅剩空容器时应删除整个文件`)
    assert.ok(backupsIn(dirname(file)).length >= 1, `${t} 删除前必须写一份原文备份`)
  }

  // trae（项目级）：同样口径
  const hp = home()
  const proj = join(hp, 'proj')
  mkdirSync(proj, { recursive: true })
  const traeCfg = join(proj, '.trae', 'mcp.json')
  assert.equal(run(['install', '--target', 'trae'], proj, { HOME: hp }).status, 0)
  const td = run(['uninstall', '--target', 'trae', '--dry-run'], proj, { HOME: hp })
  assert.match(td.stdout, /删除[^\n]*文件/, 'trae dry-run 应披露将删除仅剩空容器的文件')
  assert.equal(run(['uninstall', '--target', 'trae'], proj, { HOME: hp }).status, 0)
  assert.ok(!existsSync(traeCfg), 'trae 仅剩空容器时应删除整个文件')
})

/* ---------- 汇总自检覆盖全部 10 宿主 ---------- */

test('#26 裸 doctor 汇总覆盖全部 10 宿主，新装 5 宿主均报 [ok]', skipOnWin, () => {
  const h = home()
  const proj = join(h, 'proj')   // trae 项目级：从项目目录装配，doctor 也从该目录汇总
  mkdirSync(proj, { recursive: true })
  for (const t of ['codex', 'openclaw', 'hermes', 'atomcode']) {
    const r = run(['install', '--target', t], h)
    assert.equal(r.status, 0, `${t}: ${r.stderr}`)
  }
  const trae = run(['install', '--target', 'trae'], proj, { HOME: h })
  assert.equal(trae.status, 0, `trae: ${trae.stderr}`)
  const doctor = run(['doctor'], proj, { HOME: h })
  assert.equal(doctor.status, 0, doctor.stderr)
  for (const t of ['codex', 'openclaw', 'hermes', 'atomcode', 'trae']) {
    assert.match(doctor.stdout, new RegExp(`\\[ok\\][^\\n]*${t}`, 'i'), `汇总自检应检出 ${t}`)
  }
  const hostLines = doctor.stdout.split('\n').filter((l) => /条目（/.test(l))
  assert.ok(hostLines.length >= 10, `裸 doctor 应覆盖 10 宿主，实际 ${hostLines.length} 行`)
})