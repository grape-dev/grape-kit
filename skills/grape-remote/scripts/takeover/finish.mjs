#!/usr/bin/env node
import { resolveCreds, parseArgv, one, list, requireSession, post, fail } from './_lib.mjs'

const USAGE = `用法: node finish.mjs --session <tkos_xxx> --summary "结论" [--evidence "命令+输出"] [--files a.mjs,b.mjs] [--action "动作"]... [--artifact "产物"]... [--next-step "..."] [--issue-summary "..."]
env: GRAPE_BASE_URL / GRAPE_API_TOKEN（必须是用户级 grape_ 凭据）
说明: 正式交回仅在用户明确确认后执行；tko_ 仅 repo_session 能力，调用 finish 会 403。`

const opts = parseArgv(process.argv.slice(2))
if (opts.help) { console.log(USAGE); process.exit(0) }

try {
  const session = requireSession(opts, USAGE)
  const summary = one(opts.summary)
  if (!summary) { console.error(USAGE); throw new Error('缺少 --summary') }
  const { base } = resolveCreds()
  const token = process.env.GRAPE_API_TOKEN || ''
  if (!token) fail('finish 需用户级凭据：请设置 GRAPE_API_TOKEN=grape_xxx（tko_ 不能推进流水线）')
  const body = {
    summary,
    evidence: one(opts.evidence) || '',
    files_written: String(one(opts.files) || '').split(',').map((s) => s.trim()).filter(Boolean),
    actions: list(opts.action),
    artifacts: list(opts.artifact),
    next_step: one(opts['next-step']) || '',
    issue_summary: one(opts['issue-summary']) || '',
    outcome: 'completed',
    handoff: 'a2a',
  }
  const r = await post(`/api/takeover/sessions/${encodeURIComponent(session)}/finish`, body, { base, token }, 'finish')
  if (r.status === 403) fail('finish 403：需用户级凭据（grape_）；tko_ 仅 repo_session，不能推进流水线。')
  process.exit(r.ok ? 0 : 1)
} catch (e) {
  fail(e.message)
}
