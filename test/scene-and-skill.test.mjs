/**
 * 场景/技能/交回三条链路的契约测试（grape-kit × 宿主测试报告 P3/P4/P5/P6/D3/D4）。
 *
 * 这些用例锁的是「宿主看到什么、kit 实际打了哪个端点」：
 * - apply_scene 必须走 market 应用（创建副本），不得再打 /api/scenes/apply（只刷节点绑定）
 * - 未命中的市场场景不发请求、不回落到 default
 * - set_repo_scene 打 default-scene 并以回读为准
 * - create_issue 把 description 标成必填（服务端缺正文 400）
 * - finish 交回后先查 issue 事件，平台已派发就不再客户端补发（消掉 P6 假警报 + 防重复跑）
 * - 技能上传本地预检 + 自动 ZIP（顶层目录 + frontmatter 口径与服务器一致）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { api } from '../src/api.mjs'
import { findTool, preflightSkillDir, preflightSkillTags, parseSkillFrontmatter } from '../src/tools.mjs'
import { zipDirectory } from '../src/zip.mjs'

const MARKET = {
  scenes: [
    { id: 10, name: 'huawei-skill', display_name: '华为云Skill开发', scope: 'official' },
    { id: 2, name: 'default', display_name: '通用开发', scope: 'official' },
  ],
}

function stubApi(over = {}) {
  const calls = []
  const base = {
    scenesMarket: async () => MARKET,
    marketApply: async (owner, repo, id, displayName) => {
      calls.push(['marketApply', id, displayName])
      return { message: '场景已创建', scene_id: 'custom-b16ea26e' }
    },
    repoScenes: async () => ({ scenes: [{ id: 'custom-b16ea26e', display_name: '华为云Skill开发', nodes: [] }] }),
    setDefaultScene: async (owner, repo, sceneId) => {
      calls.push(['setDefaultScene', sceneId])
      return { message: '仓库默认场景已设置', dev_scene: sceneId, repo_key: `gitcode:${owner}/${repo}` }
    },
    repoDashboard: async () => ({ dev_scene: 'custom-b16ea26e' }),
  }
  const merged = { ...base, ...over }
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete api[k]
    else api[k] = v
  }
  return calls
}

/* ── 场景 ─────────────────────────────────────────────────────────────── */

test('apply_scene：按市场数字 id 创建副本，并回读确认（不再打错端点）', async () => {
  const calls = stubApi()
  const out = await findTool('grape_apply_scene').native({ owner: 'qq_44826240', repo: 'HD-SKill', scene: '10' })

  assert.deepEqual(calls, [['marketApply', 10, '']])
  assert.equal(out.scene_id, 'custom-b16ea26e')
  assert.equal(out.verified, true)
  assert.equal(out.set_default, false)

  const text = findTool('grape_apply_scene').render(out)
  assert.match(text, /仓库场景副本/)
  assert.match(text, /默认场景没变/, '未设默认时必须明说默认场景没变，避免“应用=切换”的误解')
  assert.match(text, /grape_set_repo_scene/)
})

test('apply_scene：场景名同样可应用，set_default=true 才写 dev_scene', async () => {
  const calls = stubApi()
  const out = await findTool('grape_apply_scene').native({
    owner: 'o', repo: 'r', scene: 'huawei-skill', set_default: true,
  })
  assert.equal(out.market_id, 10)
  assert.deepEqual(calls.at(-1), ['setDefaultScene', 'custom-b16ea26e'])
  assert.equal(out.default_result.dev_scene, 'custom-b16ea26e')
  assert.match(findTool('grape_apply_scene').render(out), /dev_scene = `custom-b16ea26e`/)
})

test('apply_scene：市场里没有的 id 不发请求（服务端会静默回落 default）', async () => {
  const calls = stubApi()
  await assert.rejects(
    () => findTool('grape_apply_scene').native({ owner: 'o', repo: 'r', scene: '41' }),
    (e) => /没有 id=41/.test(e.message) && /10:huawei-skill/.test(e.message))
  assert.deepEqual(calls, [], '未命中必须本地拒绝，不得盲发请求')
})

test('apply_scene：custom- 副本 id 引导到 set_repo_scene，而不是当市场场景应用', async () => {
  stubApi()
  await assert.rejects(
    () => findTool('grape_apply_scene').native({ owner: 'o', repo: 'r', scene: 'custom-abc123' }),
    (e) => /grape_set_repo_scene/.test(e.message))
})

test('apply_scene：回读不到副本时明确报警，不宣称已应用', async () => {
  stubApi({ repoScenes: async () => ({ scenes: [] }) })
  const out = await findTool('grape_apply_scene').native({ owner: 'o', repo: 'r', scene: '10', set_default: true })
  assert.equal(out.verified, false)
  const text = findTool('grape_apply_scene').render(out)
  assert.match(text, /回读未在仓库场景列表里找到该副本/)
  assert.doesNotMatch(text, /✅/)
})

test('set_repo_scene：写默认场景并以回读 dev_scene 为准', async () => {
  const calls = stubApi()
  const out = await findTool('grape_set_repo_scene').native({ owner: 'o', repo: 'r', scene_id: 'custom-b16ea26e' })
  assert.deepEqual(calls, [['setDefaultScene', 'custom-b16ea26e']])
  assert.match(findTool('grape_set_repo_scene').render(out), /仓库默认场景已更新/)
})

test('set_repo_scene：clear=true 清空（回落智能推荐）', async () => {
  stubApi({ setDefaultScene: async (owner, repo, sceneId) => ({ dev_scene: '', repo_key: `gitcode:${owner}/${repo}` }) })
  const out = await findTool('grape_set_repo_scene').native({ owner: 'o', repo: 'r', clear: true })
  assert.equal(out.requested, '')
  assert.match(findTool('grape_set_repo_scene').render(out), /已清空/)
})

test('set_repo_scene：回读不一致时不得宣称已切换', async () => {
  stubApi({ setDefaultScene: async () => ({ dev_scene: 'custom-old' }) })
  const out = await findTool('grape_set_repo_scene').native({ owner: 'o', repo: 'r', scene_id: 'custom-new' })
  assert.match(findTool('grape_set_repo_scene').render(out), /默认场景未确认/)
})

/* ── 建单 / 交回 ──────────────────────────────────────────────────────── */

test('create_issue：description 必填（服务端缺正文 400）', () => {
  const t = findTool('grape_create_issue')
  assert.deepEqual(t.schema.required, ['owner', 'repo', 'title', 'description'])
  assert.match(t.description, /必填/)
})

test('takeover_finish：平台事件已派发下一节点时只报事实，不再重复派发（P6）', async () => {
  let triggered = 0
  const finishTool = findTool('grape_takeover_finish')
  stubApi({
    takeoverFinish: async () => ({
      ok: true, changed: true, next_agent: 'qa', handoff_seq: 22908,
      session: { id: 'tk_1', agent_type: 'coding', repo_key: 'gitcode:o/r', issue_number: 15 },
    }),
    takeoverGet: async () => ({ session: { id: 'tk_1', repo_key: 'gitcode:o/r', issue_number: 15 } }),
    issueEvents: async () => ({
      events: [
        { seq: 22900, agent_type: 'coding', event_type: 'a2a_event', status: 'completed' },
        { seq: 22908, agent_type: 'qa', event_type: 'a2a_event', status: 'running' },
      ],
    }),
    triggerPipeline: async () => { triggered += 1; return { seq: 1 } },
  })

  const json = await finishTool.native({ session_id: 'tk_1', summary: '实现完成', evidence: 'npm test 全绿' })
  assert.equal(triggered, 0, '平台已派发就不许再派一次')
  assert.equal(json.dispatch.status, 'already_dispatched')
  assert.equal(json.next_seq, 22908)
  const text = finishTool.render(json)
  assert.match(text, /已由平台派发/)
  assert.doesNotMatch(text, /pending_dispatch/)
})

test('takeover_finish：确实没派发时才兜底补发一次', async () => {
  let triggered = 0
  const finishTool = findTool('grape_takeover_finish')
  stubApi({
    takeoverFinish: async () => ({ ok: true, changed: true, next_agent: 'qa', handoff_seq: 22908 }),
    takeoverGet: async () => ({ session: { id: 'tk_2', agent_type: 'coding', repo_key: 'gitcode:o/r', issue_number: 16 } }),
    issueEvents: async () => ({ events: [{ seq: 22908, agent_type: 'coding', event_type: 'a2a_event' }] }),
    triggerPipeline: async (owner, repo, n, ctx, agent) => { triggered += 1; return { seq: 23100, agent } },
  })

  const json = await finishTool.native({ session_id: 'tk_2', summary: '完成', evidence: 'ok' })
  assert.equal(triggered, 1)
  assert.equal(json.dispatch.status, 'dispatched')
  assert.equal(json.next_seq, 23100)
})

/* ── 技能上传 ─────────────────────────────────────────────────────────── */

const SKILL_MD = `---
name: deploy-playbook
version: 1.2.0
description: 华为云部署经验沉淀
---

# Deploy Playbook

正文
`

function makeSkillDir(name = 'deploy-playbook', md = SKILL_MD) {
  const root = mkdtempSync(join(tmpdir(), 'gk-skill-'))
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md)
  writeFileSync(join(dir, 'notes.md'), '细节\n')
  return dir
}

test('技能预检：合格目录通过，取值口径与服务器一致', () => {
  const dir = makeSkillDir()
  const pf = preflightSkillDir(dir)
  assert.deepEqual(pf.errors, [])
  assert.equal(pf.name, 'deploy-playbook')
  assert.equal(pf.version, '1.2.0')
  assert.equal(pf.rootName, 'deploy-playbook')
})

test('技能预检：缺 SKILL.md / 缺 frontmatter / 名字与目录名不一致 一次列全', () => {
  const empty = mkdtempSync(join(tmpdir(), 'gk-empty-'))
  assert.match(preflightSkillDir(empty).errors[0], /SKILL\.md/)

  const bad = makeSkillDir('wrong-name')
  const pf = preflightSkillDir(bad)
  assert.ok(pf.errors.some((e) => /必须与技能目录名/.test(e)), '目录名与 name 不一致必须报错')

  const noFm = makeSkillDir('no-fm', '# 只有正文，没有 frontmatter\n')
  assert.ok(preflightSkillDir(noFm).errors.some((e) => /Front Matter/.test(e)))
})

test('技能标签：系统标签（Agent 类型）重名被本地拦下', () => {
  assert.deepEqual(preflightSkillTags('deploy,obs').errors, [])
  const bad = preflightSkillTags('sre,qa')
  assert.equal(bad.errors.length, 1)
  assert.match(bad.errors[0], /Agent 类型/)
})

test('frontmatter 解析：去引号、忽略注释与嵌套行', () => {
  const fm = parseSkillFrontmatter(`---\nname: "demo-skill"\nversion: 2.0.0  # 注释\ntools:\n  - bash\n---\n正文`)
  assert.equal(fm.name, 'demo-skill')
  assert.equal(fm.version, '2.0.0')
  assert.equal(fm.tools, undefined)
})

test('ZIP：顶层目录 + UTF-8 文件名，自身可解析（不依赖 7z/zip 命令）', () => {
  const dir = makeSkillDir()
  const { buffer, rootName, files } = zipDirectory(dir, { rootName: 'deploy-playbook' })
  assert.equal(rootName, 'deploy-playbook')
  assert.deepEqual(files.sort(), ['SKILL.md', 'notes.md'])
  // EOCD：结尾 22 字节，签名 0x06054b50，条目数 2
  const eocd = buffer.subarray(buffer.length - 22)
  assert.equal(eocd.readUInt32LE(0), 0x06054b50)
  assert.equal(eocd.readUInt16LE(8), 2)
  // 第一条本地头签名 + 名字带顶层目录
  assert.equal(buffer.readUInt32LE(0), 0x04034b50)
  const nameLen = buffer.readUInt16LE(26)
  const firstName = buffer.subarray(30, 30 + nameLen).toString('utf8')
  assert.ok(firstName.startsWith('deploy-playbook/'), `首条应为顶层目录内的文件，实际 ${firstName}`)
})

test('upload_skill：预检不过不发请求，报错列出全部问题', async () => {
  let uploaded = 0
  stubApi({ skillUpload: async () => { uploaded += 1; return { skill_id: 1 } } })
  const noFm = makeSkillDir('bad-skill', '# 无 frontmatter\n')
  await assert.rejects(
    () => findTool('grape_upload_skill').native({ path: noFm, scope: 'user', agent_type: 'sre' }),
    (e) => /本地预检未通过/.test(e.message) && /Front Matter/.test(e.message))
  assert.equal(uploaded, 0)
})

test('upload_skill：repo scope 缺 owner/repo 立刻报错；合格目录按顶层目录打包上传', async () => {
  let payload = null
  stubApi({ skillUpload: async (buf, filename, fields) => {
    payload = { filename, fields, bytes: buf.length }
    return { skill_id: 3625, message: '技能上传成功' }
  } })
  const dir = makeSkillDir()

  await assert.rejects(
    () => findTool('grape_upload_skill').native({ path: dir, scope: 'repo', agent_type: 'sre' }),
    /必须同时给 owner \+ repo/)

  const out = await findTool('grape_upload_skill').native({
    path: dir, scope: 'repo', owner: 'o', repo: 'r', agent_type: 'sre', tags: 'deploy,obs',
  })
  assert.equal(payload.filename, 'deploy-playbook.zip')
  assert.equal(payload.fields.repo, 'o/r')
  assert.equal(payload.fields.agent_type, 'sre')
  assert.ok(payload.bytes > 0)
  assert.equal(out.skill_id, 3625)
  assert.match(findTool('grape_upload_skill').render(out), /技能已上传/)
})
test('upload_skill 的下一步提示必须承认 D5 缺口（不承诺做不到的节点级绑定）', () => {
  const text = findTool('grape_upload_skill').render({ skill_id: 3625, root_name: 'deploy-playbook' })
  assert.match(text, /没有节点级写端点/, '必须写明平台暂无节点级端点')
  assert.match(text, /整场景/, '必须给出当前唯一可行路径：整场景 PUT')
})
