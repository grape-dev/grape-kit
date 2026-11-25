/**
 * Issue #28 · 技能物化：把平台下发的 `bundle.assets.skill` 落成本次运行工作区里的真实文件。
 *
 * 设计约束（docs/issue-28/plan.md）：
 * - 副作用（网络 / 解压 / 写盘）集中在本模块，`grape_takeover_start` 的 render 保持同步纯函数；
 * - 零新增依赖：zip 走 Node 原生 `zlib.inflateRawSync` + 最小 ZIP 解析（仅 store / deflate）；
 * - **不抛错**：物化失败不应让已建立的接管会话失效——返回 `status:'failed'` + `reason`，由渲染显式告警；
 * - 安全：技能名白名单 + 条目路径逐段校验 + 落盘前缀校验 + 逐级 lstat 拒符号链接；恒不写 `.skills/`
 *   （worker 会 rmtree 该目录）。
 *
 * 三态：
 *   inline  `assets.skill.files`（数组或「路径→内容」映射）
 *   zip     `assets.skill.zip_url`（下载后解压，可带 `<skill>/` 顶层前缀）
 *   legacy  无 `assets.skill`（旧版平台）→ 显式提示本次未物化
 */
import { mkdirSync, lstatSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** 物化根目录名（工作区相对路径；与 `.skills/` 刻意区分——后者会被 worker 清理） */
export const SKILL_ROOT_DIRNAME = '.grape-takeover-skills'
/** 技能名白名单：首字符必须字母数字，其余限字母数字与 `._-`，长度 ≤ 64 */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 保留名：归一化前的 `.`/`..`、worker 清理用的 `.skills`、物化根本身（大小写不敏感，兼容 Windows/macOS） */
const RESERVED_SKILL_NAMES = new Set(['.', '..', '.skills', SKILL_ROOT_DIRNAME.toLowerCase()])
/** 保留名比较前的规范化：小写 + 去尾部 `.`/空格（Windows 会忽略这两类后缀） */
const normalizeReserved = (value) => {
  const name = String(value ?? '').toLowerCase()
  return name === '.' || name === '..' ? name : name.replace(/[. ]+$/, '')
}
const isReservedName = (value) => RESERVED_SKILL_NAMES.has(normalizeReserved(value))
/** 防护上限（防 zip 炸弹 / 异常大包） */
const MAX_ZIP_BYTES = 32 * 1024 * 1024
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
const MAX_ASSET_FILES = 512

const ZIP_EOCD_SIG = 0x06054b50
const ZIP_CD_SIG = 0x02014b50
const ZIP_LOCAL_SIG = 0x04034b50

class MaterializeError extends Error {}

/** CRC-32（IEEE 802.3，ZIP 条目校验用）查表实现——零依赖，避免损坏/截断条目被静默落盘 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const emptyResult = (status, patch = {}) => ({
  status,
  skill: '',
  path: '',
  fileCount: 0,
  hasReferences: false,
  reason: '',
  ...patch,
})

const failed = (reason, skill = '') => emptyResult('failed', { skill, reason: String(reason) })
const toReason = (e) => (e && e.message ? e.message : String(e))

/**
 * 技能名校验：**拒绝而不归一化**——归一化会掩盖攻击面，显式失败可审计（plan.md 决策 4）。
 * @returns {{ok: true, name: string}|{ok: false, reason: string}}
 */
export function validateSkillName(raw) {
  const name = String(raw ?? '').trim()
  if (!name) return { ok: false, reason: '技能名为空（assets.skill.skill / env.GRAPE_BOUND_SKILL 均未给出）' }
  if (isReservedName(name)) return { ok: false, reason: `技能名 "${name}" 属保留目录（大小写/尾点不敏感），拒绝物化` }
  if (/[\\/:]/.test(name) || name.includes('\u0000')) {
    return { ok: false, reason: `技能名 "${name}" 含路径分隔符/盘符/控制字符，拒绝物化` }
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `技能名 "${name}" 不在白名单 ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$，拒绝物化` }
  }
  return { ok: true, name }
}

/**
 * 条目相对路径校验：拒 NUL / 反斜杠 / 绝对路径 / 盘符 / 空段 / `.`·`..` 段 / `.skills` 段。
 * 合法段原样保留（不归一化）；`isDir` 表示以 `/` 结尾的目录条目。
 */
export function checkEntryPath(raw) {
  const text = String(raw ?? '')
  if (!text) return { ok: false, reason: '条目路径为空' }
  if (text.includes('\u0000')) return { ok: false, reason: '条目路径含控制字符（NUL）' }
  if (text.includes('\\')) return { ok: false, reason: `条目路径 "${text}" 含反斜杠（Windows 分隔符 / 盘符不可信）` }
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text)) {
    return { ok: false, reason: `条目路径 "${text}" 为绝对路径或含盘符` }
  }
  const isDir = text.endsWith('/')
  const body = isDir ? text.replace(/\/+$/, '') : text
  if (!body) return { ok: false, reason: `条目路径 "${text}" 无有效段` }
  const segments = body.split('/')
  for (const seg of segments) {
    if (!seg) return { ok: false, reason: `条目路径 "${text}" 含空段` }
    if (seg === '.' || seg === '..') return { ok: false, reason: `条目路径 "${text}" 含上跳/当前目录段` }
    if (normalizeReserved(seg) === '.skills') {
      return { ok: false, reason: `条目路径 "${text}" 落在 .skills/ 内（大小写/尾点不敏感；worker 会清理该目录，禁止写入）` }
    }
    if (seg.includes(':')) return { ok: false, reason: `条目路径 "${text}" 含盘符/备用数据流标记` }
  }
  return { ok: true, rel: segments.join('/'), isDir }
}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** 物化根：不存在则建；已存在必须是非符号链接目录（否则可被指向任意位置） */
function prepareRoot(cwd) {
  const root = join(resolve(cwd), SKILL_ROOT_DIRNAME)
  const st = lstatOrNull(root)
  if (st) {
    if (st.isSymbolicLink()) throw new MaterializeError(`物化根 "${root}" 是符号链接，拒绝写入`)
    if (!st.isDirectory()) throw new MaterializeError(`物化根 "${root}" 已存在且不是目录，拒绝写入`)
    return { rootReal: realpathSync(root), created: false }
  }
  mkdirSync(root, { recursive: true })
  return { rootReal: realpathSync(root), created: true }
}

/** 从技能目录逐段下钻建子目录：已存在段必须是非符号链接目录 */
function ensureDirPath(baseReal, relDir) {
  let cur = baseReal
  for (const seg of relDir.split('/')) {
    if (!seg) continue
    cur = join(cur, seg)
    const st = lstatOrNull(cur)
    if (st) {
      if (st.isSymbolicLink()) throw new MaterializeError(`目标目录 "${cur}" 是符号链接，拒绝写入（逃逸防护）`)
      if (!st.isDirectory()) throw new MaterializeError(`目标路径 "${cur}" 已存在且不是目录`)
      continue
    }
    mkdirSync(cur)
  }
  return cur
}

/** 写入单个条目：目录逐级校验 + 落盘前缀校验 + 目标非符号链接 */
function writeEntry(baseReal, rel, content) {
  const cut = rel.lastIndexOf('/')
  const dir = cut === -1 ? baseReal : ensureDirPath(baseReal, rel.slice(0, cut))
  const target = resolve(join(dir, cut === -1 ? rel : rel.slice(cut + 1)))
  if (target !== baseReal && !target.startsWith(baseReal + sep)) {
    throw new MaterializeError(`落盘路径 "${target}" 逃出技能目录 "${baseReal}"，拒绝写入`)
  }
  const st = lstatOrNull(target)
  if (st) {
    if (st.isSymbolicLink()) throw new MaterializeError(`目标文件 "${target}" 是符号链接，拒绝写入（逃逸防护）`)
    if (st.isDirectory()) throw new MaterializeError(`目标文件 "${target}" 已被同名的目录占用`)
  }
  writeFileSync(target, content)
}

const pickContent = (holder) => holder.content ?? holder.text ?? holder.data ?? holder.body ?? ''

/** inline 条目归一：数组形态 `{path, content}` 或「路径→内容」映射 */
function collectInlineEntries(files) {
  const out = []
  if (Array.isArray(files)) {
    for (const raw of files) {
      if (raw == null) continue
      if (typeof raw !== 'object') {
        out.push({ path: '', content: raw })
        continue
      }
      out.push({
        path: String(raw.path ?? raw.rel_path ?? raw.filename ?? raw.name ?? ''),
        content: pickContent(raw),
        base64: raw.base64 === true || raw.encoding === 'base64' || raw.encoding === 'b64',
      })
    }
    return out
  }
  if (files && typeof files === 'object') {
    for (const [p, v] of Object.entries(files)) {
      if (v == null) continue
      if (typeof v === 'object' && !Buffer.isBuffer(v)) {
        out.push({ path: p, content: pickContent(v), base64: v.base64 === true || v.encoding === 'base64' || v.encoding === 'b64' })
      } else {
        out.push({ path: p, content: v })
      }
    }
  }
  return out
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - (22 + 0xffff))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) return i
  }
  throw new MaterializeError('不是合法的 ZIP（未找到 EOCD 结束记录）')
}

/** 最小 ZIP 解析：EOCD → 中央目录 → local header；仅支持 store(0) / deflate(8) */
function parseZip(buf) {
  const eocd = findEocd(buf)
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new MaterializeError('压缩包为 zip64（或条目数溢出），当前仅支持标准 ZIP')
  }
  if (cdOffset + cdSize > buf.length) throw new MaterializeError('ZIP 中央目录越界（文件被截断）')

  const entries = []
  let off = cdOffset
  let unpacked = 0
  for (let i = 0; i < total; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== ZIP_CD_SIG) {
      throw new MaterializeError('ZIP 中央目录结构异常')
    }
    const flags = buf.readUInt16LE(off + 8)
    const method = buf.readUInt16LE(off + 10)
    const crcExpected = buf.readUInt32LE(off + 16)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const externalAttrs = buf.readUInt32LE(off + 38)
    const localOffset = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen

    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw new MaterializeError(`条目 "${name}" 使用 zip64 扩展字段，当前仅支持标准 ZIP`)
    }
    if (flags & 0x1) throw new MaterializeError(`条目 "${name}" 已加密，不支持解压`)
    // unix mode 高位标记：符号链接一律拒绝（解压 symlink 即逃逸）
    const unixMode = (externalAttrs >>> 16) & 0xffff
    if ((unixMode & 0xf000) === 0xa000) throw new MaterializeError(`条目 "${name}" 标记为符号链接，拒绝解压（逃逸防护）`)
    if (name.endsWith('/')) continue

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) {
      throw new MaterializeError(`条目 "${name}" 的 local header 损坏`)
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    const dataEnd = dataStart + csize
    if (dataEnd > buf.length) throw new MaterializeError(`条目 "${name}" 数据越界（文件被截断）`)

    // 解压前预检：声明体积超出剩余额度直接拒绝，避免先分配再判超限（防 zip 炸弹）
    const remaining = MAX_UNPACKED_BYTES - unpacked
    if (usize > remaining) {
      throw new MaterializeError(`条目 "${name}" 声明解压后 ${usize} 字节，超出剩余额度（上限 ${MAX_UNPACKED_BYTES} 字节），拒绝物化`)
    }

    const raw = buf.subarray(dataStart, dataEnd)
    let data
    if (method === 0) {
      if (csize !== usize) throw new MaterializeError(`条目 "${name}" store 长度不一致（压缩 ${csize} / 声明 ${usize}），包已损坏`)
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        // maxOutputLength 硬顶剩余额度：即使 usize 谎报，inflate 也不会突破全局上限
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, remaining) })
      } catch (e) {
        throw new MaterializeError(`条目 "${name}" deflate 解压失败：${toReason(e)}`)
      }
    } else {
      throw new MaterializeError(`条目 "${name}" 使用不支持的压缩方式 ${method}（仅 store/deflate）`)
    }
    if (data.length !== usize) {
      throw new MaterializeError(`条目 "${name}" 解压长度 ${data.length} 与声明 ${usize} 不一致（包损坏/截断），拒绝物化`)
    }
    if (crc32(data) !== crcExpected) throw new MaterializeError(`条目 "${name}" CRC 校验失败（包损坏/截断），拒绝物化`)
    unpacked += data.length
    if (unpacked > MAX_UNPACKED_BYTES) throw new MaterializeError('解压后体积超限，拒绝物化')
    entries.push({ path: name, content: data })
  }
  if (entries.length > MAX_ASSET_FILES) throw new MaterializeError(`条目数超过上限 ${MAX_ASSET_FILES}，拒绝物化`)
  return entries
}

async function collectZipEntries(asset, opts, name) {
  const url = String(asset.zip_url ?? asset.zipUrl ?? '').trim()
  if (!url) return null
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new MaterializeError('当前运行环境无 fetch 实现，无法下载 zip_url')
  const res = await fetchImpl(url)
  if (!res || typeof res !== 'object') throw new MaterializeError('zip 下载返回不可识别')
  if (res.ok === false || (typeof res.status === 'number' && (res.status < 200 || res.status >= 300))) {
    throw new MaterializeError(`技能 zip 下载失败：HTTP ${res.status ?? '未知'}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new MaterializeError('技能 zip 为空（0 字节）')
  if (buf.length > MAX_ZIP_BYTES) throw new MaterializeError(`技能 zip 超过 ${MAX_ZIP_BYTES} 字节上限`)
  const entries = parseZip(buf)
  // 平台 zip 常带 `<skill>/` 顶层前缀：全条目同前缀才剥离（混合结构保持原样）
  const prefix = `${name}/`
  return entries.every((e) => e.path.startsWith(prefix)) ? entries.map((e) => ({ ...e, path: e.path.slice(prefix.length) })) : entries
}

/**
 * 物化 `assets.skill` 到 `<cwd>/.grape-takeover-skills/<skill>/`。
 *
 * @param {object|null|undefined} skill 平台下发的 `bundle.assets.skill`（`skill`/`name` + `files` 或 `zip_url`）
 * @param {string} cwd 工作目录（`bundle.workspace.cwd_hint || process.cwd()`）
 * @param {{fetchImpl?: Function, env?: object}} [options] 可注入 fetch（单测）与 env（技能名回退 GRAPE_BOUND_SKILL）
 * @returns {Promise<{status: 'ok'|'legacy'|'failed', skill: string, path: string, fileCount: number, hasReferences: boolean, reason: string}>}
 */
export async function materializeSkillAssets(skill, cwd, options = {}) {
  const opts = options || {}
  const env = opts.env || process.env || {}
  const asset = skill && typeof skill === 'object' ? skill : null

  if (!asset) {
    const fallback = validateSkillName(env.GRAPE_BOUND_SKILL)
    return emptyResult('legacy', {
      skill: fallback.ok ? fallback.name : '',
      reason: '平台未下发 assets.skill（legacy 接管包）：本次未物化技能，SKILL.md 需按 env.GRAPE_BOUND_SKILL 自行获取',
    })
  }

  const nameCheck = validateSkillName(asset.skill ?? asset.name ?? env.GRAPE_BOUND_SKILL)
  if (!nameCheck.ok) return failed(nameCheck.reason)
  const name = nameCheck.name

  let entries
  try {
    entries = collectInlineEntries(asset.files ?? null)
    if (!entries.length) entries = await collectZipEntries(asset, opts, name)
  } catch (e) {
    return failed(`技能包解析失败：${toReason(e)}`, name)
  }
  if (!entries || !entries.length) {
    return failed(
      asset.files == null
        ? 'assets.skill 既无 files 也无 zip_url（无内容可物化）'
        : 'assets.skill.files 形态不可识别或为空（需条目数组或「路径→内容」映射）',
      name,
    )
  }

  // 两段式：先校验全部条目路径（失败即返回，盘上零副作用），再落盘
  const checked = []
  try {
    for (const entry of entries) {
      const chk = checkEntryPath(entry.path)
      if (!chk.ok) throw new MaterializeError(chk.reason)
      checked.push({ ...entry, rel: chk.rel, isDir: chk.isDir })
    }
  } catch (e) {
    return failed(toReason(e), name)
  }

  const baseDir = resolve(String(cwd || process.cwd()))
  let root
  try {
    root = prepareRoot(baseDir)
  } catch (e) {
    return failed(toReason(e), name)
  }
  const rootReal = root.rootReal

  const targetDir = join(rootReal, name)
  const existing = lstatOrNull(targetDir)
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    return failed(`目标目录 "${targetDir}" 是符号链接或非目录，拒绝写入`, name)
  }
  const createdByUs = !existing
  let fileCount = 0
  let hasReferences = false
  try {
    if (createdByUs) mkdirSync(targetDir)
    for (const entry of checked) {
      if (entry.isDir) {
        ensureDirPath(targetDir, entry.rel)
        continue
      }
      const content = entry.base64 ? Buffer.from(String(entry.content ?? ''), 'base64') : entry.content ?? ''
      writeEntry(targetDir, entry.rel, content)
      fileCount += 1
      if (/(^|\/)references\//.test(entry.rel)) hasReferences = true
    }
  } catch (e) {
    // 半成品清理：只删本次新建的目标目录，不动上一轮已成功的物化结果（幂等覆盖语义）
    if (createdByUs) {
      try {
        rmSync(targetDir, { recursive: true, force: true })
      } catch {
        /* 清理失败不改变失败结论 */
      }
      if (root.created) {
        try {
          rmSync(rootReal, { recursive: false, force: true })
        } catch {
          /* 根目录非空（并发物化）时保留，不改变失败结论 */
        }
      }
    }
    return failed(toReason(e), name)
  }

  return { status: 'ok', skill: name, path: targetDir, fileCount, hasReferences, reason: '' }
}