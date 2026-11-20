# AGENTS.md

面向在本仓工作的 AI 编码 agent（opencode / codex / codearts 等）。

## 环境与命令

- Node >= 20，零 Python 依赖：`npm install`
- 测试：`npm test`（fake-grape 替身，不依赖真实服务端）
- 冒烟：`npm run smoke`（真实 stdio JSON-RPC 往返）
- 改动提交前必须 `npm test` 全绿

## 约定

- 提交信息走 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `test:`
- 工具返回一律 Markdown（表格 / 节点链），供无 UI agent 直读
- 危险操作（cancel / apply_scene / takeover_finish 等）保留「需用户确认」决策门，不得绕过
- **不得提交任何真实凭据**：token 一律走环境变量（`GRAPE_API_TOKEN`），测试用 fake 值
- 真实服务端只读冒烟（`scripts/live-smoke.mjs`）需自备环境变量；会变更状态的 sweep 必须在自有测试载体上跑并显式传参

## Windows 宿主注意

1. **编码**：CLI/工具输出为 UTF-8，PowerShell 默认按 GBK 解码会乱码——`chcp 65001`，或把 `$OutputEncoding` / `[Console]::OutputEncoding` 设为 UTF-8。
2. **BOM**：`~/.grape/config.json` 带 UTF-8 BOM 时 `JSON.parse` 失败——用无 BOM 保存（`Set-Content -Encoding utf8NoBOM`）。
3. **setx 不传播**：`setx GRAPE_API_TOKEN ...` 只对新进程生效；当前宿主会话读不到，设置后必须重启 Agent 宿主（opencode / CodeArts / WorkBuddy）或重新登录终端。

## 结构速览

- `src/`：核心实现（api / tools / server / render / cli / update-check）
- `skills/grape-remote/`：无 MCP 宿主（hermes 等）用的 skill 副本
- `test/`：单测 + `test/cards/` 人工测试卡
- `docs/`：架构文档（对外可见，勿放内部信息）
