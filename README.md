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
  在 opencode / hermes / codex 等终端 agent 里触发、观察、推进 Grape 多 agent DevOps 流水线，<br>
  并以<strong>接管会话（takeover）原语</strong>把云端节点原子让渡到本地——链不断、成果结构化交回。<br>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit">npm</a> · <a href="https://www.grapedev.cn/">Grape 官网</a> · <a href="https://gitcode.com/grape-dev/grape-kit">源码仓库</a>
</p>

---

帮助**无 Web UI 的编码 agent**（opencode / hermes / codex 等）安全、结构化地使用 [Grape](https://gitcode.com/grape-dev/grape) —— 多 agent 协作的 AI Native DevOps 平台（vod → issue → coding → qa → sre）。

```
agent 宿主（MCP stdio：opencode / codex…；skill 引导 bash：hermes…）
  → grape-kit（36 工具 · 原生 HTTP 直连 · Markdown 渲染 · initialize instructions 自举）
    → grape 服务端（流水线 / events / takeover 会话 API；CLI 仅 401 回退用）
```

## 端云协同（v0.3.2+ 核心：接管会话原语）

> 平台要求 weekly-11+（takeover API）。旧平台自动回退老路径并提示。

| 工具 | 作用 |
|------|------|
| `grape_takeover_start` | **原子接管**：云端任务让渡（链不断）、签发 `tko_` 凭据（12h→24h）、返回完整接管上下文（prompt/env/workspace/skill/history） |
| `grape_takeover_progress` | 接管期间回报进度（云端面板可见，可 attach 本地会话） |
| `grape_takeover_status` | 会话查询/列表；`renew` 顺带续期凭据 |
| `grape_takeover_finish` | **两阶段交回**：先 `request_only=true` 报告完成 → 用户确认 → 正式 finish（结构化结论落事件流，coding→qa 自动接力） |
| `grape_takeover_abort` | 让渡回流水线：当前节点重派云端（`redispatch=false` 只停不重派），链不中断 |
| `grape_takeover_context` | 旧路径（无 takeover API 平台的回退）：只读接管上下文 |

全生命周期时序与架构图：
[20261114-takeover-architecture.html](https://devkit-docs-pub-20261030.obs.cn-north-4.myhuaweicloud.com/plans/20261114-takeover-architecture.html)

## 其余工具面（30 个）

- **触发/等待**：`grape_trigger_pipeline`（A2A 唯一入口）· `grape_wait_task` · `grape_get_task_status`
- **issue/事件**：`list_issues` / `list_my_issues` / `get_issue_detail` / `get_pipeline_info` / `get_issue_events` / `create_issue` / `cancel_issue`（三选决策门）· `resume_issue`（事实复核）
- **场景/仓库**：`list_scenes` / `apply_scene`（用户决策层）· `host_repo` / `sync_repos` / `managed/member repos` / `project-info`
- **搜索/知识**：`search`（all/event/repo/agent）· skills ×3 · knowledge ×2 · dashboard
- **项目/端侧**：`create_project` · `list_project_templates` · `worker_onboard`（本机接入 worker 池）

**边界**：不暴露 A2A 节点间交接；terminate / delete / credential 类高危与 session_only 命令（git-repo 等 28 个）不纳管；cancel / apply_scene / takeover_finish 强制「需用户确认」。

## 快速开始（opencode）

```bash
# 前提：Node >= 20（无需 Python——v0.3.0 起原生 HTTP 直连）
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # Grape WebUI → 设置 → API Key
# hermes 等会清洗 env 的宿主：写文件通道 ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}

# 装配（写 opencode mcp.grape 条目 + skill 副本 + receipt，带备份幂等）
npx -y @grape-dev/grape-kit install --target opencode
npx -y @grape-dev/grape-kit doctor --probe   # node / 服务端连通性 / 工具面逐项自检
# 重启 opencode 会话后生效
```

安装后在对话里直接说：

```
> 帮我看看我的 grape issue 里有哪些在跑流水线
> 触发 acme/demo 仓库 issue #12 的流水线，然后等到终态
> #12 的 coding 在跑，让本机接手这个节点，别断链        ← takeover_start
> 改完了，跟平台报一声，等我确认再正式交回              ← progress + request-finish
> 这节点我做不了，还回云端让别人做，链别断              ← takeover_abort
```

**hermes**（无 MCP client）：复制 `skills/grape-remote/` 到其 skill 目录，agent 以 bash 调 `grape` CLI 即可。
**codex**：`~/.codex/config.toml` 加 `[mcp_servers.grape]`（command/args/env），示例见使用指南。
**WorkBuddy**：`npx -y @grape-dev/grape-kit install --target workbuddy` —— 写入 `~/.workbuddy/mcp.json`（`mcpServers.grape-kit`，走 npx 免全局安装）+ skill 落 `~/.workbuddy/skills/grape-remote/`；自检 `doctor --target workbuddy --probe`。装完需在 WorkBuddy 中手动「信任」连接器（一次性）；凭据走环境变量，**不要**写进 mcp.json。

## 版本历史

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.3.2 | 2026-11-14 | takeover 会话原语五工具（start/status/progress/finish/abort）；#2517 端侧适配（abort 重派失败告警 + 竞态警告渲染）；SKILL.md 双路径语义 |
| 0.3.1 | 2026-11-11 | cancel 三选决策门 · resume 事实复核 · search 契约收敛 · 结构化交回模板 |
| 0.3.0 | 2026-11-10 | 传输层原生化：原生 HTTP 直连，grape CLI/Python 变可选（401 回退通道） |
| 0.2.x | 2026-11-09 前 | 13→31 工具扩展 · worker_onboard · B1 接管闭环 |

## 设计原则

- **只触发、只观察、可推进、可接管**：A2A 编排由服务端 `pipelines.json` 驱动，插件永不干预节点交接；接管以会话原语完成原子让渡与交回
- **scope 是第一道门禁**：契约 219 命令中 session_only 的 28 个（git-repo 等）对外部 token 必 403，直接排除；`tko_` 接管凭据仅 repo_session 能力、结束即吊销
- **无 UI 补偿**：工具返回即 Markdown 表格 / 节点链 / 事件时间线；`wait_task` 轮询带阶段摘要与超时提示

## 版本更新提示

`doctor` 自检与 MCP server 启动都会比对 npm registry 上的最新版本，本地落后时给出**一次性**升级提示：

```bash
npx -y @grape-dev/grape-kit doctor
#   [!!] 版本更新: 有新版本 0.3.2 → 0.3.3（npm i -g @grape-dev/grape-kit 更新；GRAPE_KIT_SKIP_UPDATE_CHECK=1 关闭提醒）
```

- 只提示不自动升级，提示不阻塞 doctor 自检与 stdio 工具调用
- 5s 有界超时 + 任何失败静默降级：registry 不可达时 `doctor` 与工具均正常
- 24h 缓存（`~/.grape/grape-kit-update-check.json`）：同一新版本 24h 内只提示一次，不重复打扰
- 关闭开关：`export GRAPE_KIT_SKIP_UPDATE_CHECK=1`（等价别名 `GRAPE_KIT_NO_UPDATE_CHECK=1`）
- 版本比较按 semver：仅本地 < latest 才提示，本地更高或预发布版本不会被误报

## 开发与测试

```bash
npm install
npm test        # 75 个单测（fake-grape 替身，不依赖真实服务端）
npm run smoke   # 真实 stdio JSON-RPC 往返：initialize → tools/list → tools/call
```

对真实服务端只读冒烟：

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/live-smoke.mjs
```

## Roadmap

- [x] 版本更新检测与升级提示（对齐 huaweicloud-devkit `check_update` 体验；doctor + MCP 双路径，24h 缓存）
- [ ] install 目标扩展：codearts / workbuddy / officeace（integrations 三型）
- [ ] 组织仓归位（grape-dev/grape-kit，待 #1773 授权）+ CI
- [ ] dsh 宿主由 [grape-dsh](https://gitcode.com/grape-dev/grape-dsh) 独立插件承载，不重复建设

## 相关链接

- [Grape 平台](https://www.grapedev.cn/) · [grape 主仓](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh（DSH 宿主插件）](https://gitcode.com/grape-dev/grape-dsh)
- 端云协同架构与验证报告：`docs/20261114-takeover-architecture.md`（[OBS 在线版](https://devkit-docs-pub-20261030.obs.cn-north-4.myhuaweicloud.com/plans/20261114-takeover-architecture.html)）

## License

[MIT](LICENSE)
