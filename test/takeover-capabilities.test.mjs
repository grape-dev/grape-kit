import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/api.mjs'
import { findTool } from '../src/tools.mjs'
import { E_CAP_UNSUPPORTED_MULTI_SKILL, resetCapabilitiesCache } from '../src/capabilities.mjs'

const t = findTool('grape_takeover_start')

let calls
const install = ({ health, context, start }) => {
  calls = { health: 0, context: 0, start: 0 }
  api.health = async () => { calls.health += 1; return health }
  api.takeoverContext = async () => { calls.context += 1; return context }
  api.takeoverStart = async () => { calls.start += 1; return start }
}

beforeEach(() => resetCapabilitiesCache())

test('description 声明 capabilities 依赖与多技能门槛', () => {
  assert.match(t.description, /api\/health/)
  assert.match(t.description, /skills\.multi/)
  assert.match(t.description, /E_CAP_UNSUPPORTED_MULTI_SKILL/)
})

test('旧服务端 + required 3：拒绝且不发起 takeover 请求', async () => {
  install({
    health: { reachable: false, status: 404 },
    context: { skill: 'coding-cli' },
    start: { ok: true, takeover_id: 'tkos_x', bundle: {} },
  })
  const out = await t.native({
    owner: 'acme', repo: 'demo', number: 1,
    bundle: { skills: [{ name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] },
  })
  assert.equal(out.refused, true)
  assert.equal(out.code, E_CAP_UNSUPPORTED_MULTI_SKILL)
  assert.equal(out.required_count, 3)
  assert.equal(out.capabilities_source, 'unknown')
  assert.equal(calls.start, 0, '拒绝时不得发起 takeover 请求')
})

test('新服务端 + skills.multi + required 3：通过并披露判据来源', async () => {
  install({
    health: { reachable: true, version: '2.0.0', capabilities: ['takeover_bundle.v2', 'skills.multi'] },
    context: { skill: 'coding-cli' },
    start: { ok: true, takeover_id: 'tkos_x', bundle: {} },
  })
  const out = await t.native({
    owner: 'acme', repo: 'demo', number: 1,
    bundle: { skills: [{ name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] },
  })
  assert.equal(out.takeover_id, 'tkos_x')
  assert.equal(calls.start, 1)
  assert.equal(out.client_capabilities.source, 'server')
  assert.equal(out.client_capabilities.version, '2.0.0')
  assert.equal(out.client_capabilities.required_count, 3)
  const text = t.render(out)
  assert.match(text, /capabilities: 2\.0\.0/)
  assert.match(text, /来源 server/)
  assert.match(text, /判据：通过（required=3）/)
})

test('单技能 + 旧服务端：行为不变（仍发起 takeover）', async () => {
  install({
    health: { reachable: false, status: 404 },
    context: { skill: 'coding-cli' },
    start: { ok: true, takeover_id: 'tkos_y', bundle: {} },
  })
  const out = await t.native({ owner: 'acme', repo: 'demo', number: 1 })
  assert.equal(calls.start, 1)
  assert.equal(out.takeover_id, 'tkos_y')
  assert.equal(out.client_capabilities.required_count, 1)
  assert.match(t.render(out), /判据：通过（required=1）/)
})

test('拒绝渲染：首行错误码 + 升级指引三连', () => {
  const out = t.render({
    ok: false, refused: true, code: E_CAP_UNSUPPORTED_MULTI_SKILL,
    message: '接管被拒绝：节点要求 3 个技能（a,b,c），服务端 未知版本 仅支持单技能（skills.multi 未声明）。',
    required_skills: ['a', 'b', 'c'], required_count: 3,
    service_version: '', supported_capabilities: [], capabilities_source: 'unknown',
    handshake_at: '2026-01-01T00:00:00.000Z', retryable: true,
    remediation: ['升级服务端至声明 skills.multi 的版本', '升级 kit 至支持 capabilities 握手的版本', '将节点改为单技能'],
  })
  assert.match(out.split('\n')[0], /接管已被拒绝：E_CAP_UNSUPPORTED_MULTI_SKILL/)
  assert.match(out, /升级服务端/)
  assert.match(out, /升级 kit/)
  assert.match(out, /单技能/)
  assert.match(out, /retryable/)
})