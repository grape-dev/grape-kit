import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* Issue #21 · dsh（DeepSeek Harness）目标：MCP stdio 托管 patch 模式。
 * Seam = CLI 公开入口 `install|uninstall|doctor --target dsh`；断言宿主侧可观测结果
 * （cordis.patch.yml 字节、skill 目录、doctor 输出、退出码），不测私有文本操作。 */
const SETUP = new URL('../grape-kit.mjs', import.meta.url).pathname

const homes = []
function home() {
  const h = mkdtempSync(join(tmpdir(), 'grape-kit-dsh-'))
  homes.push(h)
  return h
}
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** 依赖安装走 best-effort：用例注入必失败的 node 调用，避免访问网络（默认路径是 npx） */
function run(args, h, extraEnv = {}) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    encoding: 'utf8',
    cwd: h,
    env: {
      ...process.env,
      HOME: h,
      DSH_HOME: '',
      GRAPE_DSH_PATCH: '',
      GRAPE_DSH_DEP_CMD: process.execPath,
      GRAPE_CODEARTS_CONFIG: '',
      GRAPE_OFFICEACE_MANIFEST: '',
      ...extraEnv,
    },
    timeout: 30_000,
  })
}

const patchPath = (h) => join(h, '.dsh', 'profiles', 'web', 'cordis.patch.yml')
const skillPath = (h) => join(h, '.dsh', 'skills', 'grape-remote', 'SKILL.md')
const backupsIn = (dir) => readdirSync(dir).filter((f) => f.includes('.bak-grapemcp-')).sort()
const backupContents = (dir) => backupsIn(dir).map((f) => readFileSync(join(dir, f), 'utf8'))

/** 预置「用户已写的 patch 行」：install/uninstall 都必须逐字节保留 */
const USER_PATCH = `# 用户自建 patch：勿动
- insert:
    - id: my-own-plugin
      name: '@example/some-plugin'
      config:
        transport: stdio
`

function seedDsh(h) {
  const dir = join(h, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), USER_PATCH)
}

/* ---------- S1：install 写入托管块，用户行保留 + 写前备份 ---------- */

test('dsh 安装写入 MCP stdio 托管块，用户 patch 行逐字节保留并生成备份', () => {
  const h = home()
  seedDsh(h)
  const r = run(['install', '--target', 'dsh'], h)
  assert.equal(r.status, 0, r.stderr)

  const text = readFileSync(patchPath(h), 'utf8')
  assert.equal(text.slice(0, USER_PATCH.length), USER_PATCH, '用户既有 patch 行必须逐字节保留（只追加托管块）')
  assert.match(text, /# Grape Kit DSH integration start/)
  assert.match(text, /# Grape Kit DSH integration end/)
  assert.match(text, /- id: grape-kit/)
  assert.match(text, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(text, /transport: stdio/)
  assert.match(text, /command: node/, '本地 MCP 入口优先：command 应为 node')
  assert.match(text, /grape-kit-mcp\.mjs/, 'args 应指向 MCP 入口脚本')
  assert.match(text, /failOnStartupError: false/)

  const dir = join(h, '.dsh', 'profiles', 'web')
  assert.deepEqual(backupContents(dir), [USER_PATCH], '写前备份必须是改动前原文')
})

test('dsh 无 patch 文件时新建目录与文件，MCP 入口缺失时回退 npx 启动', () => {
  const h = home()
  const r = run(['install', '--target', 'dsh', '--script', join(h, 'missing-mcp.mjs')], h)
  assert.equal(r.status, 0, r.stderr)
  const text = readFileSync(patchPath(h), 'utf8')
  assert.match(text, /command: npx/, '脚本解析不到时回退 npx')
  assert.match(text, /@grape-dev\/grape-kit/, 'npx 回退应指向本包')
  assert.equal(backupsIn(join(h, '.dsh', 'profiles', 'web')).length, 0, '新建文件无需备份')
})

/* ---------- S2：幂等 + skill 落位 ---------- */

test('dsh 重复安装幂等（patch 逐字节不变、托管块唯一），skill 副本落位', () => {
  const h = home()
  seedDsh(h)
  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  const first = readFileSync(patchPath(h), 'utf8')
  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  const second = readFileSync(patchPath(h), 'utf8')

  assert.equal(second, first, '重复安装不得漂移托管块内容')
  assert.equal((second.match(/- id: grape-kit/g) || []).length, 1, '托管块不得重复')
  assert.ok(existsSync(skillPath(h)), 'grape-remote skill 应落到 $DSH_HOME/skills')
  assert.equal(backupContents(join(h, '.dsh', 'profiles', 'web')).length, 2, '每次写入各留一份备份')
})

/* ---------- S3：uninstall 只删托管块 ---------- */

test('dsh 卸载只删托管块，其余与原文逐字节相等；可重入并清理 skill 副本', () => {
  const h = home()
  seedDsh(h)
  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  const u = run(['uninstall', '--target', 'dsh'], h)
  assert.equal(u.status, 0, u.stderr)
  assert.equal(readFileSync(patchPath(h), 'utf8'), USER_PATCH, '卸载后 patch 必须回到用户原文')
  assert.ok(!existsSync(join(h, '.dsh', 'skills', 'grape-remote')), 'skill 副本应被移除')

  const again = run(['uninstall', '--target', 'dsh'], h)
  assert.equal(again.status, 0, `二次卸载应幂等：${again.stderr}`)
  assert.equal(readFileSync(patchPath(h), 'utf8'), USER_PATCH)
})

/* ---------- S4：doctor 三项检查 ---------- */

test('dsh doctor 未安装时三项均为 [!!]，装后 patch/skill [ok]、缺依赖仍 [!!]', () => {
  const h = home()
  const before = run(['doctor', '--target', 'dsh'], h)
  assert.equal(before.status, 0, before.stderr)
  assert.match(before.stdout, /\[!!\][^\n]*dsh 托管块[^\n]*未安装/)
  assert.match(before.stdout, /\[!!\][^\n]*dsh skill 副本[^\n]*未安装/)
  assert.match(before.stdout, /\[!!\][^\n]*dsh-mcp-client 依赖[^\n]*未安装/)

  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  const afterInstall = run(['doctor', '--target', 'dsh'], h)
  assert.equal(afterInstall.status, 0, afterInstall.stderr)
  assert.match(afterInstall.stdout, /\[ok\][^\n]*dsh 托管块/)
  assert.match(afterInstall.stdout, /\[ok\][^\n]*dsh skill 副本/)
  assert.match(afterInstall.stdout, /\[!!\][^\n]*dsh-mcp-client 依赖/, '依赖未装时该行必须准确报 [!!]')

  // 依赖已声明（profile 侧 package.json）→ 第三项转 ok
  writeFileSync(join(h, '.dsh', 'profiles', 'web', 'package.json'), JSON.stringify({
    name: 'dsh-web-profile',
    dependencies: { '@deepseek-ai/dsh-mcp-client': '^1.0.0' },
  }, null, 2))
  const withDep = run(['doctor', '--target', 'dsh'], h)
  assert.equal(withDep.status, 0, withDep.stderr)
  assert.match(withDep.stdout, /\[ok\][^\n]*dsh-mcp-client 依赖/)
})

test('dsh doctor 对不完整托管块报配置损坏而非 ok', () => {
  const h = home()
  const dir = join(h, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), '# Grape Kit DSH integration start\n- insert: [\n')
  const d = run(['doctor', '--target', 'dsh'], h)
  assert.equal(d.status, 0, d.stderr)
  assert.match(d.stdout, /\[!!\][^\n]*dsh 托管块[^\n]*(不完整|损坏)/)
})

/* ---------- S5：检测与分发（零宿主 / all / 未知 target / help） ---------- */

test('仅 ~/.dsh 痕迹时无 --target 的 install 自动命中 dsh', () => {
  const h = home()
  mkdirSync(join(h, '.dsh'), { recursive: true })
  const r = run(['install'], h)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(patchPath(h)), '检测到 dsh 痕迹应直接装配该宿主')
})

test('未知 target 报错列出 dsh；help 用法与宿主清单含 dsh；--target all 覆盖 dsh', () => {
  const h = home()
  const bad = run(['install', '--target', 'nope'], h)
  assert.notEqual(bad.status, 0)
  assert.match(`${bad.stderr}${bad.stdout}`, /dsh/, '未知 target 报错应列出 dsh')

  const help = run(['help'], h)
  assert.match(help.stdout, /用法: node setup\.mjs install\|uninstall\|doctor \[--target [^\]]+\] \[--probe\]/)
  for (const t of ['opencode', 'workbuddy', 'codearts', 'officeace', 'dsh', 'codex', 'openclaw', 'hermes', 'atomcode', 'trae']) assert.match(help.stdout, new RegExp(`--target ${t}`), `help 宿主清单应含 ${t}`)

  const all = run(['install', '--target', 'all'], h)
  assert.equal(all.status, 0, all.stderr)
  assert.match(all.stdout, /===== dsh =====/)
  assert.ok(existsSync(patchPath(h)), '--target all 应覆盖 dsh')
})

/* ---------- S6：依赖安装失败不阻塞 ---------- */

test('dsh-mcp-client 安装失败仍退出 0，托管块已写入并给出指引', () => {
  const h = home()
  const r = run(['install', '--target', 'dsh'], h)
  assert.equal(r.status, 0, `依赖失败不得阻塞安装：${r.stderr}`)
  assert.ok(existsSync(patchPath(h)))
  assert.match(r.stdout, /@deepseek-ai\/dsh-mcp-client/, '应给出依赖名')
  assert.match(r.stdout, /corepack enable pnpm|plugin --profile web add/, '应给出可执行安装指引')
})

/* ---------- QA 复审（PR #12）：S1 无尾换行还原 / S2 不完整块拒写 / S3 映射形状拒写 / S4 新建文件无残留 ---------- */

test('dsh 无尾换行原文：install→uninstall 逐字节还原，不残留补的分隔换行', () => {
  const h = home()
  const dir = join(h, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const noEol = USER_PATCH.replace(/\n$/, '')
  writeFileSync(join(dir, 'cordis.patch.yml'), noEol)

  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  assert.match(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), /- id: grape-kit/, '托管块应已写入')
  const u = run(['uninstall', '--target', 'dsh'], h)
  assert.equal(u.status, 0, u.stderr)
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), noEol, '无尾换行原文必须逐字节还原（不得多出 1 字节）')
})

test('dsh 不完整托管块（有 start 缺 end）：install 拒绝写入，不删除其后的用户 patch 行', () => {
  const h = home()
  const dir = join(h, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const broken = `${USER_PATCH}# Grape Kit DSH integration start\n- insert:\n    - id: mine\n`
  writeFileSync(join(dir, 'cordis.patch.yml'), broken)

  const r = run(['install', '--target', 'dsh'], h)
  assert.notEqual(r.status, 0, '不完整块必须拒绝写入并给出非零退出')
  assert.match(`${r.stdout}${r.stderr}`, /不完整|修复指引|integration end/, '应给出修复指引')
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), broken, '拒绝写入时不得改动用户 patch 行')
})

test('dsh 顶层映射形状 patch：install 拒绝写入，避免追加序列项破坏 YAML', () => {
  const h = home()
  const dir = join(h, '.dsh', 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const mapping = '# 用户映射形状 patch\nplugins:\n  foo:\n    enabled: true\n'
  writeFileSync(join(dir, 'cordis.patch.yml'), mapping)

  const r = run(['install', '--target', 'dsh'], h)
  assert.notEqual(r.status, 0, '映射形状必须拒绝写入并给出非零退出')
  assert.match(`${r.stdout}${r.stderr}`, /顶层不是 YAML 序列|序列文件/, '应说明形状不合法与修复方式')
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), mapping, '拒绝写入时保持原文')

  const d = run(['doctor', '--target', 'dsh'], h)
  assert.doesNotMatch(d.stdout, /\[ok\][^\n]*dsh 托管块/, '未写入托管块时 doctor 不得报 ok')
})

test('dsh 新建文件卸载后不残留空 patch 与仅含托管块的备份', () => {
  const h = home()
  assert.equal(run(['install', '--target', 'dsh'], h).status, 0)
  assert.ok(existsSync(patchPath(h)))

  const u = run(['uninstall', '--target', 'dsh'], h)
  assert.equal(u.status, 0, u.stderr)
  assert.ok(!existsSync(patchPath(h)), '仅剩托管块的文件应在卸载后删除（不留 0 字节 patch）')
  assert.deepEqual(backupsIn(join(h, '.dsh', 'profiles', 'web')), [], '不得残留仅含托管块的备份')
})
