/** 启动期版本检查（check_update，2026-11-18 优化点 1）
 *
 * MCP server 启动后异步执行一次 npm registry 版本比对：
 * - registry latest > 本地版本 → stderr 一次性提醒（不阻塞 stdio JSON-RPC，不打扰模型上下文）
 * - 24h 缓存（~/.grape/grape-kit-update-check.json），避免每次启动都打 registry
 * - 任何失败（网络/解析/非 TTY 判定失败）静默：版本提醒是尽力而为，绝不影响工具可用性
 * - 环境变量 GRAPE_KIT_SKIP_UPDATE_CHECK=1 可关闭
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_TTL_MS = 24 * 3600 * 1000
const REGISTRY = 'https://registry.npmjs.org'
const cachePath = join(homedir(), '.grape', 'grape-kit-update-check.json')

export function checkUpdate(localVersion, { now = Date.now(), fetchImpl = fetch, env = process.env } = {}) {
  if ((env.GRAPE_KIT_SKIP_UPDATE_CHECK || '').trim() === '1') return Promise.resolve(null)
  // 缓存：24h 内已查过（无论结果）不再打 registry
  try {
    if (existsSync(cachePath)) {
      const c = JSON.parse(readFileSync(cachePath, 'utf-8'))
      if (c && typeof c.checkedAt === 'number' && now - c.checkedAt < CACHE_TTL_MS) {
        if (c.latest && c.latest !== localVersion) return Promise.resolve({ latest: c.latest, cached: true })
        return Promise.resolve(null)
      }
    }
  } catch { /* 缓存损坏 → 视为无缓存 */ }

  return fetchImpl(`${REGISTRY}/@grape-dev/grape-kit/latest`, { signal: AbortSignal.timeout(5000) })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      const latest = d && typeof d.version === 'string' ? d.version : ''
      try { writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest })) } catch { /* 只读失败忽略 */ }
      if (latest && latest !== localVersion) return { latest, cached: false }
      return null
    })
    .catch(() => null)
}
