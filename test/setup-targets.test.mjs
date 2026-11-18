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
