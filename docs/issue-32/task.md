# Issue #32 · 任务拆解

- [x] 文档：spec / plan / task
- [x] 红：`test/capabilities.test.mjs`（握手归一化、缓存命中/过期/失败、gate、payload）
- [x] 绿：`src/api.mjs` health + `src/capabilities.mjs`
- [x] 红/绿：`test/takeover-capabilities.test.mjs` + `src/tools.mjs` gate/render/description
- [x] README 双语 + CHANGELOG Unreleased
- [x] 自审查 + 敏感增量扫描
- [x] `npm test` 全绿