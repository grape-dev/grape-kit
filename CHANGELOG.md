# Changelog

> `@grape-dev/grape-kit` 的变更记录。分组方式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)（Added / Changed / Fixed），版本按 npm 发布倒序；各节日期为 npm 发布时间（UTC，取自 `npm view @grape-dev/grape-kit time`），与 git 提交日期可能相差一天。发版续写方式见文末。

> 发布口径说明：npm 已发布版本不可回写——0.3.3 的 npm tarball 内 CHANGELOG 仅含本节（10 行）、README 尚无本节链接且把 0.3.2 记为 2026-11-14（commit 日）。因此「npm 页面与仓内 CHANGELOG 一致」自下一版发布起生效。

## Unreleased

### Added

- `grape_takeover_start` 物化平台下发的 `bundle.assets.skill`（#28）：接管建立后把节点技能落到本地工作区 `<cwd>/.grape-takeover-skills/<skill>/`（`SKILL.md` + `references/*`），渲染给出 `技能已物化：<path>` + 文件数 + 是否含 references——接管 prompt 里「技能已物化，直接读 SKILL.md」由指引变成事实。内联 `files`（数组或「路径→内容」映射）与 `zip_url` 两种下发都支持（zip 走 `zlib.inflateRawSync` 零依赖解压，仅 store/deflate，剥离 `<skill>/` 顶层前缀）；物化幂等覆盖，重复接管不叠加文件。
- 物化安全面：技能名白名单 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（拒 `.` / `..` / `.skills` / 分隔符与盘符，非法即拒绝、不归一化），条目路径拒 `..`、绝对路径、反斜杠与盘符、`.skills` 段（大小写/尾点归一后比较），逐级 `lstat` 拒符号链接（含 zip 的 `S_IFLNK` 条目）并做落盘前缀校验；恒不写 `.skills/`（worker 会 rmtree 该目录）。zip 解压在 inflate 前按 `usize` 预检剩余额度并传 `maxOutputLength` 封顶（64MB），解压后校验长度与 CRC-32，压缩比无法绕过上限。

### Changed

- 接管渲染新增「技能物化」段：`ok` 给落盘路径、`legacy`（旧平台未下发技能包）与 `failed` 各给显式 warning，失败不作废已建立的接管会话。

- `grape_takeover_finish` 派发判据对齐平台真实返回（#30）：已派发 = `handoff.seq>0` 或 `handoff.reason=already_dispatched`；平台不回填的 `next_seq`（恒 0）降级为辅助展示信号，不再据此误判「未派发」而重复补发/误告警。双判据缺失时以本轮 `handoff_seq` 为事件下界回读 issue 事件，只认本轮之后且非 `failed` 的下一节点 `a2a_event`，历史轮次/失败事件不再被当成本轮已派发。旧字段 `handoff_seq` 与结构化 `handoff.seq` 不同源，仅见 `handoff_seq` 时先回读核实、不直接判已派发。
- 兜底派发范围由硬编码 `coding→qa` 改为按**场景链 `next`** 推导（缺省取场景接口 `scenes detail` 的节点 `next`，支持自定义链如 coding→review→sre）；响应未带链且场景接口不可用时不猜默认链、落 `pending` 待人工确认；场景链之外节点名仍原样上报、落 `pending` 待人工裁决；部署类节点（`sre`）保留用户确认门、不自动派发。`grape_takeover_status` 渲染与 finish 复用同一判据函数，口径不再漂移。
- 事件回读增加 `issueEvents` 存在性守卫与 `total` 截断检测：api 模块缺该函数或分页截断时落 `pending`，不再误判「无事件」重复派发。

### Fixed

- #30 修复 `next_seq` 恒 0 导致的「派发未证实」误告警与重复补发；补发响应缺事件 `seq` 仍判未证实、不冒充成功。

## 0.5.0 (2026-11-25)

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
- 自管理五工具（Issue #27，工具面 39 → 48）：`grape_kit_version` 版本全景（本地 kit 版本 / npm latest 与更新可用性 / grape CLI 回退通道 / 服务端连通性与契约版本 / 凭据来源档位，各通道 best-effort 降级不阻塞其余字段）、`grape_kit_check_update` 主动更新检查（`dismiss` 拒绝版本落 `~/.grape/grape-kit-dismiss.json`，**3 天冷却**内同版本不再提醒、新版本立即重新提醒，与启动期 24h 缓存语义解耦）、`grape_kit_upgrade` / `grape_kit_install` / `grape_kit_uninstall` 只生成可复制命令（安装形态自动识别：全局 npm / npx 缓存 / ClawHub / 项目本地依赖 / 未知，未知形态只给手动指引不给命令）。
- 新增 `src/lifecycle.mjs` 自管理核心：纯函数 + 可注入依赖（home/env/fetch/spawn/now），五宿主只读检出（opencode / workbuddy / codearts / officeace / dsh，含配置损坏与托管块不完整的显式区分），与 `grape-kit.mjs` 的检测逻辑成对维护并有同夹具一致性断言（防两份逻辑漂移）。

### Changed

- MCP `initialize` instructions 重写为可执行契约：角色边界（禁止 `force` 越门禁、卡点交还用户）、场景/技能/接管三条易错语义、写动作一律回读、403 两类分流。
- `grape_takeover_finish` 派发前先查 issue 事件：平台已派发下一节点（`handoff_seq` 之后已有该节点 `a2a_event`）时只报事实、**不再客户端补发**——消除「pending_dispatch 假警报」，同时避免同一节点被重复派发跑两遍；交回响应缺 `repo_key`/`issue_number` 时回读会话补齐，不再误报「缺少仓库/issue 标识」。
- 修正 `grape-kit.mjs` 中「hermes 无 MCP client」的过时注释：hermes 已支持 MCP client（`config.yaml` 的 `mcp_servers` 段），安装器写入条目并附带 skill 副本。
- 裸 `doctor` 汇总自检由 5 宿主扩到全部 10 宿主；`uninstall` 零痕迹提示与 `help` 用法统一随 `SUPPORTED_TARGETS` 自动列出全部宿主。
- dsh 补充 `--dry-run` 预览实现（托管块 / skill / receipt 只列不删），与其它宿主预览口径一致。
- `trae` 收窄为严格项目级：当前目录与 `$HOME` 相同时 `install` / `uninstall` 直接拒绝并提示到目标项目目录执行（此时项目级路径等同用户级 `~/.trae/mcp.json`）；`--target all` 与全量卸载枚举不再包含项目级宿主，跳过时显式披露原因，任意目录下 `--target all` 不再静默创建 `.trae/`。
- `src/server.mjs` INSTRUCTIONS 补第 8 条纪律：自管理工具属用户决策层——`grape_kit_version` / `grape_kit_check_update` 只读直执行，`grape_kit_upgrade` / `grape_kit_install` / `grape_kit_uninstall` **只生成命令、不执行任何变更**，执行前必须获得用户确认。
- README 双语能力总览与工具面口径同步为 48 工具（新增「自管理」条目）；`scripts/smoke.mjs` / `scripts/sweep-0.2.mjs` 工具数断言 39 → 48，冒烟新增 `grape_kit_version` / `grape_kit_check_update` 只读调用。`grape-kit.mjs`（CLI）与 `src/update-check.mjs`（启动期提醒红线）**均零行为改动**：`src/lifecycle.mjs` 自持 registry URL / 有界超时 / 取数，只复用 `update-check.mjs` 的纯 semver 函数（同值由 `test/lifecycle.test.mjs` 断言兜住漂移）。
- `CONTRIBUTING.md` 自身纳入「工具数变化必须同步」清单（§1 冒烟注释与 §6 数字），并由 `test/docs-sync.test.mjs` 按 `TOOL_NAMES` 实际数量断言，避免规范文字外的漏改。

### Fixed

- QA 复审（PR #21）BOM 口径对齐：`src/lifecycle.mjs` 对纯 JSON 宿主（workbuddy / officeace）的检出不再私自剥 BOM——与 CLI `detectJsonEntry` 同口径（BOM 配置报 `damaged`），jsonc 通道仍按 `parseLoose` 剥 BOM；两侧判定分歧（lifecycle=installed / doctor=damaged）消除，并有 BOM 夹具（纯 JSON damaged、jsonc installed）与同夹具一致性断言兜住。
- QA 复审（PR #21）损坏宿主不给假动作：`grape_kit_install` / `grape_kit_uninstall` 遇 `damaged` 宿主不再生成命令（CLI 对解析失败的配置 `exit 1`），改为单列 `blocked` 并带出解析错误与「先修复或移走该文件」指引；「已装配跳过」与「配置损坏待修复」不再混为一谈。
- QA 复审（PR #21）同步指针去行号：`src/lifecycle.mjs` 对 `grape-kit.mjs` 的 14 处同步指针由「文件:行号」改为函数名/常量名锚，并新增 `SYNC_POINTERS` 清单 + 校验测试（CLI 侧改名/删除即变红），消除行号随无关改动 7/14 失准的漂移面。
- QA 复审第 3 轮 dismiss 三处口径（Q4/Q5/Q6）：`recordDismiss` 写盘失败不再被吞——如实返回 `ok:false` + 原因，`checkForUpdate` 不再把失败当「已忽略」，工具渲染「记录失败（路径不可写）」并说明下次仍会提示；registry 不可达且未传 `dismissVersion` 时**不再兜底记当前版本**（该版本永不触发冷却），改为返回 `dismissSkipped` 说明原因并提示显式指定版本；`grape_kit_version` 的版本全景改为读 dismiss 状态，「已忽略（冷却中）」不再被说成「有可用更新 / 已是最新」。
- QA 复审第 3 轮判断项：空命令文案区分「目标宿主配置均损坏（先修复）」与「均为相反状态」（SJ5）；`HOST_STATE` / 新增 `UPDATE_STATE` 常量单源，判定与两端渲染不再散落字面量（SJ6/SJ7）；`credentialSummary` 三层嵌套三元拆成档位映射表、检出结果去掉与 `host` 重复的 `label`（SJ7）；三个写工具的「用户决策层」描述纳入 `test/tools.test.mjs` 决策门断言表（SJ8）。
- QA 复审第 3 轮贡献流程模板口径（S2）：`.github/PULL_REQUEST_TEMPLATE.md` / `.github/ISSUE_TEMPLATE/bug_report.md` 工具数 39 → 44、单测数不再写死（以 `npm test` 实际输出为准），两个模板纳入 `CONTRIBUTING.md` §6 同步清单并由 `test/docs-sync.test.mjs` 断言。
- `detectHosts` 的 hermes 探测改用 `hermesPaths().home`，`HERMES_HOME` 覆盖时可被自动命中。
- codex `uninstall --dry-run` 在文件仅剩托管条目时明确披露「将删除整个文件」，预览与执行同源。
- hermes 裸 `mcp_servers:` 头按首个内容行判定形态：序列（`  - a`）与标量（`  foo`）取值一律中止安装并保持文件原样——此前会追加托管条目，产出 mapping+sequence 混层（`yaml.safe_load` 直接 ParserError）。
- hermes 手写条目摘除区间只纳入缩进更深的注释：同层用户注释（如 `# my other server`）不再被重装/卸载吞掉，兑现 README「comments preserved」。
- codex 表头判定改行级剥离注释后精确匹配：仅含注释行 `# [mcp_servers.grape-kit]` 的配置不再被 doctor 报 `[ok]`，`uninstall` 也不再打印「已移除（备份: …）」而文件未变。
- 卸载不再残留空容器：hermes 摘除条目后若 `mcp_servers` 段已空则连段头一并移除，配置只剩本次写入的空容器（hermes 空段 / JSON 宿主空 `mcpServers` / `mcp.servers`）时直接删除该文件，写前备份且 `--dry-run` 同步披露（与 codex `removeFile` 同口径）。
- `test/setup-targets.test.mjs` 子进程补 `DSH_HOME` 置空：宿主运行环境自带 `DSH_HOME` 时不再命中真实 `~/.dsh`（零痕迹用例假绿，且会对真实宿主配置执行卸载）。
- `AGENTS.md` 结构速览同步 hermes 口径：skill 副本改为「MCP client 宿主（hermes）与无 MCP 宿主共用」，与 `grape-kit.mjs` / README 一致（CONTRIBUTING §7）。

## 0.4.0 (2026-11-23)

### Added

- `install --target dsh`（DeepSeek Harness）：以 **MCP stdio 托管 patch** 模式把 grape-kit 接入 dsh web profile —— 在 `$DSH_HOME/profiles/web/cordis.patch.yml`（`$DSH_HOME` 缺省 `~/.dsh`）写入带标记的 `insert` 托管块（`id: grape-kit` / `name: '@deepseek-ai/dsh-mcp-client'` / `transport: stdio`），MCP 入口本地脚本优先、解析不到回退 `npx`；`grape-remote` skill 落到 `$DSH_HOME/skills/`。39 工具零改动复用。
- dsh 同族能力：`uninstall --target dsh` 只删托管块 + skill 副本（其余 patch 行与 profile 依赖不动），`doctor --target dsh` 给出托管块 / skill 副本 / `dsh-mcp-client` 三项检查，`detect` 把 `~/.dsh` 纳入宿主自动检测（零宿主菜单、`--target all` 与 `help` 用法随 `SUPPORTED_TARGETS` 自动覆盖）。
- `install --target dsh` 的 `@deepseek-ai/dsh-mcp-client` 依赖安装为 best-effort：失败只打印手动指引（`npx @deepseek-ai/dsh plugin --profile web add …`，pnpm 缺失先 `corepack enable pnpm`），不阻塞装配、退出码仍为 0。

### Changed

- dsh 口径由「由 grape-dsh 独立插件承载」改为「MCP 最小路径 / 完整形态插件并存」：`--target` 未知宿主提示与 `SUPPORTED_TARGETS` 注释同步改口径；README 双语新增 dsh 宿主段、路线图条目改口径。

### Fixed

- QA 复审（PR #12）dsh 写入安全：`install --target dsh` 在托管块不完整（有 start 缺 end）或 patch 顶层为映射形状时拒绝写入并给出修复指引——不再静默删除 start 之后的用户 patch 行，也不再写出 YAML 非法文件；`doctor` 对映射形状同样报配置损坏而非 ok。
- QA 复审（PR #12）dsh 往返保真：无尾换行原文 `install→uninstall` 后逐字节还原（不再多出 1 字节分隔换行）；仅含托管块的新建 patch 卸载后删除空文件与仅含托管块的备份，不留 0 字节残留。

## 0.3.10 (2026-11-23)

### Added

- `uninstall --clean-global`：一键清理凭据与使用痕迹——整删 `~/.grape`（含文件通道 `config.json` 与 worker 注册产物）、删除 `GRAPE_AUTH_FILE` 指向的凭据文件（非凭据形态的目标不盲删，点名提示人工处理）、删除用户级 `GRAPE_API_TOKEN`/`GRAPE_BASE_URL`（POSIX 精确删 rc 中的 `export` 行，备份保留非凭据原文、凭据行掩码标注；Windows 用 `reg delete HKCU\Environment`）、清理 `_npx` 中仅含 `node_modules/@grape-dev/grape-kit` 的条目（其他包缓存不动；Windows 读 `%LocalAppData%\npm-cache\_npx`）。主命令不带 `--target` 也可用（无宿主痕迹时跳过宿主卸载、照跑全局清理，且先打印残留项与清理命令）；残留提示与清理路径共用同一扫描（所见即所删）。新增 `--dry-run` 全程预览：宿主条目移除、skill 删除与全局清理均只列不做、不动盘（配置备份只在真实执行时生成）；预览与执行共用误删护栏（`GRAPE_HOME` 先 resolve/realpath 归一化，指向 `$HOME`/`$HOME/.config`/`..` 穿越/祖先一律拒绝，自定义路径须有真实 grape 产物证据——`config.json` 须为凭据形态（`grape_` token 或已知 grape 域 base_url），`workers/` 单独不构成证据，且目录内全部条目均为 grape 产物）。不带该选项时 `uninstall` 只列出残留项与清理命令，不静默删除。
- `auth init` 子命令：凭据唯一写入入口，`--token grape_... [--base-url ...]`（TTY 下可交互），写入目标与解析目标严格一致（`GRAPE_AUTH_FILE` 已设置时写它，否则写 `GRAPE_HOME/config.json`），权限 600、剥 BOM（win32 无 600 权限位、按目录 ACL，文案平台分流），写盘后回读校验，并打印 env 通道设置命令与优先级说明；已设置更高优先级 env（`GRAPE_API_TOKEN_ONCE`/`GRAPE_API_TOKEN`）时提示冲突与让文件通道生效的处置指引，非 TTY 会话对 token 掩码回显（明文只落文件通道）；非 `grape_` 前缀直接拒绝。

### Changed
- 内部重构（PR #13 三审 判断项 7）：各宿主卸载收敛为 `STEP` 具名常量 + `applyUninstallSteps`/`planUninstallSteps` 单一渲染层（原先 8 处 if/else 复制），文案差异由每宿主 `*_COPY` 描述；`DAMAGED_LINE` 改为随 `steps` 生成的 `damagedEntryLine()`；workbuddy 的 `skills` 目录回到 `workbuddyPaths()` 单源（去掉 `dirname(mcpJson)` 的第二份定义），`HOSTS.workbuddy.uninstall` 不再重复 rmSync；护栏证据与条目判定共用 `isGrapeCredentialShape()`；测试断言从掩码精确串改为行为断言（名称保留、值不出现）。
- `doctor` 把单行「当前生效凭据来源」升级为**完整优先级视图**：逐档列出 runtime（`GRAPE_API_TOKEN_ONCE`）> env（`GRAPE_API_TOKEN`/`GRAPE_BASE_URL`）> file（`GRAPE_AUTH_FILE`/`GRAPE_HOME/config.json`）的命中/未命中及原因，仍不回显 token。渲染三态化：命中档 `[ok]`，未命中/被覆盖档 `[--]` 信息行（无修复动作），失败项 `[!!]`——不再出现「`[ok]` 行内写着未命中」的自相矛盾，runtime 档命中时凭据行也不再出现 `[!!]`；`doctor --target <宿主>` 的检查项不再重复打印。
- `GRAPE_HOME` 覆盖点（默认 `~/.grape`）收敛到 `src/api.mjs` 单源实现（`grapeHome()`/`readAuthChannel()` 导出），安装器、版本检查缓存与文件通道解析共用；takeover 脚本 `skills/grape-remote/scripts/takeover/_lib.mjs` 同语义接入（无依赖 skill 副本，保留逐字一致表达式）。README 双语同步凭据优先级链与新命令用法。

### Fixed
- QA 复审（PR #13 三审）硬违规 1：`GRAPE_AUTH_FILE` 的「凭据形态」判据比文档承诺宽松——`scanResidues` 把任意 `token` 字符串或任意 `base_url` 字段当凭据，`cleanGlobal` 直接删文件：实测 `GRAPE_AUTH_FILE=$HOME/myapp-settings.json`（`{"base_url":"https://api.stripe.com","retries":3}`）被标注为凭据文件并删除，同一内容放进 `GRAPE_HOME` 反而被护栏拒绝。现将「凭据形态」抽成单判据 `isGrapeCredentialShape()`（`token` 以 `grape_` 开头，或 `base_url` 命中 `grapedev.cn`），护栏的目录证据与 `GRAPE_AUTH_FILE` 的删除授权共用；非凭据形态走人工处理分支（残留提示与 `--clean-global` 均点名，不盲删）。补两条在该断言下 `ba5a402` 变红的回归（任意 `base_url`、非 `grape_` 前缀 token）与一条「两通道判据一致」回归。
- QA 复审（PR #13 三审）判断项 1：`DAMAGED_LINE` 固定文案「（grape 自有 skill 仍会清理）」在 codearts/officeace 也打印，而这两个宿主没有 skill 副本处理——实测 codearts 损坏配置打印该句却无任何动作。现按宿主能力拼接：`steps.skills` 存在（opencode/workbuddy）才承诺 skill 清理。
- QA 复审（PR #13 三审）判断项 3：rc 清理只认 `export`，`declare -x`（.bashrc）、`.bash_profile` 的 export、fish `set -x` 三种形态不清不掩，`--clean-global` 仍输出「未发现导出行（跳过）」。本轮扩范围（不另开 Issue）：扫描目标加 `.bash_profile` 与 `~/.config/fish/config.fish`，行判据统一为 `export` / `declare -x` / fish `set -x`，清理、掩码备份与残留提示共用同一 `credentialLineKey()`。
- QA 复审（PR #13 三审）判断项 4：win32 `scanResidues` 把 `reg query` 非零退出一律当「不存在」——reg 不可用/拒绝访问时静默零残留，与「不再吞错」不符。新增 `src/registry.mjs` 的 `classifyRegQuery()`：只有 exit 1 + 系统「找不到该项」文案判 absent，其余（拒绝访问、reg 缺失、被信号终止、退出码不可判定）判 error，登记 `regErrors` 并在残留提示/预览/清理中如实上报「请人工核对」。
- QA 复审（PR #13 三审）判断项 5：`--dry-run` 注释仍写「宿主条目/skill/备份同样只列不删」，而预览不列备份——注释与 README 对齐（备份只由真实执行生成）。
- QA 复审（PR #13 三审）判断项 6：护栏拒绝文案把「无强证据」与「存在非 grape 条目」并成一句且未给判据。现拒绝信息分「原因 / 判定依据 / 放行办法」三行；空目录、无证据、存在非 grape 条目各自点名，判定依据列出凭据形态与 grape 专属文件、`workers`/`worker-*` 仅作伴随条目，放行办法给出可执行动作。
- QA 复审（合入后 dev 基线，修复 PR）硬违规 1：`GRAPE_AUTH_FILE` 指向的凭据文件在 `auth init` 写入后既不检测也不清理，默认 uninstall 谎报零残留、同屏 doctor 仍报该文件生效——`GRAPE_AUTH_FILE` 纳入 `scanResidues` 单一扫描：残留提示点名路径，`--clean-global` 删除该文件，`--dry-run` 预览同步；非凭据形态目标拒删并提示人工处理。
- QA 复审（同批）硬违规 2：`--dry-run` 仍执行宿主卸载/删 skill/写备份（与 README/CHANGELOG「不动盘」矛盾），测试还把该行为固化为断言——dry-run 全程不动盘，宿主卸载改为各宿主 `plan()` 预览（与 uninstall 同路径判定），错误断言测试同步修正；不带 `--clean-global` 时不再静默忽略。
- QA 复审（同批）硬违规 3：误删护栏可被路径形态绕过——`GRAPE_HOME=$HOME/.config`（普通 config.json 误判特征）整删 `.config`、`GRAPE_HOME=$HOME/.grape/..` 清空 HOME。护栏改为 resolve/realpath 归一化后与 HOME/根/祖先比较；特征收窄为已知 grape 产物 + 凭据形态 config.json，所有自定义路径均要求全部条目为 grape 产物；空目录拒删；`--dry-run` 预览与执行同护栏；拒绝信息给出解析后的绝对路径。
- QA 复审（PR #13）硬违规 1：护栏证据判据与文档承诺相反——任意含 `http(s)` base_url 的通用 `config.json` 被当作 grape 证据、`workers` 单独也算特征，实测 `GRAPE_HOME=$HOME/tool`（普通 config.json）与 `$HOME/proj/src`（`workers/`+用户文件）被整删。现 `config.json` 须为凭据形态（`grape_` token 或命中已知 grape 域 base_url），`workers`/`worker-*` 仅作伴随条目、不能单独当证据，自定义路径一律要求全部条目为 grape 产物；两例均补「应拒绝」回归。
- QA 复审（PR #13）判断项：各宿主 `planUninstall*` 与 `uninstall*` 判定分叉（损坏配置下 dry-run 说「执行卸载会报错」，真实执行却说「未发现条目」并删 skill）——抽出 `inspectUninstall*` 共享步骤函数，预览与执行同源；`--dry-run` 文档不再声称会列备份（备份只在真实执行生成）；win32 `cleanEnvVars` 改读 `scanResidues` 单一扫描（不再自行 `reg query`）；`--dry-run`/残留提示的「备份只留非凭据行」「含 @grape-dev 的条目」过期文案改为掩码与 `@grape-dev/grape-kit` 实际口径。
- Spec AC1：普通 `uninstall` 不带 `--target` 零宿主痕迹时 exit 1 且不打印残留提示——现于非零退出前输出残留项与清理命令（干净环境亦明确报告「未检测到残留」）。
- Spec AC2：已存在旧 `GRAPE_API_TOKEN` 时 `auth init` 不检测冲突、双通道不一致——现提示 env/runtime 覆盖与处置指引。
- Spec AC4：测试套件继承导出的 `GRAPE_HOME` 时 13 处红（夹具未隔离）——update-check 每用例接管缓存目录、setup/intro run 夹具清继承值，导出 `GRAPE_HOME` 跑测全绿。
- QA 判断项批：仅 runtime 档生效时凭据检查行误报 `[!!]`（与「没有 [!!] 即就绪」矛盾）——改 `[--]` 信息行；win32 残留扫描不读注册表（`setx` 变量旧进程不可见）——补 `reg query` 扫描与删除前预检（不再吞错）；`_npx` 路径 win32 写死 `~/.npm/_npx`——`npxCacheRoot()` 平台分流至 `%LocalAppData%\npm-cache\_npx`；`_npx` 按 `@grape-dev` scope 匹配误删仅含 `grape-card` 的条目——收窄到 `@grape-dev/grape-kit` 实体；rc 备份与清理后文件逐字节相同（无回滚价值）——备份改保留非凭据原文 + 凭据行掩码标注；`credentialSourceCheck` 字符串反推命中档——改用结构化 `sourceKind`。
- QA 复审（PR #11）安全回归：`doctor` 文件通道解析失败时透传 `JSON.parse` 报错消息，会把 `config.json` 原文（含 token 片段）带进输出——改为固定文案「解析失败（内容不回显）」。
- QA 复审（PR #11）硬违规：`--clean-global` 的 rc 备份曾保留完整 `export GRAPE_API_TOKEN=…` 明文行且残留检测不扫备份，卸载后打印「未检测到残留」实为假象——备份保留非凭据原文、凭据行掩码标注，旧版本留下的含凭据 `.bak-grapemcp-*` 备份纳入残留检测并由 `--clean-global` 清零。
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