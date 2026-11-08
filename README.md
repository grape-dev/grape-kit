<h1 align="center">@grape-dev/grape-kit</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/v/@grape-dev/grape-kit" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/dm/@grape-dev/grape-kit" alt="npm downloads"></a>
  <a href="https://gitcode.com/grape-dev/grape-kit/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@grape-dev/grape-kit" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/@grape-dev/grape-kit" alt="node">
  <a href="https://www.grapedev.cn/"><img src="https://img.shields.io/badge/grape-www.grapedev.cn-2563eb" alt="grape"></a>
</p>

<p align="center">
  <strong>Grape DevOps 流水线工具 × 无界面编码 agent</strong><br>
  在 opencode / hermes 等终端 agent 里直接触发、观察、推进 Grape 多 agent DevOps 流水线。<br>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit">npm</a> · <a href="https://www.grapedev.cn/">Grape 官网</a> · <a href="https://gitcode.com/grape-dev/grape-kit">源码仓库</a>
</p>

---

帮助**无 Web UI 的编码 agent**（opencode / hermes 等）安全、结构化地使用 [Grape](https://gitcode.com/grape-dev/grape) —— 多 agent 协作的 AI Native DevOps 平台（vod → issue → coding → qa → sre）。

厚能力全在 [grape-cli](https://gitcode.com/grape-dev/grape-cli)（契约驱动命令树 = 官方 SDK：认证分流 / 错误包装 / `--json-out` 纯 JSON 全现成），本壳只做三件事：**发现、转发、渲染**。

```
agent 宿主（opencode: MCP stdio / hermes: skill 引导 bash）
  → grape-kit（精选 13 工具 · Markdown 渲染 · initialize instructions 自举）
    → spawn grape CLI（token 走 env，不进 argv）
      → grape 服务端（流水线 / events / takeover-context）
```

## 工具面（13 个精选，token scope 硬门禁先行）

| 工具 | 作用 |
|------|------|
| `grape_trigger_pipeline` | 触发流水线（A2A 唯一入口，节点流转由服务端内部驱动） |
| `grape_get_task_status` / `grape_wait_task` | 按 seq 查询 / 阻塞等终态（默认 300s 上限） |
| `grape_list_issues` / `grape_list_my_issues` | 仓库 issue（含流水线状态）/ 我的 issue |
| `grape_get_issue_detail` / `grape_get_pipeline_info` / `grape_get_issue_events` | 详情 / 节点链 / 事件回环（QA 打回入口） |
| `grape_create_issue` | 建 issue |
| `grape_list_scenes` / `grape_apply_scene` | 场景市场 / 切换场景（用户决策层，需确认） |
| `grape_search` / `grape_get_repo_dashboard` | 全局搜索 / 仓库仪表盘 |

**边界**：不暴露 A2A 节点间交接；terminate / delete / credential 类高危与 session_only 命令（git-repo 等 28 个）不纳管。

## 快速开始（opencode）

```bash
# 前提：Python >= 3.10 + grape CLI
pip install git+https://gitcode.com/grape-dev/grape-cli.git

# 凭据（用户环境一次性，不落配置文件）
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # Grape WebUI → 设置 → API Key

# 装配（写 opencode mcp.grape 条目 + skill 副本 + receipt，带备份幂等）
npx -y @grape-dev/grape-kit install --target opencode
npx -y @grape-dev/grape-kit doctor --probe   # node / grape CLI / 契约连通性逐项检查
# 重启 opencode 会话后生效
```

安装后在对话里直接说：

```
> 帮我看看我的 grape issue 里有哪些在跑流水线
> 触发 acme/demo 仓库 issue #12 的流水线，然后等到终态
> 看看 #12 的流水线走到哪个节点了
```

**hermes**（无 MCP client）：复制 `skills/grape-remote/` 到其 skill 目录，agent 以 bash 调 `grape` CLI 即可。

## 设计原则

- **只触发、只观察、可推进**：A2A 编排由服务端 `pipelines.json` 驱动，插件永不干预节点交接；cancel / apply_scene 属用户决策层，工具描述强制「需用户确认」
- **scope 是第一道门禁**：契约 219 命令中 session_only 的 28 个（git-repo 等）对外部 token 必 403，直接排除
- **无 UI 补偿**：工具返回即 Markdown 表格 / 节点链 / 事件时间线；`wait_task` 轮询带阶段摘要与超时提示

## 开发与测试

```bash
npm install
npm test        # 23 个单测（fake-grape 替身，不依赖真实服务端）
npm run smoke   # 真实 stdio JSON-RPC 往返：initialize → tools/list → tools/call
```

对真实服务端只读冒烟：

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/live-smoke.mjs
```

## 相关链接

- [Grape 平台](https://www.grapedev.cn/) · [grape 主仓](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh（DSH 宿主插件）](https://gitcode.com/grape-dev/grape-dsh)
- 设计文档：`grape-plugin-analysis` §10–11（契约驱动链路 / 无 UI agent 插件架构 / 端云协同）

## License

[MIT](LICENSE)
