import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── Issue #17：安装后能力引导 + intro 子命令 + 凭据前置指引 ── */

const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname
const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-intro-'))
  homes.push(h)
  return h
}
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })

function run(args, h, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: h,
      GRAPE_BASE_URL: '',
      GRAPE_API_TOKEN: '',
      GRAPE_AUTH_FILE: '',
      GRAPE_KIT_SKIP_UPDATE_CHECK: '1',
      ...extraEnv,
    },
    timeout: 30_000,
  })
}

const menuOf = (out) => {
  const i = out.indexOf('能力地图')
  assert.ok(i >= 0, `输出应包含能力菜单：\n${out}`)
  return out.slice(i).trimEnd()
}
const groups = (menu) => menu.split('\n').filter((l) => /^\s*▸/.test(l))

test('intro 无凭据：首行给获取 API Key 地址 + 3-5 组能力（每组一条示例问句）', () => {
  const h = home()
  const r = run(['intro'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /app\/#account\/profile/, '无凭据必须先给 Key 获取地址')
  const menu = menuOf(r.stdout)
  const gs = groups(menu)
  assert.ok(gs.length >= 3 && gs.length <= 5, `能力分组应为 3-5 组，实际 ${gs.length}`)
  for (const line of gs) {
    assert.match(line, /—|：/, '每组应有能力说明')
  }
  const examples = menu.split('\n').filter((l) => /例：「.+」/.test(l))
  assert.equal(examples.length, gs.length, '每组必须且只需 1 条可复制示例问句')
})

for (const target of ['opencode', 'workbuddy', 'codearts']) {
  test(`安装结束（${target}）打印能力菜单，与 intro 文案一致`, () => {
    const h = home()
    const inst = run(['install', '--target', target], h)
    assert.equal(inst.status, 0, inst.stderr)
    const intro = run(['intro'], h)
    assert.equal(intro.status, 0, intro.stderr)
    assert.equal(menuOf(inst.stdout), menuOf(intro.stdout), '安装结束与 intro 必须共享同一份能力清单')
    assert.match(inst.stdout, /app\/#account\/profile/, '无凭据安装时即给 Key 指引，避免调用时 401')
  })
}

test('WorkBuddy 安装提示不再要求「手动信任一次」，改为实测准确说明', () => {
  const h = home()
  const r = run(['install', '--target', 'workbuddy'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /需在 WorkBuddy 中手动「信任」一次/)
  assert.match(r.stdout, /重启.*宿主会话|重启.*WorkBuddy/, '应给出实测准确的生效方式')
})

test('用法行把 intro 与 --target 拆开：intro 不接收 --target（避免用户以为能指定宿主）', () => {
  const h = home()
  const r = run(['--help'], h)
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.split('\n')
  const usageOf = (re) => lines.find((l) => re.test(l))
  assert.ok(usageOf(/install\|uninstall\|doctor/), '用法行应列出 install|uninstall|doctor')
  assert.match(usageOf(/install\|uninstall\|doctor/), /--target/, 'install/uninstall/doctor 必须给出 --target')
  const introLine = usageOf(/\bintro\b/)
  assert.ok(introLine, '用法行必须单独列出 intro')
  assert.doesNotMatch(introLine, /--target/, 'intro 会静默忽略 --target，不得与 --target 并列在同一行')
})
