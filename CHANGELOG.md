# Changelog

> `@grape-dev/grape-kit` 的变更记录。分组方式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)（Added / Changed / Fixed），版本按 npm 发布倒序；各节日期取自 `npm view @grape-dev/grape-kit time` 的发布时间（UTC），与 git 提交日期可能相差一天。发版续写方式见文末。

## 0.3.3 (2026-11-18)

> 版本号已在 dev 预置、尚未发布到 npm；发布后由生成器按发布日刷新本节。

### Added

- `check_update`：MCP 启动时异步比对 npm registry 版本并一次性提醒（24h 缓存、失败静默、可用 `GRAPE_KIT_SKIP_UPDATE_CHECK=1` 关闭）。
- `scripts/gen-changelog.mjs`：发版时按 `feat→Added / fix→Fixed / 其余→Changed` 从 git log 生成 CHANGELOG 片段并头插。

### Changed

- 包版本升到 0.3.3，`package.json` 的 `files` 白名单加入 `CHANGELOG.md`（使变更记录随包发布）。

### Fixed

- 401 回退改为最佳努力：CLI 失败时回抛原始 native 401 提示，不再吞掉真实原因。

## 0.3.2 (2026-11-17)

### Added

- 接管会话（takeover）原语五工具：`grape_takeover_start` / `grape_takeover_status` / `grape_takeover_progress` / `grape_takeover_finish` / `grape_takeover_abort` —— 云端节点原子让渡到本地、`request_only` 两阶段交回、abort 可让渡回流水线（需平台 weekly-11+，旧平台回退只读的 `grape_takeover_context`）。
- `install --target workbuddy`：写入 `~/.workbuddy/mcp.json`（`mcpServers.grape-kit`，走 npx 免全局安装）并投放 `grape-remote` skill，配套 `uninstall --target workbuddy` 与 `doctor --target workbuddy --probe`。
- 工具面 31 → 36：新增 5 个工具全部为 takeover 原语，既有 31 个工具语义不变。
- `grape-kit --version` / `-v` / `version` 版本查询入口（安装自检用）。

### Changed

- README 对齐 0.3.2 实况：36 工具、接管会话原语、零 Python 安装、版本历史与 Roadmap。
- 新增接管会话架构与全生命周期时序文档（`docs/20261114-takeover-architecture.md`，含验证矩阵）。
- 预发版口径收敛：`scripts/smoke.mjs` 与 `doctor` 的工具数断言行统一为 36；`doctor` 把 `grape` CLI 视为可选回退通道，并探测 takeover API（weekly-11+）可用性。

### Fixed

- 接管 `abort` / `start` 渲染补上台面 #2517 的平台披露：重派失败告警与竞态警告不再被吞掉。
- 安装器安全加固：`--target workbuddy` 的 `mcp.json` 只写 stdio 命令与参数（`npx -y -p @grape-dev/grape-kit grape-kit-mcp`），凭据走环境变量、不落配置文件；改写前先备份原文件。

## 0.3.1 (2026-11-11)

### Added

- `skills/grape-remote/SKILL.md` 新增「端云协同语义边界必读」：接管不是无损操作、cancel 三选决策门、本地成果交回的结构化 context、resume 复核口径。

### Changed

- `grape_search` 契约收敛：`type` 枚举限定为 `all` / `event` / `repo` / `agent`（服务端不支持 issue），描述同步修正。
- `grape_wait_task` 超时提示升级：给出轮询次数与三条复查路径（`grape_get_task_status` 复查 / `grape_get_pipeline_info` 定位节点 / 长任务先做别的）。
- `grape_trigger_pipeline` 描述补充「本地接管成果交回」结构化 context 约定：产出分支 + commit + 测试证据，并要求接手节点识别后直接进入 QA、勿重复实现。
- `grape_list_managed_repos` 补充数据源差异提示：视图为空时改用 `grape_list_repos_member` 或 `grape_sync_repos`。

### Fixed

- `grape_cancel_issue` 语义澄清并加强制决策门：先让用户在「①让渡接管（推荐）②暂停等我确认 ③终止整链」中显式选择，未选择不得执行。
- `grape_resume_issue` 改为事实复核：接口成功后自动回读 `pipeline_info`，返回 `verified_stage` 报告真实阶段，而非接口回执。

## 0.3.0 (2026-11-11)

### Added

- 原生 HTTP 传输层（`src/api.mjs`）：工具优先走服务端 HTTP 接口，安装与运行不再需要 Python，`grape` CLI 降为可选通道。
- `grape_wait_task` 原生轮询实现（无 CLI 冷启动）。

### Changed

- 31 个工具逐个补 `native()` 原生实现，`buildArgs()` 仅保留给 CLI 回退路径。
- 派发层只把凭据缺失（401）回退到 CLI，其余 API 错误如实上抛。

### Fixed

- 测试/冒烟环境隔离：本机真实凭据、本机已装 CLI 不再干扰断言，伪造域名不可达时两条通道都可容忍。

## 0.2.4 (2026-11-08)

### Added

- 无新增工具，工具面维持 31 个。

### Changed

- 派发契约明确化：`waitBased` 工具返回 `{ json, timedOut, polls }`，其余 `run()` 工具直接返回结果值。

### Fixed

- 非 `waitBased` 的 `run()` 工具曾返回 `undefined`（回归），修复后直接返回工具结果本身。

## 0.2.2 (2026-11-08)

### Added

- `grape_list_knowledge` 改为必填 `repo`（服务端契约要求）并新增可选 `q` 关键字过滤。
- `grape_worker_onboard` 在凭据名已存在（400）时自动加时间戳后缀重试一次（凭据名全局唯一、token 仅显示一次），并改用本机 `GRAPE_BASE_URL` 组装一次性安装命令（安装命令不内联真实 token）。

### Changed

- `grape_get_repo_project_info` 动词链修正为 `repos project info`、参数标准化为 `--repo`（原 `repos project-info` + `--repo_name` 会被 CLI 拒绝）。

### Fixed

- 多步工具派发修复：此前 `run()` 未被触达，导致等待类与级联解析类工具链路失效（live sweep 发现）。

## 0.2.1 (2026-11-08)

### Added

- 无新增工具，工具面维持 31 个。

### Changed

- `grape_takeover_context` 的 CLI 动词链修正为三 token `runtime takeover context`（原 `takeover-context` 组合形式不被 CLI 接受）。

### Fixed

- 用真实用户 token 在 issue #4 上验证接管上下文：修正后的动词链在「无在跑任务」时返回 404，语义正确。

## 0.2.0 (2026-11-08)

### Added

- 工具面 13 → 31，新增 18 个工具：`grape_get_pipeline_roadmap`、`grape_cancel_issue` / `grape_resume_issue` / `grape_start_issue`、`grape_list_managed_repos` / `grape_list_repos_member` / `grape_get_repo_project_info` / `grape_host_repo` / `grape_sync_repos`、skills ×3（`list_skills` / `search_skills` / `get_skill_detail`）、knowledge ×2（`list_knowledge` / `get_knowledge_detail`）、`grape_list_project_templates`、`grape_create_project`、`grape_takeover_context`、`grape_worker_onboard`。

### Changed

- 工具面与 `grape-dsh` 对齐，纳入搜索、场景、项目模板、端侧接入等能力。
- 描述中固化 scope 门禁：session_only 命令（`git-repo` 等 28 个）不纳管，高危 terminate / delete 类不纳管，cancel / apply_scene 等要求「需用户确认」。

### Fixed

- 无独立修复项（本版本为工具面对齐扩展）。

## 0.1.3 (2026-11-08)

### Added

- 无新增工具，工具面维持 13 个。

### Changed

- `grape_create_issue` 正文参数由 `body` 更名为 `description`，描述注明「字段名以服务端契约为准」。
- 补充多 agent 测试矩阵报告（opencode / hermes / codex E2E 全绿，含 5 项发现）。

### Fixed

- `grape_create_issue` 传 `body` 被服务端以 400 拒绝（真实 agent 写路径 E2E 发现），改用 `description` 后写路径可用。

## 0.1.2 (2026-11-08)

### Added

- 无新增工具，工具面维持 13 个。

### Changed

- `initialize` 返回的 `serverInfo.version` 改为读取 `package.json`（`src/server.mjs`），不再硬编码。

### Fixed

- `serverInfo.version` 曾硬编码为 `0.1.0`，导致客户端做版本判断时失真。

## 0.1.1 (2026-11-08)

### Added

- 包内新增 `LICENSE`（MIT），并进入 npm tarball。

### Changed

- npm 页面打磨：README 补 5 个 badge，description 收敛，keywords 由 5 个扩到 13 个。

### Fixed

- 升级路径缺陷：`mcp` 块被清空后重新插入条目会产生悬挂逗号（配置变成非法 JSON），已修复并补回归测试。

## 0.1.0 (2026-11-08)

### Added

- 首个可用版本：基于契约的 MCP 服务器，13 个精选工具（`grape_trigger_pipeline`、`grape_get_task_status`、`grape_wait_task`、issue ×5、场景 ×2、`grape_search`、`grape_get_repo_dashboard`）。
- 两个可执行入口 `grape-kit` / `grape-kit-mcp`；`src/` 与 `skills/` 随包发布。

### Changed

- 由 MVP 工作名（grape-mcp）收敛为 `@grape-dev/grape-kit`，补齐 `publishConfig`（npmjs public）与 npm 发布形态。

### Fixed

- 安装器 JSONC 解析三处修复：条目体内层大括号处理、块尾扫描 off-by-one、以及 `doctor` 的 `GRAPE_BASE_URL` 设置状态显示（ECS 上 live E2E 验证）。

## 0.0.0-stage (2026-11-08)

### Added

- npm 分阶段发布（staged publishing）占位包：仅含 `package.json` 与 `README.md`，用于占住 `@grape-dev/grape-kit` 包名并打通作用域发布链路。

### Changed

- 尚无功能面（tarball 不含 `src/`），工具能力自 0.1.0 起提供。

### Fixed

- 无代码修复项。

---

**发版续写**：`node scripts/gen-changelog.mjs <上一版本> <head>` 会读取 `package.json` 的 `version`，按 `feat→Added / fix→Fixed / 其余→Changed` 归类，并把新版本节（`## <version> (YYYY-MM-DD)`）插入文件头，历史版本节不改动。因生成器只做头部插入，新节会落在本文档的标题与说明之上（标题随每次发版下沉一次）。