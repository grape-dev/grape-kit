#!/usr/bin/env node
/**
 * v0.2.x 新增工具的系统性 live 扫描（真实服务端）。
 * 覆盖：roadmap / cancel+resume（在自有测试载体上）/ repos×4 / skills×3 / knowledge×2 / templates / worker_onboard（只生成命令不执行）。
 * 用法：GRAPE_BASE_URL=... GRAPE_API_TOKEN=... node scripts/sweep-0.2.mjs [owner/repo] [issue_number]
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [ownerRepo, issueNumber] = process.argv.slice(2)
if (!ownerRepo || !issueNumber) {
  console.error('用法: GRAPE_BASE_URL=... GRAPE_API_TOKEN=... node scripts/sweep-0.2.mjs <owner/repo> <issue_number>')
  console.error('注意: 请在自有测试载体（如一次性 eval 仓库）上运行，cancel/resume 会变更 issue 状态。')
  process.exit(1)
}
const [owner, repo] = ownerRepo.split('/')
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'grape-kit-mcp.mjs')

const proc = spawn(process.execPath, [SERVER], { env: process.env })
let buf = ''
const pending = new Map()
let nextId = 1
proc.stdout.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

function call(name, args = {}, timeoutMs = 90_000) {
  const id = nextId++
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`超时: ${name}`)) }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(t)
      if (msg.error) rej(new Error(JSON.stringify(msg.error).slice(0, 200)))
      else res({ isError: !!msg.result.isError, text: msg.result.content?.[0]?.text ?? '' })
    })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
}

const results = []
async function probe(label, name, args, expect) {
  try {
    const { isError, text } = await call(name, args)
    const ok = expect ? expect(text, isError) : !isError
    results.push([label, ok ? 'PASS' : 'FAIL', (isError ? 'isError: ' : '') + text.replace(/\n/g, ' ').slice(0, 90)])
    return { text, isError }
  } catch (e) {
    results.push([label, 'FAIL', e.message])
    return { text: '', isError: true }
  }
}

// 1 tools/list 数量
const listId = nextId++
const listCount = await new Promise((res) => {
  pending.set(listId, (msg) => res(msg.result.tools.length))
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: listId, method: 'tools/list' }) + '\n')
})
results.push(['tools/list 数量', listCount === 39 ? 'PASS' : 'FAIL', `${listCount} tools`])
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

// 2 只读组
await probe('roadmap', 'grape_get_pipeline_roadmap', { owner, repo })
await probe('repos.managed', 'grape_list_managed_repos', {})
await probe('repos.member', 'grape_list_repos_member', {})
await probe('repos.project_info', 'grape_get_repo_project_info', { owner, repo_name: repo })
const sk = await probe('skills.list', 'grape_list_skills', {})
await probe('skills.search', 'grape_search_skills', { q: 'grape' })
const kn = await probe('knowledge.list', 'grape_list_knowledge', { repo: `${owner}/${repo}` })
await probe('templates.list', 'grape_list_project_templates', {})

// 链式 detail（从 list 提取 id）
const skFirst = sk.text.match(/^\|\s*(\S+)\s*\|/m)
if (skFirst) await probe('skills.detail', 'grape_get_skill_detail', { skill_id: skFirst[1] })
else results.push(['skills.detail', 'SKIP', '列表为空'])
const knFirst = kn.text.match(/^\|\s*(\S+)\s*\|/m)
if (knFirst) await probe('knowledge.detail', 'grape_get_knowledge_detail', { knowledge_id: knFirst[1] })
else results.push(['knowledge.detail', 'SKIP', '列表为空'])

// 3 决策层：cancel → resume（自有测试载体）
const num = Number(issueNumber)
await probe('issues.cancel(#' + num + ')', 'grape_cancel_issue', { owner, repo, number: num })
await probe('issues.resume(#' + num + ')', 'grape_resume_issue', { owner, repo, number: num })

// 4 写探针：host 已纳管仓（预期服务端给出幂等/重复提示也算通过——非网络级失败）
await probe('repos.host(业务探针)', 'grape_host_repo', { full_name: `${owner}/${repo}` }, (t, isErr) => !isErr || /授权|已纳管|已存在|managed|409/.test(t))
await probe('repos.sync', 'grape_sync_repos', {})

// 5 worker_onboard：只验证命令生成，不执行
const wb = await probe('worker.onboard(生成命令)', 'grape_worker_onboard', { device_name: 'grape-kit-e2e-probe' })
if (wb.text && !wb.isError) {
  const ok = /--token RTA|curl -sSL/.test(wb.text)
  results.push(['worker.onboard(命令形态)', ok ? 'PASS' : 'FAIL', wb.text.split('\n').find((l) => l.includes('curl'))?.slice(0, 90) ?? ''])
}

proc.kill()
console.log('\n===== grape-kit v0.2.x 新增工具 live 扫描 =====')
for (const [label, status, note] of results) {
  console.log(`${status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌'} ${label.padEnd(28)} ${status}  ${note}`)
}
const pass = results.filter((r) => r[1] === 'PASS').length
const skip = results.filter((r) => r[1] === 'SKIP').length
console.log(`\n合计: ${pass} PASS / ${results.length - pass - skip} FAIL / ${skip} SKIP`)
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0)
