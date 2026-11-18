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
  const got = sections(changelog()).map((s) => s.version)
  assert.deepEqual(got, PUBLISHED.map(([v]) => v), '版本集合与顺序应与 npm 发布记录一致（倒序）')
  assert.ok(!got.includes('0.2.3'), '0.2.3 未在 npm 发布，不得补造')
})

test('每个版本节含 npm 发布日与至少一条 Added/Changed/Fixed 条目', () => {
  const got = sections(changelog())
  assert.equal(got.length, PUBLISHED.length)
  for (const s of got) {
    const expected = PUBLISHED.find(([v]) => v === s.version)
    assert.equal(s.date, expected[1], `${s.version} 发布日期应与 npm 发布时间一致`)
    assert.match(s.body, /^### (Added|Changed|Fixed)$/m, `${s.version} 缺少 Added/Changed/Fixed 分类`)
    const items = s.body.split('\n').filter((l) => /^- \S/.test(l))
    assert.ok(items.length >= 1, `${s.version} 应至少有一条变更条目`)
  }
})
