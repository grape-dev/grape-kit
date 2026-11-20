import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiRequest, api, resolveCredentials, hintFor, hostInfo } from '../src/api.mjs'
import { findTool } from '../src/tools.mjs'

/*
 * 真实平台契约回归（Issue #12 补强）
 *
 * 几条用例刻意用「平台真实响应形状」而不是手搓的友好形状：
 *  - takeover 错误体是 {ok:false, code, message}，message 是中文散文（不含 agent_mismatch 字样）
 *  - bundle 脚本资产在 bundle.assets.scripts（不是 bundle.scripts），元素是 {filename, ext, mode, exec, content}
 *  - StartBody 认 host_os/host_arch/host_shell（缺省 linux），不上报就拿不到 PowerShell 版脚本
 */

function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

const ISO = { GRAPE_AUTH_FILE: '/nonexistent/takeover-contract-test.json' }

test('409 真实错误体：按 code=agent_mismatch 命中友好提示（message 里没有该字样）', async () => {
  const { srv, port } = await serve((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'agent_mismatch', message: '该任务属于 vod 节点，不是 coding' }))
  })
  try {
    await assert.rejects(
      apiRequest('POST', '/api/takeover/sessions', {
        env: { ...ISO, GRAPE_API_TOKEN: 'grape_fake', GRAPE_BASE_URL: `http://127.0.0.1:${port}` },
        body: {},
      }),
      (e) => {
        assert.equal(e.status, 409)
        assert.equal(e.code, 'agent_mismatch', '平台 code 必须透传到 Error')
        assert.match(e.hint, /当前活跃节点/)
        assert.match(e.hint, /60-120s/)
        return true
      },
    )
  } finally { srv.close() }
})

test('takeover_start 上报宿主 OS/架构/shell（否则服务端永远渲染 posix 脚本）', async () => {
  let body = null
  const { srv, port } = await serve((req, res) => {
    let buf = ''
    req.on('data', (d) => { buf += d })
    req.on('end', () => {
      body = JSON.parse(buf || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, takeover_id: 'tkos_x', bundle: {} }))
    })
  })
  const saved = { ...process.env }
  try {
    process.env.GRAPE_API_TOKEN = 'grape_fake'
    process.env.GRAPE_BASE_URL = `http://127.0.0.1:${port}`
    process.env.GRAPE_AUTH_FILE = ISO.GRAPE_AUTH_FILE
    delete process.env.GRAPE_API_TOKEN_ONCE
    await api.takeoverStart('acme', 'demo', 12, 'coding')
    assert.ok(body, '应发出 start 请求')
    assert.equal(body.platform, 'grape-kit')
    assert.equal(body.host_os, hostInfo().host_os)
    assert.equal(body.host_arch, hostInfo().host_arch)
    assert.ok(body.host_shell, '应上报 host_shell')
  } finally {
    for (const k of ['GRAPE_API_TOKEN', 'GRAPE_BASE_URL', 'GRAPE_AUTH_FILE']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    }
    srv.close()
  }
})

test('takeover_start 渲染平台真实脚本资产：bundle.assets.scripts + {{CWD}} 本地替换', () => {
  const t = findTool('grape_takeover_start')
  const out = t.render({
    takeover_id: 'tkos_x',
    bundle: {
      takeover_id: 'tkos_x',
      workspace: { cwd_hint: '/work/demo' },
      platform: { host_os: 'windows' },
      assets: {
        scripts: [
          { name: 'env', filename: '.grape-takeover-env.ps1', ext: 'ps1', mode: '0600', exec: 'dot-source', content: "$env:GRAPE_AUTH_FILE = '{{CWD}}\\.grape-takeover-token'" },
          { name: 'report', filename: '.grape-takeover-report.ps1', ext: 'ps1', mode: '0700', exec: 'pwsh -File', content: 'param([string]$Message) # {{CWD}}' },
        ],
      },
    },
  })
  assert.match(out, /\.grape-takeover-env\.ps1/, '应渲染平台资产的文件名')
  assert.match(out, /\.grape-takeover-report\.ps1/)
  assert.ok(!out.includes('{{CWD}}'), '不得把字面量占位符留给执行者')
  assert.match(out, /\/work\/demo\\\.grape-takeover-token/, '应替换为实际 CWD')
})

test('文件通道：带 UTF-8 BOM 的 config.json 仍能解析（Windows 记事本）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-bom-'))
  try {
    const f = join(dir, 'config.json')
    writeFileSync(f, '\uFEFF' + JSON.stringify({ token: 'tko_fake_from_bom', base_url: 'https://self.example' }))
    const c = resolveCredentials({ GRAPE_AUTH_FILE: f })
    assert.equal(c.token, 'tko_fake_from_bom')
    assert.equal(c.baseUrl, 'https://self.example')
    assert.match(c.source, /^file:/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('hintFor 409 同时认 code 与 detail（兼容旧平台只给散文）', () => {
  assert.match(hintFor(409, { code: 'agent_mismatch' }), /当前活跃节点/)
  assert.match(hintFor(409, { detail: 'agent_mismatch: 非活跃节点' }), /当前活跃节点/)
  assert.equal(hintFor(409, { detail: 'other conflict' }), '')
  assert.match(hintFor(409, { code: 'taken_by_other' }), /10-30s/)
})