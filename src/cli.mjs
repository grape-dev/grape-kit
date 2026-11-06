/**
 * grape CLI 子进程封装 — 插件壳里唯一的能力出口。
 *
 * 设计要点（对齐 grape-dsh 实测结论 docs/HTTP-VS-CLI-ANALYSIS.md）：
 * - token 一律走环境变量（GRAPE_API_TOKEN / GRAPE_BASE_URL / GRAPE_AUTH_FILE），
 *   不进 argv（ps 可见）、不进日志；
 * - GRAPE_CLI_MODE=USER：外部调用者是用户身份，防止 CLI 误用 tk_ 优先级；
 * - --json-out 保证 stdout 是单行纯 JSON（CLI registry.py: click.echo(json.dumps(...))）；
 * - 退出码语义（CLI cli.py main() 收口）：0 成功；1 配置/网络；2 用法错误；≥400 HTTP 透传。
 */
import { spawn } from 'node:child_process'

export class GrapeCliError extends Error {
  constructor(message, { code = 1, stderr = '', args = [] } = {}) {
    super(message)
    this.name = 'GrapeCliError'
    this.code = code
    this.stderr = stderr
    this.args = args
  }
}

export function cliConfigFromEnv(env = process.env) {
  return {
    bin: env.GRAPE_CLI_BIN || 'grape',
    baseUrl: env.GRAPE_BASE_URL || '',
    tokenFile: env.GRAPE_AUTH_FILE || '',
    timeoutMs: Number(env.GRAPE_MCP_TIMEOUT || 60_000),
  }
}

/**
 * 执行一条 grape CLI 命令，返回解析后的 JSON。
 * @param {string[]} args CLI 参数（不含 --json-out，会自动追加）
 * @param {{timeoutMs?: number, env?: NodeJS.ProcessEnv, bin?: string}} [opts]
 * @returns {Promise<{json: unknown, raw: string, code: number}>}
 */
export function runGrape(args, opts = {}) {
  const cfg = cliConfigFromEnv(opts.env)
  const bin = opts.bin || cfg.bin
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs
  const env = { ...(opts.env || process.env) }
  env.GRAPE_CLI_MODE = env.GRAPE_CLI_MODE || 'USER'
  const fullArgs = [...args, '--json-out']

  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = spawn(bin, fullArgs, { env })
    } catch (err) {
      return reject(new GrapeCliError(`grape CLI 启动失败: ${err.message}（bin=${bin}）`, { code: 127, args: fullArgs }))
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill('SIGTERM')
      reject(new GrapeCliError(`grape CLI 超时（>${Math.round(timeoutMs / 1000)}s；可用 GRAPE_MCP_TIMEOUT 调大或 --timeout 传给 CLI）`, { code: 124, stderr, args: fullArgs }))
    }, timeoutMs)

    proc.stdout.on('data', (d) => { stdout += d })
    proc.stderr.on('data', (d) => { stderr += d })
    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const msg = err.code === 'ENOENT'
        ? `找不到 grape CLI（bin=${bin}）。请先安装：pip install git+https://gitcode.com/grape-dev/grape-cli.git ，或用 GRAPE_CLI_BIN 指定路径`
        : `grape CLI 启动失败: ${err.message}`
      reject(new GrapeCliError(msg, { code: err.code === 'ENOENT' ? 127 : 1, stderr, args: fullArgs }))
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const raw = stdout.trim()
      let json
      if (raw) {
        try { json = JSON.parse(raw) } catch { json = undefined }
      }
      if (code !== 0) {
        const tail = (stderr || raw || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ')
        reject(new GrapeCliError(tail || `grape CLI 退出码 ${code}`, { code: code ?? 1, stderr, args: fullArgs }))
        return
      }
      resolve({ json, raw, code: 0 })
    })
  })
}

/** 终态集合（与 grape events 状态机对齐；未知状态一律视为未终态继续等） */
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error'])

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 轮询 events detail 直到终态或超时（无 UI 补偿：wait_task 在壳内循环，
 * 每轮 spawn 一次 CLI；grape-dsh 实测 ~200ms/次冷启动，3s 间隔下开销可接受）。
 * @returns {Promise<{json: unknown, polls: number, elapsedMs: number}>}
 */
export async function waitTask(seq, { timeoutSec = 300, intervalSec = 3, onPoll, opts = {} } = {}) {
  const start = Date.now()
  const deadline = start + timeoutSec * 1000
  let last = null
  let polls = 0
  while (Date.now() < deadline) {
    polls += 1
    const { json } = await runGrape(['events', 'detail', '--seq', String(seq)], opts)
    last = json
    const status = String((json && json.status) || '').toLowerCase()
    if (onPoll) onPoll({ polls, status, elapsedMs: Date.now() - start })
    if (TERMINAL_STATUSES.has(status)) {
      return { json: last, polls, elapsedMs: Date.now() - start }
    }
    await sleep(intervalSec * 1000)
  }
  return { json: last, polls, elapsedMs: Date.now() - start, timedOut: true }
}
