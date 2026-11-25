# Task: Issue #28 —— 任务拆解

| # | 切片 | 产物 | 提交 | 验收 |
|---|------|------|------|------|
| T1 | 文档：需求/方案/拆解 | `docs/issue-28/{spec,plan,task}.md` | `docs(#28)` | 三份文档齐备 |
| T2 | 红：物化模块契约先失败 | `test/skill-materialize.test.mjs`（三态 / 逃逸 / 渲染 / 无 `.skills`） | `test(#28)` | `node --test test/skill-materialize.test.mjs` 失败（模块不存在） |
| T3 | 绿：物化模块实现 | `src/skill-materialize.mjs` | `feat(#28)` | 新增测试全绿 |
| T4 | 绿：接管链路接入 | `src/tools.mjs`（native 后置 + render 物化段 + 描述） | `feat(#28)` | 渲染出现「技能已物化：<path>」，legacy/failed 有 warning |
| T5 | 实机验证（Linux） | 临时目录跑真实落盘 + 外部 `zip` 产物解压 | —（不入库） | `SKILL.md` 与 `references/` 实际存在可读 |
| T6 | 文档同步 | README 双语 + CHANGELOG Unreleased + 架构文档 §3.3/§5 | `docs(#28)` | `docs-sync.test.mjs` 全绿、双语单测计数一致 |
| T7 | 自审查 + 建 PR + A2A | PR + Issue 评论 | — | 5 轴审查 + 敏感增量扫描通过 |

## 验收映射

| 验收标准（Issue #28） | 覆盖点 |
|----------------------|--------|
| inline / zip / legacy 三态单测 | T2 + T3（`materializeSkillAssets` 直调） |
| `SKILL.md` 与 `references/` 实机存在可读 | T5（Linux）；Windows 受当前执行环境限制，由代码路径（`resolve`/`path.sep`/拒 `\`）与测试覆盖，实机待宿主验证 |
| `../`、绝对路径、符号链接逃逸被拒且有原因 | T2（每类一条断言 + reason 非空 + 目标文件未生成） |
| 渲染出现「技能已物化：<path>」 | T4（`render()` 直调断言） |
| 不写 `.skills/`（快照断言） | T2（`readdirSync` 前后快照） |
| `npm test` 全绿 | main 基线遗留 6 条 `HOSTS[n].plan` 失败与本改动无关（见 `plan.md` §4），本改动不新增失败 |