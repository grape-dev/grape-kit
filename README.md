<h1 align="center">@grape-dev/grape-kit</h1>

<p align="center">English | <a href="README.zh.md">简体中文</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/v/@grape-dev/grape-kit" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/dm/@grape-dev/grape-kit" alt="npm downloads"></a>
  <a href="https://gitcode.com/grape-dev/grape-kit/blob/dev/LICENSE"><img src="https://img.shields.io/npm/l/@grape-dev/grape-kit" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/@grape-dev/grape-kit" alt="node">
  <a href="https://www.grapedev.cn/"><img src="https://img.shields.io/badge/grape-www.grapedev.cn-2563eb" alt="grape"></a>
</p>

<p align="center">
  <strong>Grape DevOps pipeline tools × headless coding agents</strong><br>
  Trigger, observe and advance Grape multi-agent DevOps pipelines from terminal agents like opencode / hermes / codex,<br>
  and atomically hand over cloud nodes to your local machine via <strong>takeover sessions</strong> — the chain never breaks, results return in structured form.<br>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit">npm</a> · <a href="https://www.grapedev.cn/">Grape website</a> · <a href="https://gitcode.com/grape-dev/grape-kit">Source</a>
</p>

---

Grape-kit helps **coding agents without a Web UI** (opencode / hermes / codex, etc.) use [Grape](https://gitcode.com/grape-dev/grape) safely and in a structured way — an AI-native DevOps platform with multi-agent pipelines (vod → issue → coding → qa → sre).

```
agent host (MCP stdio: opencode / codex…; skill-guided bash: hermes…)
  → grape-kit (36 tools · native HTTP · Markdown rendering · initialize-instruction bootstrap)
    → grape server (pipelines / events / takeover session API; CLI only as 401 fallback)
```

## Cloud-Local Collaboration (v0.3.2+ core: takeover sessions)

> Platform requirement: weekly-11+ (takeover API). Older platforms fall back to the legacy path automatically.

| Tool | Purpose |
|------|---------|
| `grape_takeover_start` | **Atomic takeover**: the cloud task is handed over (chain intact), a `tko_` credential is issued (12h→24h), full takeover context returned (prompt/env/workspace/skill/history) |
| `grape_takeover_progress` | Report progress during takeover (visible on the cloud panel, can attach a local session) |
| `grape_takeover_status` | Query/list sessions; `renew` also extends the credential |
| `grape_takeover_finish` | **Two-phase hand-back**: first `request_only=true` to report completion → user confirms → formal finish (structured conclusion lands in the event stream, coding→qa relays automatically) |
| `grape_takeover_abort` | Yield the node back to the pipeline: redispatch to cloud (`redispatch=false` stops without redispatch), chain stays intact |
| `grape_takeover_context` | Legacy path (fallback for platforms without the takeover API): read-only takeover context |

Full lifecycle sequence and architecture: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)

## The other 30 tools

- **Trigger/wait**: `grape_trigger_pipeline` (the only A2A entry) · `grape_wait_task` · `grape_get_task_status`
- **Issue/events**: `list_issues` / `list_my_issues` / `get_issue_detail` / `get_pipeline_info` / `get_issue_events` / `create_issue` / `cancel_issue` (three-choice decision gate) · `resume_issue` (fact re-verification)
- **Scenes/repos**: `list_scenes` / `apply_scene` (user decision layer) · `host_repo` / `sync_repos` / `managed/member repos` / `project-info`
- **Search/knowledge**: `search` (all/event/repo/agent) · skills ×3 · knowledge ×2 · dashboard
- **Project/local**: `create_project` · `list_project_templates` · `worker_onboard` (join this machine to the worker pool)

**Boundaries**: A2A node hand-offs are never exposed; high-risk terminate / delete / credential commands and session-only commands (git-repo, 28 others) are out of scope; cancel / apply_scene / takeover_finish enforce an explicit user-confirmation gate.

## Quick start (opencode)

```bash
# Prerequisite: Node >= 20 (no Python needed — native HTTP since v0.3.0)
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # Grape WebUI → Settings → API Key
# Hosts that sanitize env (hermes etc.): file channel ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}

# Install (writes the opencode mcp.grape entry + skill copy + receipt, idempotent with backup)
npx -y @grape-dev/grape-kit install --target opencode
npx -y @grape-dev/grape-kit doctor --probe   # node / server connectivity / per-tool self-check
# Restart your opencode session to take effect
```

Then just talk to your agent:

```
> Which of my grape issues have pipelines running?
> Trigger the pipeline for issue #12 of acme/demo, then wait for a terminal state
> #12's coding node is running — take it over on this machine, keep the chain   ← takeover_start
> Done — report to the platform, wait for my confirmation before formal hand-back  ← progress + request-finish
> Can't finish this node — give it back to the cloud, keep the chain            ← takeover_abort
```

**hermes** (no MCP client): copy `skills/grape-remote/` into its skill directory; the agent calls the `grape` CLI via bash.
**codex**: add `[mcp_servers.grape]` (command/args/env) to `~/.codex/config.toml` — see the usage guide.
**WorkBuddy**: `npx -y @grape-dev/grape-kit install --target workbuddy` — writes `~/.workbuddy/mcp.json` (`mcpServers.grape-kit`, via npx, no global install) + skill to `~/.workbuddy/skills/grape-remote/`; self-check with `doctor --target workbuddy --probe`. Trust the connector once in WorkBuddy; credentials go through environment variables — **never** write them into mcp.json.

## Version history

Full release notes: [CHANGELOG.md](CHANGELOG.md) — 14 条发布记录（含 0.0.0-stage 占位包）

| Version | Date | Highlights |
|---|---|---|
| 0.3.4 | 2026-11-19 | codearts + officeace install targets (supported hosts 2→4); doctor version-update line (24h dedupe, five states); installer entry-engine structural scan hardening |
| 0.3.3 | 2026-11-18 | check_update startup reminder + CHANGELOG generator; 401 fallback hardened |
| 0.3.2 | 2026-11-17 | Takeover session five tools (start/status/progress/finish/abort); #2517 client-side adaptation (abort redispatch failure alert + race warning rendering); SKILL.md dual-path semantics |
| 0.3.1 | 2026-11-11 | cancel three-choice decision gate · resume fact re-verification · search contract convergence · structured hand-back template |
| 0.3.0 | 2026-11-10 | Native HTTP transport; grape CLI/Python becomes optional (401 fallback channel) |
| 0.2.x | pre 2026-11-09 | 13→31 tools · worker_onboard · B1 takeover loop |

## Design principles

- **Trigger, observe, advance, take over — nothing more**: A2A orchestration is server-driven; the plugin never interferes with node hand-offs; takeovers use session primitives for atomic hand-over and hand-back
- **Scope is the first gate**: of the 219 contract commands, the 28 session-only ones (git-repo etc.) always 403 for external tokens — excluded outright; `tko_` takeover credentials are repo_session-only and revoked on completion
- **UI-less compensation**: tool responses are Markdown tables / node chains / event timelines; `wait_task` polls with stage summaries and timeout hints

## Development & testing

```bash
npm install
npm test        # 114 unit tests (fake-grape stand-in, no real server needed)
npm run smoke   # real stdio JSON-RPC round-trip: initialize → tools/list → tools/call
```

Read-only smoke against a real server:

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/live-smoke.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow, [AGENTS.md](AGENTS.md) if you are an AI coding agent working on this repo.

## 版本历史

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.3.4 | 2026-11-19 | codearts/officeace 两宿主安装（受支持宿主 2→4）· doctor 版本更新行（24h 去重、五态）· 条目引擎结构扫描加固 |
| 0.3.3 | 2026-11-18 | check_update 启动版本提醒 · CHANGELOG 生成器 · 401 回退回抛原始 native 提示 |
| 0.3.2 | 2026-11-17 | takeover 会话原语五工具（start/status/progress/finish/abort）；#2517 端侧适配（abort 重派失败告警 + 竞态警告渲染）；SKILL.md 双路径语义 |
| 0.3.1 | 2026-11-11 | cancel 三选决策门 · resume 事实复核 · search 契约收敛 · 结构化交回模板 |
| 0.3.0 | 2026-11-11 | 传输层原生化：原生 HTTP 直连，grape CLI/Python 变可选（401 回退通道） |
| 0.2.x | 2026-11-09 前 | 13→31 工具扩展 · worker_onboard · B1 接管闭环 |

逐版本完整记录（发布日期、工具面变化、行为修复，覆盖 npm 全部 14 条发布记录——含 `0.0.0-stage` 占位包，0.2.3 从未发布）：[CHANGELOG.md](CHANGELOG.md)

## Roadmap

- [x] Org repo home (grape-dev/grape-kit)
- [ ] Full CI gating (GitHub Actions-compatible workflow provided today; enable GitCode GoCI once generally available)
- [x] More install targets: codearts / officeace (three integration types)
- [ ] dsh hosts served by the dedicated [grape-dsh](https://gitcode.com/grape-dev/grape-dsh) plugin, no duplicate effort

## Links

- [Grape platform](https://www.grapedev.cn/) · [grape main repo](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh (DSH host plugin)](https://gitcode.com/grape-dev/grape-dsh)
- Takeover architecture & verification report: [docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Support: [SUPPORT.md](SUPPORT.md) · Agent guide: [AGENTS.md](AGENTS.md)

## License

[MIT](LICENSE)
