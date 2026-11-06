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

## 端云协同

- **QA 打回**：PR 评论会出现在 `grape_get_issue_events`；发现打回后向用户展示缺陷清单，本地修复后重推，云端 QA 会自动复审。
- **接管**：云端任务卡住或用户要介入时，走服务端 takeover 流程（本插件 MVP 暂未封装工具，用 `grape` CLI / WebUI 操作）。
- **提交产物**：本地开发用 `grape git`（凭据注入）或自有 git 工作流；PR 建立后云端 QA/SRE 自动接手。

## 输出约定

- 工具返回已是 Markdown；向用户汇报时保留表格/节点链，不要转述成纯文字。
- 等待期间不要刷屏：每次轮询结果有变化才汇报（增量、简洁）。
