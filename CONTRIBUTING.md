# 贡献指南

感谢关注 grape-kit！本文说明如何参与贡献。

## 开发环境

- Node >= 20（无需 Python）
- 零原生依赖（仅 `@modelcontextprotocol/sdk`），`npm install` 即可

## 分支模型

- `dev`：开发主线，所有改动先合入这里
- `main`：稳定分支，随版本发布推进

## 开发流程

1. Fork 或从 `dev` 拉特性分支（命名建议 `feat/<主题>` / `fix/<主题>`）
2. 提交前保证本地验证通过：

```bash
npm test        # 单测（fake-grape 替身，不依赖真实服务端）
npm run smoke   # 真实 stdio JSON-RPC 往返冒烟
```

3. 向 `dev` 发起 PR，描述动机、改动点与验证结果
4. PR 审查通过后合入

## 提交规范

采用 Conventional Commits（见历史提交风格）：

- `feat:` / `fix:` / `docs:` / `chore:` / `test:` / `refactor:`
- 关联 issue 时写编号：`fix(#12): ...`

## 工具面约定

- 新增/修改 MCP 工具时保持既有渲染风格：返回 Markdown 表格 / 节点链，方便无 UI agent 直读
- 危险操作（cancel / apply_scene / takeover_finish 等）必须保留「需用户确认」决策门语义
- `session_only` 类命令不纳入工具面

## 安全问题

请勿在公开 issue 中提交安全漏洞细节，参见 [SECURITY.md](SECURITY.md)。
