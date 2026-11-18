import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
