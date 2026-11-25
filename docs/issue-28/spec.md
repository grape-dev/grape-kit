# Spec: Issue #28 —— takeover_start 物化 assets.skill 到工作区（.grape-takeover-skills）

> 来源：Issue #28（[P0] takeover_start 物化 assets.skill 到工作区）／Issue Agent 定稿 Spec（评论 203703358）｜目标分支：main｜开发分支：feat/issue-28

## 1. 问题（现状核实）

- 接管 prompt 声称「技能已物化，直接读 SKILL.md」，但 `src/tools.mjs` 对 `bundle.assets.skill` **零引用**：`grape_takeover_start.render` 只消费 `bundle.assets.scripts`（`renderBundleScripts`），不落盘任何技能文件。
- 本地接手方只能从 `bundle.env.GRAPE_BOUND_SKILL` 看到技能名，prompt 指向的目录实际不存在——接管链路首个断点（P0）。
- `src/tools.mjs` 至今未引入 `node:fs`（写盘是新能力面）；依赖面仅 `@modelcontextprotocol/sdk`，`engines.node >= 20`（原生 `fetch` 可用，无 zip 解压库）。

## 2. 目标

`grape_takeover_start` 消费平台下发的 `assets.skill`，把节点技能全文物化到本次运行工作区 `<cwd>/.grape-takeover-skills/<skill>/`，并在渲染结果中给出落盘路径，使接管 prompt 的指引成为事实。

## 3. 范围

### In Scope
- 新增 `src/skill-materialize.mjs`：`materializeSkillAssets(skill, cwd, { fetchImpl, env })`，纯模块 + 可注入 fetch。
- inline（`skill.files`）/ zip（`skill.zip_url`）/ legacy（无 `assets.skill`）三态。
- `src/tools.mjs`：`grape_takeover_start.native` 后置物化并挂到返回体；`render` 增加「技能物化」段（保持同步纯函数）。
- 目录名白名单 + 路径穿越/符号链接防护；**恒不写 `.skills/`**。
- 测试：`test/skill-materialize.test.mjs`（三态 + 逃逸拒绝 + 渲染文案 + 无 `.skills` 写入）。
- 文档同步：README 双语、CHANGELOG Unreleased、架构文档（CONTRIBUTING §7）。

### Out of Scope
- 不改 `assets.scripts` 现有渲染路径；不改平台下发协议；不新增 npm 依赖；不物化到全局/安装根；不动 `.gitignore`。

## 4. 期望行为

| 态 | 输入 | 行为 | 渲染 |
|----|------|------|------|
| inline | `assets.skill.files` | 逐条目落盘到 `<cwd>/.grape-takeover-skills/<skill>/`，相对路径原样保留 | `技能已物化：<path>` + 文件数 + references 有无 |
| zip | `assets.skill.zip_url` | 下载后零依赖解压（仅 store/deflate），剥掉 `<skill>/` 顶层前缀 | 同上 |
| legacy | 无 `assets.skill` | 不落盘、不报错 | 显式 warning：本次未物化技能 |
| failed | 白名单/逃逸/下载/解压失败 | 不抛错、不回滚会话，半成品目录清理 | `技能未能物化：<reason>` warning |

## 5. 关键设计决策（Issue Agent 定稿的 5 项）

| 决策 | 选择 |
|------|------|
| 物化时机与 render 纯度 | `native()` 后置 + 独立 async `materializeSkillAssets`；`render` 保持同步纯函数只读结果字段 |
| 落盘基准目录 | `cwd = bundle.workspace.cwd_hint \|\| process.cwd()`，物化根 `<cwd>/.grape-takeover-skills` |
| zip 解压实现 | 零依赖：`node:zlib.inflateRawSync` + 最小 ZIP 解析（EOCD → 中央目录 → local header），仅 store/deflate |
| 目录名白名单 | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，拒绝 `.`/`..`/`.skills`/含 `/`、`\`、盘符；非法即拒绝（不归一化、不跳过） |
| 失败语义 | 会话成功即保留：物化失败不回滚、不抛错，`status:'failed'` + reason 进渲染 warning；无 `assets.skill` → `legacy` 显式 warning |

## 6. 验收标准

- [ ] inline / zip / legacy 三态各一条单测（直调 `materializeSkillAssets`）。
- [ ] `SKILL.md` 与 `references/` 真实落盘可读（Linux 实机跑通；Windows 由受环境限制的说明覆盖）。
- [ ] `../`、绝对路径、反斜杠盘符、符号链接逃逸被拒，且有明确失败原因（不静默）。
- [ ] `status:ok` 渲染出现「技能已物化：<path>」。
- [ ] 不产生 `.skills/` 写入（目录快照断言）。
- [ ] 现有测试不因本改动新增失败（main 基线遗留 6 条与本改动无关，见 plan.md §4）。