#!/usr/bin/env node
/**
 * live 冒烟 —— 对真实 grape 服务端的只读验证（不需要任何仓库写权限）。
 * 验收：initialize instructions → tools/list 13 → grape_list_scenes / grape_list_my_issues 真实数据渲染。
 * 运行：GRAPE_BASE_URL=... GRAPE_API_TOKEN=grape_xxx node scripts/live-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'grape-kit-mcp.mjs')
const proc = spawn(process.execPath, [SERVER], { env: process.env })
let buf = ''
const pending = new Map()
let nextId = 1
proc.stdout.on('data', (d) => {
  buf += d
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))

function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`RPC 超时: ${method}`)) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result) })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

let failed = false
try {
  if (!process.env.GRAPE_BASE_URL || !process.env.GRAPE_API_TOKEN) throw new Error('请设置 GRAPE_BASE_URL / GRAPE_API_TOKEN')
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-smoke', version: '0.0.0' },
  })
  console.log(`[ok] initialize: ${init.serverInfo.name}@${init.serverInfo.version}`)
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await rpc('tools/list', {})
  console.log(`[ok] tools/list: ${tools.tools.length} tools`)

  const scenes = await rpc('tools/call', { name: 'grape_list_scenes', arguments: {} })
  console.log(`[ok] grape_list_scenes（真实数据，前 6 行）:\n${scenes.content[0].text.split('\n').slice(0, 6).join('\n')}`)

  const mine = await rpc('tools/call', { name: 'grape_list_my_issues', arguments: {} })
  console.log(`[ok] grape_list_my_issues（真实数据，前 8 行）:\n${mine.content[0].text.split('\n').slice(0, 8).join('\n')}`)
} catch (e) {
  failed = true
  console.error(`[FAIL] ${e.message}`)
} finally {
  proc.kill('SIGTERM')
}
process.exit(failed ? 1 : 0)
