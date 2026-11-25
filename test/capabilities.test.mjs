import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../src/api.mjs'
import {
  CAP_SKILLS_MULTI,
  E_CAP_UNSUPPORTED_MULTI_SKILL,
  getServerCapabilities,
  normalizeCapabilities,
  normalizeSkills,
  evaluateTakeoverGate,
  resetCapabilitiesCache,
} from '../src/capabilities.mjs'

const ENV = { GRAPE_CAPABILITIES_TTL_MS: '300000' }

let healthCalls = 0
const installHealth = (impl) => {
  healthCalls = 0
  api.health = async () => {
    healthCalls += 1
    return impl(healthCalls)
  }
}

beforeEach(() => resetCapabilitiesCache())

test('normalizeCapabilities 兼容 string[] / {name:boolean} / items[] 三形态', () => {
  assert.deepEqual(normalizeCapabilities(['skills.multi', 'takeover_bundle.v2']), ['skills.multi', 'takeover_bundle.v2'])
  assert.deepEqual(normalizeCapabilities({ 'skills.multi': true, 'review.decide': false }), ['skills.multi'])
  assert.deepEqual(normalizeCapabilities([{ name: 'skills.multi', enabled: true }, { name: 'review.decide', enabled: false }]), ['skills.multi'])
  assert.deepEqual(normalizeCapabilities(undefined), [])
})

test('握手成功：归一化 version/capabilities，source=server，带 handshake_at', async () => {
  installHealth(() => ({ reachable: true, version: '1.2.3', capabilities: ['takeover_bundle.v2', 'skills.multi'] }))
  const caps = await getServerCapabilities({ env: ENV })
  assert.equal(caps.source, 'server')
  assert.equal(caps.version, '1.2.3')
  assert.deepEqual(caps.capabilities, ['takeover_bundle.v2', 'skills.multi'])
  assert.ok(caps.handshake_at)
})

test('握手失败（404/不可达）：source=unknown、capabilities=[]、不伪造且不缓存失败', async () => {
  installHealth(() => ({ reachable: false, status: 404 }))
  const a = await getServerCapabilities({ env: ENV })
  assert.equal(a.source, 'unknown')
  assert.equal(a.version, '')
  assert.deepEqual(a.capabilities, [])
  const b = await getServerCapabilities({ env: ENV })
  assert.equal(b.source, 'unknown')
  assert.equal(healthCalls, 2, '失败不得长负缓存，下次调用应重试')
})

test('缓存：TTL 内复用不重复握手，force 强制刷新', async () => {
  installHealth(() => ({ reachable: true, version: '2.0.0', capabilities: ['skills.multi'] }))
  await getServerCapabilities({ env: ENV })
  await getServerCapabilities({ env: ENV })
  assert.equal(healthCalls, 1, 'TTL 内应命中缓存')
  await getServerCapabilities({ env: ENV, force: true })
  assert.equal(healthCalls, 2, 'force 应强制重取')
})

test('缓存过期：TTL=0 时重取', async () => {
  installHealth(() => ({ reachable: true, version: '2.0.0', capabilities: ['skills.multi'] }))
  await getServerCapabilities({ env: { GRAPE_CAPABILITIES_TTL_MS: '0' } })
  await getServerCapabilities({ env: { GRAPE_CAPABILITIES_TTL_MS: '0' } })
  assert.equal(healthCalls, 2)
})

test('过期后重取失败：回退 stale-cache（保留旧能力与 fetched_at）', async () => {
  installHealth((n) => n === 1
    ? { reachable: true, version: '2.0.0', capabilities: ['skills.multi'] }
    : { reachable: false, status: 0 })
  const fresh = await getServerCapabilities({ env: { GRAPE_CAPABILITIES_TTL_MS: '0' } })
  const stale = await getServerCapabilities({ env: { GRAPE_CAPABILITIES_TTL_MS: '0' } })
  assert.equal(stale.source, 'stale-cache')
  assert.equal(stale.version, '2.0.0')
  assert.deepEqual(stale.capabilities, ['skills.multi'])
  assert.equal(stale.fetched_at, fresh.fetched_at)
})

test('normalizeSkills 来源优先级与 required 解析', () => {
  const fromSkills = normalizeSkills({ skills: [{ name: 'a', required: true }, 'b'] })
  assert.deepEqual(fromSkills, [{ name: 'a', required: true }, { name: 'b', required: undefined }])

  const fromAsset = normalizeSkills({ assets: { skill: 'only-one' } })
  assert.deepEqual(fromAsset, [{ name: 'only-one', required: undefined }])

  const fromEnv = normalizeSkills({ env: { GRAPE_BOUND_SKILL: 'bound' } })
  assert.deepEqual(fromEnv, [{ name: 'bound', required: undefined }])

  assert.deepEqual(normalizeSkills({ skills: ['first'], assets: { skill: 'second' }, env: { GRAPE_BOUND_SKILL: 'third' } }), [{ name: 'first', required: undefined }])
})

const oldCaps = { version: '', capabilities: [], source: 'unknown', handshake_at: '2026-01-01T00:00:00.000Z' }
const newCaps = { version: '2.0.0', capabilities: [CAP_SKILLS_MULTI], source: 'server', handshake_at: '2026-01-01T00:00:00.000Z' }

test('gate：required>1 且无 skills.multi → 拒绝，错误码与 payload 完整', () => {
  const skills = normalizeSkills({ skills: [{ name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] })
  const gate = evaluateTakeoverGate(skills, oldCaps)
  assert.equal(gate.allowed, false)
  const p = gate.payload
  assert.equal(p.ok, false)
  assert.equal(p.refused, true)
  assert.equal(p.code, E_CAP_UNSUPPORTED_MULTI_SKILL)
  assert.deepEqual(p.required_skills, ['a', 'b', 'c'])
  assert.equal(p.required_count, 3)
  assert.equal(p.service_version, '')
  assert.deepEqual(p.supported_capabilities, [])
  assert.equal(p.capabilities_source, 'unknown')
  assert.equal(p.handshake_at, oldCaps.handshake_at)
  assert.equal(p.retryable, true)
  assert.equal(p.remediation.length, 3)
  assert.match(p.message, /接管被拒绝/)
  assert.match(p.message, /a,b,c/)
})

test('gate：required>1 且声明 skills.multi → 通过（v2 不隐含 multi，只认 skills.multi）', () => {
  const skills = normalizeSkills({ skills: [{ name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }] })
  const gate = evaluateTakeoverGate(skills, newCaps)
  assert.equal(gate.allowed, true)
  assert.equal(gate.required_count, 3)
  assert.deepEqual(gate.required_skills, ['a', 'b', 'c'])

  const v2Only = { version: '2.0.0', capabilities: ['takeover_bundle.v2'], source: 'server', handshake_at: 'x' }
  assert.equal(evaluateTakeoverGate(skills, v2Only).allowed, false, 'takeover_bundle.v2 不得隐含 skills.multi')
})

test('gate：required 字段整体缺失且数量>1 → 全部按 required 保守计数', () => {
  const gate = evaluateTakeoverGate(normalizeSkills({ skills: ['a', 'b'] }), oldCaps)
  assert.equal(gate.allowed, false)
  assert.equal(gate.required_count, 2)
})

test('gate：单技能在旧服务端通过，行为不变', () => {
  const gate = evaluateTakeoverGate(normalizeSkills({ skills: ['coding-cli'] }), oldCaps)
  assert.equal(gate.allowed, true)
  assert.equal(gate.required_count, 1)
})