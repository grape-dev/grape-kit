/**
 * 最小 ZIP 写入器（store 模式，零依赖）——技能上传要用 multipart ZIP，
 * 而 Node 标准库没有 zip 打包能力；宿主机上装 7z/zip 又不可控（Windows/POSIX 差异）。
 *
 * 只做平台 `POST /api/skills/upload` 需要的那一件事：把目录打成
 * `<顶层目录>/...` 结构的合法 ZIP。store（不压缩）对 SKILL.md 这类文本完全够用，
 * 也避免了 deflate 实现带来的体积/兼容风险；文件名按 UTF-8 标记（flag 0x0800），
 * 中文文件名在服务端 zipfile 解压不会乱码。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/** DOS 时间/日期（zip 只存这两个 16 位字段，精度 2s） */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store', '.idea', '.vscode'])

function collectFiles(dir, base, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) collectFiles(abs, base, out)
    else if (st.isFile()) out.push({ abs, rel: relative(base, abs).split(sep).join('/') })
  }
  return out
}

/**
 * 把目录打成 ZIP（顶层目录固定用 rootName，服务端据此识别技能目录名）。
 *
 * @param {string} dir 技能源码目录（须已含 SKILL.md）
 * @param {{rootName?: string}} [opts] 顶层目录名，缺省取目录 basename
 * @returns {{buffer: Buffer, rootName: string, files: string[]}}
 */
export function zipDirectory(dir, { rootName } = {}) {
  const name = String(rootName || dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')
  if (!name) throw new Error(`无法确定技能目录名：${dir}`)
  const files = collectFiles(dir, dir)
  if (!files.length) throw new Error(`目录为空：${dir}`)

  const { time, date } = dosDateTime()
  const locals = []
  const centrals = []
  let offset = 0

  for (const f of files) {
    const data = readFileSync(f.abs)
    const entryName = Buffer.from(`${name}/${f.rel}`, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // flags: UTF-8 names
    local.writeUInt16LE(0, 8)           // method: store
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(entryName.length, 26)
    local.writeUInt16LE(0, 28)          // extra len
    locals.push(local, entryName, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)        // version made by
    central.writeUInt16LE(20, 6)        // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(entryName.length, 28)
    central.writeUInt16LE(0, 30)        // extra
    central.writeUInt16LE(0, 32)        // comment
    central.writeUInt16LE(0, 34)        // disk start
    central.writeUInt16LE(0, 36)        // internal attrs
    central.writeUInt32LE(0, 38)        // external attrs
    central.writeUInt32LE(offset, 42)   // local header offset
    centrals.push(central, entryName)

    offset += local.length + entryName.length + data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return { buffer: Buffer.concat([...locals, centralBuf, eocd]), rootName: name, files: files.map((f) => f.rel) }
}