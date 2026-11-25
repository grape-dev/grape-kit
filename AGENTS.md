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

## 工具描述 / 提示语的五条硬规矩

新增或修改任何工具 `description`、`schema` 字段说明、`server.mjs` 的 `INSTRUCTIONS`，
一律按这五条写（来自宿主实测整改，见 CHANGELOG 0.4.x）：

1. **先写「什么时候用 / 什么时候别用」**，再写参数。模型读描述是为了决定调不调，不是为了背参数表。
2. **端点语义写死**：哪个端点做什么、返回什么、有没有副作用。不写修复史、提交号、「实测为 A 而非 B」这类考古结论——那只会变成模型的额外约束。
3. **每个写动作带回读判据**：应用场景后列仓库副本、设默认后读 `dev_scene`、建单后读详情、交回后看 `handoff` 与 issue 事件。接口 200 不算成功。
4. **决策门放首句**：会改变用户环境或终态的动作（建单 / 触发 / 应用场景 / 设默认 / 取消恢复终止 / 上传升级技能 / finish），第一句就是「必须先向用户确认」。
5. **失败给下一步**：哪个工具、哪个入参、什么情况重试（如 409 agent_mismatch 轮询 60–120s）、什么情况换通道（tk_ 专属端点 403 → WebUI）。

配套约束：`render()` 必须给出下一步动作，不能只回显 JSON；描述里的数字（工具数、上限）改动要同步 README 双语 + CHANGELOG。

## Windows 宿主注意

1. **编码**：CLI/工具输出为 UTF-8，PowerShell 默认按 GBK 解码会乱码——`chcp 65001`，或把 `$OutputEncoding` / `[Console]::OutputEncoding` 设为 UTF-8。
2. **BOM**：`~/.grape/config.json` 带 UTF-8 BOM 时 `JSON.parse` 失败——用无 BOM 保存（`Set-Content -Encoding utf8NoBOM`）。
3. **setx 不传播**：`setx GRAPE_API_TOKEN ...` 只对新进程生效；当前宿主会话读不到，设置后必须重启 Agent 宿主（opencode / CodeArts / WorkBuddy）或重新登录终端。

## 结构速览

- `src/`：核心实现（api / tools / server / render / cli / update-check）
- `skills/grape-remote/`：MCP client 宿主（hermes）与无 MCP 宿主共用的 skill 副本
- `test/`：单测 + `test/cards/` 人工测试卡
- `docs/`：架构文档（对外可见，勿放内部信息）
