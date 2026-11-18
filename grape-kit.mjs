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
import { checkUpdate, formatUpdateNotice, isUpdateCheckDisabled } from './src/update-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = resolve(HERE, 'grape-kit-mcp.mjs')
const RECEIPT = '.grape-kit-native.json'

const arg = (name, def = undefined) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def
}
const cmd = process.argv[2] || 'help'
const target = arg('target', 'opencode')

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
  const checks = []
  checks.push(['node >= 20', Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'FAIL'])
  const baseUrl = process.env.GRAPE_BASE_URL
  checks.push(['GRAPE_BASE_URL', baseUrl ? `ok（${baseUrl}）` : '未设置（FAIL）：export GRAPE_BASE_URL=https://www.grapedev.cn'])
  checks.push(['GRAPE_API_TOKEN', process.env.GRAPE_API_TOKEN ? 'ok（已设置，不回显）' : '未设置（FAIL）：在 Grape WebUI 生成用户级 API Key（不要写进 mcp.json，用环境变量传递）'])
  let mcpOk = false
  if (existsSync(p.mcpJson)) {
    try { mcpOk = !!JSON.parse(readFileSync(p.mcpJson, 'utf8')).mcpServers?.['grape-kit'] } catch {}
  }
  checks.push(['workbuddy mcpServers.grape-kit', mcpOk ? 'ok' : '未安装（npx -y @grape-dev/grape-kit install --target workbuddy）'])
  checks.push(['workbuddy skill 副本', existsSync(join(p.skillsDir, 'grape-remote', 'SKILL.md')) ? 'ok' : '未安装'])
  if (probe && baseUrl) {
    const ok = spawnSync(process.execPath, ['-e',
      `fetch(process.argv[1] + '/static/openapi.json').then(r => console.log('contract ' + r.status)).catch(() => console.log('contract unreachable'))`,
      baseUrl], { encoding: 'utf8', timeout: 20_000 })
    checks.push(['契约连通性', String(ok.stdout).trim() || '探测失败'])
  }
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
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

function buildEntry(scriptAbs) {
  // 只生成条目体（不含外层大括号）：由 writeEntry 负责插入到 mcp 块内
  const inner = JSON.stringify({
    grape: {
      type: 'local',
      command: [process.execPath, scriptAbs],
      enabled: true,
      timeout: 600000,
    },
  }, null, 2)
  return inner.replace(/^\{/, '').replace(/\}\s*$/, '').trim()
    .split('\n').map((l) => '    ' + l).join('\n')
}

function installOpencode(scriptAbs) {
  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (!existsSync(cfgPath)) {
    console.error(`未找到 opencode 配置: ${p.config}（或 opencode.json）`)
    process.exit(1)
  }
  const text = readFileSync(cfgPath, 'utf8')
  if (/"grape"\s*:/.test(text.slice(findMcpBlockStart(text)))) {
    // 已有 grape 条目：删除旧条目后重插（幂等升级）
    const removed = removeGrapeEntry(text)
    if (!removed) { console.error('grape 条目已存在但移除失败，请手动检查'); process.exit(1) }
    return writeEntry(removed, cfgPath, scriptAbs)
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
  return writeEntry(text, cfgPath, scriptAbs)
}

function writeEntry(text, cfgPath, scriptAbs) {
  const start = findMcpBlockStart(text)
  if (start < 0) {
    console.error('配置文件中未找到 "mcp": { 块；请手动添加（README 有片段）')
    process.exit(1)
  }
  const backup = `${cfgPath}.bak-grapemcp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
  writeFileSync(backup, text)
  const inner = buildEntry(scriptAbs)
  // 插入点之后块体为空（只剩空白/逗号直到块闭合）时不带尾逗号，避免悬挂逗号产生非法 JSON
  const emptyBlock = /^\s*,?\s*\}/.test(text.slice(start))
  const sep = emptyBlock ? '' : ','
  const next = text.slice(0, start) + '\n    ' + inner + sep + text.slice(start)
  writeFileSync(cfgPath, next)
  console.log(`已写入 ${cfgPath}（备份: ${backup}）`)
  return true
}

function removeGrapeEntry(text) {
  const start = findMcpBlockStart(text)
  if (start < 0) return null
  const m = text.slice(start).match(/"grape"\s*:\s*\{/)
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

async function doctor(probe) {
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
  // check_update：复用 src/update-check.mjs（24h 缓存 + 5s 有界超时，失败静默，不阻塞其它检查）
  const pkgVersion = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  let upd = null
  try { upd = await checkUpdate(pkgVersion) } catch { /* 版本检查绝不影响 doctor */ }
  const disabled = isUpdateCheckDisabled(process.env)
  checks.push(['版本更新', upd && upd.latest
    ? formatUpdateNotice(pkgVersion, upd.latest)
    : disabled
      ? 'ok（提示已关闭）'
      : `ok（已是最新 ${pkgVersion} / 24h 内已提示过或检测不可用）`])
  for (const [k, v] of checks) console.log(`  ${String(v).startsWith('ok') ? '[ok]' : '[!!]'} ${k}: ${v}`)
}

/* ---------- main ---------- */

if (cmd === '--version' || cmd === 'version' || cmd === '-v') {
  console.log(JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version)
  process.exit(0)
}

if (cmd === 'install') {
  if (target === 'workbuddy') {
    installWorkbuddy()
    copySkillWorkbuddy()
  } else if (target !== 'opencode') {
    console.error(`MVP 仅支持 --target opencode / workbuddy（${target} 未支持；hermes 走 skill 手动复制，见 README）`)
    process.exit(1)
  } else {
    const scriptAbs = resolve(String(arg('script', DEFAULT_SCRIPT)))
    installOpencode(scriptAbs)
    copySkill()
    console.log('\n完成。环境变量（用户侧一次性）：')
    console.log('  export GRAPE_BASE_URL=https://www.grapedev.cn')
    console.log('  export GRAPE_API_TOKEN=grape_xxx   # WebUI 生成')
    console.log('重启 opencode 会话后生效；用 node setup.mjs doctor 验证。')
  }
} else if (cmd === 'uninstall') {
  if (target === 'workbuddy') {
    uninstallWorkbuddy()
    rmSync(join(workbuddyPaths().skillsDir, 'grape-remote'), { recursive: true, force: true })
    rmSync(join(workbuddyPaths().skillsDir, RECEIPT), { force: true })
  } else {
  const p = opencodePaths()
  const cfgPath = existsSync(p.config) ? p.config : p.configAlt
  if (existsSync(cfgPath)) {
    const text = readFileSync(cfgPath, 'utf8')
    const removed = removeGrapeEntry(text)
    if (removed) {
      const backup = `${cfgPath}.bak-grapemcp-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`
      writeFileSync(backup, text)
      writeFileSync(cfgPath, removed)
      console.log(`已移除 mcp.grape 条目（备份: ${backup}）`)
    } else {
      console.log('未发现 grape 条目，跳过')
    }
  }
  uninstallSkill()
  }
} else if (cmd === 'doctor') {
  if (target === 'workbuddy') doctorWorkbuddy(!!arg('probe'))
  else await doctor(!!arg('probe'))
} else {
  console.log('用法: node setup.mjs install|uninstall|doctor [--target opencode] [--probe]')
}
