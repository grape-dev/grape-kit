# Changelog

> `@grape-dev/grape-kit` 的变更记录。分组方式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)（Added / Changed / Fixed），版本按 npm 发布倒序；各节日期为 npm 发布时间（UTC，取自 `npm view @grape-dev/grape-kit time`），与 git 提交日期可能相差一天。发版续写方式见文末。

> 发布口径说明：npm 已发布版本不可回写——0.3.3 的 npm tarball 内 CHANGELOG 仅含本节（10 行）、README 尚无本节链接且把 0.3.2 记为 2026-11-14（commit 日）。因此「npm 页面与仓内 CHANGELOG 一致」自下一版发布起生效。

## Unreleased

### Added

- **场景三段式工具面**（修复宿主实测 P3/P4/P5 的静默失败）：`grape_apply_scene` 改为走 `POST /api/scenes/market/{id}/apply` 在仓库内**创建场景副本**（响应带 `scene_id=custom-xxxxxxxx`），应用后**回读** `GET /api/scenes?repo=` 确认副本存在；输入只认市场数字 id 或场景名，未命中即本地拒绝（不再让服务端静默回落 `default`），`custom-` 副本 id 直接引导到新工具。`set_default=true` 时再调 `POST …/default-scene` 完成「设为仓库默认」。
- `grape_set_repo_scene`：写 `managed_repos.dev_scene`（或 `clear=true` 清空回落智能推荐），写后回读 `dev_scene`，不一致时报「未确认」而不是宣称已切换。此前 kit 没有任何工具能改仓库默认场景，「应用场景」与「切换场景」被混为一谈。
- `grape_list_scenes` 支持仓库视角：传 `owner/repo` 列仓库场景副本（`custom-xxxxxxxx`，`set_repo_scene` 的唯一合法入参），不传则列市场模板。
- **技能上传/升级/跨 scope**（此前只能手搓 HTTP）：`grape_upload_skill` / `grape_update_skill` / `grape_convert_skill`。上传前做与服务端 `validate_skill` 同口径的本地预检（`SKILL.md`、frontmatter `name`/`version`/`description`、name 必须等于目录名、标签不得与 Agent 类型重名），一次列全部问题、**预检不过不发请求**；ZIP 由内置 `src/zip.mjs` 现场打包（顶层目录 = 技能目录名，UTF-8 文件名，零依赖），服务端 `detail.errors` 全量透出。
- `grape_create_issue` 把 `description` 标为必填（服务端缺正文 400「任务描述必填」）。
- 新增 5 个安装目标，`--target` 全量达到 10 个（`SUPPORTED_TARGETS` 由 5 扩到 10）：`codex` / `openclaw` / `hermes` / `atomcode` / `trae`。每个新宿主均提供 `install` / `uninstall`（含 `--dry-run`）/ `doctor`（含 `--probe`）/ `detect` 四件套，并纳入宿主自动检测与 `--target all` 汇总。
- codex：`~/.codex/config.toml` TOML 托管块 `[mcp_servers.grape-kit]` + `[mcp_servers.grape-kit.env]`，只增删托管块与 grape-kit 表，保留其它表与注释；`GRAPE_CODEX_CONFIG` 可覆盖路径。
- openclaw：`~/.openclaw/openclaw.json` 的 `mcp.servers.grape-kit`，兼容旧 `mcpServers` 键；`GRAPE_OPENCLAW_CONFIG` 可覆盖路径。
- hermes：`~/.hermes/config.yaml` 的 `mcp_servers.grape-kit`（保注释/保序）+ `grape-remote` skill 副本到 `~/.hermes/skills/`；`HERMES_HOME` / `GRAPE_HERMES_CONFIG` 可覆盖。
- atomcode：`~/.atomcode/mcp.json` 的 `mcpServers.grape-kit`，`ATOMCODE_HOME` 可覆盖根路径。
- trae：项目级 `.trae/mcp.json` 的 `mcpServers.grape-kit`（仅项目级语义，不做用户级兜底），`GRAPE_TRAE_CONFIG` 可覆盖；路径对齐 Trae 官方 MCP 入口。
- 每个新宿主补 fake HOME 单测（含 TOML 注释/他人表保留、YAML 保注释与条目隔离、JSON 容器兼容、dry-run 不动盘、幂等与备份），单测 270→296；README / README.zh 新增 10 宿主支持矩阵与 5 个宿主专段。
- 自管理五工具（Issue #27，工具面 39 → 45）：`grape_kit_version` 版本全景（本地 kit 版本 / npm latest 与更新可用性 / grape CLI 回退通道 / 服务端连通性与契约版本 / 凭据来源档位，各通道 best-effort 降级不阻塞其余字段）、`grape_kit_check_update` 主动更新检查（`dismiss` 拒绝版本落 `~/.grape/grape-kit-dismiss.json`，**3 天冷却**内同版本不再提醒、新版本立即重新提醒，与启动期 24h 缓存语义解耦）、`grape_kit_upgrade` / `grape_kit_install` / `grape_kit_uninstall` 只生成可复制命令（安装形态自动识别：全局 npm / npx 缓存 / ClawHub / 项目本地依赖 / 未知，未知形态只给手动指引不给命令）。
- 新增 `src/lifecycle.mjs` 自管理核心：纯函数 + 可注入依赖（home/env/fetch/spawn/now），五宿主只读检出（opencode / workbuddy / codearts / officeace / dsh，含配置损坏与托管块不完整的显式区分），与 `grape-kit.mjs` 的检测逻辑成对维护并有同夹具一致性断言（防两份逻辑漂移）。

### Changed

- MCP `initialize` instructions 重写为可执行契约：角色边界（禁止 `force` 越门禁、卡点交还用户）、场景/技能/接管三条易错语义、写动作一律回读、403 两类分流。
- `grape_takeover_finish` 派发前先查 issue 事件：平台已派发下一节点（`handoff_seq` 之后已有该节点 `a2a_event`）时只报事实、**不再客户端补发**——消除「pending_dispatch 假警报」，同时避免同一节点被重复派发跑两遍；交回响应缺 `repo_key`/`issue_number` 时回读会话补齐，不再误报「缺少仓库/issue 标识」。
- 修正 `grape-kit.mjs` 中「hermes 无 MCP client」的过时注释：hermes 已支持 MCP client（`config.yaml` 的 `mcp_servers` 段），安装器写入条目并附带 skill 副本。
- 裸 `doctor` 汇总自检由 5 宿主扩到全部 10 宿主；`uninstall` 零痕迹提示与 `help` 用法统一随 `SUPPORTED_TARGETS` 自动列出全部宿主。
- dsh 补充 `--dry-run` 预览实现（托管块 / skill / receipt 只列不删），与其它宿主预览口径一致。
- `trae` 收窄为严格项目级：当前目录与 `$HOME` 相同时 `install` / `uninstall` 直接拒绝并提示到目标项目目录执行（此时项目级路径等同用户级 `~/.trae/mcp.json`）；`--target all` 与全量卸载枚举不再包含项目级宿主，跳过时显式披露原因，任意目录下 `--target all` 不再静默创建 `.trae/`。

### Fixed

- 技能上传/升级失败时只显示第一条校验错误：现在按服务端 `detail.errors` 全量列出。
- 测试脚手架可移植性：`scripts/fake-grape.mjs` 的 wait 轮询计数器原硬编码在共享临时目录，多用户机器上非属主跑 `npm test` 会 EACCES（表现为 287 pass / 1 fail 的假产品缺陷）；改为 `os.tmpdir()` 下按 uid 隔离，并支持 `GRAPE_FAKE_TMPDIR` 覆盖。
- 技能上传后的「下一步」提示不再暗示平台已有节点级绑定能力：写明目前只能整场景 PUT（节点级写端点属 P1 计划）。
- `test/setup-targets.test.mjs` 子进程补 `cwd` 隔离：工作树含 `.trae/` 时不再误命中 trae 探测，也不会改写真实 `.trae/mcp.json`。
- trae 探测收窄为 `.trae/mcp.json` 文件存在，避免仅有空目录时误判。
- hermes 手写条目缩进泛化（不再只认 2 空格）：4 空格等合法 YAML 条目安装时去重、doctor 可检出；托管条目缩进对齐既有段落。
- hermes 遇非空 inline `mcp_servers` 映射时中止安装并保持文件原样，避免生成重复顶级键。
- hermes 卸载判定收敛为单一 `hermesUninstallDecision()`：`--dry-run` 预览与执行共用同一决策，不完整托管块下预览不再承诺「将移除」而执行 exit 1；同一决策下不再二次读盘。
- hermes 手写条目按 `mcp_servers` 段内缩进精确匹配：`mcp_servers.other.grape-kit` 这类其它 server 下的同名嵌套键不再被误删、不再被误判为已安装。
- hermes 对无法安全追加的 `mcp_servers` 取值（inline 非空映射、多行 flow map、序列/标量）一律中止并保持文件原样，写入前另做「顶级键唯一」兜底校验，杜绝 YAML last-wins 丢弃用户映射。
- JSON 宿主（openclaw / atomcode / trae）改用宽松解析判据：含注释/尾随逗号的配置不再直接 exit 1，写入前备份原文并在 stderr 披露规范化。
- `test/setup-dsh.test.mjs` 的 `run()` 补齐 `HERMES_HOME` / `GRAPE_*_CONFIG` / `ATOMCODE_HOME` / `GRAPE_HOME` 置空：`--target all` 不再因继承变量写进真实用户目录。
- `detectHosts` 的 hermes 探测改用 `hermesPaths().home`，`HERMES_HOME` 覆盖时可被自动命中。
- codex `uninstall --dry-run` 在文件仅剩托管条目时明确披露「将删除整个文件」，预览与执行同源。
- hermes 裸 `mcp_servers:` 头按首个内容行判定形态：序列（`  - a`）与标量（`  foo`）取值一律中止安装并保持文件原样——此前会追加托管条目，产出 mapping+sequence 混层（`yaml.safe_load` 直接 ParserError）。
- hermes 手写条目摘除区间只纳入缩进更深的注释：同层用户注释（如 `# my other server`）不再被重装/卸载吞掉，兑现 README「comments preserved」。
- codex 表头判定改行级剥离注释后精确匹配：仅含注释行 `# [mcp_servers.grape-kit]` 的配置不再被 doctor 报 `[ok]`，`uninstall` 也不再打印「已移除（备份: …）」而文件未变。
- 卸载不再残留空容器：hermes 摘除条目后若 `mcp_servers` 段已空则连段头一并移除，配置只剩本次写入的空容器（hermes 空段 / JSON 宿主空 `mcpServers` / `mcp.servers`）时直接删除该文件，写前备份且 `--dry-run` 同步披露（与 codex `removeFile` 同口径）。
- `test/setup-targets.test.mjs` 子进程补 `DSH_HOME` 置空：宿主运行环境自带 `DSH_HOME` 时不再命中真实 `~/.dsh`（零痕迹用例假绿，且会对真实宿主配置执行卸载）。
- `AGENTS.md` 结构速览同步 hermes 口径：skill 副本改为「MCP client 宿主（hermes）与无 MCP 宿主共用」，与 `grape-kit.mjs` / README 一致（CONTRIBUTING §7）。
