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
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, rmdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkUpdateStatus, formatUpdateNotice } from './src/update-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = resolve(HERE, 'grape-kit-mcp.mjs')
const RECEIPT = '.grape-kit-native.json'

/** npx 免全局安装的启动参数（workbuddy / codearts / officeace 共用，与 opencode 的本地脚本模式并列） */
const NPX_ARGS = ['-y', '-p', '@grape-dev/grape-kit', 'grape-kit-mcp']
/** 备份时间戳精确到秒：分钟精度会让同一分钟内的多次写入互相覆盖 */
const stamp = () => {
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
}
/** 备份路径；同名备份已存在时追加 -2/-3… 去重，绝不覆盖既有备份 */
function backupPathFor(file) {
  const base = `${file}.bak-grapemcp-${stamp()}`
  if (!existsSync(base)) return base
  for (let n = 2; ; n++) {
    const p = `${base}-${n}`
    if (!existsSync(p)) return p
  }
}
/**
 * 写前备份。originalText 用于「先移除再插入」的重装路径——此时磁盘文本已被改写，
 * 必须显式传入改动前的原文，否则备份里缺少用户原有条目、无法回滚。
 * 目标不存在（新建）时返回 null。
 */
function backupOf(file, originalText) {
  const text = originalText !== undefined ? originalText : (existsSync(file) ? readFileSync(file, 'utf8') : null)
  if (text === null) return null
  const b = backupPathFor(file)
  writeFileSync(b, text)
  return b
}
/** 单项检查定义：node / grape CLI / 凭据（凭据只读环境变量，不回显 token） */
const nodeCheck = () => ['node >= 20', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'FAIL']
const cliCheck = () => {
  const bin = process.env.GRAPE_CLI_BIN || 'grape'
  const which = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
  // v0.3.0 起原生 HTTP 直连，CLI 仅 401 回退通道——缺失降级为提示而非 FAIL
  return [`grape CLI（${bin}，可选回退通道）`, which.status === 0 ? `ok（${String(which.stdout).trim()}）` : '未安装（可选：pip install git+https://gitcode.com/grape-dev/grape-cli.git）']
}
const envChecks = () => [
  ['GRAPE_BASE_URL', process.env.GRAPE_BASE_URL ? `ok（${process.env.GRAPE_BASE_URL}）` : '未设置（FAIL）：export GRAPE_BASE_URL=https://www.grapedev.cn'],
  ['GRAPE_API_TOKEN', process.env.GRAPE_API_TOKEN
    ? 'ok（已设置，不回显）'
    : existsSync(join(homedir(), '.grape', 'config.json'))
      ? (() => { try { const c = JSON.parse(readFileSync(join(homedir(), '.grape', 'config.json'), 'utf8')); return c.token ? 'ok（文件通道 ~/.grape/config.json）' : '未设置（FAIL）' } catch { return '未设置（FAIL）：~/.grape/config.json 解析失败' } })()
      : '未设置（FAIL）：打开 https://www.grapedev.cn/app/#account/profile 生成用户级 API Key（自部署实例用「你的地址/app/#account/profile」），用环境变量或 ~/.grape/config.json 提供'],
]
const baseChecks = () => [nodeCheck(), ...envChecks()]
/** 单宿主详情与裸 doctor 汇总共用的检查序列（CLI 位于 node 之后），避免位置切片耦合 */
const baseChecksWithCli = () => [nodeCheck(), cliCheck(), ...envChecks()]
function connectivityCheck(baseUrl) {
  const r = spawnSync(process.execPath, ['-e',
    `fetch(process.argv[1] + '/static/openapi.json').then(r => console.log('contract ' + r.status)).catch(() => console.log('contract unreachable'))`,
    baseUrl], { encoding: 'utf8', timeout: 20_000 })
  return String(r.stdout).trim() || '探测失败'
}
function printChecks(checks) {
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
}

/** 纯 JSON 宿主（mcpServers 容器）条目检出；解析失败带 error，供 doctor 区分「未装配」与「配置损坏」 */
function detectJsonEntry(file, rootKey, name = 'grape-kit') {
  if (!existsSync(file)) return { ok: false, path: file }
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const container = cfg?.[rootKey]
    return { ok: !!(container && typeof container === 'object' && container[name]), path: file }
  } catch (e) {
    return { ok: false, path: file, error: e.message }
  }
}
/** doctor 条目状态：配置损坏优先于「未安装」，避免把损坏配置误报成未装配 */
function entryCheck(label, found, hint) {
  if (found.error) return [`${label}（${found.path}）`, `配置损坏（${found.error}）：请先修复或移走该文件`]
  return [`${label}（${found.path}）`, found.ok ? 'ok' : `未安装（${hint}）`]
}

const arg = (name, def = undefined) => {
  // 同时支持 `--target codearts` 与 `--target=codearts`：分发处按 startsWith('--target=') 判定，
  // 若这里只认分离写法，等号写法会被静默当成默认 opencode（写错宿主/删错配置）。
  const eqPrefix = `--${name}=`
  const eq = process.argv.find((a) => a.startsWith(eqPrefix))
  if (eq !== undefined) {
    const v = eq.slice(eqPrefix.length)
    return v === '' ? true : v
  }
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def
}
const cmd = process.argv[2] || 'help'
const targetExplicit = process.argv.some((a) => a === '--target' || a.startsWith('--target='))
let target = targetExplicit ? arg('target', 'opencode') : ''  // install/uninstall 分发处惰性求值（SUPPORTED_TARGETS 定义在文件后段，顶层求值会 TDZ）

/** 宿主自动检测：detectHosts() 扫描本机宿主痕迹，resolveTargetAuto() 未显式指定 --target 时据此选择。
 *  单个痕迹直装该宿主、多个痕迹全装；零痕迹时交互选择，非交互则列出支持项并非零退出（不再兜底 opencode）。 */

/** 未知 target 明确报错，不静默回落到 opencode（否则会写错宿主的配置） */
function resolveTarget() {
  const t = String(target)
  if (t !== 'all' && !SUPPORTED_TARGETS.includes(t)) {
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
  const originalText = existsSync(p.mcpJson) ? readFileSync(p.mcpJson, 'utf8') : null
  let cfg = { mcpServers: {} }
  if (originalText !== null) {
    // 解析失败必须非零退出：静默重置会丢掉用户的其它连接器（只剩在 .bak 里），
    // 与「只增删 grape 条目不动他人配置」冲突；与 officeace 走同一策略。
    try { cfg = JSON.parse(originalText) } catch (e) {
      console.error(`${p.mcpJson} 解析失败（${e.message}），请先修复或移走该文件后重试`)
      process.exit(1)
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}
  }
  cfg.mcpServers['grape-kit'] = { command: 'npx', args: [...NPX_ARGS] }
  const backup = writeValidated(p.mcpJson, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), originalText)
  console.log(`已写入 ${p.mcpJson}（mcpServers.grape-kit，${backup ? `备份: ${backup}` : '新建'}）`)
  console.log('⚠️ 新注册的连接器需在 WorkBuddy 中手动「信任」一次，否则工具不可调用')
  return true
}

function uninstallWorkbuddy() {
  const p = workbuddyPaths()
  if (existsSync(p.mcpJson)) {
    const originalText = readFileSync(p.mcpJson, 'utf8')
    let cfg
    try { cfg = JSON.parse(originalText) } catch { cfg = null }
    if (cfg && cfg.mcpServers && cfg.mcpServers['grape-kit']) {
      delete cfg.mcpServers['grape-kit']
      const backup = writeValidated(p.mcpJson, JSON.stringify(cfg, null, 2) + String.fromCharCode(10), originalText)
      console.log(`已移除 mcpServers.grape-kit（备份: ${backup}）`)
    } else if (cfg) {
      console.log('未安装条目')
    }
  } else {
    console.log('未找到 ~/.workbuddy/mcp.json，无需卸载')
  }
  // skill 清理：删 grape-remote 目录 + receipt（.grape-kit-native.json）；skills 目录空则一并移除
  const skillsRoot = join(dirname(p.mcpJson), 'skills')
  const skillDir = join(skillsRoot, 'grape-remote')
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    console.log(`skill 已删除: ${skillDir}`)
  }
  const receipt = join(skillsRoot, RECEIPT)
  if (existsSync(receipt)) {
    rmSync(receipt, { force: true })
    console.log(`receipt 已删除: ${receipt}`)
  }
  try { rmdirSync(skillsRoot); console.log(`空目录已清理: ${skillsRoot}`) } catch { /* skills 目录非空（其他插件）则保留 */ }
}

/** 检出 workbuddy 条目（doctor 与汇总自检共用同一判定） */
function detectWorkbuddy() {
  return detectJsonEntry(workbuddyPaths().mcpJson, 'mcpServers')
}

function doctorWorkbuddy(probe) {
  const p = workbuddyPaths()
  const checks = baseChecks()
  const found = detectWorkbuddy()
  checks.push(entryCheck('workbuddy mcpServers.grape-kit', found, 'npx -y @grape-dev/grape-kit install --target workbuddy'))
  checks.push(['workbuddy skill 副本', existsSync(join(p.skillsDir, 'grape-remote', 'SKILL.md')) ? 'ok' : '未安装'])
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  printChecks(checks)
}

/* ---------- codearts（华为云码道 CodeArts Agent） ---------- */

/**
 * 码道 MCP 配置位置（官方《MCP命令》文档）：
 * - 全局：~/.codeartsdoer/codearts_cli.jsonc
 * - 项目级：<项目>/.codeartsdoer/codearts_cli.jsonc
 * 条目结构 {"mcp": {"<名称>": {"type","command","args","env"}}}；本安装器写入的字段为
 * type:"local" + command/args/env（`type` 取值官方文档无示例，待 sre 实机确认）。
 * 本安装器只写码道 CLI/全局配置；IDE 的 mcp_settings.json 顶层是 mcpServers（与 CLI 的 mcp 结构不同），不在写入范围。
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
    writeValidated(cfgPath, JSON.stringify({ mcp: { 'grape-kit': body } }, null, 2) + '\n', null)
    console.log(`已写入 ${cfgPath}（新建文件与 mcp 块）`)
  } else {
    const text = readFileSync(cfgPath, 'utf8')
    if (!findMcpBlock(text)) {
      // 无 mcp 块：纯 JSON 可整体重写（同样走 writeValidated：写前/写后结构校验 + 备份）；
      // 含注释的 jsonc 无法安全改写则报错，不改写用户文件
      let cfg
      try { cfg = JSON.parse(text) } catch (e) {
        console.error(`配置文件 ${cfgPath} 无 "mcp" 块且非纯 JSON（${e.message}）；请手动添加，README 有片段`)
        process.exit(1)
      }
      cfg.mcp = { ...cfg.mcp, 'grape-kit': body }
      const backup = writeValidated(cfgPath, JSON.stringify(cfg, null, 2) + '\n', text)
      console.log(`已写入 ${cfgPath}（新建 mcp 块，备份: ${backup}）`)
    } else if (hasEntry(text, 'grape-kit')) {
      // 已安装：先移除再插入（幂等升级，避免字段漂移）；备份用改动前原文
      const removed = removeEntry(text, 'grape-kit')
      if (removed === null) { console.error('grape-kit 条目已存在但移除失败，请手动检查'); process.exit(1) }
      writeEntry(removed, cfgPath, inner, text)
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
  if (removed === null) { console.log('未发现 grape-kit 条目，跳过'); return }
  const backup = writeValidated(cfgPath, removed, text)
  console.log(`已移除 mcp.grape-kit 条目（备份: ${backup}）`)
}

/** 检出 codearts 条目（与 install 共用同一路径与成员判定）；结构损坏显式返回 error */
function detectCodearts() {
  const cfgPath = codeartsConfigPath()
  if (existsSync(cfgPath)) {
    const text = readFileSync(cfgPath, 'utf8')
    try { parseLoose(text) } catch (e) { return { ok: false, path: cfgPath, error: e.message } }
    try { return { ok: hasEntry(text, 'grape-kit'), path: cfgPath } } catch (e) { return { ok: false, path: cfgPath, error: e.message } }
  }
  return { ok: false, path: cfgPath }
}

function doctorCodearts(probe) {
  const checks = baseChecks()
  const found = detectCodearts()
  checks.push(entryCheck('codearts mcp.grape-kit', found, 'npx -y @grape-dev/grape-kit install --target codearts'))
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
  const originalText = existsSync(manifest) ? readFileSync(manifest, 'utf8') : null
  let cfg = { mcpServers: {} }
  if (originalText !== null) {
    try {
      cfg = JSON.parse(originalText)
    } catch (e) {
      console.error(`${manifest} 解析失败（${e.message}），请先修复或移走该文件`)
      process.exit(1)
    }
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {}
  }
  mkdirSync(dirname(manifest), { recursive: true })
  // 覆盖同名连接器（幂等），不触碰文件内其他连接器。注意：清单是「导入用 JSON」，
  // 整文件 JSON 往返会丢掉注释——OfficeAce 的粘贴导入本身也不接受注释。
  cfg.mcpServers['grape-kit'] = officeaceEntry()
  const backup = writeValidated(manifest, JSON.stringify(cfg, null, 2) + '\n', originalText)
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
  const originalText = readFileSync(manifest, 'utf8')
  delete cfg.mcpServers['grape-kit']
  const backup = writeValidated(manifest, JSON.stringify(cfg, null, 2) + '\n', originalText)
  console.log(`已移除 mcpServers.grape-kit（备份: ${backup}）`)
  console.log('⚠️ 果办OfficeAce 侧还需在「扩展 → 连接器 → 我的连接器」中手动删除该连接器')
}

/** 检出 officeace 清单条目（与 install 共用同一路径） */
function detectOfficeace() {
  return detectJsonEntry(officeacePaths().manifest, 'mcpServers')
}

function doctorOfficeace(probe) {
  const checks = baseChecks()
  const found = detectOfficeace()
  checks.push(entryCheck('officeace mcpServers.grape-kit', found, 'npx -y @grape-dev/grape-kit install --target officeace'))
  if (found.ok) checks.push(['officeace 导入状态', '需在客户端「扩展 → 连接器」中确认已连接（清单存在 ≠ 已导入）'])
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  printChecks(checks)
}

/* ---------- mcp.jsonc 文本外科手术（结构扫描：注释/字符串感知，只动 grape 条目） ---------- */

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

/** 跳过空白与注释（仅在结构位置调用，不会进入字符串内部） */
function skipTrivia(text, i) {
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') { i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl + 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    break
  }
  return i
}

/** 跳过一个值（对象/数组/字符串/原始值），返回结束位置（不含）；异常返回 -1 */
function skipValue(text, i) {
  const c = text[i]
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']'
    let depth = 0
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (ch === '"') {
        const e = skipString(text, j)
        if (e < 0) return -1
        j = e
        continue
      }
      if (ch === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
        const k = skipTrivia(text, j)
        if (k <= j) return -1
        j = k - 1
        continue
      }
      if (ch === c) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) return j + 1
      }
    }
    return -1
  }
  if (c === '"') {
    const e = skipString(text, i)
    return e < 0 ? -1 : e + 1
  }
  let j = i
  while (j < text.length && !',}] \t\r\n'.includes(text[j])) {
    if (text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) break
    j++
  }
  return j
}

/**
 * 枚举对象（openIdx 指向 '{'）的**直接成员**，返回 [{ key, keyStart, valueStart, valueEnd }]。
 * 层级靠结构扫描而非正则，因此嵌套对象里的同名键不会被当成本层成员。
 */
function objectMembers(text, openIdx) {
  const members = []
  let i = skipTrivia(text, openIdx + 1)
  while (i < text.length && text[i] !== '}') {
    if (text[i] === ',') { i = skipTrivia(text, i + 1); continue }
    if (text[i] !== '"') break
    const keyEnd = skipString(text, i)
    if (keyEnd < 0) break
    let key
    try { key = JSON.parse(text.slice(i, keyEnd + 1)) } catch { break }
    const colon = skipTrivia(text, keyEnd + 1)
    if (text[colon] !== ':') break
    const valueStart = skipTrivia(text, colon + 1)
    const valueEnd = skipValue(text, valueStart)
    if (valueEnd < 0) break
    members.push({ key, keyStart: i, valueStart, valueEnd })
    i = skipTrivia(text, valueEnd)
  }
  return members
}

/** 根对象中名为 key 的对象成员边界：{ open: '{' 下标, close: '}' 下标 }；不存在返回 null */
function findRootBlock(text, key) {
  const rootOpen = skipTrivia(text, 0)
  if (text[rootOpen] !== '{') return null
  const m = objectMembers(text, rootOpen).find((x) => x.key === key)
  if (!m || text[m.valueStart] !== '{') return null
  return { open: m.valueStart, close: m.valueEnd - 1 }
}

/** mcp 块边界（根级 "mcp": { … }） */
function findMcpBlock(text) {
  return findRootBlock(text, 'mcp')
}

/** 去注释（字符串感知） */
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

/** 去尾随逗号（字符串感知，保留字符串内的 ",]" 之类内容） */
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

/** jsonc 结构校验：去 BOM/注释/尾随逗号后按 JSON 解析，失败即抛错 */
function parseLoose(text) {
  return JSON.parse(stripTrailingCommas(stripComments(String(text).replace(/^\uFEFF/, ''))))
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
  let cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (!existsSync(cfgPath)) {
    mkdirSync(dirname(p.config), { recursive: true })
    writeFileSync(p.config, '{}\n')
    console.log(`未找到 opencode 配置，已自动创建空配置: ${p.config}`)
    cfgPath = p.config
  }
  const text = readFileSync(cfgPath, 'utf8')
  const inner = buildEntry('grape', opencodeEntry(scriptAbs))
  if (hasEntry(text, 'grape')) {
    // 已有 grape 条目：删除旧条目后重插（幂等升级）；备份内容必须是改动前原文
    const removed = removeEntry(text, 'grape')
    if (removed === null) { console.error('grape 条目已存在但移除失败，请手动检查'); process.exit(1) }
    return writeEntry(removed, cfgPath, inner, text)
  }
  if (!findMcpBlock(text)) {
    // 无 mcp 块：纯 JSON 文件可安全整体重写；解析失败（含注释的 jsonc）才报错、不改写用户文件
    let cfg
    try { cfg = JSON.parse(text) } catch (e) {
      console.error(`配置文件 ${cfgPath} 无 "mcp" 块且非纯 JSON（${e.message}）；请手动添加，README 有片段`)
      process.exit(1)
    }
    cfg.mcp = { ...cfg.mcp, grape: opencodeEntry(scriptAbs) }
    // 整体重写同样走 writeValidated：写前/写后结构校验 + 备份，与其它写入路径口径一致
    const backup = writeValidated(cfgPath, JSON.stringify(cfg, null, 2) + '\n', text)
    console.log(`已写入 ${cfgPath}（新建 mcp 块，备份: ${backup}）`)
    return true
  }
  return writeEntry(text, cfgPath, inner)
}

/**
 * 把条目体插到 mcp 块首。
 * @param text 当前待写入文本（可能是已移除旧条目的文本）
 * @param originalText 改动前的磁盘原文——备份必须用它，否则重装后无法回滚到用户原配置
 */
function writeEntry(text, cfgPath, inner, originalText = text) {
  const block = findMcpBlock(text)
  if (!block) {
    console.error(`配置文件中未找到根级 "mcp": { 块；请手动添加（README 有片段）`)
    process.exit(1)
  }
  const at = block.open + 1
  // 插入点之后块体为空（只剩空白/注释直到块闭合）时不带尾逗号，避免悬挂逗号产生非法 JSON
  const emptyBlock = skipTrivia(text, at) === block.close
  const sep = emptyBlock ? '' : ','
  const next = text.slice(0, at) + '\n    ' + inner + sep + text.slice(at)
  const backup = writeValidated(cfgPath, next, originalText)
  console.log(`已写入 ${cfgPath}（备份: ${backup}）`)
  return true
}

/**
 * 落盘并做结构校验：产物不合法则不写；写入后回读失败则回滚改动前原文并 exit 1。
 * 保证任何失败路径下磁盘上都还是用户原来的配置。
 */
function writeValidated(cfgPath, nextText, originalText) {
  try {
    parseLoose(nextText)
  } catch (e) {
    console.error(`生成结果结构校验失败（${e.message}）；未写入 ${cfgPath}，原文件保持不变`)
    process.exit(1)
  }
  const backup = backupOf(cfgPath, originalText)
  writeFileSync(cfgPath, nextText)
  try {
    parseLoose(readFileSync(cfgPath, 'utf8'))
  } catch (e) {
    // 新建文件（originalText 为 null）无原文可回滚，直接删掉刚写的文件
    if (typeof originalText === 'string') writeFileSync(cfgPath, originalText)
    else rmSync(cfgPath, { force: true })
    console.error(`写入后结构校验失败（${e.message}）；已回滚 ${cfgPath}（备份: ${backup}）`)
    process.exit(1)
  }
  return backup
}

/** mcp 块内**直接成员**是否已有指定名称的条目（嵌套同名键不算） */
function hasEntry(text, name) {
  const block = findMcpBlock(text)
  if (!block) return false
  return objectMembers(text, block.open).some((m) => m.key === name)
}

/** keyStart 所在行的行首位置（前一个换行之后）；用于整行摘除，保住下一条目的原缩进 */
function lineIndentStart(text, keyStart) {
  const nl = text.lastIndexOf('\n', keyStart - 1)
  return nl < 0 ? keyStart : nl + 1
}
/** 位置 i 所在行的下一行行首（含换行）；无换行返回文本长度 */
function endOfLineIndex(text, i) {
  const nl = text.indexOf('\n', i)
  return nl < 0 ? text.length : nl + 1
}

/**
 * 从 mcp 块中精确摘除某条目：按成员位置删除，并处理相邻逗号（中间/首/尾/唯一成员四种情形），
 * 保留其余成员与注释，产出仍是合法结构。
 */
function removeEntry(text, name) {
  const block = findMcpBlock(text)
  if (!block) return null
  const members = objectMembers(text, block.open)
  const idx = members.findIndex((m) => m.key === name)
  if (idx < 0) return null
  const m = members[idx]
  const next = members[idx + 1]
  // 值之后是否有分隔逗号（尾随逗号在最后成员后、紧跟 '}' 时不算「有兄弟」）
  let sepAfter = -1
  let after = skipTrivia(text, m.valueEnd)
  if (text[after] === ',') {
    sepAfter = after
    after = skipTrivia(text, after + 1)
  }
  if (next) {
    // 中间/首条：只摘除本条目自身所在行，**不删到下一条目行首**——否则会把
    // 挂在下一条目前的用户注释一并吞掉（README 承诺保留注释）。
    const hasContent = (a, b) => text.slice(a, b).trim() !== ''
    const lineStart = lineIndentStart(text, m.keyStart)
    const inlineKey = hasContent(lineStart, m.keyStart)
    const from = inlineKey ? m.keyStart : lineStart
    const end = sepAfter >= 0 ? sepAfter + 1 : m.valueEnd
    const eol = endOfLineIndex(text, end)
    // 下一条目仍与本单位于同一行（内联写法）：按成员边界删，不能整行删否则吞掉邻居
    if (inlineKey || next.keyStart < eol) return text.slice(0, from) + text.slice(end)
    // 行尾到换行之间只有空白才连换行一起删；有行尾注释则只删到成员结束，注释保留
    const to = text.slice(end, eol).trim() === '' ? eol : end
    return text.slice(0, from) + text.slice(to)
  }
  // 末条：需要连同前置逗号一起删；唯一成员则只删自身（含尾随逗号，若有）
  if (idx > 0) {
    const prev = members[idx - 1]
    let sepBefore = skipTrivia(text, prev.valueEnd)
    if (text[sepBefore] !== ',') return null
    const stop = sepAfter >= 0 ? sepAfter + 1 : m.valueEnd
    return text.slice(0, sepBefore) + text.slice(stop)
  }
  const stop = sepAfter >= 0 ? sepAfter + 1 : m.valueEnd
  return text.slice(0, m.keyStart) + text.slice(stop)
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

/** doctor「版本更新」行：拆开有新版本/已提示过/已最新/检测不可用/已关闭，避免误报「已是最新」 */
function updateCheckLine(pkgVersion, status) {
  switch (status && status.state) {
    case 'newer': return formatUpdateNotice(pkgVersion, status.latest)
    case 'disabled': return 'ok（提示已关闭）'
    case 'notified': return `ok（已提示过 ${status.latest}，24h 内不重复提醒；npm i -g @grape-dev/grape-kit 可更新）`
    case 'unavailable': return 'ok（检测不可用：registry 不可达或响应异常）'
    default: return `ok（已是最新 ${pkgVersion}）`
  }
}

/* ---------- doctor ---------- */

/** 检出 opencode 条目（install / doctor 共用同一判定，防「装了检不出」/嵌套误判） */
function detectOpencode() {

  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  let error
  // 候选文件可能同时存在（opencode.jsonc + opencode.json）：错误必须归因到**实际解析失败的文件**，
  // 否则会把损坏记到优先选取的 .jsonc 上，让用户去修一个正常文件。
  let errorPath
  for (const f of [cfgPath, ...(cfgPath === p.config ? [p.configAlt] : [])].filter(existsSync)) {
    const text = readFileSync(f, 'utf8')
    try { if (hasEntry(text, 'grape')) return { ok: true, path: f } } catch (e) { error = e.message; errorPath = f }
    try { parseLoose(text) } catch (e) { error = e.message; errorPath = f }
  }
  return { ok: false, path: errorPath || cfgPath, ...(error ? { error } : {}) }
}

async function doctorOpencode(probe) {
  const p = opencodePaths()
  // 与其它宿主共用 baseChecksWithCli / printChecks，避免文案与判定各写一份后漂移
  const checks = baseChecksWithCli()
  const baseUrl = process.env.GRAPE_BASE_URL
  const found = detectOpencode()
  checks.push(entryCheck('opencode mcp.grape 条目', found, 'node setup.mjs install --target opencode'))
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
  // check_update：复用 src/update-check.mjs（24h 缓存 + 5s 有界超时，失败静默，不阻塞其它检查）
  const pkgVersion = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  let updateStatus = { state: 'unavailable' }
  try { updateStatus = await checkUpdateStatus(pkgVersion) } catch { /* 版本检查绝不影响 doctor */ }
  checks.push(['版本更新', updateCheckLine(pkgVersion, updateStatus)])
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
  printChecks(checks)
}

/* ---------- 宿主注册表（install / uninstall / doctor 共用同一份路径定义，防「装了检不出」） ---------- */

function uninstallOpencode() {
  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (existsSync(cfgPath)) {
    const text = readFileSync(cfgPath, 'utf8')
    const removed = removeEntry(text, 'grape')
    if (removed !== null) {
      const backup = writeValidated(cfgPath, removed, text)
      console.log(`已移除 mcp.grape 条目（备份: ${backup}）`)
    } else {
      console.log('未发现 grape 条目，跳过')
    }
  }
  uninstallSkill()
}

/**
 * 不带 --target 的汇总自检：基础检查 + 逐宿主条目检出。
 * Issue 验收要求「两宿主全新安装后 doctor 检出对应条目」——裸 doctor 必须覆盖全部宿主，
 * 而不是默认只看 opencode（已装 codearts 却报 opencode 未安装会误导用户）。
 */
async function doctorAll(probe) {
  const checks = baseChecksWithCli()
  for (const [name, host] of Object.entries(HOSTS)) {
    const found = host.detect()
    checks.push(entryCheck(`${name} 条目`, found, `npx -y @grape-dev/grape-kit install --target ${name}`))
  }
  if (probe && process.env.GRAPE_BASE_URL) checks.push(['契约连通性', connectivityCheck(process.env.GRAPE_BASE_URL)])
  // check_update：汇总模式同样提示版本（24h 缓存 + 5s 有界超时，失败静默）
  const pkgVersion = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  let updateStatus = { state: 'unavailable' }
  try { updateStatus = await checkUpdateStatus(pkgVersion) } catch { /* 版本检查绝不影响 doctor */ }
  checks.push(['版本更新', updateCheckLine(pkgVersion, updateStatus)])
  printChecks(checks)
  console.log('  提示：doctor --target <宿主> 可查看单宿主详情（skill 副本 / OfficeAce 导入状态等）')
}

const HOSTS = {
  opencode: {
    label: 'opencode',
    install: () => {
      installOpencode(resolve(String(arg('script', DEFAULT_SCRIPT))))
      copySkill()
      console.log(`
──────────────────────────────────────────────
 grape-kit 安装完成 · 接下来 3 步上手
──────────────────────────────────────────────
【第 1 步 · 配置凭证】（一次性，约 1 分钟）
  1. 打开 https://www.grapedev.cn/app/#account/profile（自部署实例换成「你的地址/app/#account/profile」）
  2. 生成 API Key（grape_ 前缀），明文只显示一次，立即复制
  3. 写入环境变量（建议写进 shell 配置文件长期生效）：
       export GRAPE_BASE_URL=https://www.grapedev.cn
       export GRAPE_API_TOKEN=grape_你的Key
【第 2 步 · 自检】
       npx -y @grape-dev/grape-kit doctor --probe
  全部 [ok] 即就绪；每个 [!!] 行都会给出对应修复动作。
【第 3 步 · 重启宿主会话】然后对 agent 说一句话即可（见能力地图）。

能力地图（36 个 MCP 工具，5 大类）：
  ▸ 流水线遥控   建/查/触发/取消需求，看流水线进度与节点状态
  ▸ 端云接管     takeover 五件套：云端任务让渡到本地 agent，人工确认后交回
  ▸ Worker 接入  本机注册成 grape 执行引擎（worker_onboard）
  ▸ 仓库/项目    托管仓库、项目模板、看板数据
  ▸ 知识/技能    平台知识库与技能检索

上手案例（对 agent 直接说，自然语言即可）：
  ·「帮我建一个需求单：标题 xxx、描述 yyy」 → 建单进入流水线
  ·「查 xxx/yyy 仓库流水线，#12 到哪个节点了」 → 观察进度
  ·「接管 xxx/yyy 的 #12」 → 端云接管，本地干活
  · 干完审查它的证据后说「确认」 → 正式交回，流水线自动接力

完整文档：https://gitcode.com/grape-dev/grape-kit/blob/dev/README.md
──────────────────────────────────────────────`)
    },
    uninstall: uninstallOpencode,
    doctor: doctorOpencode,
    detect: detectOpencode,
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
    detect: detectWorkbuddy,
  },
  codearts: {
    label: 'codearts（华为云码道 CodeArts Agent）',
    install: installCodearts,
    uninstall: uninstallCodearts,
    doctor: doctorCodearts,
    detect: detectCodearts,
  },
  officeace: {
    label: 'officeace（果办OfficeAce）',
    install: installOfficeace,
    uninstall: uninstallOfficeace,
    doctor: doctorOfficeace,
    detect: detectOfficeace,
  },
}

/* 受支持宿主以 HOSTS 为唯一来源（hermes 无 MCP client 走 skill 手动复制；dsh 由 grape-dsh 插件承载） */
const SUPPORTED_TARGETS = Object.keys(HOSTS)

function detectHosts() {
  const home = homedir()
  const found = []
  if (existsSync(join(home, '.workbuddy'))) found.push('workbuddy')
  if (existsSync(join(home, '.codeartsdoer'))) found.push('codearts')
  if (existsSync(join(home, '.officeace'))) found.push('officeace')
  if (existsSync(join(home, '.config', 'opencode'))) found.push('opencode')
  return found
}

/** 未指定 --target 时：检测到 1 个宿主直接装；多个全装；零宿主进入交互菜单让用户选（参考 huaweicloud-devkit 检测 + 交互化改进）。
 *  非交互环境（无 TTY，如 agent 代跑/CI）退化为列出支持项并退出，指引 --target。 */
async function resolveTargetAuto() {
  const found = detectHosts()
  if (found.length === 1) return found[0]
  if (found.length > 1) return 'all'
  if (!process.stdin.isTTY) {
    console.error('未检测到任何已安装的宿主 agent。')
    console.error('支持的宿主: opencode / workbuddy / codearts / officeace')
    console.error('请用 --target <宿主> 指定后重跑（或先安装对应宿主 agent）。')
    process.exit(1)
  }
  console.log('未检测到已安装的宿主 agent，请选择要安装的目标：')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q) => new Promise((r) => rl.question(q, r))
  for (let i = 0; i < SUPPORTED_TARGETS.length; i++) {
    const h = HOSTS[SUPPORTED_TARGETS[i]]
    console.log(`  ${i + 1}. ${SUPPORTED_TARGETS[i].padEnd(10)} ${h ? h.label : ''}`)
  }
  while (true) {
    const a = (await ask('输入编号（1-' + SUPPORTED_TARGETS.length + '）或宿主名：')).trim()
    const byIdx = SUPPORTED_TARGETS[parseInt(a, 10) - 1]
    const pick = byIdx || SUPPORTED_TARGETS.find((t) => t === a.toLowerCase())
    if (pick) { rl.close(); return pick }
    console.log('无效选择，请重输。')
  }
}

/* ---------- main ---------- */

if (cmd === '--version' || cmd === 'version' || cmd === '-v') {
  console.log(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version)
  process.exit(0)
}

if (cmd === 'install' || cmd === 'uninstall' || cmd === 'doctor') {
  // doctor 未显式指定 --target 时汇总全部宿主；install/uninstall 仍默认 opencode
  if (cmd === 'doctor' && !process.argv.slice(2).some((a) => a === '--target' || a.startsWith('--target='))) {
    doctorAll(!!arg('probe'))
  } else {
    if (!targetExplicit && cmd !== 'doctor') target = await resolveTargetAuto()
    const t = resolveTarget()
    if (t === 'all') {
      const names = SUPPORTED_TARGETS
      console.log(`检测到多个宿主痕迹，全部安装/自检: ${names.join(' + ')}`)
      for (const n of names) {
        console.log(`
===== ${n} =====`)
        if (cmd === 'install') HOSTS[n].install()
        else if (cmd === 'uninstall') HOSTS[n].uninstall()
        else await HOSTS[n].doctor(!!arg('probe'))
      }
    } else {
      const host = HOSTS[t]
      if (cmd === 'install') host.install()
      else if (cmd === 'uninstall') host.uninstall()
      else await host.doctor(!!arg('probe'))
    }
  }
} else {
  console.log(`用法: node setup.mjs install|uninstall|doctor [--target ${SUPPORTED_TARGETS.join('|')}] [--probe]`)
  for (const [name, host] of Object.entries(HOSTS)) console.log(`  --target ${name.padEnd(10)} ${host.label}`)
}
