#!/usr/bin/env node
/**
 * grape-mcp 安装器 —— 面向无 UI agent 的装配 + doctor + 卸载。
 *
 * 设计对齐 devkit v2 installer 模式（install/doctor/uninstall 生命周期 + receipt 所有权）：
 * - opencode：mcp.grape 条目做「文本外科手术」插入 opencode.jsonc（保注释、先备份、幂等）；
 *   native skill 副本进 ~/.config/opencode/skills/，配 .grape-kit-native.json receipt；
 * - 凭据不落配置文件：GRAPE_BASE_URL / GRAPE_API_TOKEN 由用户环境提供（写入配置会泄漏 token）。
 *
 * 用法：
 *   node setup.mjs install --target opencode [--script /abs/grape-kit-mcp.mjs]
 *   node setup.mjs uninstall --target opencode
 *   node setup.mjs doctor [--probe]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = resolve(HERE, 'grape-kit-mcp.mjs')
const RECEIPT = '.grape-kit-native.json'

/** npx 免全局安装的启动参数（workbuddy / codearts / officeace 共用，与 opencode 的本地脚本模式并列） */
const NPX_ARGS = ['-y', '-p', '@grape-dev/grape-kit', 'grape-kit-mcp']
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const backupPathFor = (file) => `${file}.bak-grapemcp-${stamp()}`
/** 写前备份；目标不存在时返回 null（新建无需备份） */
function backupOf(file) {
  if (!existsSync(file)) return null
  const b = backupPathFor(file)
  writeFileSync(b, readFileSync(file, 'utf8'))
  return b
}
/** 通用 doctor 前置检查（node / 凭据走环境变量，不回显 token） */
function baseChecks() {
  return [
    ['node >= 20', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'FAIL'],
    ['GRAPE_BASE_URL', process.env.GRAPE_BASE_URL ? `ok（${process.env.GRAPE_BASE_URL}）` : '未设置（FAIL）：export GRAPE_BASE_URL=https://www.grapedev.cn'],
    ['GRAPE_API_TOKEN', process.env.GRAPE_API_TOKEN ? 'ok（已设置，不回显）' : '未设置（FAIL）：在 Grape WebUI 生成用户级 API Key（用环境变量传递，不要写进宿主配置）'],
  ]
}
function connectivityCheck(baseUrl) {
  const r = spawnSync(process.execPath, ['-e',
    `fetch(process.argv[1] + '/static/openapi.json').then(r => console.log('contract ' + r.status)).catch(() => console.log('contract unreachable'))`,
    baseUrl], { encoding: 'utf8', timeout: 20_000 })
  return String(r.stdout).trim() || '探测失败'
}
function printChecks(checks) {
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
}

const arg = (name, def = undefined) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def
}
const cmd = process.argv[2] || 'help'
const target = arg('target', 'opencode')

/** 未知 target 明确报错，不静默回落到 opencode（否则会写错宿主的配置） */
function resolveTarget() {
  const t = String(target)
  if (!SUPPORTED_TARGETS.includes(t)) {
    console.error(`不支持的 --target: ${t}`)
    console.error(`受支持宿主: ${SUPPORTED_TARGETS.join(' / ')}`)
    console.error('（hermes 无 MCP client，复制 skills/grape-remote 手动装配；dsh 由 grape-dsh 独立插件承载）')
    process.exit(1)
  }
  return t
}

function opencodePaths() {
  const home = homedir()
  return {
    config: join(home, '.config', 'opencode', 'opencode.jsonc'),
    configAlt: join(home, '.config', 'opencode', 'opencode.json'),
    skillsDir: join(home, '.config', 'opencode', 'skills'),
  }
}

/* ---------- workbuddy（P0-1/P0-2，WorkBuddy 上架评估报告） ---------- */

function workbuddyPaths() {
  const home = homedir()
  return {
    mcpJson: join(home, '.workbuddy', 'mcp.json'),
    skillsDir: join(home, '.workbuddy', 'skills'),
  }
}

function installWorkbuddy() {
  const p = workbuddyPaths()
  mkdirSync(join(homedir(), '.workbuddy'), { recursive: true })
  let cfg = { mcpServers: {} }
  if (existsSync(p.mcpJson)) {
    try { cfg = JSON.parse(readFileSync(p.mcpJson, 'utf8')) } catch { cfg = { mcpServers: {} } }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}
  }
  const backup = `${p.mcpJson}.bak-grapemcp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
  if (existsSync(p.mcpJson)) writeFileSync(backup, readFileSync(p.mcpJson, 'utf8'))
  cfg.mcpServers['grape-kit'] = {
    command: 'npx',
    args: ['-y', '-p', '@grape-dev/grape-kit', 'grape-kit-mcp'],
  }
  writeFileSync(p.mcpJson, JSON.stringify(cfg, null, 2) + String.fromCharCode(10))
  console.log(`已写入 ${p.mcpJson}（mcpServers.grape-kit，${existsSync(backup) ? `备份: ${backup}` : '新建'}）`)
  console.log('⚠️ 新注册的连接器需在 WorkBuddy 中手动「信任」一次，否则工具不可调用')
  return true
}

function uninstallWorkbuddy() {
  const p = workbuddyPaths()
  if (!existsSync(p.mcpJson)) { console.log('未找到 ~/.workbuddy/mcp.json，无需卸载'); return }
  let cfg
  try { cfg = JSON.parse(readFileSync(p.mcpJson, 'utf8')) } catch { console.log('mcp.json 解析失败，跳过'); return }
  if (cfg.mcpServers && cfg.mcpServers['grape-kit']) {
    delete cfg.mcpServers['grape-kit']
    writeFileSync(p.mcpJson, JSON.stringify(cfg, null, 2) + String.fromCharCode(10))
    console.log('已移除 mcpServers.grape-kit')
  } else console.log('未安装条目')
}

function doctorWorkbuddy(probe) {
  const p = workbuddyPaths()
  const checks = baseChecks()
  let mcpOk = false
  if (existsSync(p.mcpJson)) {
    try { mcpOk = !!JSON.parse(readFileSync(p.mcpJson, 'utf8')).mcpServers?.['grape-kit'] } catch {}
  }
  checks.push(['workbuddy mcpServers.grape-kit', mcpOk ? 'ok' : '未安装（npx -y @grape-dev/grape-kit install --target workbuddy）'])
  checks.push(['workbuddy skill 副本', existsSync(join(p.skillsDir, 'grape-remote', 'SKILL.md')) ? 'ok' : '未安装'])
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  printChecks(checks)
}

/* ---------- codearts（华为云码道 CodeArts Agent） ---------- */

/**
 * 码道 MCP 配置位置（官方《MCP命令》文档）：
 * - 全局：~/.codeartsdoer/codearts_cli.jsonc
 * - 项目级：<项目>/.codeartsdoer/codearts_cli.jsonc
 * 条目结构 {"mcp": {"<名称>": {"command","args","env"}}}；IDE 侧同源配置为 mcp_settings.json。
 * GRAPE_CODEARTS_CONFIG 用于宿主实机路径差异（装配期指定，不改代码）。
 */
function codeartsPaths() {
  const home = homedir()
  const override = String(process.env.GRAPE_CODEARTS_CONFIG || '').trim()
  return {
    override,
    config: join(home, '.codeartsdoer', 'codearts_cli.jsonc'),
    configAlt: join(home, '.codeartsdoer', 'codearts_cli.json'),
  }
}

function codeartsConfigPath() {
  const p = codeartsPaths()
  if (p.override) return p.override
  if (existsSync(p.config)) return p.config
  if (existsSync(p.configAlt)) return p.configAlt
  return p.config
}

function installCodearts() {
  const cfgPath = codeartsConfigPath()
  const body = { type: 'local', command: 'npx', args: [...NPX_ARGS], env: {} }
  const inner = buildEntry('grape-kit', body)
  if (!existsSync(cfgPath)) {
    mkdirSync(dirname(cfgPath), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ mcp: { 'grape-kit': body } }, null, 2) + '\n')
    console.log(`已写入 ${cfgPath}（新建文件与 mcp 块）`)
  } else {
    const text = readFileSync(cfgPath, 'utf8')
    if (findMcpBlockStart(text) < 0) {
      // 无 mcp 块：纯 JSON 可整体重写；含注释的 jsonc 无法安全改写则报错
      let cfg
      try { cfg = JSON.parse(text) } catch (e) {
        console.error(`配置文件 ${cfgPath} 无 "mcp" 块且非纯 JSON（${e.message}）；请手动添加，README 有片段`)
        process.exit(1)
      }
      cfg.mcp = { ...cfg.mcp, 'grape-kit': body }
      const backup = backupOf(cfgPath)
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
      console.log(`已写入 ${cfgPath}（新建 mcp 块，备份: ${backup}）`)
    } else if (hasEntry(text, 'grape-kit')) {
      // 已安装：先移除再插入（幂等升级，避免字段漂移）
      const removed = removeEntry(text, 'grape-kit')
      if (!removed) { console.error('grape-kit 条目已存在但移除失败，请手动检查'); process.exit(1) }
      writeEntry(removed, cfgPath, inner)
    } else {
      writeEntry(text, cfgPath, inner)
    }
  }
  console.log('码道 CodeArts：设置 → MCP工具 → 已安装 → 对 grape-kit 点「重启」，配置方才生效')
  console.log('凭据走环境变量（GRAPE_BASE_URL / GRAPE_API_TOKEN），不要写进宿主配置')
}

function uninstallCodearts() {
  const cfgPath = codeartsConfigPath()
  if (!existsSync(cfgPath)) { console.log(`未找到码道 MCP 配置 ${cfgPath}，无需卸载`); return }
  const text = readFileSync(cfgPath, 'utf8')
  const removed = removeEntry(text, 'grape-kit')
  if (!removed) { console.log('未发现 grape-kit 条目，跳过'); return }
  const backup = backupOf(cfgPath)
  writeFileSync(cfgPath, removed)
  console.log(`已移除 mcp.grape-kit 条目（备份: ${backup}）`)
}

function doctorCodearts(probe) {
  const cfgPath = codeartsConfigPath()
  const checks = baseChecks()
  let mcpOk = false
  if (existsSync(cfgPath)) {
    try { mcpOk = hasEntry(readFileSync(cfgPath, 'utf8'), 'grape-kit') } catch {}
  }
  checks.push([`codearts mcp.grape-kit（${cfgPath}）`, mcpOk ? 'ok' : '未安装（npx -y @grape-dev/grape-kit install --target codearts）'])
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  printChecks(checks)
}

/* ---------- officeace（果办OfficeAce） ---------- */

/**
 * 果办OfficeAce 的连接器（MCP）只能通过 GUI 注册（扩展 > 连接器 > 我的连接器 > 自定义添加，
 * 支持「JSON配置」与「表单配置」，无文件式注册入口）。因此这里写一份**可直接粘贴导入**的清单，
 * 并打印手动步骤；doctor 检出该清单条目（Spec Risks & Mitigations：无文件注册的宿主降级方案）。
 * 清单路径可用 GRAPE_OFFICEACE_MANIFEST 覆盖。
 */
function officeacePaths() {
  const home = homedir()
  const override = String(process.env.GRAPE_OFFICEACE_MANIFEST || '').trim()
  return { manifest: override || join(home, '.officeace', 'mcp.json') }
}

function officeaceEntry() {
  return { command: 'npx', args: [...NPX_ARGS], env: {} }
}

function installOfficeace() {
  const { manifest } = officeacePaths()
  let cfg = { mcpServers: {} }
  if (existsSync(manifest)) {
    try {
      cfg = JSON.parse(readFileSync(manifest, 'utf8'))
    } catch (e) {
      console.error(`${manifest} 解析失败（${e.message}），请先修复或移走该文件`)
      process.exit(1)
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}
  }
  mkdirSync(dirname(manifest), { recursive: true })
  const backup = backupOf(manifest)
  // 先移除再插入：幂等，且不覆盖文件内其他连接器
  cfg.mcpServers['grape-kit'] = officeaceEntry()
  writeFileSync(manifest, JSON.stringify(cfg, null, 2) + '\n')
  console.log(`已写入 ${manifest}（mcpServers.grape-kit${backup ? `，备份: ${backup}` : '，新建'}）`)
  console.log('⚠️ 果办OfficeAce 不支持文件式注册，需在客户端完成一次导入：')
  console.log('   扩展 → 连接器 → 我的连接器 → 自定义添加 → JSON配置 → 粘贴上述文件内容 → 确认并连接')
  console.log('凭据走环境变量（GRAPE_BASE_URL / GRAPE_API_TOKEN），不要写进连接器配置')
}

function uninstallOfficeace() {
  const { manifest } = officeacePaths()
  if (!existsSync(manifest)) { console.log(`未找到 ${manifest}，无需卸载`); return }
  let cfg
  try { cfg = JSON.parse(readFileSync(manifest, 'utf8')) } catch (e) {
    console.error(`${manifest} 解析失败（${e.message}），跳过`)
    return
  }
  if (!cfg.mcpServers || !cfg.mcpServers['grape-kit']) { console.log('未发现 grape-kit 连接器，跳过'); return }
  const backup = backupOf(manifest)
  delete cfg.mcpServers['grape-kit']
  writeFileSync(manifest, JSON.stringify(cfg, null, 2) + '\n')
  console.log(`已移除 mcpServers.grape-kit（备份: ${backup}）`)
  console.log('⚠️ 果办OfficeAce 侧还需在「扩展 → 连接器 → 我的连接器」中手动删除该连接器')
}

function doctorOfficeace(probe) {
  const { manifest } = officeacePaths()
  const checks = baseChecks()
  let ok = false
  if (existsSync(manifest)) {
    try { ok = !!JSON.parse(readFileSync(manifest, 'utf8')).mcpServers?.['grape-kit'] } catch {}
  }
  checks.push([`officeace mcpServers.grape-kit（${manifest}）`, ok ? 'ok' : '未安装（npx -y @grape-dev/grape-kit install --target officeace）'])
  if (ok) checks.push(['officeace 导入状态', '需在客户端「扩展 → 连接器」中确认已连接（清单存在 ≠ 已导入）'])
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  printChecks(checks)
}

/* ---------- mcp.jsonc 文本外科手术 ---------- */

function findMcpBlockStart(text) {
  const m = text.match(/"mcp"\s*:\s*\{/)
  if (!m) return -1
  return m.index + m[0].length
}

/** 在 mcp 块内定位某条目闭合大括号（from 指向条目自身的 '{'；跳过字符串字面量内的花括号） */
function findBlockEnd(text, from) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function buildEntry(name, body) {
  // 只生成条目体（不含外层大括号）：由 writeEntry 负责插入到 mcp 块内
  const inner = JSON.stringify({ [name]: body }, null, 2)
  return inner.replace(/^\{/, '').replace(/\}\s*$/, '').trim()
    .split('\n').map((l) => '    ' + l).join('\n')
}

/** opencode 条目体：本地脚本直连（开发/离线场景可用 --script 指定） */
function opencodeEntry(scriptAbs) {
  return { type: 'local', command: [process.execPath, scriptAbs], enabled: true, timeout: 600000 }
}

function installOpencode(scriptAbs) {
  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (!existsSync(cfgPath)) {
    console.error(`未找到 opencode 配置: ${p.config}（或 opencode.json）`)
    process.exit(1)
  }
  const text = readFileSync(cfgPath, 'utf8')
  const inner = buildEntry('grape', opencodeEntry(scriptAbs))
  if (hasEntry(text, 'grape')) {
    // 已有 grape 条目：删除旧条目后重插（幂等升级）
    const removed = removeEntry(text, 'grape')
    if (!removed) { console.error('grape 条目已存在但移除失败，请手动检查'); process.exit(1) }
    return writeEntry(removed, cfgPath, inner)
  }
  if (findMcpBlockStart(text) < 0) {
    // 无 mcp 块：纯 JSON 文件可安全整体重写；解析失败（含注释的 jsonc）才报错
    try {
      const cfg = JSON.parse(text)
      cfg.mcp = {
        ...cfg.mcp,
        grape: { type: 'local', command: [process.execPath, scriptAbs], enabled: true, timeout: 600000 },
      }
      const backup = `${cfgPath}.bak-grapemcp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
      writeFileSync(backup, text)
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
      console.log(`已写入 ${cfgPath}（新建 mcp 块，备份: ${backup}）`)
      return true
    } catch (e) {
      console.error(`配置文件无 "mcp" 块且非纯 JSON（${e.message}）；请手动添加，README 有片段`)
      process.exit(1)
    }
  }
  return writeEntry(text, cfgPath, inner)
}

function writeEntry(text, cfgPath, inner) {
  const start = findMcpBlockStart(text)
  if (start < 0) {
    console.error('配置文件中未找到 "mcp": { 块；请手动添加（README 有片段）')
    process.exit(1)
  }
  const backup = backupPathFor(cfgPath)
  writeFileSync(backup, text)
  // 插入点之后块体为空（只剩空白/逗号直到块闭合）时不带尾逗号，避免悬挂逗号产生非法 JSON
  const emptyBlock = /^\s*,?\s*\}/.test(text.slice(start))
  const sep = emptyBlock ? '' : ','
  const next = text.slice(0, start) + '\n    ' + inner + sep + text.slice(start)
  writeFileSync(cfgPath, next)
  console.log(`已写入 ${cfgPath}（备份: ${backup}）`)
  return true
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** mcp 块内是否已有指定名称的条目 */
function hasEntry(text, name) {
  const start = findMcpBlockStart(text)
  if (start < 0) return false
  return new RegExp(`"${escRe(name)}"\\s*:`).test(text.slice(start))
}

function removeEntry(text, name) {
  const start = findMcpBlockStart(text)
  if (start < 0) return null
  const m = text.slice(start).match(new RegExp(`"${escRe(name)}"\\s*:\\s*\\{`))
  if (!m) return null
  const entryStart = start + m.index
  // 回溯吃掉前置换行与（可能存在的）前置逗号
  let s = entryStart
  while (s > start && /[\s,]/.test(text[s - 1])) s--
  const end = findBlockEnd(text, entryStart + m[0].length - 1)
  if (end < 0) return null
  // 吃掉后置逗号（若条目后有兄弟条目）
  let e = end + 1
  if (text[e] === ',') e++
  return text.slice(0, s) + text.slice(e)
}

/* ---------- skill 副本 + receipt ---------- */

function copySkill() {
  const p = opencodePaths()
  const src = join(HERE, 'skills', 'grape-remote')
  if (!existsSync(src)) { console.warn('skill 源缺失，跳过'); return }
  mkdirSync(p.skillsDir, { recursive: true })
  const dst = join(p.skillsDir, 'grape-remote')
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(dst, { recursive: true })
  for (const f of readdirSync(src)) {
    if (statSync(join(src, f)).isFile()) writeFileSync(join(dst, f), readFileSync(join(src, f)))
  }
  writeFileSync(join(p.skillsDir, RECEIPT), JSON.stringify({
    installedBy: 'grape-kit',
    version: JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version,
    skills: ['grape-remote'],
    placedAt: new Date().toISOString(),
  }, null, 2))
  console.log(`skill 已安装: ${dst}`)
}

function copySkillWorkbuddy() {
  const p = workbuddyPaths()
  const src = join(HERE, 'skills', 'grape-remote')
  if (!existsSync(src)) { console.warn('skill 源缺失，跳过'); return }
  mkdirSync(p.skillsDir, { recursive: true })
  const dst = join(p.skillsDir, 'grape-remote')
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(dst, { recursive: true })
  for (const f of readdirSync(src)) {
    if (statSync(join(src, f)).isFile()) writeFileSync(join(dst, f), readFileSync(join(src, f)))
  }
  writeFileSync(join(p.skillsDir, RECEIPT), JSON.stringify({ installedBy: 'grape-kit', skills: ['grape-remote'], placedAt: new Date().toISOString() }, null, 2))
  console.log(`skill 已安装: ${dst}`)
}

function uninstallSkill() {
  const p = opencodePaths()
  const receiptPath = join(p.skillsDir, RECEIPT)
  let skills = ['grape-remote']
  if (existsSync(receiptPath)) {
    try { skills = JSON.parse(readFileSync(receiptPath, 'utf8')).skills || skills } catch { /* 用默认 */ }
  }
  for (const s of skills) rmSync(join(p.skillsDir, s), { recursive: true, force: true })
  rmSync(receiptPath, { force: true })
  console.log(`skill 已卸载: ${skills.join(', ')}`)
}

/* ---------- doctor ---------- */

function doctorOpencode(probe) {
  const p = opencodePaths()
  const checks = []
  checks.push(['node >= 20', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'FAIL'])
  const bin = process.env.GRAPE_CLI_BIN || 'grape'
  const which = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  // v0.3.0 起原生 HTTP 直连，CLI 仅 401 回退通道——缺失降级为提示而非 FAIL
  checks.push([`grape CLI（${bin}，可选回退通道）`, which.status === 0 ? `ok（${String(which.stdout).trim()}）` : '未安装（可选：pip install git+https://gitcode.com/grape-dev/grape-cli.git）'])
  const baseUrl = process.env.GRAPE_BASE_URL
  checks.push(['GRAPE_BASE_URL', baseUrl ? `ok（${baseUrl}）` : '未设置（FAIL）：export GRAPE_BASE_URL=https://www.grapedev.cn'])
  checks.push(['GRAPE_API_TOKEN', process.env.GRAPE_API_TOKEN ? 'ok（已设置，不回显）' : '未设置（FAIL）：在 Grape WebUI 生成用户级 API Key'])
  const cfgText = [p.config, p.configAlt].filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n')
  checks.push(['opencode mcp.grape 条目', /"grape"\s*:\s*\{/.test(cfgText) ? 'ok' : '未安装（node setup.mjs install --target opencode）'])
  checks.push(['opencode skill 副本', existsSync(join(p.skillsDir, 'grape-remote', 'SKILL.md')) ? 'ok' : '未安装'])
  if (probe && baseUrl) {
    const ok = spawnSync(process.execPath, ['-e', `
const base = process.argv[1]
const tok = process.env.GRAPE_API_TOKEN || ''
Promise.all([
  fetch(base + '/static/openapi.json').then(r => 'contract ' + r.status).catch(() => 'contract unreachable'),
  fetch(base + '/api/takeover/sessions', { headers: tok ? { Authorization: 'Bearer ' + tok } : {} })
    .then(r => r.status === 404 ? 'takeover 不可用（平台 < weekly-11，接管工具走回退路径）' : 'takeover ' + r.status + (r.status === 401 || r.status === 422 ? '（可用，需鉴权/参数）' : ''))
    .catch(() => 'takeover unreachable'),
]).then(l => console.log(l.join(' | ')))
`, baseUrl], { encoding: 'utf8', timeout: 20_000 })
    checks.push(['服务端能力探测', String(ok.stdout).trim() || '探测失败'])
  }
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
}

/* ---------- 宿主注册表（install / uninstall / doctor 共用同一份路径定义，防「装了检不出」） ---------- */

function uninstallOpencode() {
  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (existsSync(cfgPath)) {
    const text = readFileSync(cfgPath, 'utf8')
    const removed = removeEntry(text, 'grape')
    if (removed) {
      const backup = backupOf(cfgPath)
      writeFileSync(cfgPath, removed)
      console.log(`已移除 mcp.grape 条目（备份: ${backup}）`)
    } else {
      console.log('未发现 grape 条目，跳过')
    }
  }
  uninstallSkill()
}

const HOSTS = {
  opencode: {
    label: 'opencode',
    install: () => {
      installOpencode(resolve(String(arg('script', DEFAULT_SCRIPT))))
      copySkill()
      console.log('\n完成。环境变量（用户侧一次性）：')
      console.log('  export GRAPE_BASE_URL=https://www.grapedev.cn')
      console.log('  export GRAPE_API_TOKEN=grape_xxx   # WebUI 生成')
      console.log('重启 opencode 会话后生效；用 node setup.mjs doctor 验证。')
    },
    uninstall: uninstallOpencode,
    doctor: doctorOpencode,
  },
  workbuddy: {
    label: 'workbuddy（WorkBuddy）',
    install: () => { installWorkbuddy(); copySkillWorkbuddy() },
    uninstall: () => {
      uninstallWorkbuddy()
      rmSync(join(workbuddyPaths().skillsDir, 'grape-remote'), { recursive: true, force: true })
      rmSync(join(workbuddyPaths().skillsDir, RECEIPT), { force: true })
    },
    doctor: doctorWorkbuddy,
  },
  codearts: {
    label: 'codearts（华为云码道 CodeArts Agent）',
    install: installCodearts,
    uninstall: uninstallCodearts,
    doctor: doctorCodearts,
  },
  officeace: {
    label: 'officeace（果办OfficeAce）',
    install: installOfficeace,
    uninstall: uninstallOfficeace,
    doctor: doctorOfficeace,
  },
}

/* 受支持宿主以 HOSTS 为唯一来源（hermes 无 MCP client 走 skill 手动复制；dsh 由 grape-dsh 插件承载） */
const SUPPORTED_TARGETS = Object.keys(HOSTS)

/* ---------- main ---------- */

if (cmd === '--version' || cmd === 'version' || cmd === '-v') {
  console.log(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version)
  process.exit(0)
}

if (cmd === 'install' || cmd === 'uninstall' || cmd === 'doctor') {
  const host = HOSTS[resolveTarget()]
  if (cmd === 'install') host.install()
  else if (cmd === 'uninstall') host.uninstall()
  else host.doctor(!!arg('probe'))
} else {
  console.log(`用法: node setup.mjs install|uninstall|doctor [--target ${SUPPORTED_TARGETS.join('|')}] [--probe]`)
  for (const [name, host] of Object.entries(HOSTS)) console.log(`  --target ${name.padEnd(10)} ${host.label}`)
}
