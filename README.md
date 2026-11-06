# grape-mcp

Grape DevOps 流水线工具的无 UI agent 插件（MCP stdio 薄壳），面向 opencode / hermes 等无 Web UI 的编码 agent。
厚能力全在 [grape-cli](https://gitcode.com/grape-dev/grape-cli)（契约驱动命令树 = 官方 SDK），壳只做三件事：**发现、转发、渲染**。

```
agent 宿主（opencode: MCP stdio / hermes: skill 引导 bash）
  → grape-mcp（契约精选 13 工具 · Markdown 渲染 · initialize instructions 自举）
    → spawn grape CLI（token 走 env，不进 argv）
      → grape 服务端（流水线 / events / takeover-context）
```

## 工具面（13 个精选，scope 硬门禁先行）

| 工具 | 作用 |
|---|---|
| `grape_trigger_pipeline` | 触发流水线（A2A 唯一入口，节点流转服务端内部驱动） |
| `grape_get_task_status` / `grape_wait_task` | 按 seq 查询 / 阻塞等终态（默认 300s 上限） |
| `grape_list_issues` / `grape_list_my_issues` | 仓库 issue（含流水线状态）/ 我的 issue |
| `grape_get_issue_detail` / `grape_get_pipeline_info` / `grape_get_issue_events` | 详情 / 节点链 / 事件回环（QA 打回入口） |
| `grape_create_issue` | 建 issue |
| `grape_list_scenes` / `grape_apply_scene` | 场景市场 / 切换场景（用户决策层，需确认） |
| `grape_search` / `grape_get_repo_dashboard` | 全局搜索 / 仓库仪表盘 |

边界：不暴露 A2A 交接；terminate/delete/credential 类高危与 session_only 命令（git-repo 等 28 个）不纳管。

## 安装（opencode）

```bash
# 前提：Python>=3.10 + grape CLI
pip install git+https://gitcode.com/grape-dev/grape-cli.git

# 凭据（用户环境一次性，不落配置文件）
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # Grape WebUI → 设置 → API Key

# 装配（写 opencode.jsonc mcp.grape 条目 + skill 副本 + receipt，带备份幂等）
node setup.mjs install --target opencode
node setup.mjs doctor --probe         # node / grape CLI / 契约连通性逐项检查
# 重启 opencode 会话后生效
```

hermes（无 MCP client）：复制 `skills/grape-remote/` 到其 skill 目录，agent 以 bash 调 `grape` CLI 即可。

## 开发与测试

```bash
npm install
npm test        # 22 个单测（fake-grape 替身，不依赖真实服务端）
npm run smoke   # 真实 stdio JSON-RPC 往返：initialize → tools/list → tools/call
```

对真实服务端冒烟：

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/smoke.mjs   # 把 FAKE 换成真实 grape CLI 后同流程验证
```

## 设计依据

- 传输选型与量化代价：grape-dsh `docs/HTTP-VS-CLI-ANALYSIS.md`（CLI 冷启动 ~200ms/次、依赖成本；本壳前提 = 目标机器已装 grape CLI）
- 工具纳管门禁：`docs/CLI-CAPABILITY-BOUNDARY.md`（219 命令 scope 分布，session_only 28 个硬排除）
- 端云协同：takeover 复用服务端 `/api/runtime/issues/takeover-context`（二期工具化）
- 完整架构与决策：`grape-plugin-analysis` §10–11（OBS: devkit-docs-pub-20261030/plans/20261102-grape-plugin-analysis.html）

## License

MIT
