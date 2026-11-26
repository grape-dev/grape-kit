# grape-kit 工具面速查（45 工具）

## 流水线触发与跟踪
| 工具 | 用途 |
|---|---|
| grape_trigger_pipeline | 触发 issue 流水线，返回 seq（⚠️ 需用户确认） |
| grape_wait_task | 阻塞等任务终态（默认 300s） |
| grape_get_task_status | 按 seq 查任务状态（超时后复查用） |
| grape_get_pipeline_info | 看 issue 节点链 vod→issue→coding→qa→sre |
| grape_get_pipeline_roadmap | 看仓库级场景蓝图 |
| grape_cancel_issue / grape_resume_issue / grape_start_issue / grape_confirm_done | 流水线生命周期（⚠️ 均需用户确认） |

## Issue 与仓库
| 工具 | 用途 |
|---|---|
| grape_list_my_issues | 列我的 issue（领任务入口） |
| grape_list_issues | 列仓库 issue 及流水线状态 |
| grape_get_issue_detail | 读 issue 详情（含验收要求，实现前必读） |
| grape_get_issue_events | 读事件历史（QA 打回/评论/交接回环入口） |
| grape_create_issue | 建 issue（⚠️ 需用户确认） |
| grape_list_managed_repos | 列已纳管仓库 |
| grape_list_repos_member | 列我有权限的仓库 |
| grape_get_repo_dashboard | 仓库仪表盘（运行汇总、状态统计） |
| grape_get_repo_project_info | 仓库项目信息（语言/框架/结构） |
| grape_host_repo / grape_sync_repos | 纳管/同步仓库（⚠️ 需用户确认） |

## 场景与模板
| 工具 | 用途 |
|---|---|
| grape_list_scenes | 列场景市场 |
| grape_apply_scene | 应用场景到仓库（⚠️ 需用户确认） |
| grape_set_repo_scene | 设仓库默认场景（⚠️ 需用户确认） |
| grape_list_project_templates / grape_create_project | 模板建仓（⚠️ 建仓需确认） |

## 知识与技能
| 工具 | 用途 |
|---|---|
| grape_list_knowledge / grape_get_knowledge_detail | 知识库检索/详情 |
| grape_list_skills / grape_get_skill_detail / grape_search_skills | 技能库 |
| grape_upload_skill / grape_update_skill / grape_convert_skill | 技能上载/更新/转换（⚠️ 需确认） |
| grape_search | 全局搜索（event/repo/agent，不支持 issue） |
| grape_review_pass / grape_review_reject | 评审通过/打回（⚠️ 需确认） |

## 端云协同（takeover 六件套）
| 工具 | 用途 |
|---|---|
| grape_takeover_start | 发起接管（原子让渡，签发 tko_ 12h 凭据） |
| grape_takeover_context | 取接管上下文（task_id/prompt/日志/env） |
| grape_takeover_progress | 回报本地进度（云端面板可见） |
| grape_takeover_finish | 两阶段交回（request-finish → 用户确认 → finish） |
| grape_takeover_abort | 放弃接管、让渡回流水线（链不断） |
| grape_takeover_status | 会话状态/列表；单查带 renew 续期 |

## 本机生命周期
| 工具 | 用途 |
|---|---|
| grape_kit_install / grape_kit_uninstall | 安装/卸载（--target 指定宿主） |
| grape_kit_upgrade / grape_kit_version / grape_kit_check_update | 升级/版本/更新检查 |
| grape_worker_onboard | 本机接入为 Grape Worker（打印安装命令，用户亲跑） |
