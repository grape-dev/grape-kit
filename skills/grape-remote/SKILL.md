---
name: grape-remote
description: |
  遥控 Grape DevOps 流水线（多 agent：vod→issue→coding→qa→sre）的行为准则。
  当用户提到 grape、流水线、触发任务、查 issue/PR 进度、QA 打回、接管任务时使用。
  覆盖工具选择、token 作用域、等待与复查策略、端云协同边界。
---

# Grape 流水线遥控纪律

## 边界（先读）

1. **只触发、只观察、可推进**：流水线节点间交接（A2A）由服务端驱动，永远不要试图干预或伪造节点流转。
2. **用户决策层动作需确认**：`grape_apply_scene`、取消/终止/重派类操作，调用前必须向用户复述目标并得到确认。
3. **token 作用域**：本插件走用户级 `GRAPE_API_TOKEN`。git-repo 类会话命令（tk_ 专属）不可用，403 属预期边界，不要重试。

## 标准动作序列

- **领任务**：`grape_list_my_issues(status=processing)` → 用户选定 → `grape_get_issue_detail` 读验收要求。
- **触发**：`grape_trigger_pipeline(owner, repo, issue_number)` → 记下返回的 `seq`。
- **等待**：`grape_wait_task(seq)`（默认 300s 上限）。超时**不要**无限重等——改用 `grape_get_task_status(seq)` 让用户稍后复查。
- **看进度**：`grape_get_pipeline_info` 看节点链（vod→issue→coding→qa→sre）；`grape_get_issue_events` 看事件明细。

## 端云协同（⚠️ 语义边界必读）

### 路径一：takeover 会话原语（weekly-11+ 平台，首选）

平台具备 takeover API（`POST /api/takeover/sessions` 返回 200 即支持）时，接管走会话原语，**链不断**：

> **动手前先读「前置检查清单」**：`grape_takeover_start` 的 warnings 全量呈现（含 `remote_may_still_run`）。远端分支可能已有云端提交/已开 MR，按「复用远端分支（推荐）→ rebase 后强推（需用户确认）→ 另起分支」三选一裁决，禁止裸 `--force`。完整 playbook：[docs/20261114-takeover-architecture.md](../docs/20261114-takeover-architecture.md)。

1. `grape_takeover_start(owner, repo, number[, agent_type])` —— 原子让渡：云端任务停、本地接手、签发 tko_ 凭据（12h）、返回完整上下文与服务端渲染脚本。**不要**再调用 `grape_cancel_issue`。
   - tko_ 只有 repo_session 能力：可继续节点工作、回报进度，**不含 git 凭据注入**；洁净机器的写回链路见下方「git 写回」。
   - **git 写回（Issue #31）**：`grape_git_credential(session_id, owner, repo, workspace)` 用 tko_ 换一次性本仓券（600s）并落 `GIT_ASKPASS`（0600，内嵌到期 epoch）；**push 前重新换券**（不缓存），券过期脚本非零退出并提示「重新换券」，不存在静默回退本机 git/CLI 凭据的分支。PR 用 `grape_create_pull(title/head/base)`；两工具只服务本仓 + 会话工作区，非本仓/越界拒绝且不落盘；`.grape` 目录/askpass 文件 symlink 拒绝；写盘前把 `/.grape/` 写入 `.git/info/exclude` 并以 `git check-ignore` 复核（无法确认已排除即拒绝），**提交前确认 `.grape/` 不在待提交列表**。
2. 本地继续该节点工作；关键动作后 `grape_takeover_progress(session_id, summary)` 回报（云端面板可见）。
3. 完成后两阶段交回（**第二阶段 finish 必须用用户级凭据**）：
   - **① request-finish**：`grape_takeover_finish(request_only=true, …)` 只报告完成与结构化产物，用 tko_ 接管凭据即可。
   - **② 用户授权**：把结论 + 证据原样呈现给用户，在**对话中**取得明确确认。平台不提供任何 UI 确认按钮，不要指路 WebUI/前端页面。
   - **③ finish**：用户确认后，由**用户级凭据（`grape_`）**的会话调用 `grape_takeover_finish(request_only=false, …)` 正式交回（结构化产物，coding→qa 自动接力；**coding 交回须带 branch / commit / PR 三件套**——request-finish 缺项只强 warning，正式 finish 缺项直接拒绝，`allow_incomplete=true` 可覆写并在 actions 留痕；finish/abort 自动清理 askpass；判据只看派发指针 `next_seq`——`next_seq>0` 平台已派发则不重复，`next_seq=0` 时 kit 兜底补发并回填 `next_seq`；返回 `pending_dispatch` 待派发标记时按提示 `grape_trigger_pipeline(agent=…)` 补发——标记随交回结果返回，事后可用 `grape_takeover_status` 复查会话派发指针，平台对已结束会话拒绝 progress 写入）。tko_ 仅 repo_session 能力、不推进流水线，用它调 finish 会 403——这是凭据语义边界，不是权限不足。
4. 中途放弃：`grape_takeover_abort(session_id, redispatch=true)` —— 当前节点重新派发回云端引擎，已完成的节点保留。
5. 断连恢复：`grape_takeover_status(owner, repo, number)` 找回 session_id；单条查询带 `renew=true` 续期凭据。

**节点对准约束**：`grape_takeover_start` 只能接管**当前活跃节点**；提前接管下一节点会返回 409 `agent_mismatch`。先 `grape_get_pipeline_info` 确认当前 running/takeover 节点；目标尚未活跃时按 60-120s 轮询，不要连打开 start。

**脚本**：`grape_takeover_start` 会上报宿主 `host_os/host_arch/host_shell`，服务端据此渲染脚本资产（Windows 得 `.ps1`、Linux/macOS 得 `.sh`）；工具输出里 `{{CWD}}` 已替换为实际路径，可直接落地。平台未返回脚本资产时用随包分发的 Node 版 `skills/grape-remote/scripts/takeover/{report,request-finish,finish}.mjs`（Node ≥20，跨平台，token 只从 env 读取，不要写进 argv）。

### 路径二：cancel+context 旧路径（平台无 takeover API 时的回退）

- **接管不是无损操作**：cancel 是「终止整链」语义。用户说"停掉云端、本地接管"时，必须先讲清后果（当前及后续节点停止、不做 QA/SRE 交接），并让用户在「①takeover 会话接管（若平台支持，推荐）②让渡并行（云端继续跑）③终止整链+本地接管」中显式选择，未选择不得执行 cancel。
- **本地成果交回**：cancel 后云端不认识你的本地分支。交回时用 `grape_trigger_pipeline` 重新触发，context 必须结构化写明：产出分支名 + commit + 测试证据 + 「代码已在远端分支，请识别后直接进 QA，勿重复实现」。
- **resume 的坑**：接口返回成功 ≠ 流水线真的恢复（0.3.1 起工具会自动回读复核，verified_stage 字段是事实，接口回执不是）。
- **QA 打回**：PR 评论会出现在 `grape_get_issue_events`；发现打回后向用户展示缺陷清单，本地修复后重推，云端 QA 会自动复审。
- **提交产物**：本地开发用 PAT/`grape git`（凭据注入）或自有 git 工作流；PR 建立后云端 QA/SRE 自动接手。

## 输出约定

- 工具返回已是 Markdown；向用户汇报时保留表格/节点链，不要转述成纯文字。
- 等待期间不要刷屏：每次轮询结果有变化才汇报（增量、简洁）。
