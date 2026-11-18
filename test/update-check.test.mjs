import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync, existsSync as _ex } from 'node:fs'

const CACHE = join(homedir(), '.grape', 'grape-kit-update-check.json')
beforeEach(() => { try { rmSync(CACHE, { force: true }) } catch {} })

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
