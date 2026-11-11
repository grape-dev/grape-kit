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

- **接管不是无损操作**：平台只有「终止整链」的 cancel，没有「暂停当前节点」原语。用户说"停掉云端、本地接管"时，必须先讲清后果（当前及后续节点停止、不做 QA/SRE 交接），并让用户在「①让渡接管（云端继续跑，推荐）②暂停等确认 ③终止整链」三选中显式选择，未选择不得执行 cancel。
- **本地成果交回**：cancel 后云端不认识你的本地分支。交回时用 `grape_trigger_pipeline` 重新触发，context 必须结构化写明：产出分支名 + commit + 测试证据 + 「代码已在远端分支，请识别后直接进 QA，勿重复实现」。
- **resume 的坑**：接口返回成功 ≠ 流水线真的恢复（0.3.1 起工具会自动回读复核，verified_stage 字段是事实，接口回执不是）。
- **QA 打回**：PR 评论会出现在 `grape_get_issue_events`；发现打回后向用户展示缺陷清单，本地修复后重推，云端 QA 会自动复审。
- **提交产物**：本地开发用 PAT/`grape git`（凭据注入）或自有 git 工作流；PR 建立后云端 QA/SRE 自动接手。

## 输出约定

- 工具返回已是 Markdown；向用户汇报时保留表格/节点链，不要转述成纯文字。
- 等待期间不要刷屏：每次轮询结果有变化才汇报（增量、简洁）。
