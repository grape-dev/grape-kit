import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_NAME = '@grape-dev/grape-kit'
const GIT_IDENTITY = ['-c', 'user.name=changelog-test', '-c', 'user.email=changelog-test@example.com']

/**
 * npm 已发布版本 → 发布日期（基准：`npm view @grape-dev/grape-kit time`；0.3.6 为本版待发布，发布后以 npm view time 复核）。
 * `0.0.0-stage` 是 npm staged publishing 占位包（tarball 不含 `src/`），与功能版本一并计入发布记录；
 * `0.2.3` 从未发布，不得补造。
 */
const PUBLISHED = [
  ['0.3.6', '2026-11-19'],
  ['0.3.5', '2026-11-19'],
  ['0.3.4', '2026-11-19'],
  ['0.3.3', '2026-11-18'],
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

function readme() {
  return readFileSync(join(ROOT, 'README.md'), 'utf8')
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

/** 截取指定二级标题的整节（到下一个二级标题为止），避免跨节误匹配 */
function mdSection(md, title) {
  const start = md.indexOf(`## ${title}`)
  if (start === -1) return ''
  const next = md.slice(start + 1).search(/^## /m)
  return next === -1 ? md.slice(start) : md.slice(start, start + 1 + next)
}

/** 首个版本节的起点；其前为标题 + 说明，其后为历史版本节 */
function firstSectionAt(md) {
  return md.search(/^## /m)
}

function preambleOf(md) {
  const at = firstSectionAt(md)
  return at === -1 ? md : md.slice(0, at)
}

function historyOf(md) {
  const at = firstSectionAt(md)
  return at === -1 ? '' : md.slice(at)
}

test('CHANGELOG 版本节与 npm 已发布记录完全一致（倒序，无 0.2.3）', () => {
  const all = sections(changelog())
  const published = all.filter((s) => PUBLISHED.some(([v]) => v === s.version))
  assert.deepEqual(
    published.map((s) => s.version),
    PUBLISHED.map(([v]) => v),
    '已发布版本集合与顺序应与 npm 记录一致（倒序）',
  )
  assert.equal(all[0].version, PUBLISHED[0][0], '最新发布版本节应排在首位')
  assert.ok(!all.some((s) => s.version === '0.2.3'), '0.2.3 未在 npm 发布，不得补造')
  // 非 npm 版本节只允许是尚未发布的 dev 候选版本，且必须排在全部已发布节之前
  const firstPublished = all.findIndex((s) => PUBLISHED.some(([v]) => v === s.version))
  all.forEach((s, i) => {
    if (PUBLISHED.some(([v]) => v === s.version)) return
    assert.ok(i < firstPublished, `未发布版本节 ${s.version} 应位于已发布节之前`)
    assert.match(s.version, /^0\.\d+\.\d+$/, `未发布节版本号应形如 0.x.y：${s.version}`)
  })
})

test('已发布的 0.3.3 不得标为「尚未发布」，并说明 npm 一致口径自下一版生效', () => {
  const md = changelog()
  assert.ok(!/尚未发布到/.test(md), '0.3.3 已于 2026-11-18 发布，不得再写「尚未发布到 npm」')
  assert.match(md, /npm 已发布版本不可回写/, '应说明 npm 已发布版本不可回写')
  assert.match(md, /自下一版发布起生效/, '应说明「npm 页面与仓内一致」自下一版发布起生效')
})

test('CHANGELOG 说明 0.2.3 从未发布', () => {
  assert.match(changelog(), /0\.2\.3 从未在 npm 发布/, '应在 0.2.4 节处说明 0.2.3 从未发布')
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

test('README 版本历史节链接 CHANGELOG.md、含 0.3.3/0.3.5/0.3.6 行且计数与 npm 发布记录一致', () => {
  const md = readme()
  const section = mdSection(md, '版本历史') || mdSection(md, 'Version history')
  assert.ok(section, 'README 应保留版本历史节（英文版为 Version history）')
  assert.match(section, /\[[^\]]*CHANGELOG[^\]]*\]\(\.?\/?CHANGELOG\.md\)/, '版本历史节应含指向 CHANGELOG.md 的相对链接')

  const row036 = section.split('\n').find((l) => /^\| 0\.3\.6 \|/.test(l))
  assert.ok(row036, '版本历史表应含 0.3.6 行')
  assert.match(row036, /\| 2026-11-19 \|/, '0.3.6 日期应为 npm 发布日 2026-11-19')

  const row035 = section.split('\n').find((l) => /^\| 0\.3\.5 \|/.test(l))
  assert.ok(row035, '版本历史表应含 0.3.5 行')
  assert.match(row035, /\| 2026-11-19 \|/, '0.3.5 日期应为 npm 发布日 2026-11-19')

  const row032 = section.split('\n').find((l) => /^\| 0\.3\.2 \|/.test(l))
  assert.ok(row032, '版本历史表应保留 0.3.2 行')
  assert.match(row032, /\| 2026-11-17 \|/, '0.3.2 日期应为 npm 发布日 2026-11-17（README 旧值 2026-11-14 是 commit 日）')

  const row033 = section.split('\n').find((l) => /^\| 0\.3\.3 \|/.test(l))
  assert.ok(row033, '版本历史表应含 0.3.3 行')
  assert.match(row033, /\| 2026-11-18 \|/, '0.3.3 日期应为 npm 发布日 2026-11-18')

  assert.match(section, /16 条发布记录/, '发布记录计数应为 16（含 0.0.0-stage 占位包）')
  assert.ok(!/12 个已发布版本|12 条发布记录/.test(section), '不得再写「12 个已发布版本」')
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
    spawnSync('git', [...GIT_IDENTITY, ...args], { cwd: dir, encoding: 'utf8' })
  copyFileSync(join(ROOT, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, version }, null, 2))
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

test('gen-changelog 把新版本节插在标题与说明之后，历史节逐字保留', () => {
  const dir = tempRepo('0.3.7')
  try {
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
    const after = runGenerator(dir, 'HEAD~1')
    assert.equal(preambleOf(after), preambleOf(before), '标题与说明应保持原位（新节不得压到标题之上）')
    assert.match(historyOf(after), /^## 0\.3\.7 \(\d{4}-\d{2}-\d{2}\)/, '新版本节应为首个版本节')
    assert.ok(after.endsWith(historyOf(before)), '历史版本节应逐字保留')
    assert.match(after, /^# Changelog$/m, '文件仍应以 Keep a Changelog 标题开头')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一版本重跑生成器不产生重复节，且不改动已定稿内容', () => {
  const dir = tempRepo('0.3.2')
  try {
    const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')
    const after = runGenerator(dir, 'HEAD~1')
    assert.equal(after.match(/^## 0\.3\.2 /gm).length, 1, '同一版本不应出现两个节')
    assert.equal(after, before, '该版本节已存在时应跳过写入（历史节不改动）')
    assert.match(after, /^# Changelog$/m, '标题仍在文件首行')
    for (const [v, d] of PUBLISHED) {
      assert.ok(after.includes(`## ${v} (${d})`), `原有版本节 ${v} (${d}) 不应丢失`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})