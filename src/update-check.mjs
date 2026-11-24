/** 启动期版本检查（check_update，2026-11-18 优化点 1）
 *
 * MCP server 启动后异步执行一次 npm registry 版本比对：
 * - registry latest > 本地版本（semver 语义）→ stderr 一次性提醒（不阻塞 stdio JSON-RPC，不打扰模型上下文）
 * - 24h 缓存（~/.grape/grape-kit-update-check.json），避免每次启动都打 registry
 * - 任何失败（网络/解析/非 TTY 判定失败）静默：版本提醒是尽力而为，绝不影响工具可用性
 * - 环境变量 GRAPE_KIT_SKIP_UPDATE_CHECK=1 可关闭，GRAPE_KIT_NO_UPDATE_CHECK=1 为等价别名
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { grapeHome } from './api.mjs'

const CACHE_TTL_MS = 24 * 3600 * 1000

/** registry 访问单源（Issue #27 QA SJ2）：URL 与有界超时由本模块导出，
 *  src/lifecycle.mjs 的版本全景/主动检查直接复用，不再自带第二份常量与第二份 fetch。 */
export const REGISTRY_URL = 'https://registry.npmjs.org'
export const REGISTRY_TIMEOUT_MS = 5000
// GRAPE_HOME 覆盖点单源：与凭据文件通道共用 src/api.mjs 的 grapeHome()（QA P2 去重）
const cachePath = () => join(grapeHome(), 'grape-kit-update-check.json')

/**
 * 取 npm registry 上的 latest 版本号（best-effort）。
 * 任何失败（网络/非 2xx/响应不可解析/无 version 字段）一律返回空串，由调用方自行降级——
 * 版本提示是尽力而为，绝不影响工具可用性。
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  try {
    const r = await fetchImpl(`${REGISTRY_URL}/@grape-dev/grape-kit/latest`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r || !r.ok) return ''
    const d = await r.json()
    return d && typeof d.version === 'string' ? d.version.trim() : ''
  } catch {
    return ''
  }
}

/** 写缓存：目录不存在时先创建（首次运行 HOME 下通常没有 ~/.grape） */
function writeCache(data) {
  const file = cachePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data))
  } catch { /* 只读失败忽略：升级提示是尽力而为 */ }
}

/** 升级提示文案：doctor 的「版本更新」行与 MCP stderr 共用，避免两份拷贝分叉 */
export function formatUpdateNotice(localVersion, latest) {
  return `有新版本 ${localVersion} → ${latest}（npm i -g @grape-dev/grape-kit 更新，npx 用户下次拉取即最新；GRAPE_KIT_SKIP_UPDATE_CHECK=1 或 GRAPE_KIT_NO_UPDATE_CHECK=1 关闭提醒）`
}

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

/**
 * 版本检查结果状态：
 * - newer：发现更高版本且尚未提示过（cached 表示来自 24h 缓存）
 * - notified：更高版本但同一版本已提示过（24h 内不重复打扰）
 * - latest：本地已是最新（或本地版本更高）
 * - unavailable：registry 不可达、非 2xx 或响应不可解析
 * - disabled：开关关闭
 */
export async function checkUpdateStatus(localVersion, { now = Date.now(), fetchImpl = fetch, env = process.env } = {}) {
  if (isUpdateCheckDisabled(env)) return { state: 'disabled' }
  // 缓存：24h 内已查过（无论结果）不再打 registry；
  // notified 记录已提示过的 latest —— 同一新版本只打扰一次
  try {
    if (existsSync(cachePath())) {
      const c = JSON.parse(readFileSync(cachePath(), 'utf-8'))
      if (c && typeof c.checkedAt === 'number' && now - c.checkedAt < CACHE_TTL_MS) {
        const latest = typeof c.latest === 'string' ? c.latest : ''
        if (!latest) return { state: 'unavailable', cached: true }
        if (isNewerVersion(latest, localVersion)) {
          if (c.notified !== latest) {
            writeCache({ ...c, notified: latest })
            return { state: 'newer', latest, cached: true }
          }
          return { state: 'notified', latest, cached: true }
        }
        return { state: 'latest', latest, cached: true }
      }
    }
  } catch { /* 缓存损坏 → 视为无缓存 */ }

  try {
    const latest = await fetchLatestVersion({ fetchImpl })
    const newer = !!latest && isNewerVersion(latest, localVersion)
    writeCache({ checkedAt: now, latest, notified: newer ? latest : '' })
    if (newer) return { state: 'newer', latest, cached: false }
    if (latest) return { state: 'latest', latest, cached: false }
    return { state: 'unavailable', cached: false }
  } catch {
    // 失败也落盘（latest 为空），遵循「24h 内无论结果都不再打 registry」
    writeCache({ checkedAt: now, latest: '', notified: '' })
    return { state: 'unavailable', cached: false }
  }
}

/** 兼容接口：仅在发现未提示过的新版本时返回 { latest, cached }，其余一律 null */
export async function checkUpdate(localVersion, opts) {
  const status = await checkUpdateStatus(localVersion, opts)
  return status.state === 'newer' ? { latest: status.latest, cached: status.cached } : null
}
