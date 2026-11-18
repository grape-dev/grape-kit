/** CHANGELOG 生成器（2026-11-18 优化点 2）
 *
 * 发版时从 git log 生成 CHANGELOG.md，供 npm/ClawHub --changelog 消费：
 *   node scripts/gen-changelog.mjs <prev_tag_or_ref> [head]
 * 输出：标准 Keep a Changelog 风格片段（Added/Changed/Fixed 归类）到 stdout + 写入 CHANGELOG.md。
 * 分类规则：feat→Added、fix→Fixed、其余（chore/docs/refactor/perf/test）→Changed/Internal。
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

const out = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf-8') : ''
if (out.startsWith(`## ${pkg.version}`)) {
  writeFileSync('CHANGELOG.md', md + out.slice(md.length))
} else {
  writeFileSync('CHANGELOG.md', md + '\n' + out)
  console.log('CHANGELOG.md 头部插入完成')
}
process.stdout.write(md)
