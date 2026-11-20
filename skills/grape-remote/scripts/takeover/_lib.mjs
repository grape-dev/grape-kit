/**
 * 接管脚本共用件：零依赖（Node >= 20 原生 fetch），凭据只从环境变量读取。
 * GRAPE_BASE_URL：平台地址（默认生产实例）；GRAPE_SESSION_TOKEN：tko_ 接管凭据；
 * GRAPE_API_TOKEN：用户级凭据（仅 finish 需要）。
 */
export function resolveCreds() {
  const base = String(process.env.GRAPE_BASE_URL || 'https://www.grapedev.cn').replace(/\/$/, '')
  const token = process.env.GRAPE_SESSION_TOKEN || process.env.GRAPE_API_TOKEN || ''
  return { base, token }
}

export function parseArgv(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { opts.help = true; continue }
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`参数 ${a} 缺值`)
      i++
      opts[k] = opts[k] === undefined ? v : [].concat(opts[k], v)
    } else {
      opts._.push(a)
    }
  }
  return opts
}

export const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v)
export const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v])

export function requireSession(opts, usage) {
  const session = one(opts.session)
  if (!session) {
    console.error(usage)
    throw new Error('缺少 --session（接管会话 id，形如 tkos_xxx）')
  }
  return session
}

export async function post(path, body, { token, base }, label) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  console.log(`${label} ${r.status}${text ? ` ${text.slice(0, 2000)}` : ''}`)
  return r
}

export function fail(message) {
  console.error(message)
  process.exit(1)
}
