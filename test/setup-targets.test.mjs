import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
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
    // 每个用例隔离 HOME，杜绝污染真实宿主配置；显式清掉路径逃生口
    env: {
      ...process.env,
      HOME: h,
      GRAPE_CODEARTS_CONFIG: '',
      GRAPE_OFFICEACE_MANIFEST: '',
      GRAPE_HOME: '',
      GRAPE_AUTH_FILE: '',
      ...extraEnv,
    },
    timeout: 30_000,
  })
}

/** 去掉整行 // 注释后按 JSON 解析（jsonc 结构合法性断言） */
const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))

const countEntries = (text, name) => (text.match(new RegExp(`"${name}"\\s*:\\s*\\{`, 'g')) || []).length

const backupsIn = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-grapemcp-')).sort()
const backupContents = (dir) => backupsIn(dir).map((f) => readFileSync(join(dir, f), 'utf8'))

test('未知 target：install / uninstall / doctor 均非零退出并列出受支持宿主', () => {
  for (const sub of ['install', 'uninstall', 'doctor']) {
    const h = home()
    const r = run([sub, '--target', 'nope'], h)
    assert.notEqual(r.status, 0, `${sub} --target nope 应失败`)
    const out = `${r.stderr}${r.stdout}`
    assert.match(out, /codearts/, `${sub} 报错应列出 codearts`)
    assert.match(out, /officeace/, `${sub} 报错应列出 officeace`)
    assert.match(out, /opencode/, `${sub} 报错应列出 opencode`)
  }
})

/* ---------- S2：codearts（华为云码道 CodeArts Agent） ---------- */

test('codearts 全新安装写入官方 MCP 配置，doctor 检出', () => {
  const h = home()
  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, r.stderr)

  // 官方文档：码道 CLI 全局 MCP 配置 ~/.codeartsdoer/codearts_cli.jsonc，结构 {"mcp": {"<名称>": {...}}}
  const cfgPath = join(h, '.codeartsdoer', 'codearts_cli.jsonc')
  assert.ok(existsSync(cfgPath), `应写入 ${cfgPath}`)
  const text = readFileSync(cfgPath, 'utf8')
  const cfg = parseJsonc(text)
  const entry = cfg.mcp['grape-kit']
  assert.ok(entry, 'mcp 块内应有 grape-kit 条目')
  // 字段清单必须与 README 受支持宿主表一致（type/command/args/env），否则排障对不上
  assert.deepEqual(Object.keys(entry).sort(), ['args', 'command', 'env', 'type'], `条目字段: ${Object.keys(entry)}`)
  assert.equal(entry.command, 'npx')
  assert.match(entry.args.join(' '), /@grape-dev\/grape-kit/)
  assert.match(entry.args.join(' '), /grape-kit-mcp/)

  const d = run(['doctor', '--target', 'codearts'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[ok\][^\n]*codearts/i)
})

test('codearts 二次安装幂等并生成备份，他人条目保留', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const seed = `{
  // 用户注释必须保留
  "mcp": {
    "other": {
      "command": "npx",
      "args": ["other-mcp"]
    }
  }
}
`
  writeFileSync(join(dir, 'codearts_cli.jsonc'), seed)
  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)
  const afterFirst = readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8')

  const r2 = run(['install', '--target', 'codearts'], h)
  assert.equal(r2.status, 0, r2.stderr)

  const text = readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8')
  assert.equal(countEntries(text, 'grape-kit'), 1, '重复安装不应产生重复条目')
  assert.match(text, /用户注释必须保留/)
  const cfg = parseJsonc(text)
  assert.ok(cfg.mcp.other, '他人条目必须保留')
  assert.ok(cfg.mcp['grape-kit'])

  // 两次写入各留一份备份：首次=改动前 seed，重装=重装前原文（含用户原 grape-kit 条目）
  const contents = backupContents(dir)
  assert.equal(contents.length, 2, `每次写入应生成独立备份，实际: ${backupsIn(dir).join(', ')}`)
  assert.ok(contents.includes(seed), '首次写入的备份必须是改动前原文')
  assert.ok(contents.includes(afterFirst), '重装备份必须是重装前原文（含原 grape-kit 条目）')

  const u = run(['uninstall', '--target', 'codearts'], h)
  assert.equal(u.status, 0, u.stderr)
  const afterUninstall = parseJsonc(readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8'))
  assert.equal(afterUninstall.mcp['grape-kit'], undefined)
  assert.ok(afterUninstall.mcp.other, '卸载只删 grape 条目')
})

test('codearts 条目位于 mcp 块中间：安装/卸载均产出合法 JSON 且不误删邻居', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'codearts_cli.jsonc')
  writeFileSync(cfgPath, `{
  "mcp": {
    "first": {
      "command": "npx",
      "args": ["first"]
    },
    "grape-kit": {
      "type": "local",
      "command": "npx",
      "args": ["legacy"]
    },
    "tax": {
      "command": "npx",
      "args": ["tax"]
    }
  }
}
`)
  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, r.stderr)
  // 回归 P0：中段条目摘除后逗号处理错误 → 非法 JSON / 邻居条目丢失
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ['first', 'grape-kit', 'tax'])
  assert.deepEqual(cfg.mcp.first.args, ['first'])
  assert.deepEqual(cfg.mcp.tax.args, ['tax'])

  const u = run(['uninstall', '--target', 'codearts'], h)
  assert.equal(u.status, 0, u.stderr)
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.deepEqual(Object.keys(after.mcp).sort(), ['first', 'tax'])
})

test('重装备份 = 改动前原文（含用户原有 grape-kit 条目）', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const original = `{
  "mcp": {
    "grape-kit": {
      "type": "local",
      "command": "npx",
      "args": ["legacy"]
    }
  }
}
`
  writeFileSync(join(dir, 'codearts_cli.jsonc'), original)
  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, r.stderr)
  // 回归 P0：重装路径把「已删除条目后的文本」当原文备份 → 备份无法回滚用户配置
  const contents = backupContents(dir)
  assert.equal(contents.length, 1)
  assert.equal(contents[0], original, '备份必须是改动前原文（含用户原 grape-kit 条目）')
})

test('mcp 块内嵌套同名键不算已安装：doctor 不假 ok、install 不报移除失败', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'codearts_cli.jsonc')
  writeFileSync(cfgPath, `{
  "mcp": {
    "other": {
      "command": "npx",
      "args": ["x"],
      "env": { "grape-kit": "keep-me" }
    }
  }
}
`)
  const d = run(['doctor', '--target', 'codearts'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[!!\][^\n]*codearts[^\n]*未安装/, '嵌套同名键不得被误判成已安装')

  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, `嵌套同名键不得导致「移除失败」：${r.stderr}`)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ['grape-kit', 'other'])
  assert.equal(cfg.mcp.other.env['grape-kit'], 'keep-me', '他人嵌套键必须原样保留')
})

test('mcp 块外的同名键不影响检出与写入', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'codearts_cli.jsonc')
  writeFileSync(cfgPath, `{
  "grape-kit": { "note": "block-outside" },
  "mcp": {
    "other": { "command": "npx" }
  }
}
`)
  const d = run(['doctor', '--target', 'codearts'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[!!\][^\n]*codearts[^\n]*未安装/, 'mcp 块外的同名键不得被误判成已安装')

  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ['grape-kit', 'other'])
  assert.equal(cfg['grape-kit'].note, 'block-outside', '块外同名键必须原样保留')
})

/* ---------- S4：officeace（果办OfficeAce） ---------- */

test('officeace 全新安装写可导入清单并提示手动步骤，doctor 检出', () => {
  const h = home()
  const r = run(['install', '--target', 'officeace'], h)
  assert.equal(r.status, 0, r.stderr)

  // OfficeAce 连接器仅支持 GUI 注册 → 写「自定义添加 > JSON配置」可直接粘贴的清单
  const manifest = join(h, '.officeace', 'mcp.json')
  assert.ok(existsSync(manifest), `应写入 ${manifest}`)
  const cfg = JSON.parse(readFileSync(manifest, 'utf8'))
  const entry = cfg.mcpServers['grape-kit']
  assert.ok(entry, 'mcpServers 内应有 grape-kit 连接器')
  assert.equal(entry.command, 'npx')
  assert.match(entry.args.join(' '), /grape-kit-mcp/)
  assert.match(`${r.stdout}`, /连接器/, '应提示 OfficeAce 侧的导入步骤')

  const d = run(['doctor', '--target', 'officeace'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[ok\][^\n]*officeace/i)
})

test('officeace 二次安装幂等并生成备份，他人连接器保留；卸载只删 grape 条目', () => {
  const h = home()
  const dir = join(h, '.officeace')
  mkdirSync(dir, { recursive: true })
  const manifest = join(dir, 'mcp.json')
  writeFileSync(manifest, JSON.stringify({
    mcpServers: { 'tyc-mcp': { command: 'npx', args: ['-y', 'mcp-remote'] } },
  }, null, 2))
  const seed = readFileSync(manifest, 'utf8')

  assert.equal(run(['install', '--target', 'officeace'], h).status, 0)
  const r2 = run(['install', '--target', 'officeace'], h)
  assert.equal(r2.status, 0, r2.stderr)

  const text = readFileSync(manifest, 'utf8')
  const cfg = JSON.parse(text)
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['grape-kit', 'tyc-mcp'], '不应产生重复条目且他人连接器保留')
  const contents = backupContents(dir)
  assert.equal(contents.length, 2, `每次写入应生成独立备份，实际: ${backupsIn(dir).join(', ')}`)
  assert.ok(contents.includes(seed), '首次写入的备份必须是改动前原文')

  const u = run(['uninstall', '--target', 'officeace'], h)
  assert.equal(u.status, 0, u.stderr)
  const after = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.equal(after.mcpServers['grape-kit'], undefined)
  assert.ok(after.mcpServers['tyc-mcp'], '卸载只删 grape 条目')
})

/* ---------- 回归护栏：既有 workbuddy 目标 ---------- */

test('workbuddy 安装/自检/卸载不回归', () => {
  const h = home()
  const r = run(['install', '--target', 'workbuddy'], h)
  assert.equal(r.status, 0, r.stderr)
  const mcpJson = join(h, '.workbuddy', 'mcp.json')
  assert.ok(JSON.parse(readFileSync(mcpJson, 'utf8')).mcpServers['grape-kit'])
  assert.ok(existsSync(join(h, '.workbuddy', 'skills', 'grape-remote', 'SKILL.md')))

  const d = run(['doctor', '--target', 'workbuddy'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[ok\][^\n]*workbuddy/i)

  const u = run(['uninstall', '--target', 'workbuddy'], h)
  assert.equal(u.status, 0, u.stderr)
  assert.equal(JSON.parse(readFileSync(mcpJson, 'utf8')).mcpServers['grape-kit'], undefined)
  assert.ok(!existsSync(join(h, '.workbuddy', 'skills', 'grape-remote')))
})

/* ---------- doctor 汇总（不带 --target） ---------- */

test('裸 doctor 汇总检出全部宿主：装了 codearts/officeace 均报 ok', () => {
  const h = home()
  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)
  assert.equal(run(['install', '--target', 'officeace'], h).status, 0)

  const d = run(['doctor'], h)
  assert.equal(d.status, 0, d.stderr)
  // 回归 P1：裸 doctor 只检 opencode → 已装 codearts 仍报 opencode 未安装
  assert.match(d.stdout, /\[ok\][^\n]*codearts/i)
  assert.match(d.stdout, /\[ok\][^\n]*officeace/i)
  assert.match(d.stdout, /\[!!\][^\n]*opencode[^\n]*未安装/i)
  assert.match(d.stdout, /\[!!\][^\n]*workbuddy[^\n]*未安装/i)
})

/* ---------- 备份时间戳 ---------- */

test('同一秒多次写入不覆盖备份，且各份备份内容对应当次改动前原文', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'codearts_cli.jsonc')
  writeFileSync(cfgPath, JSON.stringify({ mcp: { other: { command: 'npx' } } }, null, 2) + '\n')
  const before = readFileSync(cfgPath, 'utf8')

  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)
  const afterFirst = readFileSync(cfgPath, 'utf8')
  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)

  const contents = backupContents(dir)
  assert.equal(contents.length, 2, `同一秒内两次写入不得互相覆盖备份，实际: ${backupsIn(dir).join(', ')}`)
  assert.deepEqual(contents.sort(), [before, afterFirst].sort())
})

/* ---------- 边缘状态：未安装 / 无 mcp 块的 jsonc / 纯 JSON ---------- */

test('doctor 对未安装的新宿主给出「未安装」而非 ok', () => {
  const h = home()
  for (const t of ['codearts', 'officeace']) {
    const d = run(['doctor', '--target', t], h)
    assert.equal(d.status, 0, d.stderr)
    assert.match(d.stdout, /\[!!\][^\n]*(codearts|officeace)[^\n]*未安装/i, `${t} 未安装应报 [!!] 未安装`)
  }
})

test('codearts 纯 JSON 配置无 mcp 块时自动新建块并备份既有内容', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const seed = JSON.stringify({ telemetry: false }, null, 2)
  writeFileSync(join(dir, 'codearts_cli.jsonc'), seed)
  const r = run(['install', '--target', 'codearts'], h)
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8'))
  assert.equal(cfg.telemetry, false, '既有字段必须保留')
  assert.ok(cfg.mcp['grape-kit'])
  assert.deepEqual(backupContents(dir), [seed], '备份内容必须是改动前原文')
})

test('codearts 含注释且无 mcp 块时明确报错，不静默失败', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const seed = '{\n  // 注释\n  "telemetry": false\n}\n'
  writeFileSync(join(dir, 'codearts_cli.jsonc'), seed)
  const r = run(['install', '--target', 'codearts'], h)
  assert.notEqual(r.status, 0, '无法安全改写时应失败')
  assert.match(`${r.stderr}${r.stdout}`, /mcp|README/)
  assert.equal(readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8'), seed, '失败时不得改写用户文件')
})

/* ---------- `--target=<host>` 等号写法（与分离写法等价，不得静默回落 opencode） ---------- */

test('--target=<host> 等号写法：install/uninstall/doctor 均作用于指定宿主', () => {
  const h = home()
  // 预置 opencode 配置：等号写法若被误解析为默认 opencode，会改写/卸载它
  const ocDir = join(h, '.config', 'opencode')
  mkdirSync(ocDir, { recursive: true })
  const ocPath = join(ocDir, 'opencode.jsonc')
  const ocSeed = '{\n  "mcp": {\n    "grape": { "type": "local", "command": ["node", "x"] }\n  }\n}\n'
  writeFileSync(ocPath, ocSeed)

  const r = run(['install', '--target=codearts'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(h, '.codeartsdoer', 'codearts_cli.jsonc')), '等号写法应写 codearts 配置')
  assert.equal(readFileSync(ocPath, 'utf8'), ocSeed, '等号写法的 install 不得改动 opencode 配置')

  const d = run(['doctor', '--target=codearts'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[ok\][^\n]*codearts/i)
  assert.doesNotMatch(d.stdout, /workbuddy/, '等号写法的 doctor 应为单宿主详情，不得退化为汇总')

  const u = run(['uninstall', '--target=codearts'], h)
  assert.equal(u.status, 0, u.stderr)
  const codearts = parseJsonc(readFileSync(join(h, '.codeartsdoer', 'codearts_cli.jsonc'), 'utf8'))
  assert.equal(codearts.mcp['grape-kit'], undefined, '等号写法的 uninstall 应删除 codearts 条目')
  assert.equal(readFileSync(ocPath, 'utf8'), ocSeed, '等号写法的 uninstall 不得删除 opencode 条目')
})

test('--target=<host> 等号写法遇到未知宿主同样非零退出', () => {
  const h = home()
  for (const sub of ['install', 'uninstall', 'doctor']) {
    const r = run([`${sub}`, '--target=nope'], h)
    assert.notEqual(r.status, 0, `${sub} --target=nope 应失败`)
    assert.match(`${r.stderr}${r.stdout}`, /codearts/)
  }
})

/* ---------- workbuddy 与其它宿主共用写入保障：写前备份、写后结构校验 ---------- */

test('workbuddy 安装/卸载均留备份，卸载备份 = 卸载前原文', () => {
  const h = home()
  const dir = join(h, '.workbuddy')
  mkdirSync(dir, { recursive: true })
  const mcpJson = join(dir, 'mcp.json')
  const seed = JSON.stringify({ mcpServers: { other: { command: 'npx', args: ['other'] } } }, null, 2) + '\n'
  writeFileSync(mcpJson, seed)

  assert.equal(run(['install', '--target', 'workbuddy'], h).status, 0)
  assert.deepEqual(backupContents(dir), [seed], '安装前的备份必须是改动前原文')

  const beforeUninstall = readFileSync(mcpJson, 'utf8')
  assert.equal(run(['uninstall', '--target', 'workbuddy'], h).status, 0)
  const contents = backupContents(dir)
  assert.equal(contents.length, 2, `卸载也应留备份，实际: ${backupsIn(dir).join(', ')}`)
  assert.ok(contents.includes(beforeUninstall), '卸载前的备份必须是卸载前原文')
})

/* ---------- 中段条目重装/卸载必须保留下一条目行前的说明注释 ---------- */

test('中段条目重装/卸载保留下一条目前的用户注释', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'codearts_cli.jsonc')
  writeFileSync(cfgPath, `{
  "mcp": {
    "grape-kit": {
      "type": "local",
      "command": "npx",
      "args": ["legacy"]
    },
    // 用户为 tax 写的说明注释
    "tax": {
      "command": "npx",
      "args": ["tax"]
    }
  }
}
`)

  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)
  assert.match(readFileSync(cfgPath, 'utf8'), /用户为 tax 写的说明注释/, '重装不得删掉下一条目前的注释')

  assert.equal(run(['uninstall', '--target', 'codearts'], h).status, 0)
  const text = readFileSync(cfgPath, 'utf8')
  assert.match(text, /用户为 tax 写的说明注释/, '卸载不得删掉下一条目前的注释')
  assert.ok(parseJsonc(text).mcp.tax, '下一条目必须保留')
})

/* ---------- doctor 区分「未安装」与「配置损坏」 ---------- */

test('doctor 对损坏的宿主配置报「配置损坏」而非「未安装」', () => {
  const h = home()
  const codeartsDir = join(h, '.codeartsdoer')
  mkdirSync(codeartsDir, { recursive: true })
  writeFileSync(join(codeartsDir, 'codearts_cli.jsonc'), '{ "mcp": { broken')
  const workbuddyDir = join(h, '.workbuddy')
  mkdirSync(workbuddyDir, { recursive: true })
  writeFileSync(join(workbuddyDir, 'mcp.json'), '{ not json')

  const dc = run(['doctor', '--target', 'codearts'], h)
  assert.equal(dc.status, 0, dc.stderr)
  assert.match(dc.stdout, /\[!!\][^\n]*codearts[^\n]*(损坏|解析失败)/i, 'codearts 损坏不应报「未安装」')
  assert.doesNotMatch(dc.stdout, /codearts mcp\.grape-kit[^\n]*未安装/i)

  const dw = run(['doctor', '--target', 'workbuddy'], h)
  assert.equal(dw.status, 0, dw.stderr)
  assert.match(dw.stdout, /\[!!\][^\n]*workbuddy[^\n]*(损坏|解析失败)/i, 'workbuddy 损坏不应报「未安装」')
  assert.doesNotMatch(dw.stdout, /workbuddy mcpServers\.grape-kit[^\n]*未安装/i)
})

/* ---------- 第 4 轮：损坏配置不得静默重置；doctor 错误归因到实际文件 ---------- */

test('workbuddy 遇损坏 mcp.json 非零退出且不改写文件（不静默重置他人连接器）', () => {
  const h = home()
  const dir = join(h, '.workbuddy')
  mkdirSync(dir, { recursive: true })
  const mcpJson = join(dir, 'mcp.json')
  // 半截 JSON（解析失败）且含他人连接器 keep-me
  const broken = `{
  "mcpServers": {
    "keep-me": { "command": "npx", "args": ["keep-me"] }
  },
`
  writeFileSync(mcpJson, broken)

  const r = run(['install', '--target', 'workbuddy'], h)
  // 回归：解析失败曾静默重置为 { mcpServers: {} } → 他人连接器只剩在 .bak 里
  assert.notEqual(r.status, 0, '解析失败必须非零退出（与 officeace 对齐）')
  assert.match(`${r.stderr}${r.stdout}`, /解析失败|损坏/, '应明确告知解析失败')
  assert.match(`${r.stderr}${r.stdout}`, /修复|移走/, '应提示先修复或移走该文件')
  assert.equal(readFileSync(mcpJson, 'utf8'), broken, '解析失败时不得改写用户文件')
  assert.deepEqual(backupsIn(dir), [], '失败路径不应产生「已重置」的写入')
})

test('doctor 把解析错误归因到实际损坏的候选文件（opencode.jsonc 合法 + opencode.json 损坏）', () => {
  const h = home()
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'opencode.jsonc'), '{\n  "mcp": {\n    "other": { "type": "local", "command": ["node", "x"] }\n  }\n}\n')
  writeFileSync(join(dir, 'opencode.json'), '{ "mcp": { broken')

  const d = run(['doctor', '--target', 'opencode'], h)
  assert.equal(d.status, 0, d.stderr)
  const line = d.stdout.split('\n').find((l) => l.includes('opencode mcp.grape 条目')) || ''
  // 回归：错误归因曾写死在 cfgPath（优先的 .jsonc），指向正常文件
  assert.match(line, /损坏|解析失败/, `应报配置损坏，实际: ${line}`)
  assert.match(line, /opencode\.json）/, `损坏项应指向实际出错文件 opencode.json，实际: ${line}`)
  assert.doesNotMatch(line, /opencode\.jsonc）/, '不得把错误归因到合法的 opencode.jsonc')
})

test('opencode 纯 JSON 无 mcp 块：整体重写保留既有字段并留备份', () => {
  const h = home()
  const dir = join(h, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'opencode.json')
  const seed = JSON.stringify({ theme: 'dark' }, null, 2) + '\n'
  writeFileSync(cfgPath, seed)

  const r = run(['install', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(cfg.theme, 'dark', '既有字段必须保留')
  assert.ok(cfg.mcp.grape, '应新建 mcp.grape 条目')
  assert.deepEqual(backupContents(dir), [seed], '备份内容必须是改动前原文')
})

/* ── Issue #20：uninstall --clean-global / _npx 白名单 / 默认残留提示 ── */

function seedResidue(h) {
  const grapeHome = join(h, '.grape')
  mkdirSync(join(grapeHome, 'workers'), { recursive: true })
  writeFileSync(join(grapeHome, 'config.json'), JSON.stringify({ token: 'grape_secret_file', base_url: 'https://x.example' }))
  writeFileSync(join(grapeHome, 'workers', 'worker.json'), '{}')
  writeFileSync(join(h, '.bashrc'), 'export PATH=$PATH:/bin\nexport GRAPE_API_TOKEN=grape_secret_env\nexport GRAPE_BASE_URL=https://x.example\n')
  const npx = join(h, '.npm', '_npx')
  const own = join(npx, 'aaaaaaaa')
  mkdirSync(join(own, 'node_modules', '@grape-dev', 'grape-kit'), { recursive: true })
  writeFileSync(join(own, 'package.json'), '{}')
  const other = join(npx, 'bbbbbbbb')
  mkdirSync(join(other, 'node_modules', 'some-other'), { recursive: true })
  writeFileSync(join(other, 'package.json'), '{}')
  return { grapeHome, npx, own, other }
}

test('Issue #20 uninstall --clean-global 零残留且不影响其他 npx 缓存', () => {
  const h = home()
  const s = seedResidue(h)
  assert.equal(run(['install', '--target', 'opencode'], h).status, 0)
  const r = run(['uninstall', '--target', 'opencode', '--clean-global'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(s.grapeHome), 'GRAPE_HOME（含 config.json + worker 产物）应被整目录删除')
  const bashrc = readFileSync(join(h, '.bashrc'), 'utf8')
  assert.doesNotMatch(bashrc, /GRAPE_API_TOKEN=/, 'rc 中 GRAPE_API_TOKEN 导出行应删除')
  assert.doesNotMatch(bashrc, /GRAPE_BASE_URL=/, 'rc 中 GRAPE_BASE_URL 导出行应删除')
  assert.match(bashrc, /export PATH=/, '无关行必须保留')
  assert.ok(backupsIn(h).some((f) => f.startsWith('.bashrc.bak-grapemcp-')), 'rc 改动前应留备份')
  assert.ok(!existsSync(s.own), '含 node_modules/@grape-dev 的 _npx 条目应删除')
  assert.ok(existsSync(s.other), '其他包缓存必须保留')
})

test('Issue #20 默认 uninstall 仅提示残留与清理命令，不执行删除', () => {
  const h = home()
  const s = seedResidue(h)
  assert.equal(run(['install', '--target', 'opencode'], h).status, 0)
  const r = run(['uninstall', '--target', 'opencode'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(s.grapeHome), '默认 uninstall 不得删除 GRAPE_HOME')
  assert.match(r.stdout, /残留/)
  assert.match(r.stdout, /--clean-global/)
})

test('Issue #20 _npx 白名单：名字相似但不在 @grape-dev 下的条目不删', () => {
  const h = home()
  const npx = join(h, '.npm', '_npx')
  const fake = join(npx, 'cccccccc')
  mkdirSync(join(fake, 'node_modules', 'grape-kit'), { recursive: true })
  writeFileSync(join(fake, 'package.json'), '{}')
  const r = run(['uninstall', '--target', 'opencode', '--clean-global'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(fake), '非 @grape-dev 实体不得删除')
})

/* ── QA 复审（PR #11）P1：--clean-global 主路径不得被宿主解析短路 ── */

test('QA#P1 uninstall --clean-global 不带 --target：零宿主痕迹时也照跑全局清理（exit 0）', () => {
  const h = home()
  const s = seedResidue(h)
  // seedResidue 不建任何宿主痕迹：旧实现先走 resolveTargetAuto()，非 TTY 下 exit 1，
  // cleanGlobal 从未运行（README 与残留提示推荐的主命令不可达）
  const r = run(['uninstall', '--clean-global'], h)
  assert.equal(r.status, 0, `应 exit 0，实际:\n${r.stderr}\n${r.stdout}`)
  assert.ok(!existsSync(s.grapeHome), 'GRAPE_HOME 应被整目录删除')
  assert.ok(!existsSync(s.own), '含 node_modules/@grape-dev 的 _npx 条目应删除')
  assert.ok(existsSync(s.other), '其他包缓存必须保留')
  if (process.platform !== 'win32') {
    const bashrc = readFileSync(join(h, '.bashrc'), 'utf8')
    assert.doesNotMatch(bashrc, /GRAPE_API_TOKEN=/, 'rc 中凭据导出行应删除')
  }
})

test('QA#P1 uninstall --clean-global 不带 --target：有宿主痕迹时卸载宿主并执行全局清理', () => {
  const h = home()
  const s = seedResidue(h)
  assert.equal(run(['install', '--target', 'opencode'], h).status, 0)
  const r = run(['uninstall', '--clean-global'], h)
  assert.equal(r.status, 0, `应 exit 0，实际:\n${r.stderr}\n${r.stdout}`)
  // 宿主条目与全局痕迹都要清理
  const cfgPath = join(h, '.config', 'opencode', 'opencode.jsonc')
  assert.ok(!JSON.parse(readFileSync(cfgPath, 'utf8')).mcp?.grape, '宿主 mcp.grape 条目应被卸载')
  assert.ok(!existsSync(s.grapeHome), 'GRAPE_HOME 应被整目录删除')
  assert.ok(!existsSync(s.own), '本包 _npx 缓存应被删除')
})

/* ── QA 复审（PR #11）硬违规 2：rc 备份不得含明文凭据，残留检测必须覆盖备份 ── */

const isWin = process.platform === 'win32'

test('QA#硬违规2 --clean-global 的 rc 备份不得含明文凭据行（凭据归零不得换文件名留盘）', { skip: isWin }, () => {
  const h = home()
  seedResidue(h)
  const r = run(['uninstall', '--target', 'opencode', '--clean-global'], h)
  assert.equal(r.status, 0, r.stderr)
  // rc 改动允许留备份，但任何 .bak-grapemcp-* 里不得再出现凭据导出行
  for (const text of backupContents(h)) {
    assert.doesNotMatch(text, /GRAPE_API_TOKEN\s*=|GRAPE_BASE_URL\s*=/, `备份不得含凭据导出行，实际:\n${text}`)
  }
  assert.ok(backupsIn(h).some((f) => f.startsWith('.bashrc.bak-grapemcp-')), 'rc 改动前应留备份（不含凭据行）')
})

test('QA#硬违规2 含凭据的旧 .bak-grapemcp-* 备份：残留提示点名，--clean-global 清零后不谎报', { skip: isWin }, () => {
  const h = home()
  seedResidue(h)
  // 模拟旧版 --clean-global 留下的含凭据备份（修复前 detectResiduals 不扫它 → 「未检测到残留」谎报）
  writeFileSync(join(h, '.bashrc.bak-grapemcp-20200101000000'), 'export GRAPE_API_TOKEN=grape_stale_backup\n')
  const hint = run(['uninstall', '--target', 'opencode'], h, { GRAPE_API_TOKEN: '', GRAPE_BASE_URL: '' })
  assert.equal(hint.status, 0, hint.stderr)
  assert.match(hint.stdout, /\.bak-grapemcp-20200101000000/, '残留提示必须点名含凭据备份文件')
  const r = run(['uninstall', '--target', 'opencode', '--clean-global'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(join(h, '.bashrc.bak-grapemcp-20200101000000')), '含凭据备份应被 --clean-global 删除')
  // 清零后再次默认 uninstall：必须报告真零残留（不得因检测盲区谎报）
  const after = run(['uninstall', '--target', 'opencode'], h, { GRAPE_API_TOKEN: '', GRAPE_BASE_URL: '' })
  assert.equal(after.status, 0, after.stderr)
  assert.match(after.stdout, /未检测到[^\n]*残留/, `清理后应真零残留，实际:\n${after.stdout}`)
})
