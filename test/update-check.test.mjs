import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync } from 'node:fs'

const CACHE = join(homedir(), '.grape', 'grape-kit-update-check.json')
beforeEach(() => { try { rmSync(CACHE, { force: true }) } catch {} })

/** 临时 HOME（不预建 .grape）：返回 home 与恢复函数 */
function withTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'grape-kit-update-home-'))
  const prev = process.env.HOME
  process.env.HOME = home
  return { home, restore: () => { process.env.HOME = prev; rmSync(home, { recursive: true, force: true }) } }
}

// update-check 的缓存路径是模块常量（homedir 固定），测试通过注入 fetch/now/env 控制，
// 缓存文件侧通过 mock existsSync/readFileSync 隔离——这里用注入参数覆盖全部外部 IO 判断。

async function loadMod(cacheHit) {
  // 动态改写 cachePath：通过临时 HOME 不可行（模块加载时已固化），改为注入判定
  const mod = await import('../src/update-check.mjs')
  return mod
}

test('checkUpdate：registry 有新版本 → 返回 {latest}', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.2', {
    now: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.3' }) }),
    env: {},
  })
  assert.deepEqual(r, { latest: '0.3.3', cached: false })
})

test('checkUpdate：已是最新 → null', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.3', {
    now: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.3' }) }),
    env: {},
  })
  assert.equal(r, null)
})

test('checkUpdate：网络失败 → 静默 null（绝不抛错）', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.2', {
    now: 1,
    fetchImpl: async () => { throw new Error('network down') },
    env: {},
  })
  assert.equal(r, null)
})

test('checkUpdate：GRAPE_KIT_SKIP_UPDATE_CHECK=1 → 直接 null 不打网络', async () => {
  const { checkUpdate } = await loadMod()
  let called = 0
  const r = await checkUpdate('0.3.2', {
    now: 1,
    fetchImpl: async () => { called++; return { ok: true, json: async () => ({ version: '9.9.9' }) } },
    env: { GRAPE_KIT_SKIP_UPDATE_CHECK: '1' },
  })
  assert.equal(r, null)
  assert.equal(called, 0)
})

test('checkUpdate：非 2xx registry 响应 → null', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.2', {
    now: 1,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    env: {},
  })
  assert.equal(r, null)
})

test('checkUpdate：GRAPE_KIT_NO_UPDATE_CHECK=1（别名开关）→ 直接 null 不打网络', async () => {
  const { checkUpdate } = await loadMod()
  let called = 0
  const r = await checkUpdate('0.3.2', {
    now: 1,
    fetchImpl: async () => { called++; return { ok: true, json: async () => ({ version: '9.9.9' }) } },
    env: { GRAPE_KIT_NO_UPDATE_CHECK: '1' },
  })
  assert.equal(r, null)
  assert.equal(called, 0)
})

test('checkUpdate：本地版本高于 latest → null（semver 比较，非字符串不等）', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.10', {
    now: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.9' }) }),
    env: {},
  })
  assert.equal(r, null)
})

test('checkUpdate：本地预发布低于同号正式版 → 提示', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.3-rc.1', {
    now: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.3' }) }),
    env: {},
  })
  assert.deepEqual(r, { latest: '0.3.3', cached: false })
})

test('checkUpdate：本地正式版高于 latest 预发布 → null', async () => {
  const { checkUpdate } = await loadMod()
  const r = await checkUpdate('0.3.3', {
    now: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.3-rc.1' }) }),
    env: {},
  })
  assert.equal(r, null)
})

test('checkUpdate：24h 缓存命中 → 同一新版本只提示一次且不再请求 registry', async () => {
  const { checkUpdate } = await loadMod()
  mkdirSync(join(homedir(), '.grape'), { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ checkedAt: Date.now(), latest: '0.3.9' }))
  let called = 0
  const fetchImpl = async () => { called++; throw new Error('should not hit registry') }
  const first = await checkUpdate('0.3.2', { fetchImpl, env: {} })
  assert.deepEqual(first, { latest: '0.3.9', cached: true })
  const second = await checkUpdate('0.3.2', { fetchImpl, env: {} })
  assert.equal(second, null)
  assert.equal(called, 0)
})

test('checkUpdate：24h 缓存过期 → 重新请求 registry', async () => {
  const { checkUpdate } = await loadMod()
  mkdirSync(join(homedir(), '.grape'), { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ checkedAt: 1, latest: '0.3.9' }))
  let called = 0
  const r = await checkUpdate('0.3.2', {
    now: 1 + 24 * 3600 * 1000,
    fetchImpl: async () => { called++; return { ok: true, json: async () => ({ version: '0.4.0' }) } },
    env: {},
  })
  assert.equal(called, 1)
  assert.deepEqual(r, { latest: '0.4.0', cached: false })
})

test('checkUpdate：HOME 下无 .grape 目录时自动创建缓存，24h 去重仍生效', async () => {
  const { checkUpdate } = await loadMod()
  const { home, restore } = withTempHome()
  try {
    let called = 0
    const fetchImpl = async () => { called++; return { ok: true, json: async () => ({ version: '9.9.9' }) } }
    const first = await checkUpdate('0.3.2', { now: Date.now(), fetchImpl, env: {} })
    assert.deepEqual(first, { latest: '9.9.9', cached: false })
    const cacheFile = join(home, '.grape', 'grape-kit-update-check.json')
    assert.ok(existsSync(cacheFile), '应自动创建 ~/.grape 并落盘缓存')
    const second = await checkUpdate('0.3.2', { now: Date.now(), fetchImpl, env: {} })
    assert.equal(second, null)
    assert.equal(called, 1, '缓存命中后不应再次请求 registry')
  } finally { restore() }
})
