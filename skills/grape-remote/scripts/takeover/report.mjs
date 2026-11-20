#!/usr/bin/env node
import { resolveCreds, parseArgv, one, list, requireSession, post, fail } from './_lib.mjs'

const USAGE = `用法: node report.mjs --session <tkos_xxx> --summary "进度摘要" [--message "细节"]... [--attach <client_session>]
env: GRAPE_BASE_URL / GRAPE_SESSION_TOKEN（tko_ 接管凭据即可）`

const opts = parseArgv(process.argv.slice(2))
if (opts.help) { console.log(USAGE); process.exit(0) }

try {
  const session = requireSession(opts, USAGE)
  const { base, token } = resolveCreds()
  if (!token) fail('缺少 GRAPE_SESSION_TOKEN（或 GRAPE_API_TOKEN）')
  const attach = one(opts.attach)
  if (attach) await post(`/api/takeover/sessions/${encodeURIComponent(session)}/attach`, { client_session: attach }, { base, token }, 'attach')
  const summary = one(opts.summary) || ''
  const messages = list(opts.message)
  const r = await post(`/api/takeover/sessions/${encodeURIComponent(session)}/progress`, {
    messages: messages.length ? messages : (summary ? [summary] : []),
    ...(summary ? { summary } : {}),
  }, { base, token }, 'progress')
  process.exit(r.ok ? 0 : 1)
} catch (e) {
  fail(e.message)
}
