/**
 * 自管理核心（Issue #27）——版本全景 / 更新检查 / 安装形态 / 宿主检出。
 *
 * 设计约束（Spec §2 §4）：
 * - **不 import `grape-kit.mjs`**（CLI 红线）：宿主路径与检出判定在本模块独立实现，
 *   与 CLI 侧函数**成对维护**（每处路径常量带同步指针注释），并由
 *   test/lifecycle.test.mjs 的一致性断言（Spec §4.2）兜住漂移。
 * - **纯函数 + 可注入依赖**：home / env / fetchImpl / spawnImpl / apiModule / now 全部可选注入，
 *   单测因此不读进程真实 HOME、不联网、不写真实 ~/.grape。
 * - **只读**：检出与版本聚合绝不落盘；唯一写路径是 `recordDismiss()`（Spec §3.2 的 dismiss 状态文件）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 五宿主标识：与 `grape-kit.mjs` 的 `SUPPORTED_TARGETS`（opencode/workbuddy/codearts/officeace/dsh）逐一对应 */
export const HOST_NAMES = ['opencode', 'workbuddy', 'codearts', 'officeace', 'dsh']

/** 检出状态四态：missing=没有配置文件；absent=文件在但无 grape 条目；installed=已装配；damaged=配置损坏 */
export const HOST_STATE = { MISSING: 'missing', ABSENT: 'absent', INSTALLED: 'installed', DAMAGED: 'damaged' }

/* ── jsonc 解析（字符串感知去注释/尾随逗号） ──
 * 同步指针：与 `grape-kit.mjs` 的 parseLoose / stripComments / stripTrailingCommas 同语义
 * （CLI 侧 grape-kit.mjs:945 parseLoose → :918 stripComments → :933 stripTrailingCommas）。
 * 检出只需「能否解析 + 有无条目」，故这里不复制 mcp 块的位置手术逻辑。 */

/** 跳过一个字符串字面量（i 指向开引号），返回闭引号下标；未闭合返回 -1 */
function skipString(text, i) {
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '\\') { j += 2; continue }
    if (c === '"') return j
    j++
  }
  return -1
}

function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const e = skipString(text, i)
      if (e < 0) throw new Error('字符串未闭合')
      out += text.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue }
    out += c
    i++
  }
  return out
}

function stripTrailingCommas(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      const e = skipString(text, i)
      if (e < 0) throw new Error('字符串未闭合')
      out += text.slice(i, e + 1)
      i = e + 1
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

/** jsonc 结构解析：去 BOM/注释/尾随逗号；失败抛出可读错误（检出报 damaged 用） */
export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(String(text).replace(/^\uFEFF/, ''))))
}

/* ── 宿主路径单源（与 grape-kit.mjs 成对维护；路径变更必须两侧同改） ── */

/** 同步指针：grape-kit.mjs:245 opencodePaths() */
function opencodePaths(home) {
  return {
    config: join(home, '.config', 'opencode', 'opencode.jsonc'),
    configAlt: join(home, '.config', 'opencode', 'opencode.json'),
    skillsDir: join(home, '.config', 'opencode', 'skills'),
  }
}

/** 同步指针：grape-kit.mjs:258 workbuddyPaths() */
function workbuddyPaths(home) {
  return {
    mcpJson: join(home, '.workbuddy', 'mcp.json'),
    skillsDir: join(home, '.workbuddy', 'skills'),
  }
}

/** 同步指针：grape-kit.mjs:348 codeartsPaths() / codeartsConfigPath()（GRAPE_CODEARTS_CONFIG 覆盖点同源） */
function codeartsPaths(home, env) {
  const override = String(env.GRAPE_CODEARTS_CONFIG || '').trim()
  const config = join(home, '.codeartsdoer', 'codearts_cli.jsonc')
  const configAlt = join(home, '.codeartsdoer', 'codearts_cli.json')
  const picked = override || (existsSync(config) ? config : existsSync(configAlt) ? configAlt : config)
  return { override, config, configAlt, path: picked }
}

/** 同步指针：grape-kit.mjs:451 officeacePaths()（GRAPE_OFFICEACE_MANIFEST 覆盖点同源） */
function officeacePaths(home, env) {
  const override = String(env.GRAPE_OFFICEACE_MANIFEST || '').trim()
  return { manifest: override || join(home, '.officeace', 'mcp.json') }
}

/** 同步指针：grape-kit.mjs:538 dshPaths()（DSH_HOME / GRAPE_DSH_PATCH 覆盖点同源） */
function dshPaths(home, env) {
  const dshHome = String(env.DSH_HOME || '').trim() || join(home, '.dsh')
  const override = String(env.GRAPE_DSH_PATCH || '').trim()
  return {
    home: dshHome,
    patch: override || join(dshHome, 'profiles', 'web', 'cordis.patch.yml'),
    skillsDir: join(dshHome, 'skills'),
  }
}

/* ── 托管块标记（同步指针：grape-kit.mjs:548-550 DSH_BLOCK_START/END） ── */
const DSH_BLOCK_START = '# Grape Kit DSH integration start'
const DSH_BLOCK_END = '# Grape Kit DSH integration end'

const markerRe = (marker) => new RegExp(`^[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(?:\\r?\\n|$)`, 'm')

/** 托管块定位：{ start, end, complete }；无起始标记返回 null（同步指针：grape-kit.mjs:560 findDshBlock） */
function findDshBlock(text) {
  const m = markerRe(DSH_BLOCK_START).exec(text)
  if (!m) return null
  const afterStart = m.index + m[0].length
  const em = markerRe(DSH_BLOCK_END).exec(text.slice(afterStart))
  if (!em) return { start: m.index, end: text.length, complete: false }
  return { start: m.index, end: afterStart + em.index + em[0].length, complete: true }
}

/** 顶层 YAML 序列自检（同步指针：grape-kit.mjs:652 isTopLevelSequence） */
function isTopLevelSequence(text) {
  const first = text.split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#') && l !== '---' && !l.startsWith('%'))
  return first === undefined || first.startsWith('- ')
}

const row = (host, state, path, extra = {}) => ({
  host, label: host, state, path, installed: state === HOST_STATE.INSTALLED, ...extra,
})

/** 纯 JSON 宿主（mcpServers 容器）：同步指针：grape-kit.mjs:200 detectJsonEntry */
function detectJsonEntry(file, rootKey, name, { loose, host, skillsDir, entryLabel }) {
  if (!existsSync(file)) return row(host, HOST_STATE.MISSING, file, { skillsDir, entry: entryLabel })
  let cfg
  try {
    cfg = loose ? parseJsonc(readFileSync(file, 'utf8')) : JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return row(host, HOST_STATE.DAMAGED, file, { skillsDir, entry: entryLabel, error: e.message })
  }
  const container = cfg?.[rootKey]
  const ok = !!(container && typeof container === 'object' && container[name])
  return row(host, ok ? HOST_STATE.INSTALLED : HOST_STATE.ABSENT, file, {
    skillsDir, entry: entryLabel, evidence: ok ? `${entryLabel} 条目存在于 ${file}` : `未发现 ${entryLabel} 条目`,
  })
}

/** opencode：候选 .jsonc 优先、.json 回落；两者可同时存在，任一含 grape 条即装配（同步指针：grape-kit.mjs:1203 detectOpencode） */
function detectOpencode({ home }) {
  const p = opencodePaths(home)
  const first = existsSync(p.config) ? p.config : p.configAlt
  const candidates = [first, ...(first === p.config ? [p.configAlt] : [])].filter(existsSync)
  if (!candidates.length) return row('opencode', HOST_STATE.MISSING, first, { skillsDir: p.skillsDir, entry: 'mcp.grape' })
  let error, errorPath
  for (const f of candidates) {
    let cfg
    try { cfg = parseJsonc(readFileSync(f, 'utf8')) } catch (e) { error = e.message; errorPath = f; continue }
    if (cfg?.mcp?.grape) {
      return row('opencode', HOST_STATE.INSTALLED, f, {
        skillsDir: p.skillsDir, entry: 'mcp.grape', evidence: `mcp.grape 条目存在于 ${f}`,
      })
    }
  }
  if (error) return row('opencode', HOST_STATE.DAMAGED, errorPath, { skillsDir: p.skillsDir, entry: 'mcp.grape', error })
  return row('opencode', HOST_STATE.ABSENT, first, { skillsDir: p.skillsDir, entry: 'mcp.grape', evidence: '未发现 mcp.grape 条目' })
}

/** dsh：托管块 + `- id: grape-kit`（同步指针：grape-kit.mjs:759 detectDsh） */
function detectDsh({ home, env }) {
  const p = dshPaths(home, env)
  const base = { skillsDir: p.skillsDir, entry: '托管块 id: grape-kit' }
  if (!existsSync(p.patch)) return row('dsh', HOST_STATE.MISSING, p.patch, base)
  const text = readFileSync(p.patch, 'utf8')
  const block = findDshBlock(text)
  if (!block) return row('dsh', HOST_STATE.ABSENT, p.patch, { ...base, evidence: '未发现托管块标记' })
  if (!block.complete) return row('dsh', HOST_STATE.DAMAGED, p.patch, { ...base, error: '托管块不完整（缺少结束标记）' })
  if (!isTopLevelSequence(text)) return row('dsh', HOST_STATE.DAMAGED, p.patch, { ...base, error: '顶层不是 YAML 序列（托管块无法安全追加）' })
  const ok = text.slice(block.start, block.end).includes('- id: grape-kit')
  return row('dsh', ok ? HOST_STATE.INSTALLED : HOST_STATE.ABSENT, p.patch, {
    ...base, evidence: ok ? `托管块存在于 ${p.patch}` : '托管块存在但无 id: grape-kit',
  })
}

/**
 * 五宿主只读检出（Spec §3.4 / §4.2）。
 * @param {{home?: string, env?: object}} [opts] home/env 可注入——单测据此用临时目录夹具，不读真实 HOME
 * @returns {Array<{host:string,label:string,state:string,installed:boolean,path:string,entry:string,skillsDir?:string,evidence?:string,error?:string}>}
 */
export function detectHostStatus({ home = homedir(), env = process.env } = {}) {
  const ca = codeartsPaths(home, env)
  const oa = officeacePaths(home, env)
  const wb = workbuddyPaths(home)
  return [
    detectOpencode({ home }),
    detectJsonEntry(wb.mcpJson, 'mcpServers', 'grape-kit', {
      loose: false, host: 'workbuddy', skillsDir: wb.skillsDir, entryLabel: 'mcpServers.grape-kit',
    }),
    detectJsonEntry(ca.path, 'mcp', 'grape-kit', {
      loose: true, host: 'codearts', skillsDir: '', entryLabel: 'mcp.grape-kit',
    }),
    detectJsonEntry(oa.manifest, 'mcpServers', 'grape-kit', {
      loose: false, host: 'officeace', skillsDir: '', entryLabel: 'mcpServers.grape-kit',
    }),
    detectDsh({ home, env }),
  ]
}

/** kit 包根目录（本文件在 <pkg>/src/ 下）——安装形态与版本读取同源 */
export const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
