import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

import { materializeSkillAssets, validateSkillName, SKILL_ROOT_DIRNAME } from '../src/skill-materialize.mjs'
import { findTool } from '../src/tools.mjs'

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

test('R5 render：工具描述披露技能物化（用户可见行为在描述里可发现）', () => {
  const t = findTool('grape_takeover_start')
  assert.match(t.description, /assets\.skill/)
  assert.match(t.description, /\.grape-takeover-skills/)
})