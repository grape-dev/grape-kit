/**
 * 精选工具面 —— 契约 v2.1.0 中人工筛选的 13 个工具（scope 硬门禁先行）。
 *
 * 纳入原则（对齐设计文档 §11 + grape-dsh CLI-CAPABILITY-BOUNDARY / DESIGN-A-MCP）：
 * - 只触发、只观察、可推进（start/resume/cancel 属用户决策层，工具描述里强制「需用户确认」）；
 * - 不暴露 A2A 节点间交接（trigger 是唯一入口，节点流转由服务端 pipelines.json 驱动）；
 * - session_only 命令（git-repo 等 28 个）不纳入 —— 外部 grape_ token 必 403；
 * - 高危动作（terminate / remove / delete）不纳管，兜底走 `grape` CLI 原生命令。
 *
 * 每个工具：{ name, description, schema, buildArgs, render }
 *   buildArgs(args) -> string[]   CLI 参数（不含 --json-out）
 *   render(json)    -> string     Markdown（无 UI 补偿层）
 */
import * as R from './render.mjs'
import { hostname } from 'node:os'
import { api } from './api.mjs'

const str = (desc) => ({ type: 'string', description: desc })
const num = (desc) => ({ type: 'number', description: desc })

const OWNER_REPO_NUM = {
  owner: str('仓库归属（owner）'),
  repo: str('仓库名（repo）'),
  number: num('issue 编号'),
}

export const TOOLS = [
  {
    name: 'grape_trigger_pipeline',
    description:
      '触发 Grape DevOps 流水线（A2A 交接给首个节点，默认 vod）。Grape 多 agent 流水线的唯一外部入口；节点间流转由服务端内部驱动。' +
      '【本地接管成果交回场景】若该 issue 此前被本地接管实现过（远端分支已有成果），context 必须结构化说明：' +
      '产出分支名 + commit + 测试证据，并明确「代码已在远端分支，请识别后直接进入 QA，勿重复实现」。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        issue_number: num('issue 编号'),
        agent: { type: 'string', description: '目标节点 agent，默认 vod', default: 'vod' },
        context: str('任务上下文/补充说明（可选）'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    buildArgs(a) {
      const payload = {
        repository: `${a.owner}/${a.repo}`,
        account: a.owner,
        issue_number: a.issue_number,
      }
      if (a.context) payload.context = a.context
      return ['a2a', 'handoff', '--json', JSON.stringify({ agent: a.agent || 'vod', payload })]
    },
    async native(a) {
      const r = await api.triggerPipeline(a.owner, a.repo, a.issue_number, a.context || '')
      return { seq: r.seq ?? r.event_seq, agent: r.agent ?? 'vod', status: r.status ?? 'running' }
    },
    render: R.renderTrigger,
  },
  {
    name: 'grape_get_task_status',
    description: '按事件序列号（trigger 返回的 seq）查询流水线任务当前状态。',
    schema: { type: 'object', properties: { seq: num('事件序列号') }, required: ['seq'] },
    buildArgs(a) { return ['events', 'detail', '--seq', String(a.seq)] },
    async native(a) { return api.taskStatus(a.seq) },
    render: R.renderTaskStatus,
  },
  {
    name: 'grape_wait_task',
    description:
      '阻塞等待流水线任务到终态（completed/failed/cancelled）或超时。每 interval 秒轮询一次。' +
      '默认上限 300 秒；长流水线建议由用户稍后用 get_task_status 复查，而不是无限等待。',
    schema: {
      type: 'object',
      properties: {
        seq: num('事件序列号'),
        timeout: num('超时秒数，默认 300'),
        interval: num('轮询间隔秒数，默认 3'),
      },
      required: ['seq'],
    },
    async run(a, { waitTask }) {
      const r = await waitTask(a.seq, { timeoutSec: a.timeout ?? 300, intervalSec: a.interval ?? 3 })
      return r
    },
    waitBased: true,
    render(json) {
      const base = R.renderTaskStatus(json)
      return json && json.timedOut
        ? base + `\n\n_等待超时（${json.polls ?? '-'} 次轮询后任务仍未终态）。复查方式：① 让我过几分钟再查（grape_get_task_status seq=${json.seq ?? '?'}）② 看流水线节点位置（grape_get_pipeline_info）③ 长任务别死等，先做别的。_`
        : base
    },
  },
  {
    name: 'grape_list_issues',
    description: '列出仓库的 issue 及 Grape 流水线状态（GitCode API 没有的 pipeline 视角）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        status: str('按状态过滤（open/closed/processing 等，可选）'),
      },
      required: ['owner', 'repo'],
    },
    buildArgs(a) {
      const args = ['issues', 'list', '--owner', a.owner, '--repo', a.repo]
      if (a.status) args.push('--status', String(a.status))
      return args
    },
    async native(a) { return api.listIssues(a.owner, a.repo, a.status) },
    render: R.renderIssues,
  },
  {
    name: 'grape_list_my_issues',
    description: '列出「我」的 issue（不需要 owner/repo），适合开始工作前领任务。',
    schema: {
      type: 'object',
      properties: {
        status: str('按状态过滤（如 processing，可选）'),
      },
    },
    buildArgs(a) {
      const args = ['issues', 'mine']
      if (a.status) args.push('--status', String(a.status))
      return args
    },
    async native(a) { return api.myIssues(a.status) },
    render: R.renderIssues,
  },
  {
    name: 'grape_get_issue_detail',
    description: '查看 issue 详情（含验收要求正文），开始实现前必读。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'detail', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issueDetail(a.owner, a.repo, a.number) },
    render: R.renderIssueDetail,
  },
  {
    name: 'grape_get_pipeline_info',
    description: '查看 issue 的流水线节点状态（vod→issue→coding→qa→sre 各节点进度）。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'pipeline', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issuePipeline(a.owner, a.repo, a.number) },
    render: R.renderPipeline,
  },
  {
    name: 'grape_get_issue_events',
    description: '查看 issue 的事件历史（QA 打回 / 评论 / 节点交接），端云协同的事件回环入口。',
    schema: { type: 'object', properties: OWNER_REPO_NUM, required: ['owner', 'repo', 'number'] },
    buildArgs(a) { return ['issues', 'events', '--owner', a.owner, '--repo', a.repo, '--number', String(a.number)] },
    async native(a) { return api.issueEvents(a.owner, a.repo, a.number) },
    render: R.renderEventTimeline,
  },
  {
    name: 'grape_create_issue',
    description:
      '在托管仓库创建 issue（可选同时触发流水线——由服务端场景配置决定）。' +
      'body 支持 title 与 markdown 正文 description（字段名以服务端契约为准，实测为 description 而非 body）。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        title: str('issue 标题'),
        description: str('issue 正文（markdown，可选）'),
      },
      required: ['owner', 'repo', 'title'],
    },
    buildArgs(a) {
      const body = { title: a.title }
      if (a.description) body.description = a.description
      return ['issues', 'create', '--owner', a.owner, '--repo', a.repo, '--json', JSON.stringify(body)]
    },
    async native(a) { return api.createIssue(a.owner, a.repo, a.title, a.description) },
    render(json) {
      if (json && typeof json === 'object' && (json.number || json.issue_number)) {
        return `Issue 已创建：**#${json.number ?? json.issue_number}** ${json.title ?? ''}`.trim()
      }
      return R.fallbackJson(json)
    },
  },
  {
    name: 'grape_list_scenes',
    description: '列出场景市场可用的流水线场景（agent-dev / cloud-native / iac 等）。',
    schema: {
      type: 'object',
      properties: { q: str('关键字过滤（可选）') },
    },
    buildArgs(a) {
      const args = ['scenes', 'market', 'list']
      if (a.q) args.push('--q', String(a.q))
      return args
    },
    async native(a) { return api.scenesMarket(a.q) },
    render: R.renderScenes,
  },
  {
    name: 'grape_apply_scene',
    description:
      '为仓库切换流水线场景。⚠️ 属用户决策层动作：调用前必须向用户确认目标场景。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        scene_id: str('场景 ID（从 grape_list_scenes 获取）'),
      },
      required: ['owner', 'repo', 'scene_id'],
    },
    buildArgs(a) {
      return ['scenes', 'apply', '--owner', a.owner, '--repo', a.repo, '--json', JSON.stringify({ scene_id: a.scene_id })]
    },
    async native(a) { return api.applyScene(a.owner, a.repo, a.scene_id) },
    render(json) {
      if (json && typeof json === 'object' && (json.ok ?? json.scene_id)) {
        return `场景已应用：${json.scene_id ?? ''} ${json.message ?? ''}`.trim()
      }
      return R.fallbackJson(json)
    },
  },
  {
    name: 'grape_search',
    description: '全局搜索：按关键字检索事件（event）、仓库（repo）、agent（all）。type 枚举仅 all/event/repo/agent，不支持 issue。',
    schema: {
      type: 'object',
      properties: { q: str('关键字'), type: { type: 'string', enum: ['all', 'event', 'repo', 'agent'], description: '结果类型过滤（服务端枚举，issue 不在其中）' } },
      required: ['q'],
    },
    buildArgs(a) {
      const args = ['search', '--q', String(a.q)]
      if (a.type) args.push('--type', String(a.type))
      return args
    },
    async native(a) { return api.globalSearch(a.q, a.type) },
    render: R.renderSearch,
  },
  {
    name: 'grape_get_repo_dashboard',
    description:
      '查看仓库仪表盘：流水线运行汇总、issue/PR 状态统计，适合汇报与总览场景。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo: str('repo') },
      required: ['owner', 'repo'],
    },
    buildArgs(a) { return ['dashboard', 'repo', '--owner', a.owner, '--repo', a.repo] },
    async native(a) { return api.repoDashboard(a.owner, a.repo) },
    render: R.renderGeneric,
  },

  /* ── v0.2.0 能力补齐（对齐 grape-dsh 工具面）────────────────────────── */

  {
    name: 'grape_get_pipeline_roadmap',
    description: '查看仓库级流水线蓝图（场景节点链，不针对单个 issue）。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo: str('repo') },
      required: ['owner', 'repo'],
    },
    buildArgs(a) { return ['pipeline', 'get', '--owner', a.owner, '--repo', a.repo] },
    async native(a) { return api.repoRoadmap(a.owner, a.repo) },
    render: R.renderPipeline,
  },

  ...['cancel', 'resume', 'start'].map((action) => ({
    name: `grape_${action}_issue`,
    description:
      action === 'cancel'
        ? '终止 issue 的整条流水线（⚠️ 不是「暂停当前节点」：已完成的 vod/issue 节点成果保留，但当前及后续节点全部停止、不做 QA/SRE 交接——本地接管后想交回请确认远端分支已推送并用 grape_trigger_pipeline 重新触发）。'
        + '⚠️ 强制决策门：调用前必须让用户在「①让渡接管（推荐：不取消，云端继续跑）②暂停等我确认 ③终止整链」中显式选择，未选择不得执行。'
        : action === 'resume'
          ? '恢复已取消的 issue 流水线。⚠️ 用户决策层动作：调用前必须向用户确认。'
          : '启动 issue 会话。⚠️ 用户决策层动作：调用前必须向用户确认。',
    schema: {
      type: 'object',
      properties: OWNER_REPO_NUM,
      required: ['owner', 'repo', 'number'],
    },
    async run(a, { runGrape, apiModule }) {
      const A = apiModule || (await import('./api.mjs')).api
      const det = await A.issueDetail(a.owner, a.repo, a.number)
      const id = det && (det.issue_id ?? det.id)
      if (!id) throw new Error('无法解析 issue 内部 id（detail 响应缺 issue_id）')
      const act = { cancel: A.cancelIssue, resume: A.resumeIssue, start: A.startIssue }[action]
      const r = await act(id)
      // #1-3 修复：resume 返回成功≠事实恢复——自动回读 pipeline_info 复核，向用户报告事实而非接口回执
      if (action === 'resume') {
        try {
          const pipe = await A.issuePipeline(a.owner, a.repo, a.number)
          const stage = pipe && (pipe.stage ?? pipe.task_status)
          return { ...(r ?? { ok: true, issue_id: id, action }), verified_stage: stage ?? 'unknown',
                   verify_note: stage ? `resume 已生效，当前阶段 ${stage}` : 'resume 接口返回成功但流水线状态读取失败，请用 grape_get_pipeline_info 人工复核' }
        } catch { 
          return { ...(r ?? { ok: true, issue_id: id, action }), verified_stage: 'unknown',
                   verify_note: 'resume 接口返回成功，但状态复核失败——请用 grape_get_pipeline_info 确认流水线真的恢复' }
        }
      }
      return r ?? { ok: true, issue_id: id, action }
    },
    render(json) {
      return json && typeof json === 'object'
        ? `\`${json.action ?? '操作'}\` 已执行：issue_id=${json.issue_id ?? '-'} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  })),

  {
    name: 'grape_list_managed_repos',
    description: '列出 Grape 已纳管的仓库（repo_key/场景/工作分支），是端侧找活干的第一步。注意：与成员/同步视图数据源不同，本视图为空时改用 grape_list_repos_member 或 grape_sync_repos 查看可操作仓库。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'managed'] },
    async native() { return api.managedRepos() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: '仓库', v: (r) => r.repo_key ?? r.full_name ?? r.name ?? '' },
        { h: '场景', v: (r) => r.scene_id ?? r.scene ?? '' },
        { h: '分支', v: (r) => r.work_branch ?? '' },
      ])
    },
  },
  {
    name: 'grape_list_repos_member',
    description: '列出当前用户有操作权限的仓库成员视图。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'member'] },
    async native() { return api.memberRepos() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: '仓库', v: (r) => r.repo_key ?? r.full_name ?? r.name ?? '' },
        { h: '角色', v: (r) => r.role ?? '' },
      ])
    },
  },
  {
    name: 'grape_get_repo_project_info',
    description: '查看仓库的项目信息（语言/框架/结构分析等）。',
    schema: {
      type: 'object',
      properties: { owner: str('owner'), repo_name: str('repo 名') },
      required: ['owner', 'repo_name'],
    },
    buildArgs(a) { return ['repos', 'project', 'info', '--owner', a.owner, '--repo', a.repo_name] },
    async native(a) { return api.projectInfo(a.owner, a.repo_name) },
    render: R.renderGeneric,
  },
  {
    name: 'grape_host_repo',
    description:
      '把一个 Git 仓库纳管进 Grape（owner/repo 形式的 full_name）。⚠️ 用户决策层动作：纳管会让该仓库进入流水线托管，调用前必须向用户确认。',
    schema: {
      type: 'object',
      properties: { full_name: str('owner/repo'), provider: str('来源平台（gitcode/github/gitlab，可选，默认 gitcode）') },
      required: ['full_name'],
    },
    buildArgs(a) {
      const args = ['repos', 'host', '--json', JSON.stringify({ full_name: a.full_name })]
      if (a.provider) args.push('--provider', a.provider)
      return args
    },
    async native(a) { return api.hostRepo(a.full_name, a.provider) },
    render(json) {
      return json && typeof json === 'object' && !json.error
        ? `纳管成功：${json.full_name ?? json.repo_key ?? ''} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  },
  {
    name: 'grape_sync_repos',
    description: '从 VCS 同步仓库列表到 Grape（纳管清单与远端对齐）。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['repos', 'sync'] },
    async native() { return api.syncRepos() },
    render(json) { return `同步完成 ${R.fallbackJson(json)}` },
  },

  {
    name: 'grape_list_skills',
    description: '列出 Grape 技能库技能。',
    schema: {
      type: 'object',
      properties: { q: str('关键字过滤（可选）') },
    },
    buildArgs(a) {
      return a.q ? ['skills', 'search', '--q', a.q] : ['skills', 'list']
    },
    async native(a) { return a.q ? api.skillsSearch(a.q) : api.skillsList() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.skill_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_search_skills',
    description: '按关键字搜索 Grape 技能库（name/描述全文匹配）。',
    schema: { type: 'object', properties: { q: str('关键字') }, required: ['q'] },
    buildArgs(a) { return ['skills', 'search', '--q', String(a.q)] },
    async native(a) { return api.skillsSearch(a.q) },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.skill_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_get_skill_detail',
    description: '查看 skill 详情（含 SKILL.md 内容）。',
    schema: { type: 'object', properties: { skill_id: str('skill id') }, required: ['skill_id'] },
    buildArgs(a) { return ['skills', 'detail', '--skill_id', String(a.skill_id)] },
    async native(a) { return api.skillDetail(a.skill_id) },
    render(json) {
      if (json && typeof json === 'object') {
        const body = String(json.content ?? json.skill_md ?? json.description ?? '')
        return `### ${json.name ?? json.skill_id ?? ''}\n\n${body.slice(0, 3000)}`
      }
      return R.fallbackJson(json)
    },
  },

  {
    name: 'grape_list_knowledge',
    description: '列出知识库条目（标题/摘要），实现前检索上下文用。',
    schema: {
      type: 'object',
      properties: {
        repo: str('限定仓库（owner/repo，服务端要求必须指定 repo）'),
        q: str('关键字过滤（可选）'),
      },
      required: ['repo'],
    },
    buildArgs(a) {
      const args = ['knowledge', 'list', '--repo', String(a.repo)]
      if (a.q) args.push('--q', a.q)
      return args
    },
    async native(a) { return api.knowledgeList(a.repo, a.q) },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.knowledge_id ?? r.id ?? '' },
        { h: '标题', v: (r) => r.title ?? r.name ?? '' },
        { h: '摘要', v: (r) => String(r.summary ?? r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_get_knowledge_detail',
    description: '查看知识条目详情（正文 markdown），供实现前吸收仓库沉淀的经验。',
    schema: { type: 'object', properties: { knowledge_id: str('知识条目 id') }, required: ['knowledge_id'] },
    buildArgs(a) { return ['knowledge', 'detail', '--knowledge_id', String(a.knowledge_id)] },
    async native(a) { return api.knowledgeDetail(a.knowledge_id) },
    render(json) {
      if (json && typeof json === 'object') {
        return `### ${json.title ?? json.knowledge_id ?? ''}\n\n${String(json.content ?? json.body ?? '').slice(0, 3000)}`
      }
      return R.fallbackJson(json)
    },
  },

  {
    name: 'grape_list_project_templates',
    description: '列出 Grape 项目模板——开源项目即模板，选一个即可一键建仓进入 AI 工作流。',
    schema: { type: 'object', properties: {} },
    buildArgs() { return ['project', 'templates', 'list'] },
    async native() { return api.templatesList() },
    render(data) {
      return R.mdTable(R.asArray(data) || [], [
        { h: 'ID', v: (r) => r.template_id ?? r.id ?? '' },
        { h: '名称', v: (r) => r.name ?? r.title ?? '' },
        { h: '描述', v: (r) => String(r.description ?? '').slice(0, 80) },
      ])
    },
  },
  {
    name: 'grape_create_project',
    description:
      '从模板创建项目（建在当前账号命名空间下）。⚠️ 用户决策层动作：调用前必须向用户确认模板与仓库名。',
    schema: {
      type: 'object',
      properties: {
        template_id: str('模板 id（grape_list_project_templates 获取）'),
        repo_name: str('新仓库名'),
        provider: str('来源平台（可选，默认 gitcode）'),
      },
      required: ['template_id', 'repo_name'],
    },
    buildArgs(a) {
      const body = { template_id: a.template_id, repo_name: a.repo_name }
      if (a.provider) body.provider = a.provider
      return ['project', 'template', 'create', '--json', JSON.stringify(body)]
    },
    async native(a) { return api.createProject(a.template_id, a.repo_name, a.provider) },
    render(json) {
      return json && typeof json === 'object' && !json.error
        ? `项目创建中：${json.repo_name ?? json.full_name ?? ''} ${json.message ?? ''}`.trim()
        : R.fallbackJson(json)
    },
  },

  {
    name: 'grape_takeover_context',
    description:
      '获取 issue 当前运行任务的接管上下文（task_id/原 prompt/执行日志/env）。端云协同接管第一步：' +
      '拿到上下文后通常还需取消原任务（grape_cancel_issue，需用户确认），再在本机以该上下文交互式继续。',
    schema: {
      type: 'object',
      properties: {
        owner: str('owner'),
        repo: str('repo'),
        number: num('issue 编号'),
      },
      required: ['owner', 'repo', 'number'],
    },
    buildArgs(a) {
      return ['runtime', 'takeover', 'context', '--repo_key', `gitcode:${a.owner}/${a.repo}`, '--issue_number', String(a.number)]
    },
    async native(a) { return api.takeoverContext(a.owner, a.repo, a.number) },
    render(json) {
      if (!json || typeof json !== 'object' || !json.task_id) {
        return json && json.error ? `无正在运行的任务：${json.error}` : R.fallbackJson(json)
      }
      const lines = [`### 接管上下文（task ${json.task_id}）`, '']
      lines.push(`- agent: ${json.agent_type ?? '-'} · skill: ${json.skill ?? '-'} · 状态: ${json.status ?? '-'}`)
      const msgs = Array.isArray(json.messages) ? json.messages : []
      if (msgs.length) {
        lines.push('', `**执行日志（最近 ${msgs.length} 条，已归一化）**`, '')
        const typeLine = (m) => {
          const type = m.type ?? ''
          const content = String(m.content ?? '').slice(0, 300)
          const output = String(m.output ?? '').slice(0, 300)
          if (type === 'step_start') return `--- ${content} ---`
          if (type === 'reasoning') return `[思考] ${content}`
          if (type === 'text') return `[回复] ${content}`
          if (type === 'tool_use') return `[工具调用] ${m.tool ?? ''}${content ? ': ' + content : ''}`
          if (type === 'tool_result') return `[工具结果] ${content || output}`
          if (type === 'error') return `[错误] ${content}`
          if (type === 'log') return `[日志] ${content}`
          return null
        }
        const logLines = msgs.map(typeLine).filter(Boolean)
        lines.push(logLines.join('\n').slice(-8000))
      }
      if (json.prompt) lines.push('', '**原始任务 Prompt（尾部）**', '', String(json.prompt).slice(-4000))
      lines.push('', '_接管动作：先 grape_cancel_issue（需用户确认）→ 本机以以上上下文交互式继续。env_extra 已随上下文返回，接管会话需还原 REPO_FULL_NAME / ISSUE_NUMBER 等环境。_')
      return lines.join('\n')
    },
  },

  {
    name: 'grape_worker_onboard',
    description:
      '把本机接入为 Grape Worker（生成 runtime 凭据并给出安装命令）。' +
      '本工具只生成【可见的安装命令】，由 agent 在终端中执行（用户可亲眼看到并打断）——不静默安装。' +
      '执行后本机即与远端 worker 同级参与任务认领。',
    schema: {
      type: 'object',
      properties: { device_name: str('设备名（可选，默认 grape-kit-<主机名>）') },
    },
    async run(a, { runGrape, apiModule }) {
      const base = (process.env.GRAPE_BASE_URL || 'https://www.grapedev.cn').replace(/\/$/, '')
      const baseName = a.device_name || `grape-kit-${hostname()}`
      const A = apiModule || (await import('./api.mjs')).api
      // 凭据名全局唯一且 token 只展示一次：重名（400 已存在）自动加时间戳后缀重试一次
      let cred
      let name = baseName
      const create = async (n) => (runGrape && !apiModule)
        ? runGrape(['settings', 'runtime', 'credential', 'create', '--json', JSON.stringify({ name: n, scope: 'user' })])
        : { json: await A.workerCredentialCreate(n, 'user') }
      try {
        cred = await create(name)
      } catch (err) {
        if (/已存在/.test(err.message || '')) {
          name = `${baseName}-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
          cred = await create(name)
        } else {
          throw err
        }
      }
      const j = cred.json
      const token = j && (j.token || (j.result && j.result.token))
      if (!token) return { onboard: false, error: 'credential create 未返回 token', raw: j }
      return {
        onboard: 'ready',
        device: name,
        install_command: `curl -sSL ${base}/api/runtime/install | bash -s -- --token ${token} --server ${base} --device ${name}`,
        note: '在终端可见地执行上方命令完成接入；凭据可在 grape settings runtime credentials 中管理/吊销',
      }
    },
    render(json) {
      if (json && json.onboard === false) return `凭据创建失败：${json.error}\n\n${R.fallbackJson(json.raw)}`
      if (json && json.install_command) {
        return [
          `### 本机接入 Worker（${json.device}）`, '',
          '在终端执行以下命令（幂等，可随时打断）：', '',
          '```bash', json.install_command, '```', '',
          json.note ?? '',
        ].join('\n')
      }
      return R.fallbackJson(json)
    },
  },
]

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

export function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null
}

/** MCP tools/list 用的定义（strip 实现字段） */
export function toolDefs() {
  return TOOLS.map(({ name, description, schema }) => ({ name, description, inputSchema: schema }))
}
