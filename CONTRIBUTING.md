# 贡献指南

感谢关注 grape-kit！本文说明分支模型、评审门禁、提交规范与发版流程，读完即可上手。

> 一句话流程：`Issue 确认 → 从 dev 拉分支 → 本地测试全绿 → PR 到 dev → 评审 + CI → 合入 → 发版时 dev → main 并打 tag`

## 1. 开发环境

- Node >= 20（无需 Python）
- 零原生依赖（仅 `@modelcontextprotocol/sdk`）
- 首次准备：

```bash
npm ci            # 按 package-lock.json 安装（CI 同口径）
npm test          # 单测：fake-grape 替身，不依赖真实服务端
npm run smoke     # 冒烟：真实 stdio JSON-RPC 往返（44 tools）
```

- 需要连真实实例自测时，凭据只走环境变量：`GRAPE_API_TOKEN`（勿写入任何 agent 配置文件）。

## 2. 分支模型

| 分支 | 角色 | 谁能合入 | 说明 |
|------|------|----------|------|
| `main` | 发布主干 | Maintainer | 始终与 npm 上最新发布版本对应；只接受来自 dev 的发布合并 |
| `dev` | 集成主线 | Maintainer | 所有功能/修复先合入这里，滚动集成 |
| `feat/*` `fix/*` `docs/*` `chore/*` | 工作分支 | 贡献者自治 | 从 `dev` 拉出，合入必须走 PR |

规则：

- `main` 与 `dev` **禁止直接推送**，必须 PR + 评审 + CI 全绿（见第 4 节）。
- 禁止对 `main` / `dev` 强制推送或删除分支。
- 分支名用小写 kebab-case，带需求号更清晰：`feat/issue-12-takeover-hardening`。
- 一个 PR 只做一件事；跨目录大改请先提 Issue 对齐方案。

## 3. 从 Issue 到合入

1. **先提 Issue**：Bug 写「环境 / 复现 / 期望 vs 实际 / 已试过的自检」，功能写「场景 / 预期 / 备选实现」。请在 Issue 下认领，避免重复劳动。
2. **拉分支**：

```bash
git fetch origin
git checkout -b feat/issue-12-xxx origin/dev
```

3. **开发 + 自测**：提交前必须 `npm ci && npm test` 全绿，`npm run smoke` 通过。
4. **提 PR 到 `dev`**，按仓库 PR 模板写清动机、改动点、验证结果与风险。
5. **评审**：至少 1 名 Maintainer approve；有异议在同一分支继续提交，勿新开 PR。
6. **合入**：CI 全绿且评审通过后由 Maintainer 合并（squash 或 merge 依仓库设置）。

> 外部贡献者与协作者的差别只有「建分支 vs fork」：fork 后 PR 从 `你的账号:分支` → `grape-dev/grape-kit:dev`，流程一致。

## 4. 评审与 CI 门禁

PR 合入前必须同时满足：

- CI（`.github/workflows/ci.yml`）在 Node 20 与 22 上均通过：`npm ci` → `npm test` → `npm run smoke`
- 至少 1 个 approve；涉及 `src/` 核心路径、工具面契约、安全相关改动建议 2 个
- 无未解决的 review 评论；分支与 `dev` 无冲突
- 未提交任何真实凭据（token / 私钥 / 内网地址）

维护者对争议有一票裁定权。

## 5. 提交规范

采用 Conventional Commits（与历史提交一致）：

- 类型：`feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:` / `perf:`
- 关联需求号：`fix(#12): ...`
- 正文写「为什么改」而不只是「改了什么」；破坏性变更用 `feat!:` 或正文 `BREAKING CHANGE:`
- 不要把多个不相关改动塞进一个提交

## 6. 代码与工具面约定

- 新增/修改 MCP 工具时保持既有渲染风格：返回 Markdown 表格 / 节点链，供无 UI agent 直读。
- 危险操作（`cancel` / `apply_scene` / `takeover_finish` 等）必须保留「需用户确认」决策门语义，不得绕过。
- `session_only` 类命令不纳入工具面。
- 工具数变化（当前 44）必须同步：`README.md` / `README.zh.md` 能力总览、`CHANGELOG.md`、相关测试断言，以及 **`CONTRIBUTING.md` 本文件**（§1 冒烟注释与本条数字，`test/docs-sync.test.mjs` 按 `TOOL_NAMES` 实际数量断言，漏改即红）。
- 同一份工具数口径也写在贡献流程模板里：**`.github/PULL_REQUEST_TEMPLATE.md`**（验证清单的「期望 44 tools」）与 **`.github/ISSUE_TEMPLATE/bug_report.md`**（自检清单）——贡献者照着模板跑验证，模板失真的代价是「成功运行被判失败」；单测数**不写死**（每个 PR 都会变），以 `npm test` 实际输出为准。
- 新增依赖前先提 Issue 说明必要性；仅接受 MIT/Apache-2.0 等宽松许可依赖。

## 7. 文档同步要求

同一 PR 内需一并更新：

- 用户可见行为变化 → `README.md` 与 `README.zh.md`（双语同步）
- 工具面/参数/返回结构变化 → `CHANGELOG.md` 的 Unreleased 段
- 架构或原语变化 → `docs/` 下对应文档

## 8. 发版流程（Maintainer）

1. 确认 `dev` CI 全绿，`CHANGELOG.md` 写好本次版本小节。
2. `package.json` 升版本（semver）。
3. PR `dev` → `main`，评审通过后合并。
4. 在 `main` 上打 tag：`git tag v0.x.y && git push origin v0.x.y`。
5. 发布 npm：`npm publish`（`publishConfig.access=public`，包名 `@grape-dev/grape-kit`）。
6. 写 Release Notes（对齐 npm 版本与 CHANGELOG 小节）。
7. `dev` 继续滚动，`main` 保持与 npm 最新版一致。

## 9. 安全问题

请勿在公开 Issue 中提交漏洞细节，报道路径见 [SECURITY.md](SECURITY.md)。发现仓库内出现真实凭据，请私下报告并立即轮换，不要公开引用。

## 10. 行为准则与支持

- 参与即视为同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
- 支持渠道见 [SUPPORT.md](SUPPORT.md)；提问前先跑 `grape-kit doctor` 与 `npm run smoke`。