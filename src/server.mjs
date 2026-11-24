/**
 * grape-kit MCP server（stdio）—— 无 UI agent 插件壳。
 *
 * 职责只有三件：发现（tools/list）、转发（tools/call → grape CLI）、渲染（Markdown）。
 * 厚能力全在 grape CLI（契约/认证/错误包装）；壳零 token 处理（env 直通）。
 */
import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { runGrape, waitTask, GrapeCliError } from './cli.mjs'
import { waitTaskNative, GrapeApiError, api } from './api.mjs'
import { toolDefs, findTool } from './tools.mjs'
import * as lifecycleModule from './lifecycle.mjs'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const INSTRUCTIONS = `Grape DevOps 流水线遥控（多 agent：vod→issue→coding→qa→sre）。

角色（先读）：你是流水线**外面**的遥控/观察者。只触发、只观察、可推进；节点间交接（A2A）由服务端驱动。
- 禁止用 \`--force\` / \`force=true\` 越过任何门禁（pending_review、派发门禁、技能校验）——那是伪造节点流转、冒充决策层。
- 不替用户决策：建单、触发流水线、应用场景、设默认场景、取消/恢复/终止、上传/升级技能、正式交回（finish）之前，必须先在对话里拿到用户明确同意。
- 遇到卡点（PR 未合入、审核未过、缺凭据）：停下来把事实和选项交给用户，不要自己想办法绕过。

三条最容易搞错的语义：
1. 场景三段式：市场模板（数字 id）→ \`grape_apply_scene\` 在仓库内创建副本（custom-xxxxxxxx）→ \`grape_set_repo_scene\` 设为仓库默认。
   「应用场景」≠「切换场景」：\`POST /api/scenes/apply/{owner}/{repo}\` 只把节点技能与引擎绑定刷进 agent_session，不改仓库归属，响应里也没有 scene_id。
   **只对新建生效**：已存在的 issue 保留自己的 scene_id 快照，切场景/设默认都不会追溯改动它——要换已建单的链，只能在建单时显式指定或重开一单。
2. 技能 scope：user 级技能不能绑进 repo 级场景（平台 403 级拦截）。先 \`grape_convert_skill\` 复制成 repo 技能，再改节点 skill_id。
   上传/升级用 \`grape_upload_skill\` / \`grape_update_skill\`：本地预检 frontmatter 与 ZIP 顶层目录，服务端 errors 全量透出。
3. 端云接管：\`takeover_start\` 只能对准**当前活跃节点**（409 agent_mismatch 时按 60-120s 轮询再试）。
   \`tko_\` 只覆盖 repo_session、**不含 git 凭据注入**；request-finish 可用 tko_；正式 \`finish\` 必须用**用户级凭据**（\`grape_\`）且只在用户确认后执行。

执行纪律：
- 触发后用 \`grape_wait_task\` 等终态（默认 300s）；长任务改 \`grape_get_task_status\` 复查，别死等。
- 写动作一律以**回读**为准：应用场景后列仓库场景；设默认后读 dev_scene；建单后读 issue 详情；交回后看 handoff 与事件。
- 403 分两类：tk_ 专属端点（review-pass / review-reject / confirm-done）属通道边界，**不要重试**，改用 WebUI 或请用户执行；
  仓库未纳管导致的 403（无权对该仓库发起 A2A）先用 \`grape_host_repo\` 纳管（需用户确认）。
- 事件是事实源：QA 打回与评论从 \`grape_get_issue_events\` 读；下一节点是否已派发看 \`next_seq\` 与 issue 事件，别重复派发。
- 自管理属用户决策层：grape_kit_version / grape_kit_check_update 只读直执行（check_update 的 dismiss 只写本地忽略状态文件）；grape_kit_upgrade / grape_kit_install / grape_kit_uninstall **只生成命令、工具本身不执行任何变更**——必须先把命令块与影响范围交给用户，获得确认后再由用户（或用户允许的终端）执行。`

/**
 * 创建 server 实例（依赖注入便于测试）。
 * @param {{runGrape?: Function, waitTask?: Function, apiModule?: object, lifecycleModule?: object}} [deps]
 */
export function createServer(deps = {}) {
  const apiModule = deps.apiModule || api
  const lifecycle = deps.lifecycleModule || lifecycleModule
  const _runGrape = deps.runGrape || runGrape
  const _waitTask = deps.waitTask || waitTaskNative   // v0.3.0：原生轮询（无 CLI 冷启动）；测试可注入旧版

  const server = new Server(
    { name: "grape-kit", version: PKG.version },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefs() }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = req.params.arguments || {}
    const tool = findTool(name)
    if (!tool) {
      return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true }
    }
    try {
      let json
      if (tool.run) {
        // 多步工具（等待/级联解析/凭据生成）：自持执行逻辑。
        // 契约：waitBased 工具返回 {json,...}；其余 run() 工具直接返回结果值。
        const r = await tool.run(args, { runGrape: _runGrape, waitTask: _waitTask, apiModule, lifecycle })
        json = tool.waitBased ? { ...r.json, timedOut: !!r.timedOut, polls: r.polls } : r
      } else if (tool.native) {
        // v0.3.0 传输层原生化：优先原生 HTTP（无 Python/CLI 依赖）。
        // 401 宽触发回退 CLI（CLI 可能有自己的缓存通道），但回退仅作最佳努力：
        // CLI 不可用/失败时回抛原始 native 401，保留 hintFor(401) 的 token 失效指引；
        // 其余 API 错误如实上抛，不进入回退。
        try {
          json = await tool.native(args)
        } catch (e) {
          if (e instanceof GrapeApiError && e.status === 401) {
            try {
              const r = await _runGrape(tool.buildArgs(args))
              json = r.json
            } catch {
              throw e
            }
          } else {
            throw e
          }
        }
      } else {
        // CLI 通道（grape git 等少数场景）
        const r = await _runGrape(tool.buildArgs(args))
        json = r.json
      }
      let text
      try {
        text = tool.render(json)
      } catch {
        text = undefined
      }
      if (!text) text = '```json\n' + JSON.stringify(json, null, 2).slice(0, 8000) + '\n```'
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      if (err instanceof GrapeApiError) {
        const hint = err.hint ? `\n\n${err.hint}` : ''
        // 技能上传等校验失败会一次返回多条 detail.errors：全量透出，截断只留第一条
        // 会让宿主按残缺信息反复试错（测试报告 D3 第四坑）。
        const errs = Array.isArray(err.detailErrors) && err.detailErrors.length
          ? `\n\n校验未通过（${err.detailErrors.length} 条，逐条改）：\n- ${err.detailErrors.join('\n- ')}`
          : ''
        return { content: [{ type: 'text', text: `grape API 失败（${err.status}）：${err.message}${errs}${hint}` }], isError: true }
      }
      const code = err instanceof GrapeCliError ? err.code : 1
      const hint =
        code === 401
          ? '\n\n提示：token 无效或过期，请检查 GRAPE_API_TOKEN。'
          : code === 403
            ? '\n\n提示：可能是 session_only 端点（外部 grape_ token 不可用，属预期边界）或权限不足。'
            : code === 127
              ? ''
              : ''
      return { content: [{ type: 'text', text: `grape CLI 失败（exit=${code}）：${err.message}${hint}` }], isError: true }
    }
  })

  return server
}
