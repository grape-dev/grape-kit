/** 启动期版本检查（check_update，2026-11-18 优化点 1）
 *
 * MCP server 启动后异步执行一次 npm registry 版本比对：
 * - registry latest > 本地版本（semver 语义）→ stderr 一次性提醒（不阻塞 stdio JSON-RPC，不打扰模型上下文）
 * - 24h 缓存（~/.grape/grape-kit-update-check.json），避免每次启动都打 registry
 * - 任何失败（网络/解析/非 TTY 判定失败）静默：版本提醒是尽力而为，绝不影响工具可用性
 * - 环境变量 GRAPE_KIT_SKIP_UPDATE_CHECK=1 可关闭，GRAPE_KIT_NO_UPDATE_CHECK=1 为等价别名
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_TTL_MS = 24 * 3600 * 1000
const REGISTRY = 'https://registry.npmjs.org'
const cachePath = join(homedir(), '.grape', 'grape-kit-update-check.json')

/** 开关：任一开关名置 1 即关闭全部升级提示 */
export function isUpdateCheckDisabled(env = process.env) {
  const on = (name) => String(env[name] ?? '').trim() === '1'
  return on('GRAPE_KIT_SKIP_UPDATE_CHECK') || on('GRAPE_KIT_NO_UPDATE_CHECK')
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** semver 比较：a<b → -1，a==b → 0，a>b → 1；任一不可解析 → null */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  }
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  const n = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d < 0 ? -1 : 1
    } else if (xNum) return -1
    else if (yNum) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 仅当 latest 语义上高于本地版本时才算「有新版本」（不可解析 → 保守不提示） */
export function isNewerVersion(latest, local) {
  return compareVersions(latest, local) === 1
}

export function checkUpdate(localVersion, { now = Date.now(), fetchImpl = fetch, env = process.env } = {}) {
  if (isUpdateCheckDisabled(env)) return Promise.resolve(null)
  // 缓存：24h 内已查过（无论结果）不再打 registry
  try {
    if (existsSync(cachePath)) {
      const c = JSON.parse(readFileSync(cachePath, 'utf-8'))
      if (c && typeof c.checkedAt === 'number' && now - c.checkedAt < CACHE_TTL_MS) {
        if (c.latest && isNewerVersion(c.latest, localVersion)) return Promise.resolve({ latest: c.latest, cached: true })
        return Promise.resolve(null)
      }
    }
  } catch { /* 缓存损坏 → 视为无缓存 */ }

  return fetchImpl(`${REGISTRY}/@grape-dev/grape-kit/latest`, { signal: AbortSignal.timeout(5000) })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      const latest = d && typeof d.version === 'string' ? d.version : ''
      try { writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest })) } catch { /* 只读失败忽略 */ }
      if (latest && isNewerVersion(latest, localVersion)) return { latest, cached: false }
      return null
    })
    .catch(() => null)
}
