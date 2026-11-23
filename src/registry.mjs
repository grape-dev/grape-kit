/**
 * Windows 注册表查询结果分类（`reg query HKCU\Environment /v <NAME>`）。
 *
 * QA#PR13 判断项 4：旧实现把 `reg query` 的任何非零退出都当成「变量不存在」——
 * reg 不可用、被安全软件拦截、拒绝访问时静默报「零残留」，与 CHANGELOG「不再吞错」相反。
 * 这里只做判定分类，不执行命令：win32 实机回归之外的环境也能验证这条行为。
 */

export const REG_QUERY = Object.freeze({
  /** exit 0：注册表项存在 */
  PRESENT: 'present',
  /** exit 1 + 系统「找不到该项」文案：确实不存在 */
  ABSENT: 'absent',
  /** 其它一切（拒绝访问 / reg 缺失 / 被信号终止 / 退出码不可判定）：不得当成不存在 */
  ERROR: 'error',
})

const NOT_FOUND_RE = /(系统找不到指定的注册表项|找不到指定的注册表项或值|unable to find the specified registry key)/i

/**
 * @param {{status?: number|null, stdout?: string, stderr?: string, error?: Error, signal?: string|null}} result
 *   `spawnSync('reg', ...)` 的返回值形状
 * @returns {{state: string, detail?: string}}
 */
export function classifyRegQuery(result) {
  if (!result || typeof result !== 'object') {
    return { state: REG_QUERY.ERROR, detail: '无 reg query 结果（进程未执行）' }
  }
  const { status, stderr, error, signal } = result
  if (error) return { state: REG_QUERY.ERROR, detail: `reg 无法执行：${error.message || String(error)}` }
  if (signal) return { state: REG_QUERY.ERROR, detail: `reg 被信号终止：${signal}` }
  if (typeof status !== 'number') return { state: REG_QUERY.ERROR, detail: 'reg 退出码不可判定' }
  if (status === 0) return { state: REG_QUERY.PRESENT }
  const text = String(stderr || '')
  // 只有「系统找不到该项」才是真不存在；拒绝访问等同样 exit 1，必须落到 error
  if (status === 1 && NOT_FOUND_RE.test(text)) return { state: REG_QUERY.ABSENT }
  return { state: REG_QUERY.ERROR, detail: `reg exit=${status}${text.trim() ? `：${text.trim().slice(0, 160)}` : ''}` }
}