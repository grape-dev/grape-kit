<h1 align="center">@grape-dev/grape-kit</h1>

<p align="center"><a href="README.md">English</a> | 简体中文</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/v/@grape-dev/grape-kit" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit"><img src="https://img.shields.io/npm/dm/@grape-dev/grape-kit" alt="npm downloads"></a>
  <a href="https://gitcode.com/grape-dev/grape-kit/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@grape-dev/grape-kit" alt="License: MIT"></a>
  <img src="https://img.shields.io/node/v/@grape-dev/grape-kit" alt="node">
  <a href="https://www.grapedev.cn/"><img src="https://img.shields.io/badge/grape-www.grapedev.cn-2563eb" alt="grape"></a>
</p>

<p align="center">
  <strong>Grape DevOps 流水线工具 × 主流 Agent</strong><br>
  在 opencode / CodeArts / WorkBuddy 等 Agent 里触发、观察、推进 Grape 多 agent DevOps 流水线，<br>
  并以<strong>接管会话（takeover）原语</strong>把云端节点原子让渡到本地——链不断、成果结构化交回。<br>
  <a href="https://www.npmjs.com/package/@grape-dev/grape-kit">npm</a> · <a href="https://www.grapedev.cn/">Grape 官网</a> · <a href="https://gitcode.com/grape-dev/grape-kit">源码仓库</a>
</p>

---

帮助各类 **Agent**（opencode / CodeArts / WorkBuddy 等）安全、结构化地使用 [Grape](https://gitcode.com/grape-dev/grape) —— 多 agent 协作的 AI Native DevOps 平台（vod → issue → coding → qa → sre）。

```
agent 宿主（MCP stdio：opencode / CodeArts / WorkBuddy…；其他 MCP 能力宿主可手动接线）
  → grape-kit（39 工具 · 原生 HTTP 直连 · Markdown 渲染 · initialize instructions 自举）
    → grape 服务端（流水线 / events / takeover 会话 API；CLI 仅 401 回退用）
```

## 能力总览（39 工具）

- **流水线遥控**：触发（唯一 A2A 入口）· 等待任务 · 任务状态 · 取消/恢复（带决策门）
- **需求与事件**：列表/详情/事件流/我的需求 · 建单 · 结构化交回模板
- **端云协同**（v0.3.2+ 核心）：**接管会话**把云端节点（如 coding）原子让渡到你的 Agent——签发 `tko_` 凭据（12h）并返回完整上下文（prompt/env/workspace/skill/history）；Agent 在本地干活、上报进度，按两阶段交回：`request-finish` 只报告完成，**在对话中经你确认**后再 `finish` 正式交回（结构化产物，链路保持完整）。
  - **凭据语义**：`tko_` 仅 repo_session 能力（继续节点工作 / 回报进度，**不含 git 凭据注入**）——`request-finish` 用 tko_ 即可，但**最终 `finish` 必须用用户级凭据（`grape_`）**，tko_ 调 finish 会 403 属预期边界。平台不提供 UI 确认按钮，确认只发生在你与 Agent 的对话里。
  - 平台要求 weekly-11+；旧平台自动回退只读上下文。完整时序：[docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- **场景与仓库**：场景列表 · 应用场景 · 托管仓库 · 同步仓库 · 项目模板 · 项目信息
- **搜索、知识与技能**：全局搜索 · 技能 ×3 · 知识库 ×2 · 看板
- **Worker 接入**：把本机注册为 grape 执行引擎（`grape_worker_onboard`）

## 快速开始

> 省略 `--target` 时安装器自动检测本机宿主：
>
> - **未检测到**：交互终端弹出宿主选择菜单；非交互环境报错并列出受支持宿主。
> - **检测到一个**：直接装它。
> - **检测到多个**：全部安装（等价 `--target all`）；要装单个用 `--target <宿主>`。

前提：**Node ≥ 20**（无需 Python——v0.3.0 起原生 HTTP 直连）。凭据走环境变量：

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn
export GRAPE_API_TOKEN=grape_xxx      # API Key：https://www.grapedev.cn/app/#account/profile
# 环境变量被清洗的宿主：写文件通道 ~/.grape/config.json {"token":"grape_xxx","base_url":"..."}
```

### 凭据优先级与 `auth init`

凭据写入收敛为单一入口；解析顺序固定，API 客户端、`doctor` 与接管脚本共用同一份语义：

1. `GRAPE_API_TOKEN_ONCE` —— runtime，仅当前进程（最高）
2. `GRAPE_API_TOKEN` / `GRAPE_BASE_URL` —— env 环境变量通道
3. `GRAPE_AUTH_FILE` 或 `~/.grape/config.json`（目录可用 `GRAPE_HOME` 覆盖）—— file 文件通道

```bash
# 写文件通道（权限 600、剥 BOM），并打印对应的 env 设置命令
npx -y @grape-dev/grape-kit auth init --token grape_xxx --base-url https://www.grapedev.cn
npx -y @grape-dev/grape-kit doctor     # 展示完整 runtime > env > file 优先级链（不回显 token）
```

`auth init` 在 `GRAPE_AUTH_FILE` 已设置时写它，否则写 `GRAPE_HOME/config.json`——写入目标始终与解析目标一致，写盘后回读校验。`doctor` 输出中命中档显示 `[ok]`；未命中/被覆盖档显示 `[--]`（信息行，无需处理）。

普通 `uninstall` 只移除宿主条目并提示残留凭据；加 `--clean-global` 才会删除 `~/.grape`（文件通道 + worker 注册产物）、用户级 `GRAPE_API_TOKEN`/`GRAPE_BASE_URL`（POSIX：从 rc 文件精确删除 `export` 行，备份只保留非凭据行——含凭据的备份等于换个文件名把 token 留盘；Windows 用 `reg delete`），并仅清理含 `node_modules/@grape-dev` 的 `_npx` 缓存条目。`--clean-global` 带不带 `--target` 均可执行（零宿主痕迹时也照跑全局清理）；`--dry-run` 先预览将删除项、不动盘：

```bash
npx -y @grape-dev/grape-kit uninstall --clean-global --dry-run   # 先预览
npx -y @grape-dev/grape-kit uninstall --clean-global
```

### OpenCode

```bash
npx -y @grape-dev/grape-kit install --target opencode
```

**装完重启会话**后生效。

```bash
npx -y @grape-dev/grape-kit doctor --target opencode --probe   # 逐项自检
npm install -g @grape-dev/grape-kit             # 更新（更新后重启会话）
npx -y @grape-dev/grape-kit uninstall --target opencode   # 卸载（备份配置）
```

### CodeArts Agent（华为云码道）

```bash
npx -y @grape-dev/grape-kit install --target codearts
```

写入 `~/.codeartsdoer/codearts_cli.jsonc`（全局）或 `<项目>/.codeartsdoer/codearts_cli.jsonc`（项目级）。装完需在 CodeArts：设置 → MCP工具 → 已安装 → grape-kit 点「重启」。

```bash
npx -y @grape-dev/grape-kit doctor --target codearts --probe
npx -y @grape-dev/grape-kit update --target codearts
npx -y @grape-dev/grape-kit uninstall --target codearts
```

### WorkBuddy

```bash
npx -y @grape-dev/grape-kit install --target workbuddy
```

写入 `~/.workbuddy/mcp.json`（`mcpServers.grape-kit`，走 npx 免全局安装）+ skill 落 `~/.workbuddy/skills/grape-remote/`。**重启宿主会话**即可加载连接器——无需手动「信任」（实测直接 spawn，宿主不弹授权）。凭据走环境变量，**不要**写进 mcp.json。

```bash
npx -y @grape-dev/grape-kit doctor --target workbuddy --probe
npx -y @grape-dev/grape-kit update --target workbuddy
npx -y @grape-dev/grape-kit uninstall --target workbuddy   # 移除条目+skill+receipt（配置自动备份）
```

### openclaw（ClawHub 市场）

```bash
openclaw plugins install clawhub:grape-kit@latest
```

`clawhub:` 为来源前缀（与 devkit 上架同款）。装后用插件 MCP 工具列表验证（39 工具）。市场页：https://clawhub.ai/grape-dev/plugins/grape-kit

### 版本查询与更新（全宿主通用）

```bash
npx -y @grape-dev/grape-kit --version        # 版本查询
npm install -g @grape-dev/grape-kit          # 更新（更新后重启 Agent 会话）
npx -y @grape-dev/grape-kit uninstall        # 卸载（宿主自动检测）
npx -y @grape-dev/grape-kit uninstall --clean-global   # 同时清理 ~/.grape + 用户环境变量 + _npx 缓存
```

启动时自动检查 npm 新版本（24h 去重，`GRAPE_KIT_SKIP_UPDATE_CHECK=1` 关闭）；国内镜像同步滞后 1-3 天，最新版用 `--registry https://registry.npmjs.org/`。

然后直接对 Agent 说：

```
> 我有哪些单子在跑流水线？
> 帮 acme/demo 仓库的 #12 触发流水线，等到终态
> #12 的 coding 在跑——抢到本机来干，链不断                       ← takeover_start
> 干完了——上报平台，等我确认再正式交回                          ← progress + request-finish + finish（finish 需用户级凭据）
> 这个节点干不了——还给云端重跑，链不断                          ← takeover_abort
```

### 装完看能力地图（intro）

每次 `install` 成功都会打印一张**能力地图**：5 组能力说明，每组配一条可直接复制的示例问句。若尚未检测到凭据，同一段输出会先给 3 步 API Key 获取指引（去哪生成、`grape_` 前缀、写到哪），避免首次调用直接 401。

```bash
npx -y @grape-dev/grape-kit intro     # 随时重看能力地图
```

`intro` 与安装结束共用同一份常量，文案不会漂移。它不收 `--target`——能力地图与宿主无关，只读本地凭据状态；宿主相关命令见上面各宿主小节。

## 版本历史

| 版本 | 日期 | 要点 |
|---|---|---|
| 0.3.10 | 2026-11-23 | 接管交回派发收口（#19）：派发指针只认 `next_seq`（`handoff_seq` 只是交回事件序号，不作派发证据）· 平台漏派时客户端兜底补发 coding→qa（与 trigger 同源 A2A 通道）并回填 `next_seq` · 受阻（`remote_may_still_run`／缺仓库-issue 标识／补发失败）落 `pending_dispatch` 待派发标记 + 可读告警，不再静默 grace；三处「未证实当成功」收口：交回未成功（`ok=false`／`changed=false`）不派发下一节点 · 白名单外节点名（如 `reviewer`）按「未知」上报不改写为 qa · 补发响应缺事件 `seq` 判未证实；#20 凭据/卸载批：`auth init` 唯一写入入口 · `uninstall --clean-global`（`--dry-run`、rc 备份不留凭据行、`_npx` 收窄到 grape-kit）· doctor 完整凭据优先级视图；单测 156→221 |
| 0.3.9 | 2026-11-23 | 端云接管全链路硬化（#12）：takeover_start 分支/MR 前置检查 · warnings 全量透出 · Node 跨平台接管三脚本（report/request-finish/finish）· 409 agent_mismatch 友好提示 · bundle 脚本 {{CWD}} 渲染 · doctor 凭据来源行；#17 修复批：intro 子命令 + 能力地图（无凭据先给 3 步 API Key 指引）· trigger_pipeline agent 参数（可从指定节点续跑）· doctor base_url 双通道并标注生效来源 · 审核三工具 native 崩溃修复；单测 136→156 |
| 0.3.8 | 2026-11-20 | 审核三工具（grape_review_pass / grape_review_reject / grape_confirm_done，工具面 36→39）· issues 表新增「仓库」列 · doctor 识别 ~/.grape/config.json 文件通道凭证（不再误报 FAIL） |
| 0.3.7 | 2026-11-20 | trigger/task_status 图形化渲染（触发即出节点链图 · 状态查询出卡片+进度条+下一步指引）· Quick Start 重构对齐 devkit 模式 + Capabilities 总览节 · 卸载清理 receipt · Codex/hermes 移出露出面 |
| 0.3.6 | 2026-11-19 | 流水线渲染支持 segments 事件流形态（真实 API 返回，不再回退原始 JSON）· 停滞状态「⚠️ 疑似停滞 N 分钟」透出到判读行 · 新增 segments 形态回归用例（单测 114→115） |
| 0.3.5 | 2026-11-19 | 宿主自动检测（按 workbuddy/codearts/officeace 痕迹）· 零宿主交互选择（不再静默兜底 opencode）· 干净环境自动建配置 + 三步上手引导 · 宿主矩阵补 codearts 专段与 ClawHub 渠道 |
| 0.3.4 | 2026-11-19 | codearts/officeace 两宿主安装（受支持宿主 2→4）· doctor 版本更新行（24h 去重、五态）· 条目引擎结构扫描加固 |
| 0.3.3 | 2026-11-18 | check_update 启动版本提醒 + CHANGELOG 生成器；401 回退最佳努力（#1） |
| 0.3.2 | 2026-11-17 | takeover 会话原语五工具（start/status/progress/finish/abort）；#2517 端侧适配（abort 重派失败告警 + 竞态警告渲染）；SKILL.md 双路径语义 |
| 0.3.1 | 2026-11-11 | cancel 三选决策门 · resume 事实复核 · search 契约收敛 · 结构化交回模板 |
| 0.3.0 | 2026-11-11 | 传输层原生化：原生 HTTP 直连，grape CLI/Python 变可选（401 回退通道） |
| 0.2.x | 2026-11-09 前 | 13→31 工具扩展 · worker_onboard · B1 接管闭环 |

逐版本完整记录（发布日期、工具面变化、行为修复，覆盖 npm 全部 20 条发布记录——含 `0.0.0-stage` 占位包，0.2.3 从未发布）：[CHANGELOG.md](CHANGELOG.md)

## 设计原则

- **只触发、只观察、可推进、可接管**：A2A 编排默认服务端驱动；takeover 交回时平台漏派 coding→qa（`next_seq=0`）由客户端兜底补发——且只在交回**本身成功**之后，交回未成功绝不把下一节点拉进一个未交回的任务；白名单外节点名按「未知」上报而不被改写；超出该范围保持平台原行为；接管以会话原语完成原子让渡与交回
- **scope 是第一道门禁**：契约 219 命令中 session_only 的 28 个（git-repo 等）对外部 token 必 403，直接排除；`tko_` 接管凭据仅 repo_session 能力、结束即吊销
- **无 UI 补偿**：工具返回即 Markdown 表格 / 节点链 / 事件时间线；`wait_task` 轮询带阶段摘要与超时提示

## Windows 注意事项

1. **编码**：grape CLI / MCP 输出 UTF-8，PowerShell 默认按 GBK 解码会显示乱码——先 `chcp 65001`，或设置 `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()`。
2. **BOM**：`~/.grape/config.json` 含 UTF-8 BOM 时 `JSON.parse` 会失败——用无 BOM 保存（VS Code「Save with Encoding → UTF-8」；PowerShell `Set-Content -Encoding utf8NoBOM`）。
3. **setx 不传播**：`setx GRAPE_API_TOKEN ...` 只对**新**进程生效，当前宿主会话读不到——设置后重启 Agent 宿主（opencode / CodeArts / WorkBuddy）或重新登录终端。

## 开发与测试

```bash
npm install
npm test        # 221 个单测（fake-grape 替身，不依赖真实服务端）
npm run smoke   # 真实 stdio JSON-RPC 往返：initialize → tools/list → tools/call
```

对真实服务端只读冒烟：

```bash
export GRAPE_BASE_URL=https://www.grapedev.cn GRAPE_API_TOKEN=grape_xxx
node scripts/live-smoke.mjs
```

## Roadmap

- [x] 组织仓归位（grape-dev/grape-kit）
- [x] 版本更新检测与升级提示（0.3.3 check_update）
- [x] install 目标 workbuddy（0.3.2）
- [ ] CI 门禁全面接入（当前提供 GitHub Actions 兼容 workflow，GitCode GoCI 转正后启用）
- [ ] install 目标扩展：codearts / officeace（integrations 三型）
- [ ] dsh 宿主由 [grape-dsh](https://gitcode.com/grape-dev/grape-dsh) 独立插件承载，不重复建设

## 相关链接

- [Grape 平台](https://www.grapedev.cn/) · [grape 主仓](https://gitcode.com/grape-dev/grape) · [grape-cli](https://gitcode.com/grape-dev/grape-cli) · [grape-dsh（DSH 宿主插件）](https://gitcode.com/grape-dev/grape-dsh)
- 端云协同架构与验证报告：[docs/20261114-takeover-architecture.md](docs/20261114-takeover-architecture.md)
- 贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md) · 安全报告：[SECURITY.md](SECURITY.md) · 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · 支持渠道：[SUPPORT.md](SUPPORT.md) · AI Agent 工作指引：[AGENTS.md](AGENTS.md)

## License

[MIT](LICENSE)
