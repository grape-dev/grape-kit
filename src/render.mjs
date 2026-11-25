/**
 * Markdown 渲染层 —— 无 UI 宿主的补偿（替代 dsh 的 presentCall/render/presentResult）。
 * 工具返回即人可读的表格 / 节点链 / 时间线；渲染失败一律回退 JSON，不抛错。
 */

export function asArray(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.items)) return data.items
  if (data && Array.isArray(data.issues)) return data.issues
  if (data && Array.isArray(data.scenes)) return data.scenes
  if (data && Array.isArray(data.results)) return data.results
  if (data && Array.isArray(data.events)) return data.events
  if (data && Array.isArray(data.repos)) return data.repos
  if (data && Array.isArray(data.agents)) return data.agents
  if (data && Array.isArray(data.list)) return data.list
  return null
}

export function fallbackJson(data) {
  try { return '```json\n' + JSON.stringify(data, null, 2).slice(0, 8000) + '\n```' } catch { return String(data) }
}

/**
 * 凭据掩码（Issue #31）：只保留首尾各 2 位，长度 ≤6 一律全掩。
 * 渲染层唯一入口——任何工具都不得把明文口令拼进输出/注释/评论。
 */
export function maskSecret(secret) {
  const s = String(secret ?? '')
  if (!s) return ''
  if (s.length <= 6) return '****'
  return `${s.slice(0, 2)}****${s.slice(-2)}`
}

/** 到期 epoch → 可读时间（UTC ISO；同时保留 epoch 便于脚本比对） */
export function formatEpoch(epoch) {
  const n = Number(epoch)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return String(n)
  return `${d.toISOString().replace('.000Z', 'Z')}（UTC）`
}

export function mdTable(rows, columns) {
  if (!rows || !rows.length) return '_（空）_'
  const head = `| ${columns.map((c) => c.h).join(' | ')} |`
  const sep = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => {
    const cells = columns.map((c) => {
      let v = typeof c.v === 'function' ? c.v(r) : r[c.v]
      if (v === undefined || v === null) v = ''
      return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)
    })
    return `| ${cells.join(' | ')} |`
  })
  return [head, sep, ...body].join('\n')
}

const STAGE_ORDER = ['vod', 'issue', 'coding', 'qa', 'sre']
function stageBar(stage) {
  const st = String(stage ?? '').toLowerCase()
  if (!st) return ''
  const idx = STAGE_ORDER.indexOf(st)
  if (idx < 0) return st
  return '●'.repeat(idx + 1) + '○'.repeat(STAGE_ORDER.length - idx - 1) + ` ${idx + 1}/${STAGE_ORDER.length}`
}

export function renderIssues(data) {
  const rows = asArray(data)
  if (!rows) return fallbackJson(data)
  return mdTable(rows.slice(0, 30), [
    { h: '#', v: (r) => r.number ?? r.issue_number ?? '' },
    { h: '仓库', v: (r) => (r.repo_key ? String(r.repo_key).replace(/^gitcode:/, '').split('/')[1] ?? String(r.repo_key).replace(/^gitcode:/, '') : (r.repo ?? '')) },
    { h: '标题', v: (r) => (r.title ?? '').slice(0, 40) },
    { h: '状态', v: (r) => { const st = String(r.state ?? r.status ?? ''); const em = NODE_ICON[st.toLowerCase()] ?? (st === 'processing' ? '⚙️' : st === 'active' ? '🟢' : st === 'done' || st === 'completed' ? '✅' : st === 'cancelled' ? '🚫' : ''); return (em ? em + ' ' : '') + st } },
    { h: '进度', v: (r) => stageBar(r.stage ?? r.pipeline_status) },
    { h: '节点', v: (r) => (r.stage ?? r.pipeline_status ?? '') + (r.task_status ? ` (${r.task_status})` : '') },
  ]) + (rows.length > 30 ? `\n_（共 ${rows.length} 条，仅显示前 30）_` : '')
}

export function renderIssueDetail(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const lines = []
  lines.push(`### Issue #${data.number ?? ''} ${data.title ?? ''}`)
  lines.push(`- 状态: ${data.state ?? data.status ?? '-'}`)
  if (data.stage || data.pipeline_status) lines.push(`- 阶段: ${data.stage ?? data.pipeline_status}`)
  if (data.repository || data.repo_key) lines.push(`- 仓库: ${data.repository ?? data.repo_key}`)
  const body = String(data.body ?? data.description ?? '').trim()
  if (body) lines.push('', body.slice(0, 2000))
  return lines.join('\n')
}

/** 节点链：vod → issue → coding → qa → sre，带状态标记 */
const NODE_ICON = { completed: '✅', running: '🏃', queued: '📦', failed: '❌', skipped: '⏭️', pending: '⏳', takeover: '🤝' }
const NODE_TAG = { completed: '[OK]', running: '[RUN]', queued: '[QUEUE]', failed: '[FAIL]', skipped: '[SKIP]', pending: '[WAIT]', takeover: '[TAKEOVER]' }
const ST_CLASS = { completed: 'done', running: 'run', takeover: 'run', failed: 'fail' }
function pickNodes(data) {
  const segments = (data.segments ?? data.pipeline?.segments)
  if (segments?.length) {
    // 事件流形态：每段一个节点事件（按 seq 去重取每 agent 最新），running/takeover 段是当前节点
    const byAgent = new Map()
    for (const sg of segments) {
      const a = sg.agent ?? sg.agent_type
      if (!a) continue
      byAgent.set(a, { agent: a, status: sg.status, seq: sg.seq })
    }
    return [...byAgent.values()]
  }
  const stages = (data.stages ?? data.pipeline?.stages)
  if (stages?.length) {
    return stages.map((st) => {
      const ev = st.latest_event ?? st.event ?? {}
      return { agent: st.agent ?? ev.agent, status: st.status ?? ev.status, scene_id: st.scene_id, scene_name: st.scene_name }
    })
  }
  const nodes = asArray(data) ?? data.nodes ?? data.pipeline?.nodes
  if (!nodes) return null
  return nodes.map((n) => (typeof n === 'string' ? { agent: n, status: '' } : n))
}

export function renderPipeline(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const nodes = pickNodes(data)
  if (!nodes) return fallbackJson(data)
  const sceneName = data.scene ?? data.scene_name ?? data.scene_id ?? (nodes[0]?.scene_name ?? '-')
  const issueLabel = data.issue ? ` ─ Issue #${data.issue_number ?? ''} ${data.title ?? ''}`.trimEnd() : ''
  const stats = { done: 0, run: 0, fail: 0, wait: 0 }
  for (const n of nodes) {
    const st = String(n.status ?? '').toLowerCase()
    if (st === 'completed') stats.done++
    else if (st === 'running' || st === 'takeover') stats.run++
    else if (st === 'failed') stats.fail++
    else stats.wait++
  }
  const current = nodes.find((n) => ['running', 'takeover'].includes(String(n.status ?? '').toLowerCase()))
  const overall = data.status ? ` · 整体：${data.status}${data.stalled ? `（⚠️ 疑似停滞 ${data.stalled_minutes ?? '?'} 分钟）` : ''}` : ''
  const lines = []
  lines.push(`┌─ 流水线：${sceneName}${issueLabel}`)
  for (const n of nodes) {
    const tag = n.tag ?? n.agent ?? n.id ?? '?'
    const st = String(n.status ?? '').toLowerCase()
    lines.push(`│  ${NODE_ICON[st] ?? '·'} ${String(tag).padEnd(8)} ${NODE_TAG[st] ?? (st || '?')}`)
  }
  const total = nodes.length
  const bar = '█'.repeat(stats.done * 2 + (stats.run ? 1 : 0)) + '░'.repeat(Math.max(0, (total * 2) - stats.done * 2 - (stats.run ? 1 : 0)))
  const pct = Math.round((stats.done / Math.max(1, total)) * 100)
  let verdict = `${stats.done}/${total} 节点完成`
  if (stats.fail) verdict += ` · ❌ ${stats.fail} 个失败节点`
  if (current) verdict += ` · 当前：${current.agent ?? current.tag ?? '?'} ${String(current.status).toLowerCase() === 'takeover' ? '已被本地接管' : '执行中'}`
  lines.push(`│  进度 [${bar}] ${pct}%`)
  lines.push(`└─ ${verdict}${overall}`)
  // Mermaid 图形（宿主支持则渲染为图，不支持则忽略）
  const mm = ['```mermaid', 'flowchart LR']
  nodes.forEach((n, i) => {
    const tag = n.tag ?? n.agent ?? n.id ?? ('n' + i)
    const st = String(n.status ?? '').toLowerCase()
    mm.push(`    n${i}["${tag}"]:::${ST_CLASS[st] ?? 'wait'}`)
    if (i > 0) mm.push(`    n${i - 1} --> n${i}`)
  })
  mm.push('    classDef done fill:#1a7f37,color:#fff')
  mm.push('    classDef run fill:#d4a72c,color:#fff,stroke-width:3px')
  mm.push('    classDef fail fill:#cf222e,color:#fff')
  mm.push('    classDef wait fill:#eaeef2,color:#888')
  mm.push('```')
  lines.push('', mm.join('\n'))
  return lines.join('\n')
}

export function renderTaskStatus(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const seq = data.seq ?? '-'
  const st = String(data.status ?? '-').toLowerCase()
  const agent = data.agent_type ?? data.agent ?? '-'
  const done = ['completed', 'done', 'failed', 'cancelled'].includes(st)
  const lines = []
  lines.push(`┌─ 任务 seq=${seq}`)
  lines.push(`│  ${NODE_ICON[st] ?? '·'} ${agent.padEnd(8)} ${NODE_TAG[st] ?? data.status ?? '-'}`)
  lines.push(`│  进度 [${'█'.repeat(done ? 10 : st === 'running' ? 5 : 1)}${'░'.repeat(done ? 0 : st === 'running' ? 5 : 9)}] ${done ? 100 : st === 'running' ? 50 : 10}%`)
  lines.push(`└─ ${st === 'completed' ? '已完成' : st === 'failed' ? '❌ 失败——可 force 重派：让 agent 调 grape_trigger_pipeline(force) 或重试' : st === 'running' ? '执行中——稍后说「查 seq ' + seq + '」继续跟' : data.status ?? '-'}`)
  if (data.summary) lines.push('', `摘要: ${String(data.summary).slice(0, 600)}`)
  if (data.result) lines.push('', `结果: ${String(data.result).slice(0, 1200)}`)
  return lines.join('\n')
}

export function renderEventTimeline(data) {
  const rows = asArray(data)
  if (!rows) return fallbackJson(data)
  return rows.slice(-20).map((e) => {
    const t = e.type ?? e.event_type ?? ''
    const agent = e.agent_type ?? e.agent ?? ''
    const sum = String(e.summary ?? e.content ?? '').replace(/\n/g, ' ').slice(0, 150)
    const st = e.status ? ` [${e.status}]` : ''
    return `- \`#${e.seq ?? '?'}\` **${t}** ${agent}${st} — ${sum}`
  }).join('\n') || '_（无事件）_'
}

export function renderScenes(data) {
  const rows = asArray(data)
  if (!rows) return fallbackJson(data)
  return mdTable(rows.slice(0, 20), [
    { h: 'ID', v: (r) => r.id ?? r.scene_id ?? '' },
    { h: '名称', v: (r) => r.display_name ?? r.name ?? '' },
    { h: '类目', v: (r) => r.category ?? '' },
    { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
    { h: '节点链', v: (r) => {
      const ns = r.agents ?? r.nodes ?? []
      return Array.isArray(ns) ? ns.join('→') : String(ns)
    } },
  ])
}

export function renderSearch(data) {
  const rows = asArray(data)
  if (!rows) return fallbackJson(data)
  return mdTable(rows.slice(0, 15), [
    { h: '类型', v: (r) => r.type ?? r.kind ?? '' },
    { h: '标题', v: (r) => r.title ?? r.name ?? '' },
    { h: '位置', v: (r) => r.owner && r.repo ? `${r.owner}/${r.repo}` : (r.repo_key ?? r.url ?? '') },
  ])
}

export function renderTrigger(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const seq = data.seq ?? data.event_seq ?? '?'
  const agent = data.agent ?? '-'
  const st = String(data.status ?? '-').toLowerCase()
  const lines = []
  lines.push(`流水线已触发：**seq=${seq}** · agent=${agent} · ${NODE_ICON[st] ?? ''} ${data.status ?? '-'}`)
  lines.push('')
  lines.push(`进度 [${'█'.repeat(st === 'running' ? 1 : 2)}${'░'.repeat(9)}] 刚起步`)
  lines.push('')
  lines.push('```mermaid')
  lines.push('flowchart LR')
  lines.push(`    n0["${agent}"]:::run`)
  for (const a of ['issue', 'coding', 'qa', 'sre']) {
    if (a === agent) continue
    lines.push(`    n${a}["${a}"]:::wait`)
  }
  // 按链序连线（agent 可能是链中任一节点）
  const chain = ['vod', 'issue', 'coding', 'qa', 'sre'].filter((a, i) => i === 0 || a !== agent)
  const nodes = [agent, ...['issue', 'coding', 'qa', 'sre'].filter((a) => a !== agent)]
  let prev = null
  for (const a of nodes) {
    if (prev !== null) lines.push(`    ${prev} --> ${a === 'issue' && nodes.includes('issue') ? 'issue' : a}`)
    prev = a === 'issue' ? 'issue' : a
  }
  lines.push('    classDef run fill:#d4a72c,color:#fff,stroke-width:3px')
  lines.push('    classDef wait fill:#eaeef2,color:#888')
  lines.push('```')
  lines.push('')
  lines.push('用 `grape_wait_task(seq)` 阻塞等待终态，或 `grape_get_task_status(seq)` 查询。')
  return lines.join('\n')
}

export function renderGeneric(data) {
  const rows = asArray(data)
  if (rows && rows.length && typeof rows[0] === 'object') return fallbackJson(data)
  return fallbackJson(data)
}
