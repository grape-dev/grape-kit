import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname

function home() {
  return mkdtempSync(join(tmpdir(), 'grape-kit-home-'))
}

function run(args, h, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    // 每个用例隔离 HOME，杜绝污染真实宿主配置；显式清掉路径逃生口
    env: {
      ...process.env,
      HOME: h,
      GRAPE_CODEARTS_CONFIG: '',
      GRAPE_OFFICEACE_MANIFEST: '',
      ...extraEnv,
    },
    timeout: 30_000,
  })
}

/** 去掉整行 // 注释后按 JSON 解析（jsonc 结构合法性断言） */
const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))

const countEntries = (text, name) => (text.match(new RegExp(`"${name}"\\s*:\\s*\\{`, 'g')) || []).length

const backupsIn = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-grapemcp-'))

test('未知 target：install / uninstall / doctor 均非零退出并列出受支持宿主', () => {
  for (const sub of ['install', 'uninstall', 'doctor']) {
    const h = home()
    const r = run([sub, '--target', 'nope'], h)
    assert.notEqual(r.status, 0, `${sub} --target nope 应失败`)
    const out = `${r.stderr}${r.stdout}`
    assert.match(out, /codearts/, `${sub} 报错应列出 codearts`)
    assert.match(out, /officeace/, `${sub} 报错应列出 officeace`)
    assert.match(out, /opencode/, `${sub} 报错应列出 opencode`)
    rmSync(h, { recursive: true, force: true })
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
  assert.equal(entry.command, 'npx')
  assert.match(entry.args.join(' '), /@grape-dev\/grape-kit/)
  assert.match(entry.args.join(' '), /grape-kit-mcp/)

  const d = run(['doctor', '--target', 'codearts'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[ok\][^\n]*codearts/i)
  rmSync(h, { recursive: true, force: true })
})

test('codearts 二次安装幂等并生成备份，他人条目保留', () => {
  const h = home()
  const dir = join(h, '.codeartsdoer')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'codearts_cli.jsonc'), `{
  // 用户注释必须保留
  "mcp": {
    "other": {
      "command": "npx",
      "args": ["other-mcp"]
    }
  }
}
`)
  assert.equal(run(['install', '--target', 'codearts'], h).status, 0)
  const r2 = run(['install', '--target', 'codearts'], h)
  assert.equal(r2.status, 0, r2.stderr)

  const text = readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8')
  assert.equal(countEntries(text, 'grape-kit'), 1, '重复安装不应产生重复条目')
  assert.match(text, /用户注释必须保留/)
  const cfg = parseJsonc(text)
  assert.ok(cfg.mcp.other, '他人条目必须保留')
  assert.ok(cfg.mcp['grape-kit'])
  assert.ok(backupsIn(dir).length >= 1, '每次写入应生成 *.bak-grapemcp-<ts> 备份')

  const u = run(['uninstall', '--target', 'codearts'], h)
  assert.equal(u.status, 0, u.stderr)
  const after = parseJsonc(readFileSync(join(dir, 'codearts_cli.jsonc'), 'utf8'))
  assert.equal(after.mcp['grape-kit'], undefined)
  assert.ok(after.mcp.other, '卸载只删 grape 条目')
  rmSync(h, { recursive: true, force: true })
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
  rmSync(h, { recursive: true, force: true })
})

test('officeace 二次安装幂等并生成备份，他人连接器保留；卸载只删 grape 条目', () => {
  const h = home()
  const dir = join(h, '.officeace')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: { 'tyc-mcp': { command: 'npx', args: ['-y', 'mcp-remote'] } },
  }, null, 2))

  assert.equal(run(['install', '--target', 'officeace'], h).status, 0)
  const r2 = run(['install', '--target', 'officeace'], h)
  assert.equal(r2.status, 0, r2.stderr)

  const text = readFileSync(join(dir, 'mcp.json'), 'utf8')
  const cfg = JSON.parse(text)
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['grape-kit', 'tyc-mcp'], '不应产生重复条目且他人连接器保留')
  assert.ok(backupsIn(dir).length >= 1, '每次写入应生成 *.bak-grapemcp-<ts> 备份')

  const u = run(['uninstall', '--target', 'officeace'], h)
  assert.equal(u.status, 0, u.stderr)
  const after = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
  assert.equal(after.mcpServers['grape-kit'], undefined)
  assert.ok(after.mcpServers['tyc-mcp'], '卸载只删 grape 条目')
  rmSync(h, { recursive: true, force: true })
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
  rmSync(h, { recursive: true, force: true })
})
