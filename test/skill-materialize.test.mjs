import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { materializeSkillAssets, validateSkillName, SKILL_ROOT_DIRNAME } from '../src/skill-materialize.mjs'
import { findTool } from '../src/tools.mjs'
import { api } from '../src/api.mjs'

/* ── Issue #28：takeover_start 物化 assets.skill 到 <cwd>/.grape-takeover-skills/<skill>/ ──
 * seam：materializeSkillAssets（模块公开导出，可注入 fetch）+ grape_takeover_start.render（既有同步直调）*/

const tmp = () => mkdtempSync(join(tmpdir(), 'grape-skill-'))
const real = (p) => realpathSync(p)
const drop = (p) => rmSync(p, { recursive: true, force: true })

/* 最小 ZIP 构造器（测试夹具；真实包由平台 `zip` 生成，解压端只认 store/deflate） */
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** entries: [{ name, data, method: 'store'|'deflate', symlink?, rawMethod? }] */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8')
    const method = e.rawMethod ?? (e.method === 'deflate' ? 8 : 0)
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, payload)

    const mode = e.symlink ? 0o120777 << 16 : 0o100644 << 16
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(mode >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + payload.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const zipFetch = (buf, calls = []) => async (url) => {
  calls.push(url)
  return new Response(new Uint8Array(buf), { status: 200 })
}

/* ── F1 三态之一：inline ── */

test('F1 inline：assets.skill.files 落到 <cwd>/.grape-takeover-skills/<skill>/，SKILL.md 与 references 可读', async () => {
  const cwd = tmp()
  try {
    const before = readdirSync(cwd).sort()
    const r = await materializeSkillAssets(
      {
        skill: 'coding-cli',
        files: [
          { path: 'SKILL.md', content: '# coding-cli\n1. 先读 runbook\n' },
          { path: 'references/runbook.md', content: 'runbook 正文' },
        ],
      },
      cwd,
    )
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.skill, 'coding-cli')
    assert.equal(r.fileCount, 2)
    assert.equal(r.hasReferences, true)
    assert.equal(r.reason, '')
    assert.equal(r.path, join(real(cwd), SKILL_ROOT_DIRNAME, 'coding-cli'))
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), '# coding-cli\n1. 先读 runbook\n')
    assert.equal(readFileSync(join(r.path, 'references', 'runbook.md'), 'utf8'), 'runbook 正文')
    // 目录快照：只多出物化根，不产生 .skills/
    assert.deepEqual(readdirSync(cwd).sort(), [...before, SKILL_ROOT_DIRNAME].sort())
    assert.ok(!existsSync(join(cwd, '.skills')), '不得写 .skills/（worker 会 rmtree 该目录）')
  } finally {
    drop(cwd)
  }
})

test('F1b inline：files 为「路径→内容」映射形态也能落盘', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets({ name: 'map-skill', files: { 'SKILL.md': 'map 正文', 'references/x.md': { content: 'x 正文' } } }, cwd)
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.fileCount, 2)
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), 'map 正文')
    assert.equal(readFileSync(join(r.path, 'references', 'x.md'), 'utf8'), 'x 正文')
  } finally {
    drop(cwd)
  }
})

test('F1c inline：幂等覆盖——重复物化不叠加文件，内容以最新下发为准', async () => {
  const cwd = tmp()
  try {
    const skill = { skill: 'idem', files: [{ path: 'SKILL.md', content: 'v1' }] }
    const first = await materializeSkillAssets(skill, cwd)
    assert.equal(first.fileCount, 1)
    const second = await materializeSkillAssets({ skill: 'idem', files: [{ path: 'SKILL.md', content: 'v2' }] }, cwd)
    assert.equal(second.status, 'ok', second.reason)
    assert.equal(second.fileCount, 1)
    assert.equal(readFileSync(join(second.path, 'SKILL.md'), 'utf8'), 'v2')
    assert.deepEqual(readdirSync(second.path), ['SKILL.md'])
  } finally {
    drop(cwd)
  }
})

/* ── F2 三态之二：zip ── */

test('F2 zip：下载 zip_url 并零依赖解压（store/deflate 混合 + <skill>/ 顶层前缀剥离）', async () => {
  const cwd = tmp()
  try {
    const buf = buildZip([
      { name: 'grape-remote/', data: '', method: 'store' },
      { name: 'grape-remote/SKILL.md', data: '# zip skill', method: 'deflate' },
      { name: 'grape-remote/references/tips.md', data: 'zip ref', method: 'store' },
    ])
    const calls = []
    const r = await materializeSkillAssets({ skill: 'grape-remote', zip_url: 'https://example.test/skill.zip' }, cwd, { fetchImpl: zipFetch(buf, calls) })
    assert.equal(r.status, 'ok', r.reason)
    assert.deepEqual(calls, ['https://example.test/skill.zip'], '应按 zip_url 下载一次')
    assert.equal(r.fileCount, 2, '目录条目不计入文件数')
    assert.equal(r.hasReferences, true)
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), '# zip skill')
    assert.equal(readFileSync(join(r.path, 'references', 'tips.md'), 'utf8'), 'zip ref')
  } finally {
    drop(cwd)
  }
})

test('F2b zip：下载失败显式 failed（不静默、不建目录、不抛错）', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets({ skill: 'z', zip_url: 'https://example.test/missing.zip' }, cwd, {
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /404/)
    assert.deepEqual(readdirSync(cwd), [], '失败后不留半成品目录')
  } finally {
    drop(cwd)
  }
})

test('F2c zip：不支持 zip64 / 非 store-deflate 压缩方式 → failed + 明确原因', async () => {
  const cwd = tmp()
  try {
    const zip64 = buildZip([{ name: 'z64/SKILL.md', data: 'x', method: 'store' }])
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16) // EOCD.cdOffset 置 0xFFFFFFFF = zip64 标记
    const r64 = await materializeSkillAssets({ skill: 'z64', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(zip64) })
    assert.equal(r64.status, 'failed')
    assert.match(r64.reason, /zip64/)

    const bzip = buildZip([{ name: 'bz/SKILL.md', data: 'x', rawMethod: 12 }])
    const rbz = await materializeSkillAssets({ skill: 'bz', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(bzip) })
    assert.equal(rbz.status, 'failed')
    assert.match(rbz.reason, /压缩方式/)

    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

/* ── F2d-F2f 解压上限与完整性（复审 Required） ── */

const cdOffsetOf = (buf) => buf.readUInt32LE(buf.length - 22 + 16)

test('F2d zip：单条目声明解压体积超上限 → usize 预检直接 failed（不进入 inflate 大分配）', async () => {
  const cwd = tmp()
  try {
    const buf = buildZip([{ name: 'bomb/SKILL.md', data: '# ok', method: 'store' }])
    buf.writeUInt32LE(64 * 1024 * 1024 + 1, cdOffsetOf(buf) + 24) // 中央目录 usize 谎报为 64MB+1
    const r = await materializeSkillAssets({ skill: 'bomb', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(buf) })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /额度|上限|超限/)
    assert.equal(r.path, '')
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('F2e zip：usize 谎报偏小、实际膨胀超全局上限 → inflate maxOutputLength 兜底 failed', async () => {
  const cwd = tmp()
  try {
    const big = Buffer.alloc(64 * 1024 * 1024 + 1024, 0x61)
    const buf = buildZip([{ name: 'bomb/SKILL.md', data: big, method: 'deflate' }])
    buf.writeUInt32LE(1024, cdOffsetOf(buf) + 24) // 声明 1KB，实际 64MB+
    const r = await materializeSkillAssets({ skill: 'bomb', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(buf) })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /deflate 解压失败|Buffer|上限|超限/i)
    assert.equal(r.path, '')
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('F2f zip：条目内容与 CRC 不符 → failed（损坏/截断内容不得落盘）', async () => {
  const cwd = tmp()
  try {
    const buf = buildZip([{ name: 'crc/SKILL.md', data: 'abcdef', method: 'store' }])
    const i = buf.indexOf(Buffer.from('abcdef'))
    assert.ok(i > 0, '测试夹具应包含正文字节')
    buf[i] = 0x41 // 内容 'A'bcdef，长度不变、CRC 不符
    const r = await materializeSkillAssets({ skill: 'crc', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(buf) })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /CRC/)
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

/* ── F3 三态之三：legacy ── */

test('F3 legacy：无 assets.skill 不落盘、不抛错，显式返回 legacy + 原因（技能名回退 env.GRAPE_BOUND_SKILL）', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets(undefined, cwd)
    assert.equal(r.status, 'legacy')
    assert.match(r.reason, /assets\.skill/)
    assert.equal(r.path, '')
    assert.equal(r.fileCount, 0)
    assert.equal(r.hasReferences, false)
    assert.deepEqual(readdirSync(cwd), [], 'legacy 不得落任何盘')

    const withEnv = await materializeSkillAssets(null, cwd, { env: { GRAPE_BOUND_SKILL: 'coding-cli' } })
    assert.equal(withEnv.status, 'legacy')
    assert.equal(withEnv.skill, 'coding-cli', '技能名回退 env.GRAPE_BOUND_SKILL 供渲染展示')
  } finally {
    drop(cwd)
  }
})

/* ── E 逃逸拒绝：路径穿越 / 绝对路径 / 反斜杠盘符 / .skills / 符号链接 ── */

test('E1 路径穿越：../ 条目被拒绝，且父目录不产生文件', async () => {
  const base = tmp()
  const cwd = join(base, 'ws')
  try {
    mkdirSync(cwd)
    const r = await materializeSkillAssets({ skill: 's1', files: [{ path: '../evil.md', content: 'pwn' }] }, cwd)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /\.\.|上跳/)
    assert.ok(!existsSync(join(base, 'evil.md')), '穿越目标不得落盘')
    assert.deepEqual(readdirSync(cwd), [], '失败后不留半成品目录')
  } finally {
    drop(base)
  }
})

test('E2 绝对路径与 Windows 盘符/反斜杠条目被拒绝', async () => {
  const cwd = tmp()
  try {
    const abs = await materializeSkillAssets({ skill: 's2', files: [{ path: '/tmp/evil-abs.md', content: 'pwn' }] }, cwd)
    assert.equal(abs.status, 'failed')
    assert.match(abs.reason, /绝对路径|盘符/)

    const drive = await materializeSkillAssets({ skill: 's2', files: [{ path: 'C:/evil.md', content: 'pwn' }] }, cwd)
    assert.equal(drive.status, 'failed')
    assert.match(drive.reason, /绝对路径|盘符/)

    const backslash = await materializeSkillAssets({ skill: 's2', files: [{ path: 'references\\evil.md', content: 'pwn' }] }, cwd)
    assert.equal(backslash.status, 'failed')
    assert.match(backslash.reason, /反斜杠/)

    assert.ok(!existsSync('/tmp/evil-abs.md'), '绝对路径目标不得落盘')
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('E3 .skills 段与保留技能名（.skills / .. / 非法字符）一律拒绝物化', async () => {
  const cwd = tmp()
  try {
    const inSkills = await materializeSkillAssets({ skill: 's3', files: [{ path: '.skills/x.md', content: 'pwn' }] }, cwd)
    assert.equal(inSkills.status, 'failed')
    assert.match(inSkills.reason, /\.skills/)

    for (const [name, re] of [
      ['.skills', /保留/],
      ['..', /保留/],
      ['a/b', /分隔符|盘符|白名单/],
      ['bad name!', /白名单/],
      ['', /为空/],
    ]) {
      const r = await materializeSkillAssets({ skill: name, files: [{ path: 'SKILL.md', content: 'x' }] }, cwd)
      assert.equal(r.status, 'failed', `技能名 ${JSON.stringify(name)} 应被拒绝`)
      assert.match(r.reason, re)
    }
    assert.ok(!existsSync(join(cwd, '.skills')))
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('E4 符号链接目录逃逸被拒：目标目录已是 symlink 时不写入，外部目录不受影响', async () => {
  const base = tmp()
  const cwd = join(base, 'ws')
  const outside = join(base, 'outside')
  try {
    mkdirSync(cwd)
    mkdirSync(outside)
    const root = join(cwd, SKILL_ROOT_DIRNAME, 's4')
    mkdirSync(root, { recursive: true })
    symlinkSync(outside, join(root, 'references'))

    const r = await materializeSkillAssets({ skill: 's4', files: [{ path: 'references/x.md', content: 'pwn' }] }, cwd)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /符号链接/)
    assert.deepEqual(readdirSync(outside), [], '符号链接指向的外部目录不得被写入')
  } finally {
    drop(base)
  }
})

test('E5 zip 条目标记为符号链接（S_IFLNK）被拒绝解压', async () => {
  const cwd = tmp()
  try {
    const buf = buildZip([
      { name: 'link-skill/SKILL.md', data: '# ok', method: 'store' },
      { name: 'link-skill/references/passwd', data: '/etc/passwd', method: 'store', symlink: true },
    ])
    const r = await materializeSkillAssets({ skill: 'link-skill', zip_url: 'u' }, cwd, { fetchImpl: zipFetch(buf) })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /符号链接/)
    assert.deepEqual(readdirSync(cwd), [], '失败后不留半成品目录')
  } finally {
    drop(cwd)
  }
})

test('E6 条目路径 .SKILLS / .skills. 等大小写与尾点变体一律拒绝（Windows/macOS 文件系统不敏感）', async () => {
  const cwd = tmp()
  try {
    for (const bad of ['.SKILLS/x', '.Skills/x', '.skills./x']) {
      const r = await materializeSkillAssets({ skill: 'variant', files: [{ path: bad, content: 'pwn' }] }, cwd)
      assert.equal(r.status, 'failed', `${bad} 应被拒绝`)
      assert.match(r.reason, /\.skills/i)
    }
    assert.deepEqual(readdirSync(cwd), [], '拒绝时盘上零副作用')
  } finally {
    drop(cwd)
  }
})

/* ── Issue #39：OBS 引用形态（files 条目仅含 __obs_key__）不得写成 0 字节空文件 ──
 * seam：materializeSkillAssets（模块公开导出）——下载端点经 opts.skillDownload、zip 传输经 opts.fetchImpl 注入；
 * 渲染经 grape_takeover_start.render（既有同步纯函数）。两者都是 #28 已协商的同一 seam，无新建内部 seam。 */

/** 盘上所有文件（递归），用于断言「没有 0 字节文件」这一用户可见症状 */
function walkFiles(dir) {
  const out = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

const assertNoEmptyFile = (dir) => {
  const files = walkFiles(dir)
  assert.ok(files.length > 0, '应至少物化出一个文件')
  for (const f of files) assert.ok(statSync(f).size > 0, `不得出现 0 字节文件：${f}`)
}

/** Issue #39 现场载荷形状：files 唯一条目只持 OBS 引用键 */
const obsAsset = (name = 'coding-cli', extra = {}) => ({
  name,
  mode: 'inline',
  files: { [name]: { __obs_key__: `grape/skills/official/${name}/${name}.zip` } },
  ...extra,
})

/** 引用形态技能包（带 `<skill>/` 顶层前缀，与平台 zip 一致） */
const skillZip = (name = 'coding-cli') =>
  buildZip([
    { name: `${name}/`, data: '', method: 'store' },
    { name: `${name}/SKILL.md`, data: '# coding-cli\n1. 先读 runbook\n', method: 'deflate' },
    { name: `${name}/references/runbook.md`, data: 'runbook 正文', method: 'store' },
  ])

test('F4 引用形态：files 仅含 __obs_key__ → 经下载端点拉 zip 物化真实 SKILL.md（不再 0 字节）', async () => {
  const cwd = tmp()
  try {
    const calls = []
    const downloads = []
    const r = await materializeSkillAssets(obsAsset('coding-cli', { skill_id: 'skill-42' }), cwd, {
      repo: 'grape-dev/grape-kit',
      skillDownload: async (skillId, repoKey) => {
        downloads.push([skillId, repoKey])
        return { url: 'https://obs.example.test/signed-coding-cli.zip', expires_in: 600 }
      },
      fetchImpl: zipFetch(skillZip(), calls),
    })
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.skill, 'coding-cli')
    assert.deepEqual(downloads, [['skill-42', 'grape-dev/grape-kit']], '应按技能标识请求下载端点（带仓库上下文）')
    assert.deepEqual(calls, ['https://obs.example.test/signed-coding-cli.zip'], '应只拉取短签 URL 一次')
    assert.equal(r.fileCount, 2, '目录条目不计入文件数')
    assert.equal(r.hasReferences, true)
    assert.equal(r.source, 'reference', '渲染需要如实标注来源为引用形态拉取')
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), '# coding-cli\n1. 先读 runbook\n')
    assert.equal(readFileSync(join(r.path, 'references', 'runbook.md'), 'utf8'), 'runbook 正文')
    assertNoEmptyFile(r.path)
  } finally {
    drop(cwd)
  }
})

test('F5 引用形态：下载端点失败 → failed + 明示需服务端转 inline/zip_url，盘上零副作用', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets(obsAsset('coding-cli', { skill_id: 'skill-42' }), cwd, {
      skillDownload: async () => {
        throw new Error('grape API 403: 技能下载只接受用户级凭据')
      },
    })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /引用形态技能需服务端转 inline\/zip_url 下发/)
    assert.match(r.reason, /403/, '端点失败原因必须透出（不吞错）')
    assert.equal(r.path, '')
    assert.equal(r.fileCount, 0)
    assert.deepEqual(readdirSync(cwd), [], '失败后不留半成品目录/空文件')
  } finally {
    drop(cwd)
  }
})

test('F6 引用形态：既无 skill_id 也无 URL → 不发起盲请求，failed 且盘上零副作用', async () => {
  const cwd = tmp()
  try {
    const calls = []
    const r = await materializeSkillAssets(obsAsset(), cwd, { fetchImpl: zipFetch(skillZip(), calls) })
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /引用形态技能需服务端转 inline\/zip_url 下发/)
    assert.match(r.reason, /__obs_key__|skill_id|zip_url/, '原因应指明缺什么')
    assert.deepEqual(calls, [], '无解析来源时不得盲猜 URL 发起请求')
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('F7 引用形态：资产内已带短签 URL（zip_url）时直接拉取，同样不落空文件', async () => {
  const cwd = tmp()
  try {
    const calls = []
    const r = await materializeSkillAssets(
      { ...obsAsset('coding-cli'), zip_url: 'https://obs.example.test/signed.zip' },
      cwd,
      { fetchImpl: zipFetch(skillZip(), calls) },
    )
    assert.equal(r.status, 'ok', r.reason)
    assert.deepEqual(calls, ['https://obs.example.test/signed.zip'])
    assert.equal(r.source, 'reference')
    assertNoEmptyFile(r.path)
  } finally {
    drop(cwd)
  }
})

test('F8 混合形态（部分 inline + 部分引用）→ failed，不静默只落部分内容', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets(
      { name: 'mixed', files: { 'SKILL.md': '只有一半内容', 'references/x.md': { __obs_key__: 'grape/skills/official/mixed/x.zip' } } },
      cwd,
    )
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /引用形态技能需服务端转 inline\/zip_url 下发/)
    assert.deepEqual(readdirSync(cwd), [], '不得把占位条目或半份内容落盘')
  } finally {
    drop(cwd)
  }
})

test('F9 条目既无内容字段也无引用键 → 显式 failed（移除 ?? \'\' 空文件兜底）', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets({ skill: 'noop', files: [{ path: 'SKILL.md' }] }, cwd)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /内容|引用/, '应点明条目缺少内容/引用键')
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

/* ── Z 其他边界 ── */

test('Z1 assets.skill 既无 files 也无 zip_url → failed（不静默当 legacy）', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets({ skill: 'empty' }, cwd)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /无内容|files|zip_url/)
  } finally {
    drop(cwd)
  }
})

test('Z1b assets.skill.files 形态不可识别（非数组/非映射）→ failed 且点明形态要求', async () => {
  const cwd = tmp()
  try {
    const r = await materializeSkillAssets({ skill: 'bad-shape', files: 'SKILL.md 裸字符串' }, cwd)
    assert.equal(r.status, 'failed')
    assert.match(r.reason, /形态不可识别/)
    assert.deepEqual(readdirSync(cwd), [])
  } finally {
    drop(cwd)
  }
})

test('Z2 validateSkillName：白名单边界（首字符字母数字、64 上限、禁前导点）', () => {
  assert.equal(validateSkillName('coding-cli').ok, true)
  assert.equal(validateSkillName('A.b_c-1').ok, true)
  assert.equal(validateSkillName('a'.repeat(64)).ok, true)
  assert.equal(validateSkillName('a'.repeat(65)).ok, false)
  assert.equal(validateSkillName('.hidden').ok, false, '前导点不在白名单')
  assert.equal(validateSkillName('a b').ok, false)
  assert.equal(validateSkillName('-lead').ok, false)
  assert.equal(validateSkillName('a\\b').ok, false)
})

test('Z2b native wiring：takeover_start 按 bundle.workspace.cwd_hint 物化并挂 skillMaterialization；detail 跳过物化', async () => {
  const cwd = tmp()
  const original = api.takeoverStart
  try {
    api.takeoverStart = async () => ({
      takeover_id: 'tkos_wire',
      bundle: {
        workspace: { cwd_hint: cwd },
        assets: { skill: { skill: 'coding-cli', files: [{ path: 'SKILL.md', content: '# wired' }] } },
      },
    })
    const tool = findTool('grape_takeover_start')
    const json = await tool.native({ owner: 'o', repo: 'r', number: 1 })
    assert.equal(json.skillMaterialization.status, 'ok', json.skillMaterialization.reason)
    assert.equal(json.skillMaterialization.path, join(real(cwd), SKILL_ROOT_DIRNAME, 'coding-cli'))
    assert.equal(readFileSync(join(cwd, SKILL_ROOT_DIRNAME, 'coding-cli', 'SKILL.md'), 'utf8'), '# wired')

    api.takeoverStart = async () => ({ detail: '会话不存在' })
    const err = await tool.native({ owner: 'o', repo: 'r', number: 1 })
    assert.equal(err.skillMaterialization, undefined, 'detail 失败体不物化')
  } finally {
    api.takeoverStart = original
    drop(cwd)
  }
})

/* ── R 渲染（同步纯函数，直接读结果字段） ── */

const renderTakeover = (extra) =>
  findTool('grape_takeover_start').render({
    takeover_id: 'tkos_test',
    bundle: { env: {}, workspace: { cwd_hint: '/work/x' } },
    ...extra,
  })

test('R1 render：status ok 出现「技能已物化：<path>」+ 文件数 + references', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_test',
    bundle: { env: {}, workspace: { cwd_hint: '/work/x' } },
    skillMaterialization: {
      status: 'ok',
      skill: 'coding-cli',
      path: '/work/x/.grape-takeover-skills/coding-cli',
      fileCount: 7,
      hasReferences: true,
      reason: '',
    },
  })
  assert.equal(typeof out, 'string', 'render 必须保持同步纯函数（返回字符串，不是 Promise）')
  assert.match(out, /技能已物化：\/work\/x\/\.grape-takeover-skills\/coding-cli/)
  assert.match(out, /7/, '应给出文件数')
  assert.match(out, /references/, '应给出是否含 references')
})

test('R2 render：legacy 显式 warning（不静默）', () => {
  const out = renderTakeover({ skillMaterialization: { status: 'legacy', skill: 'coding-cli', path: '', fileCount: 0, hasReferences: false, reason: '平台未下发 assets.skill' } })
  assert.match(out, /未物化/)
  assert.match(out, /assets\.skill/)
  assert.ok(!/技能已物化：/.test(out), 'legacy 不得声称已物化')
})

test('R3 render：failed 输出「技能未能物化：<reason>」warning', () => {
  const out = renderTakeover({ skillMaterialization: { status: 'failed', skill: 's', path: '', fileCount: 0, hasReferences: false, reason: '条目路径 "../evil.md" 含上跳段' } })
  assert.match(out, /技能未能物化：/)
  assert.match(out, /上跳段/, '失败原因必须透出')
})

test('R4 render：无 skillMaterialization 字段时渲染不变（CLI 401 回退路径兼容）', () => {
  const out = renderTakeover({})
  assert.ok(!/技能物化/.test(out), '无物化结果时不出现物化段')
  assert.match(out, /接管会话已建立/)
})

test('R6 render：引用形态物化成功如实标注来源与条数；降级失败给 reason 且不声称已物化', () => {
  const t = findTool('grape_takeover_start')
  const ok = t.render({
    takeover_id: 'tkos_test',
    bundle: { env: {}, workspace: { cwd_hint: '/work/x' } },
    skillMaterialization: {
      status: 'ok',
      skill: 'coding-cli',
      path: '/work/x/.grape-takeover-skills/coding-cli',
      fileCount: 2,
      hasReferences: true,
      source: 'reference',
      reason: '',
    },
  })
  assert.match(ok, /技能已物化：\/work\/x\/\.grape-takeover-skills\/coding-cli/)
  assert.match(ok, /2/, '成功条数必须透出')
  assert.match(ok, /引用形态/, '应标注来源为引用形态拉取（与 inline/zip 区分）')

  const bad = renderTakeover({
    skillMaterialization: {
      status: 'failed',
      skill: 'coding-cli',
      path: '',
      fileCount: 0,
      hasReferences: false,
      source: '',
      reason: '引用形态技能需服务端转 inline/zip_url 下发，客户端不解析 OBS 引用（引用键 grape/skills/official/coding-cli/coding-cli.zip）',
    },
  })
  assert.match(bad, /技能未能物化：/)
  assert.match(bad, /需服务端转 inline\/zip_url 下发/, '降级原因必须透出给用户')
  assert.ok(!/技能已物化：/.test(bad), '失败不得声称已物化')
})

test('R5 render：工具描述披露技能物化（用户可见行为在描述里可发现）', () => {
  const t = findTool('grape_takeover_start')
  assert.match(t.description, /assets\.skill/)
  assert.match(t.description, /\.grape-takeover-skills/)
})
/* ── Issue #39 QA 复审（PR !37 评论 203922886）修复项：
 * H1 失败下一步分派 / 二进制通道可达 / env 合并 / 超时单旋钮 / 判空口径统一。
 * seam 不变：materializeSkillAssets（默认下载通道走 globalThis.fetch 真链路）+ grape_takeover_start.render 同步直调。 */

test('F4b 引用形态默认通道（不注入 skillDownload）：端点回短签 {url} → 拉 zip 物化成功（api.skillDownload 真链路）', async () => {
  const cwd = tmp()
  const origFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('/api/skills/by-id/skill-9/download')) {
      assert.equal(opts.headers?.Authorization, 'Bearer grape_unit', '下载端点必须带用户级凭据（apiRequest 通道）')
      return new Response(JSON.stringify({ url: 'https://obs.example.test/signed.zip', expires_in: 600 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(new Uint8Array(skillZip()), { status: 200, headers: { 'content-type': 'application/zip' } })
  }
  try {
    const r = await materializeSkillAssets(obsAsset('coding-cli', { skill_id: 'skill-9' }), cwd, {
      repo: 'grape-dev/grape-kit',
      env: { GRAPE_AUTH_FILE: '/nonexistent/gk-test-auth.json', GRAPE_API_TOKEN: 'grape_unit', GRAPE_BASE_URL: 'https://unit.example' },
    })
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.source, 'reference')
    assert.equal(r.fileCount, 2)
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), '# coding-cli\n1. 先读 runbook\n')
    assert.equal(seen.length, 2, '端点解析 + 短签 zip 拉取各一次')
    assert.match(seen[0], /^https:\/\/unit\.example\/api\/skills\/by-id\/skill-9\/download\?repo=/, '端点 URL 按传入 baseUrl 与 repo query 拼接')
    assert.equal(seen[1], 'https://obs.example.test/signed.zip')
    assertNoEmptyFile(r.path)
  } finally {
    globalThis.fetch = origFetch
    drop(cwd)
  }
})

test('F4c 引用形态默认通道二进制直出：端点直接回 zip 二进制 → Buffer 分支可达并物化（注释与行为一致）', async () => {
  const cwd = tmp()
  const origFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return new Response(new Uint8Array(skillZip('bin-skill')), { status: 200, headers: { 'content-type': 'application/zip' } })
  }
  try {
    const r = await materializeSkillAssets(obsAsset('bin-skill', { skill_id: 'skill-9' }), cwd, {
      env: { GRAPE_AUTH_FILE: '/nonexistent/gk-test-auth.json', GRAPE_API_TOKEN: 'grape_unit', GRAPE_BASE_URL: 'https://unit.example' },
    })
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(r.source, 'reference')
    assert.equal(r.fileCount, 2)
    assert.equal(seen.length, 1, '二进制直出无需二次拉取')
    assertNoEmptyFile(r.path)
  } finally {
    globalThis.fetch = origFetch
    drop(cwd)
  }
})

test('Q1 超时单旋钮（实际断言）：skillDownload 收到与 zip 拉取同旋钮的 timeoutMs', async () => {
  const dir = tmp()
  try {
    const seen = []
    const opts = (timeoutMs) => ({
      skillDownload: async (id, repoKey, env, timeoutMs) => {
        seen.push({ id, repoKey, timeoutMs })
        return { url: 'https://obs.example.test/s.zip', expires_in: 600 }
      },
      fetchImpl: zipFetch(skillZip(), []),
      ...(timeoutMs ? { fetchTimeoutMs: timeoutMs } : {}),
    })
    const a = await materializeSkillAssets(obsAsset('coding-cli', { skill_id: 'skill-9' }), dir, opts())
    assert.equal(a.status, 'ok', a.reason)
    assert.equal(seen[0].timeoutMs, 15_000, '缺省端点超时必须与 zip 拉取同为 15s（接管最坏 ~30s 有上界）')

    const b = await materializeSkillAssets(obsAsset('coding-cli', { skill_id: 'skill-9' }), dir, opts(2_500))
    assert.equal(b.status, 'ok', b.reason)
    assert.equal(seen[1].timeoutMs, 2_500, 'fetchTimeoutMs 必须同时约束端点调用与 zip 拉取（单一旋钮）')
  } finally {
    drop(dir)
  }
})

test('F10a 判空口径统一：显式 content:\'\' 同样视为无正文 → failed，不落 0 字节文件', async () => {
  const dir = tmp()
  try {
    const r = await materializeSkillAssets({ name: 'blank', files: { 'SKILL.md': '' } }, dir)
    assert.equal(r.status, 'failed', '显式空串正文与缺正文同口径——不再落 0 字节文件')
    assert.match(r.reason, /无内容|拒绝物化成空文件|正文/, '原因应点明正文缺失')
    assert.deepEqual(readdirSync(dir), [], '失败后盘上零副作用')
  } finally {
    drop(dir)
  }
})

test('F10b pickContent 跳过空串：content:\'\' 且 text 有值 → 取 text 作正文（正文判定=非空）', async () => {
  const dir = tmp()
  try {
    const r = await materializeSkillAssets({ name: 'fb', files: [{ path: 'SKILL.md', content: '', text: '# 真实正文' }] }, dir)
    assert.equal(r.status, 'ok', r.reason)
    assert.equal(readFileSync(join(r.path, 'SKILL.md'), 'utf8'), '# 真实正文', '空串正文不得遮蔽后续字段的真实内容')
  } finally {
    drop(dir)
  }
})

test('Z2c native wiring：bundle.env 不再遮蔽用户级凭据/baseUrl（process.env 非空值合并优先；平台键仍可见）', async () => {
  const dir = tmp()
  const origFetch = globalThis.fetch
  const origTakeoverStart = api.takeoverStart
  const saved = {
    tok: process.env.GRAPE_API_TOKEN, base: process.env.GRAPE_BASE_URL,
    auth: process.env.GRAPE_AUTH_FILE, bound: process.env.GRAPE_BOUND_SKILL,
  }
  process.env.GRAPE_API_TOKEN = 'grape_host_level'
  process.env.GRAPE_BASE_URL = 'https://host.example'
  delete process.env.GRAPE_AUTH_FILE
  delete process.env.GRAPE_BOUND_SKILL
  try {
    api.takeoverStart = async () => ({
      takeover_id: 'tkos_env',
      bundle: {
        workspace: { cwd_hint: dir },
        env: { GRAPE_API_TOKEN: 'tko_session_scope', GRAPE_BASE_URL: 'https://shadow.example' },
        assets: { skill: { name: 'coding-cli', skill_id: 'skill-9', files: { 'coding-cli': { __obs_key__: 'grape/skills/official/coding-cli/coding-cli.zip' } } } },
      },
    })
    const seen = []
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url)
      if (u.includes('/api/health')) {
        return new Response(JSON.stringify({ version: 'x', capabilities: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (u.includes('/download')) {
        seen.push({ url: u, auth: opts.headers?.Authorization || '' })
        return new Response(JSON.stringify({ detail: '技能下载只接受用户级凭据' }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return new Response('', { status: 404 })
    }
    const tool = findTool('grape_takeover_start')
    const json = await tool.native({ owner: 'o', repo: 'r', number: 1 })
    assert.equal(seen.length, 1, '下载端点应恰好命中一次')
    assert.match(seen[0].url, /^https:\/\/host\.example\//, 'baseUrl 取 process.env 用户配置，不被 bundle.env 遮蔽打到 shadow/生产域')
    assert.equal(seen[0].auth, 'Bearer grape_host_level', '凭据取 process.env 用户级 token，不被 bundle.env 会话键遮蔽')
    assert.equal(json.skillMaterialization.status, 'failed')
    assert.match(json.skillMaterialization.reason, /403/, '端点 403 必须透出到物化失败原因')

    api.takeoverStart = async () => ({
      takeover_id: 'tkos_env2',
      bundle: { workspace: { cwd_hint: dir }, env: { GRAPE_BOUND_SKILL: 'bound-skill' } },
    })
    const legacy = await tool.native({ owner: 'o', repo: 'r', number: 1 })
    assert.equal(legacy.skillMaterialization.status, 'legacy')
    assert.equal(legacy.skillMaterialization.skill, 'bound-skill', '合并不得丢掉 bundle.env 的平台侧键（GRAPE_BOUND_SKILL）')
  } finally {
    globalThis.fetch = origFetch
    api.takeoverStart = origTakeoverStart
    if (saved.tok === undefined) delete process.env.GRAPE_API_TOKEN; else process.env.GRAPE_API_TOKEN = saved.tok
    if (saved.base === undefined) delete process.env.GRAPE_BASE_URL; else process.env.GRAPE_BASE_URL = saved.base
    if (saved.auth === undefined) delete process.env.GRAPE_AUTH_FILE; else process.env.GRAPE_AUTH_FILE = saved.auth
    if (saved.bound === undefined) delete process.env.GRAPE_BOUND_SKILL; else process.env.GRAPE_BOUND_SKILL = saved.bound
    drop(dir)
  }
})

test('R7 render（H1）：失败行按失败类别分派下一步——403 凭据 / 平台格式 / 网络超时，删笼统「可重试」', () => {
  const t = findTool('grape_takeover_start')
  const base = {
    takeover_id: 'tkos_test',
    bundle: { env: {}, workspace: { cwd_hint: '/work/x' } },
    skillMaterialization: { status: 'failed', skill: 's', path: '', fileCount: 0, hasReferences: false, source: '', reason: '' },
  }
  const renderWith = (reason) => t.render(structuredClone({ ...base, skillMaterialization: { ...base.skillMaterialization, reason } }))

  const forbidden = renderWith('引用形态技能需服务端转 inline/zip_url 下发，客户端不解析 OBS 引用（引用键 k；grape API 403: 技能下载只接受用户级凭据）')
  assert.match(forbidden, /技能未能物化：/)
  assert.match(forbidden, /用户级 grape_ 凭据/, '403/凭据类失败：下一步必须是用户级凭据或转 inline/zip_url')
  assert.match(forbidden, /inline\/zip_url/)
  assert.ok(!/核对技能包后可重试/.test(forbidden), '不得再给笼统「可重试」')

  const format = renderWith('引用形态技能需服务端转 inline/zip_url 下发，客户端不解析 OBS 引用（引用键 k；资产未给出可解析标识（无 skill_id、无 zip_url/download_url，引用键仅为 OBS key））')
  assert.match(format, /平台下发格式问题/, '下发格式类失败：下一步必须指向平台改下发，而不是重试客户端')

  const transient = renderWith('技能 zip 下载失败：HTTP 404')
  assert.match(transient, /重开接管/, '网络/超时/短签过期类失败：重开接管（取新短签）才是可执行下一步')

  assert.match(t.description, /scope=user_only/, '描述必须披露 403 凭据边界（端点 scope 与接管凭据不匹配）')
})
