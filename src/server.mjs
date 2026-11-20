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

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const INSTRUCTIONS = `Grape DevOps 流水线遥控（多 agent：vod→issue→coding→qa→sre）。

使用纪律：
1. 只触发、只观察、可推进；流水线节点间交接（A2A）由服务端驱动，不要试图干预。
2. cancel / apply_scene / terminate 属用户决策层——调用前必须向用户确认。
3. 触发后用 grape_wait_task 等终态（默认 300s 上限）；长任务改用 grape_get_task_status 复查。
4. token 作用域：当前走用户级 GRAPE_API_TOKEN；git-repo 类会话命令不可用（403 属预期）。
5. grape_get_issue_events 是云端打回/评论的事件回环入口：PR 被 QA 打回时从这里发现。
6. 命令面不止这些工具时，优先用已注册工具；未经确认不要构造任何删除/终止类操作。
7. 接管（takeover）：tko_ 仅 repo_session、不含 git 凭据注入；finish 必须用用户级凭据且仅在用户对话确认后执行；takeover_start 只能对准当前活跃节点，409 agent_mismatch 时按 60-120s 轮询再试。`

/**
 * 创建 server 实例（依赖注入便于测试）。
 * @param {{runGrape?: Function, waitTask?: Function}} [deps]
 */
export function createServer(deps = {}) {
  const apiModule = deps.apiModule || api
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
        const r = await tool.run(args, { runGrape: _runGrape, waitTask: _waitTask, apiModule })
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
        return { content: [{ type: 'text', text: `grape API 失败（${err.status}）：${err.message}${hint}` }], isError: true }
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
