#!/usr/bin/env node
/**
 * fake-grape —— 测试/冒烟用 grape CLI 替身。
 * 输出单行纯 JSON 到 stdout（模拟 --json-out 行为），stderr 静默，退出码 0。
 * 特殊：exit 1 模式（GRAPE_FAKE_FAIL=401 等）用于错误路径测试。
 */
const args = process.argv.slice(2)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const fail = process.env.GRAPE_FAKE_FAIL || ''
if (fail) {
  process.stderr.write(`Error: HTTP ${fail}: simulated failure\n`)
  process.exit(Number(fail) || 1)
}

const has = (s) => args.includes(s)
const val = (s) => { const i = args.indexOf(s); return i >= 0 ? args[i + 1] : undefined }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// wait 轮询测试：同 seq 第二次查询返回终态（计数器落临时文件）
function pollStatus(seq) {
  const scope = process.env.GRAPE_FAKE_SCOPE || "noscope"
  const key = `/tmp/opencode/fake-grape-${scope}-${seq}.count`
  let n = 0
  try { n = Number(readFileSync(key, 'utf8')) || 0 } catch {}
  mkdirSync('/tmp/opencode', { recursive: true })
  writeFileSync(key, String(n + 1))
  return n === 0 ? 'running' : 'completed'
}

if (has('events') && has('detail')) {
  const seq = Number(val('--seq'))
  const forced = process.env.GRAPE_FAKE_TASK_STATUS
  out({ seq, status: forced || pollStatus(seq), agent_type: 'vod', summary: '需求分析完成', result: '已交接给 issue 节点' })
} else if (has('a2a')) {
  out({ seq: 85, agent: 'vod', status: 'running' })
} else if (has('issues') && has('list')) {
  out([{ number: 23, title: '实现登录功能', state: 'open', pipeline_status: 'coding' },
       { number: 24, title: '修复空指针', state: 'open', pipeline_status: 'qa' }])
} else if (has('issues') && has('mine')) {
  out([{ number: 23, title: '实现登录功能', state: 'open', pipeline_status: 'coding' }])
} else if (has('issues') && has('detail')) {
  out({ number: Number(val('--number')), title: '实现登录功能', state: 'open', body: '## 验收标准\n- 支持账号密码登录' })
} else if (has('issues') && has('pipeline')) {
  out({ scene: 'default', nodes: [
    { tag: 'vod', status: 'completed' }, { tag: 'issue', status: 'completed' },
    { tag: 'coding', status: 'running' }, { tag: 'qa', status: 'pending' }, { tag: 'sre', status: 'pending' },
  ] })
} else if (has('issues') && has('events')) {
  out([{ seq: 91, type: 'issue_comment', agent_type: 'qa', status: '', summary: 'PR 打回：缺少输入校验' },
       { seq: 92, type: 'step_start', agent_type: 'coding', status: 'running', summary: '修复轮开始' }])
} else if (has('issues') && has('create')) {
  const body = JSON.parse(val('--json') || '{}')
  out({ number: 42, title: body.title || '' })
} else if (has('scenes') && has('apply')) {
  out({ ok: true, scene_id: val('--json') ? JSON.parse(val('--json')).scene_id : '' })
} else if (has('scenes')) {
  out([{ id: 's1', display_name: 'Agent开发', category: 'ai', description: '智能体应用开发场景' },
       { id: 's2', display_name: '云原生', category: 'cloud', description: 'K8s 应用场景' }])
} else if (has('search')) {
  out([{ type: 'issue', title: '实现登录功能', owner: 'acme', repo: 'demo' }])
} else if (has('dashboard')) {
  out({ repo: `${val('--owner')}/${val('--repo')}`, pipelines: 3, running: 1 })
} else {
  out({ ok: true })
}
