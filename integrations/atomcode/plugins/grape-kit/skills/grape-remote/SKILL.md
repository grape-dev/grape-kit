---
name: grape-remote
description: |
  遥控 Grape DevOps 流水线（多 agent 节点链：vod→issue→coding→qa→sre）。
  当用户提到 grape、流水线、触发任务、查 issue/PR 进度、QA 打回、接管任务时使用。
  覆盖工具选择、token 作用域、等待与复查策略、端云协同边界。
author: grape-dev
---

# Grape 流水线遥控纪律（AtomCode 版）

## 边界（先读）

1. **只触发、只观察、可推进**：流水线节点间交接（A2A）由服务端驱动，永远不要试图干预或伪造节点流转。
2. **用户决策层动作需确认**：`grape_apply_scene`、取消/终止/重派类操作，调用前必须向用户复述目标并得到确认。
3. **token 作用域**：本技能配套的 MCP 工具走用户级 `GRAPE_API_TOKEN`。git-repo 类会话命令（tk_ 专属）不可用，403 属预期边界，不要重试。
4. **前置**：若本环境尚未配置 grape-kit MCP，先按 [references/install-and-auth.md](references/install-and-auth.md) 完成「安装 + 凭据」两步，再执行下面的动作序列。

## 标准动作序列

- **领任务**：`grape_list_my_issues(status=processing)` → 用户选定 → `grape_get_issue_detail` 读验收要求。
- **触发**：`grape_trigger_pipeline(owner, repo, issue_number)` → 记下返回的 `seq`。
- **等待**：`grape_wait_task(seq)`（默认 300s 上限）。超时**不要**无限重等——改用 `grape_get_task_status(seq)` 让用户稍后复查。
- **看进度**：`grape_get_pipeline_info` 看节点链（vod→issue→coding→qa→sre）；`grape_get_issue_events` 看事件明细。
- **工具面速查**：45 个工具的分组与用途见 [references/tool-map.md](references/tool-map.md)。

## 端云协同（⚠️ 语义边界必读）

### 路径一：takeover 会话原语（平台支持时的首选）

平台具备 takeover API 时，接管走会话原语，**链不断**：

1. `grape_takeover_start(owner, repo, number[, agent_type])` —— 原子让渡：云端任务停、本地接手、签发 tko_ 凭据（12h）、返回完整上下文。**不要**再调用 `grape_cancel_issue`。
2. 本地继续该节点工作；关键动作后 `grape_takeover_progress(session_id, summary)` 回报（云端面板可见）。
3. 完成后两阶段交回（**第二阶段 finish 必须用用户级凭据**）：
   - **① request-finish**：`grape_takeover_finish(request_only=true, …)` 只报告完成与结构化产物，用 tko_ 接管凭据即可。
   - **② 用户授权**：把结论 + 证据原样呈现给用户，在**对话中**取得明确确认。
   - **③ finish**：用户确认后，由**用户级凭据（`grape_`）**的会话调用 `grape_takeover_finish(request_only=false, …)` 正式交回（结构化产物，coding→qa 自动接力）。
4. 中途放弃：`grape_takeover_abort(session_id, redispatch=true)` —— 当前节点重新派发回云端引擎，已完成的节点保留。
5. 断连恢复：`grape_takeover_status(owner, repo, number)` 找回 session_id；单条查询带 `renew=true` 续期凭据。

**节点对准约束**：`grape_takeover_start` 只能接管**当前活跃节点**；提前接管下一节点会返回 409 `agent_mismatch`。先 `grape_get_pipeline_info` 确认当前 running/takeover 节点；目标尚未活跃时按 60-120s 轮询，不要连打开 start。

### 路径二：cancel+context 旧路径（平台无 takeover API 时的回退）

- **接管不是无损操作**：cancel 是「终止整链」语义。用户说"停掉云端、本地接管"时，必须先讲清后果，并让用户在「①takeover 会话接管（若平台支持，推荐）②让渡并行（云端继续跑）③终止整链+本地接管」中显式选择，未选择不得执行 cancel。
- **本地成果交回**：cancel 后云端不认识你的本地分支。交回时用 `grape_trigger_pipeline` 重新触发，context 必须结构化写明：产出分支名 + commit + 测试证据 + 「代码已在远端分支，请识别后直接进 QA，勿重复实现」。
- **QA 打回**：PR 评论会出现在 `grape_get_issue_events`；发现打回后向用户展示缺陷清单，本地修复后重推，云端 QA 会自动复审。
- **提交产物**：本地开发用 PAT/`grape git`（凭据注入）或自有 git 工作流；PR 建立后云端 QA/SRE 自动接手。

## 输出约定

- 工具返回已是 Markdown；向用户汇报时保留表格/节点链，不要转述成纯文字。
- 等待期间不要刷屏：每次轮询结果有变化才汇报（增量、简洁）。
