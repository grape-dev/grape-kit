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
  if (data && Array.isArray(data.list)) return data.list
  return null
}

export function fallbackJson(data) {
  try { return '```json\n' + JSON.stringify(data, null, 2).slice(0, 8000) + '\n```' } catch { return String(data) }
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

export function renderIssues(data) {
  const rows = asArray(data)
  if (!rows) return fallbackJson(data)
  return mdTable(rows.slice(0, 30), [
    { h: '#', v: (r) => r.number ?? r.issue_number ?? '' },
    { h: '标题', v: (r) => r.title ?? '' },
    { h: '状态', v: (r) => r.state ?? r.status ?? '' },
    { h: '流水线', v: (r) => r.pipeline_status ?? r.stage ?? '' },
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
export function renderPipeline(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const icon = { completed: '[OK]', running: '[RUN]', queued: '[QUEUE]', failed: '[FAIL]', skipped: '[SKIP]', pending: '[WAIT]' }
  const nodes = asArray(data) ?? data.nodes ?? data.pipeline?.nodes
  if (!nodes) return fallbackJson(data)
  const chain = nodes.map((n) => {
    const tag = n.tag ?? n.agent ?? n.id ?? '?'
    const st = String(n.status ?? '').toLowerCase()
    return `${icon[st] || '·'} ${tag}(${st || '?'})`
  }).join(' → ')
  const lines = [`**流水线**: ${data.scene ?? data.scene_id ?? '-'}`, '', chain]
  return lines.join('\n')
}

export function renderTaskStatus(data) {
  if (!data || typeof data !== 'object') return fallbackJson(data)
  const lines = []
  lines.push(`- seq: ${data.seq ?? '-'} · status: **${data.status ?? '-'}** · agent: ${data.agent_type ?? data.agent ?? '-'}`)
  if (data.summary) lines.push(`- 摘要: ${String(data.summary).slice(0, 600)}`)
  if (data.result) lines.push(`- 结果: ${String(data.result).slice(0, 1500)}`)
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
  const lines = []
  lines.push(`流水线已触发：**seq=${data.seq ?? data.event_seq ?? '?'}** · agent=${data.agent ?? '-'} · status=${data.status ?? '-'}`)
  lines.push('')
  lines.push('用 `grape_wait_task(seq)` 阻塞等待终态，或 `grape_get_task_status(seq)` 查询。')
  return lines.join('\n')
}

export function renderGeneric(data) {
  const rows = asArray(data)
  if (rows && rows.length && typeof rows[0] === 'object') return fallbackJson(data)
  return fallbackJson(data)
}
