/**
 * 凭据清理通道（rc 文件 + Windows 用户环境变量）——单一实现，两平台共用。
 *
 * 为什么单列成模块：
 * - Issue #38 的缺陷根因就是「同一份清理逻辑被平台分支切成两半」——`scanResidues()` 的 rc 段
 *   包在非 win32 才执行的块里、`cleanEnvVars()` 的 win32 分支删完注册表就 return，于是 Git Bash
 *   读取的 `.bashrc` / `.bash_profile` / `config.fish` 在 Windows 上从不被清理（凭据留盘）。
 *   扫描、清理、备份掩码必须同源，否则必然再次漂移。
 * - 同时它是测试缝：平台与 `reg` 运行器可注入，非 win32 宿主（CI）也能回归 win32 双通道行为，
 *   且用例不会真的 `spawnSync(reg)` 造出 ENOENT 噪声。CLI 入口（grape-kit.mjs）因此不需要导出
 *   内部函数、也不需要「入口 vs import.meta.url」守卫——对外 CLI 行为与改动前一致。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 需要清理的用户级环境变量（rc 与注册表两条通道共用同一名单） */
export const CREDENTIAL_ENV_KEYS = ['GRAPE_API_TOKEN', 'GRAPE_BASE_URL']

/** 凭据导出行三种形态（QA#PR13 判断项 3：旧实现只认 `export`，`declare -x`、`.bash_profile`
 *  与 fish 的 `set -x` 全都不清不掩，「未发现导出行（跳过）」等于谎报）： */
const POSIX_CREDENTIAL_LINE_RE = /^\s*(?:export|declare\s+-x)\s+(GRAPE_API_TOKEN|GRAPE_BASE_URL)\s*=/
const FISH_CREDENTIAL_LINE_RE = /^\s*set\s+(?:-x|-gx|--export)\s+(GRAPE_API_TOKEN|GRAPE_BASE_URL)(?:\s|$)/

const BOM = '\uFEFF'

/** 扫描目标：POSIX 常见 rc（含仅登录 shell 读的 .bash_profile）+ fish 配置；kind 决定行形态。
 *  homeDir 默认 homedir()：win32 下即 USERPROFILE，与 Git Bash 读取位置一致（单一扫描源）。 */
function rcTargets(homeDir = homedir()) {
  return [
    { path: join(homeDir, '.zshrc'), kind: 'posix' },
    { path: join(homeDir, '.bashrc'), kind: 'posix' },
    { path: join(homeDir, '.bash_profile'), kind: 'posix' },
    { path: join(homeDir, '.profile'), kind: 'posix' },
    { path: join(homeDir, '.config', 'fish', 'config.fish'), kind: 'fish' },
  ]
}

/** 该行是否导出凭据：命中返回变量名，否则 null（扫描、清理、掩码共用同一判据） */
function credentialLineKey(line, kind) {
  const m = (kind === 'fish' ? FISH_CREDENTIAL_LINE_RE : POSIX_CREDENTIAL_LINE_RE).exec(line)
  return m ? m[1] : null
}

/** rc 文件的 .bak-grapemcp-* 备份清单（本工具备份命名空间，与 rc 同目录同名前缀） */
function rcBackupPathsOf(rcPath) {
  const dir = dirname(rcPath)
  const prefix = `${basename(rcPath)}.bak-grapemcp-`
  try { return readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f)) } catch { return [] }
}

/** rc 扫描：返回待清理行与「含凭据的旧备份」两份清单（清理与检测必须读同一份结果） */
export function scanRcResidues(homeDir = homedir()) {
  const rcHits = []
  const rcCredentialBackups = []
  for (const { path: rc, kind } of rcTargets(homeDir)) {
    if (!existsSync(rc)) continue
    let lines
    try { lines = readFileSync(rc, 'utf8').split('\n') } catch { continue }
    const hits = lines.filter((line) => credentialLineKey(line, kind)).length
    if (hits) rcHits.push({ path: rc, kind, hits })
    for (const b of rcBackupPathsOf(rc)) {
      try {
        if (readFileSync(b, 'utf8').split('\n').some((line) => credentialLineKey(line, kind))) rcCredentialBackups.push(b)
      } catch { /* 忽略 */ }
    }
  }
  return { rcHits, rcCredentialBackups }
}

/**
 * 文件内容 → 清理结果与掩码备份文本（纯函数，BOM/CRLF 保真的唯一实现处）。
 * - 备份取「原文但凭据行掩码」：非凭据行原样保留可回滚，凭据行以注释掩码标注位置
 *   （含凭据的备份等于换个文件名把 token 留盘）；备份与清理结果共用同一份行判据。
 * - 行尾保真：按 '\n' 分割，各行尾部残留的 '\r' 原样带入，CRLF 文件不会被改成 LF。
 * - BOM 保真：BOM 只存在于原文首行行首，首行恰好是凭据行时会被整行删掉——此时把 BOM
 *   迁移到新首行，否则 Windows/Git Bash 上的 rc 编码风格悄然改变（Issue #38 边界缺陷）。
 */
export function planRcCleanup(text, kind) {
  const lines = text.split('\n')
  const hits = lines.filter((line) => credentialLineKey(line, kind)).length
  const kept = lines.filter((line) => !credentialLineKey(line, kind))
  const masked = lines.map((line) => {
    const key = credentialLineKey(line, kind)
    return key ? `# [grape-kit --clean-global 已移除凭据行] ${key}` : line
  })
  return { hits, cleaned: keepBom(text, kept).join('\n'), masked: keepBom(text, masked).join('\n') }
}

/** 原文带 BOM 而结果首行不带时把 BOM 补到新首行（空结果只在原文全是凭据行时出现） */
function keepBom(originalText, lines) {
  if (!originalText.startsWith(BOM) || lines.length === 0 || lines[0].startsWith(BOM)) return lines
  const next = lines.slice()
  next[0] = BOM + lines[0]
  return next
}

/**
 * 清理 rc 通道：删除凭据行（保留原 CRLF/BOM）、留掩码备份、删除旧版含凭据备份。
 * 不返回「是否改动」——调用方不需要该值，需要的是逐条可读输出（QA 判断项 5）。
 * backupOf 由宿主注入（备份命名/去重属 CLI 侧关注点）。
 */
function cleanRcResidues(residues, { backupOf, log = console.log } = {}) {
  for (const hit of residues.rcHits) {
    const { hits, cleaned, masked } = planRcCleanup(readFileSync(hit.path, 'utf8'), hit.kind)
    const backup = backupOf(hit.path, masked)
    writeFileSync(hit.path, cleaned)
    log(`  已从 ${hit.path} 删除 ${hits} 行 GRAPE_* 导出（备份保留非凭据原文+凭据行掩码: ${backup}）`)
  }
  for (const b of residues.rcCredentialBackups) {
    rmSync(b, { force: true })
    log(`  已删除含凭据的旧备份: ${b}`)
  }
  if (!residues.rcHits.length && !residues.rcCredentialBackups.length) {
    log('  未在 shell 配置文件发现 GRAPE_API_TOKEN/GRAPE_BASE_URL 导出行（跳过）')
  }
}

const regOf = (args) => spawnSync('reg', args, { encoding: 'utf8' })

/**
 * 清理 Windows 用户级环境变量（注册表通道，Issue #38 判断项 6：从 cleanEnvVars 单列）。
 * 只读调用方传入的扫描结果，不自行 `reg query`（与残留提示同源）；删除失败必须可见，不吞错；
 * 查询失败 ≠ 不存在——不得报「未发现（跳过）」蒙混过去（QA#PR13 判断项 4）。
 * reg 运行器可注入：用例以替身覆盖，避免在非 win32 宿主上真的 spawn。
 */
function cleanWindowsUserEnvVars(residues, { reg = regOf, log = console.log, warn = console.warn } = {}) {
  for (const name of CREDENTIAL_ENV_KEYS) {
    const unreadable = residues.regErrors.find((e) => e.key === name)
    if (unreadable && !residues.envKeys.includes(name)) {
      warn(`  无法确认用户环境变量 ${name} 是否存在（${unreadable.detail}），请人工核对 HKCU\\Environment`)
      continue
    }
    if (!residues.envKeys.includes(name)) { log(`  未发现用户环境变量: ${name}（跳过）`); continue }
    const d = reg(['delete', 'HKCU\\Environment', '/v', name, '/f'])
    if (d.status === 0) log(`  已删除用户环境变量: ${name}`)
    else warn(`  删除用户环境变量 ${name} 失败（reg exit=${d.status}，可能仅存在于当前会话环境），请人工处理`)
  }
  log('  提示：已运行中的宿主会话读不到删除结果，需重启宿主/终端后生效。')
}

/**
 * 用户级凭据删除总入口：注册表与 rc 是**两条并列通道**。
 * Issue #38 主修复：win32 分支删完注册表后不再提前 return，继续走与非 win32 同一份 rc 清理器
 * ——Windows 上 Git Bash 读的是 USERPROFILE 下的 rc，只清注册表等于留盘。
 * scan 为宿主注入的单一扫描源（grape-kit.mjs 的 scanResidues：含 grapeHome / authFile / npx）。
 */
export function cleanCredentialChannels({ scan, backupOf, platform = process.platform, reg, log, warn } = {}) {
  if (typeof scan !== 'function') throw new TypeError('cleanCredentialChannels 需要 scan()：清理必须读单一扫描源的同一份结果')
  const residues = scan()
  if (platform === 'win32') cleanWindowsUserEnvVars(residues, { reg, log, warn })
  cleanRcResidues(residues, { backupOf, log })
}