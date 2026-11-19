/** CHANGELOG 生成器（2026-11-18 优化点 2）
 *
 * 发版时从 git log 生成 CHANGELOG.md，供 npm/ClawHub --changelog 消费：
 *   node scripts/gen-changelog.mjs <prev_tag_or_ref> [head]
 * 输出：标准 Keep a Changelog 风格片段（Added/Changed/Fixed 归类）到 stdout + 写入 CHANGELOG.md。
 * 分类规则：feat→Added、fix→Fixed、其余（chore/docs/refactor/perf/test）→Changed/Internal。
 * 插入位置：标题与说明（首个 `## ` 版本节之前的全部内容）之后、历史版本节之前；
 * 若该版本节已存在则跳过写入（不覆盖已定稿内容、不产生重复节）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

const prev = process.argv[2]
const head = process.argv[3] || 'HEAD'
if (!prev) {
  console.error('用法: node scripts/gen-changelog.mjs <prev_tag_or_ref> [head]')
  process.exit(2)
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim()
}

const log = git('log', '--no-decorate', '--pretty=format:%s|||%an', `${prev}..${head}`)
const commits = log ? log.split('\n').map(l => {
  const [subject, author] = l.split('|||')
  return { subject: subject || '', author: author || '' }
}) : []

const buckets = { Added: [], Changed: [], Fixed: [] }
for (const c of commits) {
  const s = c.subject
  if (/^feat(\(.+\))?!?:/i.test(s)) buckets.Added.push(s)
  else if (/^fix(\(.+\))?!?:/i.test(s)) buckets.Fixed.push(s)
  else buckets.Changed.push(s)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))
const date = new Date().toISOString().slice(0, 10)
let md = `## ${pkg.version} (${date})\n\n`
for (const [k, items] of Object.entries(buckets)) {
  if (!items.length) continue
  md += `### ${k}\n\n`
  for (const it of items) md += `- ${it}\n`
  md += '\n'
}
md = md.replace(/\n+$/, '\n')

const version = String(pkg.version)
const sectionRe = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm')
const out = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf-8') : ''

if (sectionRe.test(out)) {
  // 该版本节已存在：不覆盖已定稿内容，也不产生重复节
  console.error(`CHANGELOG.md 已存在 ${version} 版本节，跳过写入（历史节不改动）`)
} else {
  // 标题 + 说明保持原位，新节插在其后、历史版本节之前
  const first = out.search(/^## /m)
  const preamble = first === -1 ? out : out.slice(0, first)
  const history = first === -1 ? '' : out.slice(first)
  const headMd = preamble ? preamble.replace(/\n+$/, '') + '\n\n' : ''
  const tailMd = history ? '\n' + history : ''
  writeFileSync('CHANGELOG.md', headMd + md + tailMd)
  console.log(`CHANGELOG.md 已写入 ${version} 版本节`)
}
process.stdout.write(md)