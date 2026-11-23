# Changelog

> `@grape-dev/grape-kit` 的变更记录。分组方式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)（Added / Changed / Fixed），版本按 npm 发布倒序；各节日期为 npm 发布时间（UTC，取自 `npm view @grape-dev/grape-kit time`），与 git 提交日期可能相差一天。发版续写方式见文末。

> 发布口径说明：npm 已发布版本不可回写——0.3.3 的 npm tarball 内 CHANGELOG 仅含本节（10 行）、README 尚无本节链接且把 0.3.2 记为 2026-11-14（commit 日）。因此「npm 页面与仓内 CHANGELOG 一致」自下一版发布起生效。

## Unreleased

暂无待发布变更。下一开发周期的用户可见变更先落本段（按 Added / Changed / Fixed 归类，见 CONTRIBUTING §7），发版时并入对应版本节。

## 0.3.10 (2026-11-23)

### Added

- `uninstall --clean-global`：一键清理凭据与使用痕迹——整删 `~/.grape`（含文件通道 `config.json` 与 worker 注册产物）、删除用户级 `GRAPE_API_TOKEN`/`GRAPE_BASE_URL`（POSIX 精确删 rc 中的 `export` 行，备份只保留非凭据行；Windows 用 `reg delete HKCU\Environment`）、清理 `_npx` 中仅含 `node_modules/@grape-dev` 的条目（其他包缓存不动）。主命令不带 `--target` 也可用（无宿主痕迹时跳过宿主卸载、照跑全局清理）；残留提示与三路清理共用同一扫描（所见即所删）。新增 `--dry-run` 预览模式：只列出将删除项、不动盘。不带该选项时 `uninstall` 只列出残留项与清理命令，不静默删除。
- `auth init` 子命令：凭据唯一写入入口，`--token grape_... [--base-url ...]`（TTY 下可交互），写入目标与解析目标严格一致（`GRAPE_AUTH_FILE` 已设置时写它，否则写 `GRAPE_HOME/config.json`），权限 600、剥 BOM，写盘后回读校验，并打印 env 通道设置命令与优先级说明；非 `grape_` 前缀直接拒绝。

### Changed

- `doctor` 把单行「当前生效凭据来源」升级为**完整优先级视图**：逐档列出 runtime（`GRAPE_API_TOKEN_ONCE`）> env（`GRAPE_API_TOKEN`/`GRAPE_BASE_URL`）> file（`GRAPE_AUTH_FILE`/`GRAPE_HOME/config.json`）的命中/未命中及原因，仍不回显 token。渲染三态化：命中档 `[ok]`，未命中/被覆盖档 `[--]` 信息行（无修复动作），失败项 `[!!]`——不再出现「`[ok]` 行内写着未命中」的自相矛盾；`doctor --target <宿主>` 的检查项不再重复打印。
- `GRAPE_HOME` 覆盖点（默认 `~/.grape`）收敛到 `src/api.mjs` 单源实现（`grapeHome()`/`readAuthChannel()` 导出），安装器、版本检查缓存与文件通道解析共用；takeover 脚本 `skills/grape-remote/scripts/takeover/_lib.mjs` 同语义接入（无依赖 skill 副本，保留逐字一致表达式）。README 双语同步凭据优先级链与新命令用法。

### Fixed

- QA 复审（PR #11）安全回归：`doctor` 文件通道解析失败时透传 `JSON.parse` 报错消息，会把 `config.json` 原文（含 token 片段）带进输出——改为固定文案「解析失败（内容不回显）」。
- QA 复审（PR #11）硬违规：`--clean-global` 的 rc 备份曾保留完整 `export GRAPE_API_TOKEN=…` 明文行且残留检测不扫备份，卸载后打印「未检测到残留」实为假象——备份只保留非凭据行，旧版本留下的含凭据 `.bak-grapemcp-*` 备份纳入残留检测并由 `--clean-global` 清零。
- QA 复审（PR #11）主命令不可达：`uninstall --clean-global` 不带 `--target` 时曾先走宿主自动解析，无宿主痕迹即 exit 1、清理从未执行——见 Added（全局清理前置于宿主解析）。
- 测试可移植性：600 权限位与 rc 删除断言按平台分流，破坏性清理用例在 win32 skip（`HOME` 隔离对 win32 `homedir()` 无效）；win32 行为由 Windows 11 实机回归覆盖。
- `grape_takeover_finish`（`request_only=false` 正式交回）交回后不再静默停在下一节点：**派发指针只认 `next_seq`**（`next_seq>0` 平台已派发则不重复；`handoff_seq` 仅作交回事件披露，不据此判已派发），`next_seq=0` 时按场景链**兜底补发**（范围仅 Spec 指定的 coding→qa，复用 trigger 同源 A2A 通道）并回填 `next_seq`；因 `remote_may_still_run` 等阻塞、缺仓库/issue 标识或补发失败时返回**显式告警 + `pending_dispatch` 待派发标记**（附 `grape_trigger_pipeline(agent=…)` 补发指引）。工具描述与真实行为对齐，「链不断」承诺不再与静默 grace 相悖。finish 新增可选 owner/repo/issue_number，会话缺仓库标识时用于兜底派发。
- 待派发标记的落盘通道：标记不走 task_messages——finish 在服务端同步关会话，事后向已结束会话写 progress 必 409 not_active；标记由会话记录派生，`grape_takeover_status` 对已结束会话可查（`finished + next_agent + 派发指针 next_seq=0` 即派发未证实；仅有 `handoff_seq>0` 不作已派发证据，降级为「派发未证实」），渲染给出目标/原因/补发指引，并注明**客户端兜底只写事件、不回填会话 `next_seq`**，故 `next_seq=0` 不构成「未派发」证据，需查事件核实。
- 派发目标与派发源：派发目标只取 `issue_number`（平台 `issue.id` 是内部主键，不再当单号兜底）；`next_step` 仅整串 agent 名命中，散文不解析（由场景链兜底）。
- 交回渲染的 `handoff` 字段按形状分派：字符串原样作标签，对象一律按结构化口径描述——平台返回 `{"ok":false,"error":"HTTP 405: …"}` 时**醒目透出 error 原文**并给 `grape_trigger_pipeline(agent=…)` 手动补发指引，不再输出 `handoff=[object Object]`。
- 交回与派发的三处「未证实当成功」收口（QA 终审追加项）：**交回未成功**（平台 `ok=false`，或 `changed=false` 未真正落账）时**不再派发下一节点**——否则下一节点会接手一个未交回的任务，改为落待派发并渲染「交回未成功」，标题写「交回未完成」、不再输出「链不断／无需手动 trigger」；平台给了**白名单外节点名**（实测 `reviewer`）时**不按场景链改写**为 qa，原样上报「未知节点」待人工裁决（区分「平台未给」与「给了但不认识」）；**补发响应缺事件 `seq`** 时判「派发未证实」并落待派发，不再判已派发、不再渲染「已自动派发 seq=0」。`takeover_status` 的派发指针/跳过计数改走 `seqOf` 单一口径，不再内联重算。

## 0.3.9 (2026-11-23)

### Added

- `intro` 子命令 + 安装结束统一打印**能力地图**（两者共用同一常量，文案不会漂移）：5 组能力各配一条可直接复制的示例问句；无凭据时先给 3 步 API Key 获取指引（生成地址 / `grape_` 前缀 / 写到哪），避免首次工具调用直接 401。
- `trigger_pipeline` 新增 `agent` 参数（枚举 `vod` / `issue` / `coding` / `qa` / `sre`，缺省 `vod`）：上游节点已完成时可从指定节点断点续跑，不再一律从 vod 起步。native 与 CLI 回退通道共用 `normalizeTriggerAgent()` 做同一份枚举校验，非法值在发请求前就给出可读报错与可用值（此前 CLI 通道会静默把非法 agent 下发到服务端）。

### Changed

- `doctor` 的 `GRAPE_BASE_URL` 与契约连通性探针改读 `getBaseUrl()` 双通道（env > `~/.grape/config.json` > 默认），并逐行标注生效来源（`环境变量` / `文件通道 <路径>` / `默认`）——只配文件通道时不再假阳性 FAIL。
- 地址解析收敛到 `src/api.mjs` 的 `getBaseUrl()` 单一事实源：`worker_onboard`、`doctor` 与接管脚本 `skills/grape-remote/scripts/takeover/_lib.mjs` 同源（env > 文件 > 默认）；`_lib.mjs` 为无依赖 skill 副本，保留自带解析并注释取舍。
- WorkBuddy 安装提示改写为实测口径：无需手动「信任」，**重启宿主会话**即可加载连接器；`uninstall` 注释不再提宿主侧「信任」记录。README 双语同步。
- `intro` 与 `install|uninstall|doctor` 用法行拆开：`intro` 不收 `--target`（与宿主无关），避免用户以为能指定宿主。

### Fixed

- 审核三工具（`grape_review_pass` / `grape_review_reject` / `grape_confirm_done`）native 通道崩溃（`api.apiRequest is not a function`）：改为直调命名导出 `apiRequest`。403 属 `tk_` 会话通道边界（非权限缺失），提示补上可执行修复动作：改用 WebUI 审核，或由持有 `tk_` 会话的宿主执行。

## 0.3.8 (2026-11-20)

### Added

- 审核三工具（体验报告 P1：审核动作藏 OpenAPI，用户被迫直连 API）：`grape_review_pass`（pending_review 一键通过）、`grape_review_reject`（打回，意见必填、决策层确认）、`grape_confirm_done`（开发者确认收尾，等价 WebUI 确认 / CLI `confirm done`）；工具面 36→39，smoke/sweep/契约断言全量同步。

### Changed

- `renderIssues` 表新增「仓库」列（体验报告 P2：`list_my_issues` 不带仓库归属，多个在跑单需额外全局搜索才能定位）。

### Fixed

- `doctor` 识别 `~/.grape/config.json` 文件通道凭证（体验报告 P2：Windows 用户按文档配置文件通道仍被误报 FAIL，第一步就被吓住）。

## 0.3.7 (2026-11-20)

### Added

- `trigger_pipeline` / `get_task_status` 图形化渲染：触发即输出节点链图（各节点就绪/运行/完成状态一目了然），状态查询输出状态卡片 + 进度条 + 下一步指引，替代此前的纯文本摘要。

### Changed

- README Quick Start 重构对齐 devkit 模式：宿主平等罗列、每宿主独立小节、新增 Capabilities 总览节（端云协同单拎节并入，恢复「先会用再懂原理」阅读序）。
- 生命周期三件套补全：版本查询 / 更新 / 卸载命令组对齐 huaweicloud-devkit README 模式。
- 措辞口径全面对齐落地页与帮助文档：统一只写 Agent（支持面含 WorkBuddy 等非编码 Agent，去 coding 限定）、接管会话改称端云协同（cloud-local collaboration）。
- Codex/hermes 移出露出面：grape-kit 安装器无对应 target、适配未完成不展示——Codex 节改为真实手动配置指导（删假指引 `install --target codex`），hermes 相关内容同步清理（简介 / 架构图 / env 注释）。

### Fixed

- `uninstall` 清理 receipt 与残留空目录：卸载不再遗留 receipt 记录文件；`update` 提醒文案补 npx 用户升级说明。
- README 双语错位修复：删除英文版重复出现的中文「版本历史」节，双语内容归位并固化断言。

## 0.3.6 (2026-11-19)

### Fixed

- 流水线渲染支持 `segments` 事件流形态（pipeline API 真实返回）：此前 `pickNodes` 只认 stages/nodes 形态，真实返回时渲染回退原始 JSON；segments 分支按 agent 取最新事件态，整体 status 与 stalled/stalled_minutes 以「⚠️ 疑似停滞 N 分钟」透出到判读行；新增 segments 形态回归用例（#45 停滞 178 分钟真实数据），单测面 114 → 115。

## 0.3.5 (2026-11-19)

### Added

- `install` 宿主自动检测：未指定 `--target` 时按本机宿主痕迹自动选择（WorkBuddy 客户端机裸跑即写对 `mcp.json`）；显式 `--target` 语义不变。
- 零宿主交互选择：痕迹检测升级为 huaweicloud-devkit 同款（workbuddy / codearts / officeace / opencode）——1 个痕迹直装该宿主、多个痕迹全装，零痕迹时 TTY 下列出宿主菜单由用户按编号/名称选择；非交互环境列出支持项并非零退出、指引 `--target`，不再静默兜底 opencode。
- 干净环境安装引导：无现有配置时自动创建空配置继续安装（此前新用户第一面即报错退出）；完成输出重构为三步上手（配置凭证 → `doctor --probe` 自检 → 重启宿主会话，opencode 安装分支），附 36 工具能力地图与建单/查进度/接管/确认交回四条示例。

### Changed

- 宿主矩阵文档补全（中英双语）：CodeArts 专段（全局/项目级 `codearts_cli.jsonc` 路径 + 装后「重启」步骤）、openclaw/ClawHub 市场直装渠道（`clawhub:grape-kit@latest`）与 36 工具验证方式。
- 渲染升级：流水线竖排状态卡 + Mermaid 图、issues 表进度点阵、场景节点链（宿主支持 Mermaid 时渲图为图，不支持则作代码块兜底）。

### Fixed

- 宿主检测重构的顶层引用 TDZ：`SUPPORTED_TARGETS` 改为惰性求值，修复未指定 `--target` 时顶层 `await` 引用未初始化变量的问题。

## 0.3.4 (2026-11-19)

### Added

- `install --target codearts` / `install --target officeace`：受支持宿主 2 → 4——codearts 复用条目引擎与 HOSTS 表，officeace 无 MCP client、走注册清单 + GUI 导入降级方案；`uninstall` / `doctor` 同步覆盖，裸 `doctor` 汇总检出全部宿主。
- `doctor` 新增「版本更新」检查行：有界超时、失败静默、24h 缓存内同一新版本只提示一次；状态拆分「有新版本 / 已提示过 / 已最新 / 检测不可用 / 已关闭」，升级文案 `formatUpdateNotice` 与 MCP 启动提醒共用。
- 升级提示开关别名兼容与 semver 版本比较。

### Changed

- README 中英双语化（英文主 README + `README.zh.md` 中文副本），版本历史对齐 npm 发布日；补 `CODE_OF_CONDUCT.md` / `SUPPORT.md` / `AGENTS.md` 社区文档。
- `CHANGELOG.md` 覆盖 npm 全部已发布版本并随包发布；`scripts/gen-changelog.mjs` 改为在标题与说明之后插入新节、同版本节跳过（不产生重复节），配套契约测试固化版本口径。
- HOSTS 表收敛为 target 唯一来源（help 列受支持宿主），条目引擎与 doctor 判定收敛为单一实现；单测面扩容至 114 个。

### Fixed

- `--target=codearts` 等号写法此前被静默当成默认 opencode（写错宿主/删错配置），分发处改按等号前缀判定。
- 条目引擎改为结构扫描：中段逗号、备份原文、嵌套同名键误判修复；四宿主写入统一备份校验、保留用户注释。
- workbuddy 损坏配置改为非零退出，`doctor` 错误归因到实际解析失败的文件；无 `mcpServers` 块的重写统一走 `writeValidated`。
- 24h 提示去重失效修复（缓存写入前创建 `~/.grape` 目录）；失败路径落退避缓存，与模块注释一致。
- 401 / doctor / install 三处 API Key 指引补可点击入口。

## 0.3.3 (2026-11-18)

### Added

- `check_update`：MCP 启动时异步比对 npm registry 版本并一次性提醒（24h 缓存、失败静默、可用 `GRAPE_KIT_SKIP_UPDATE_CHECK=1` 关闭）。
- `scripts/gen-changelog.mjs`：发版时按 `feat→Added / fix→Fixed / 其余→Changed` 从 git log 生成 CHANGELOG 片段，插入到标题与说明之后（该版本节已存在则跳过）。

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

> 0.2.3 从未在 npm 发布（0.2.2 之后版本号直接跳到 0.2.4），故本文件无该节。

### Added

- 无新增工具，工具面维持 31 个。

### Changed

- 派发契约明确化：`waitBased` 工具返回 `{ json, timedOut, polls }`，其余 `run()` 工具直接返回结果值。

### Fixed

- 非 `waitBased` 的 `run()` 工具曾返回 `undefined`（回归），修复后直接返回工具结果本身。

## 0.2.2 (2026-11-08)

### Added

- `grape_worker_onboard` 在凭据名已存在（400）时自动加时间戳后缀重试一次（凭据名全局唯一、token 仅显示一次），并改用本机 `GRAPE_BASE_URL` 组装一次性安装命令（安装命令不内联真实 token）。

### Changed

- `grape_list_knowledge` 改为必填 `repo`（服务端契约要求）并新增可选 `q` 关键字过滤；属破坏性契约变更——未带 `repo` 的既有调用会失败。
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

**发版续写**：`node scripts/gen-changelog.mjs <上一版本> <head>` 会读取 `package.json` 的 `version`，按 `feat→Added / fix→Fixed / 其余→Changed` 归类，并把新版本节（`## <version> (YYYY-MM-DD)`）插入到本文档标题与说明之后、历史版本节之前；若该版本节已存在则跳过写入并提示，避免重复节。日期取脚本运行当日，发版后按 npm 发布时间校正。