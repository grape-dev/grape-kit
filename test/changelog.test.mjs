import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * npm 已发布版本 → 发布日期（基准：`npm view @grape-dev/grape-kit time`，2026-11-18 核对）。
 * 0.2.3 从未发布，不得补造；同日内 9 个版本发布日均为 2026-11-08。
 */
const PUBLISHED = [
  ['0.3.2', '2026-11-17'],
  ['0.3.1', '2026-11-11'],
  ['0.3.0', '2026-11-11'],
  ['0.2.4', '2026-11-08'],
  ['0.2.2', '2026-11-08'],
  ['0.2.1', '2026-11-08'],
  ['0.2.0', '2026-11-08'],
  ['0.1.3', '2026-11-08'],
  ['0.1.2', '2026-11-08'],
  ['0.1.1', '2026-11-08'],
  ['0.1.0', '2026-11-08'],
  ['0.0.0-stage', '2026-11-08'],
]

function changelog() {
  const p = join(ROOT, 'CHANGELOG.md')
  assert.ok(existsSync(p), 'CHANGELOG.md 应存在于仓库根目录')
  return readFileSync(p, 'utf8')
}

/** 解析版本节：只认 `## <version> (<YYYY-MM-DD>)` 形式的节头，其余二级标题不算版本节 */
function sections(md) {
  const out = []
  let cur = null
  for (const line of md.split('\n')) {
    const m = /^## (\S+) \((\d{4}-\d{2}-\d{2})\)$/.exec(line)
    if (m) {
      cur = { version: m[1], date: m[2], lines: [] }
      out.push(cur)
      continue
    }
    if (cur) cur.lines.push(line)
  }
  return out.map((s) => ({ version: s.version, date: s.date, body: s.lines.join('\n') }))
}

test('CHANGELOG 版本节与 npm 已发布版本完全一致（12 个，倒序，无 0.2.3）', () => {
  const all = sections(changelog())
  const published = all.filter((s) => PUBLISHED.some(([v]) => v === s.version))
  assert.deepEqual(
    published.map((s) => s.version),
    PUBLISHED.map(([v]) => v),
    '已发布版本集合与顺序应与 npm 记录一致（倒序）',
  )
  assert.ok(!all.some((s) => s.version === '0.2.3'), '0.2.3 未在 npm 发布，不得补造')
  // 非 npm 版本节只允许是尚未发布的 dev 版本（如 0.3.3），且必须排在全部已发布节之前
  const firstPublished = all.findIndex((s) => PUBLISHED.some(([v]) => v === s.version))
  all.forEach((s, i) => {
    if (PUBLISHED.some(([v]) => v === s.version)) return
    assert.ok(i < firstPublished, `未发布版本节 ${s.version} 应位于已发布节之前`)
    assert.match(s.version, /^0\.\d+\.\d+$/, `未发布节版本号应形如 0.x.y：${s.version}`)
  })
})

test('每个版本节含发布日期与至少一条 Added/Changed/Fixed 条目', () => {
  const all = sections(changelog())
  assert.ok(all.length >= PUBLISHED.length, '版本节数量不应少于 npm 已发布版本数')
  for (const s of all) {
    const expected = PUBLISHED.find(([v]) => v === s.version)
    if (expected) assert.equal(s.date, expected[1], `${s.version} 发布日期应与 npm 发布时间一致`)
    else assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/, `${s.version} 缺少 YYYY-MM-DD 发布日期`)
    assert.match(s.body, /^### (Added|Changed|Fixed)$/m, `${s.version} 缺少 Added/Changed/Fixed 分类`)
    const items = s.body.split('\n').filter((l) => /^- \S/.test(l))
    assert.ok(items.length >= 1, `${s.version} 应至少有一条变更条目`)
  }
})

test('README 版本历史节链接 CHANGELOG.md 且 0.3.2 日期为 npm 发布日 2026-11-17', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /^## 版本历史$/m, 'README 应保留版本历史节')
  assert.match(readme, /\[[^\]]*CHANGELOG[^\]]*\]\(\.?\/?CHANGELOG\.md\)/, '版本历史节应含指向 CHANGELOG.md 的相对链接')
  const row = readme.split('\n').find((l) => /^\| 0\.3\.2 \|/.test(l))
  assert.ok(row, '版本历史表应保留 0.3.2 行')
  assert.match(row, /\| 2026-11-17 \|/, '0.3.2 日期应为 npm 发布日 2026-11-17（README 旧值 2026-11-14 是 commit 日）')
})

test('package.json files 含 CHANGELOG.md（随 npm tarball 发布）', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files), 'package.json 应有 files 白名单')
  assert.ok(pkg.files.includes('CHANGELOG.md'), 'files 应含 CHANGELOG.md，否则即使提交也不进 npm tarball')
})

/** 造一个「上一次发版后又有新提交」的临时仓库：CHANGELOG.md 为仓内正式文件，package.json 版本可指定 */
function tempRepo(version) {
  const dir = mkdtempSync(join(tmpdir(), 'grape-kit-changelog-'))
  const git = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' })
  copyFileSync(join(ROOT, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@grape-dev/grape-kit', version }, null, 2))
  assert.equal(git('init', '-q').status, 0)
  git('add', '-A')
  assert.equal(git('commit', '-q', '-m', 'chore: init').status, 0)
  writeFileSync(join(dir, 'next.txt'), 'x')
  git('add', '-A')
  assert.equal(git('commit', '-q', '-m', 'feat: 下一版本功能').status, 0)
  return dir
}

function runGenerator(dir, prev) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gen-changelog.mjs'), prev, 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  return readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
}

test('gen-changelog 可在文件头插入新版本节且不改动历史节', () => {
  const dir = tempRepo('0.3.4')
  const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  const after = runGenerator(dir, 'HEAD~1')
  assert.match(after, /^## 0\.3\.4 \(\d{4}-\d{2}-\d{2}\)/, '新版本节应插入文件头')
  assert.equal(after.match(/^## 0\.3\.4 \(/gm).length, 1, '同一版本不应出现两个节')
  assert.ok(after.endsWith(before), '历史版本节应逐字保留（原文件内容为新文件后缀）')
  rmSync(dir, { recursive: true, force: true })
})

test('以当前 package 版本重跑生成器（AC 字面命令）不破坏历史节', () => {
  const dir = tempRepo('0.3.2')
  const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
  const after = runGenerator(dir, 'HEAD~1')
  assert.ok(after.endsWith(before), '历史节应逐字保留，不被按字节切片截断')
  assert.match(after, /^## 0\.3\.2 \(/, '新节仍应落在文件头')
  for (const [v, d] of PUBLISHED) {
    assert.ok(after.includes(`## ${v} (${d})`), `原有版本节 ${v} (${d}) 不应丢失`)
  }
  rmSync(dir, { recursive: true, force: true })
})
