#!/usr/bin/env node
import { resolveCreds, parseArgv, one, list, requireSession, post, fail } from './_lib.mjs'

const USAGE = `用法: node request-finish.mjs --session <tkos_xxx> --summary "结论" [--evidence "命令+输出"] [--files a.mjs,b.mjs] [--action "动作"]... [--artifact "产物"]... [--next-step "..."] [--issue-summary "..."]
env: GRAPE_BASE_URL / GRAPE_SESSION_TOKEN（tko_ 接管凭据即可）
说明: 只报告完成，等用户在对话中确认后再用 finish.mjs 正式交回。`

const opts = parseArgv(process.argv.slice(2))
if (opts.help) { console.log(USAGE); process.exit(0) }

try {
  const session = requireSession(opts, USAGE)
  const summary = one(opts.summary)
  if (!summary) { console.error(USAGE); throw new Error('缺少 --summary') }
  const { base, token } = resolveCreds()
  if (!token) fail('缺少 GRAPE_SESSION_TOKEN（或 GRAPE_API_TOKEN）')
  const body = {
    summary,
    evidence: one(opts.evidence) || '',
    files_written: String(one(opts.files) || '').split(',').map((s) => s.trim()).filter(Boolean),
    actions: list(opts.action),
    artifacts: list(opts.artifact),
    next_step: one(opts['next-step']) || '',
    issue_summary: one(opts['issue-summary']) || '',
  }
  const r = await post(`/api/takeover/sessions/${encodeURIComponent(session)}/request-finish`, body, { base, token }, 'request-finish')
  if (r.ok) console.log('已报告完成：请把结论/证据呈现给用户，取得对话确认后运行 finish.mjs。')
  process.exit(r.ok ? 0 : 1)
} catch (e) {
  fail(e.message)
}
