import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SETUP = new URL('../setup.mjs', import.meta.url).pathname

function home() {
  return mkdtempSync(join(tmpdir(), 'grape-mcp-home-'))
}

function run(args, h) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: h },
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
  rmSync(h, { recursive: true, force: true })
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
  rmSync(h, { recursive: true, force: true })
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
  rmSync(h, { recursive: true, force: true })
})

test('doctor 在干净 HOME 下逐项报告', () => {
  const h = home()
  const r = run(['doctor'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /node >= 20/)
  assert.match(r.stdout, /GRAPE_BASE_URL/)
  rmSync(h, { recursive: true, force: true })
})
