# Issue #32 · capabilities 握手与 skills[] fail-closed（客户端）

## 目标

kit 客户端与服务端建立显式 capabilities 握手；节点 required 技能数 > 1 且服务端未声明
`skills.multi` 时 fail-closed，返回稳定错误码、可读文案与升级指引。旧服务端仅允许单技能，
单技能路径行为不变。

## 需求

1. `/api/health` 握手：读取服务端 `version` + `capabilities[]`，归一化后进程内缓存。
2. 缓存：TTL 300s（`GRAPE_CAPABILITIES_TTL_MS` 可覆盖），`GRAPE_CAPABILITIES_REFRESH=1` 强制刷新；
   握手失败 `source=unknown`、`capabilities=[]`，不伪造能力、不长负缓存。
3. fail-closed：`required_count > 1` 且 capabilities 不含 `skills.multi` → 拒绝接管。
4. 错误契约：`E_CAP_UNSUPPORTED_MULTI_SKILL`，结构化 payload，不抛 MCP error。
5. `takeover_bundle.v2` 与 `skills.multi` 正交：客户端唯一判据是 `skills.multi`。
6. 披露：工具 description 声明能力依赖；render 展示 capabilities 来源、版本与判据。

## 验收

- 新端 + 新服务端：3 技能通过，render 显示来源 `server` 与判据通过。
- 新端 + 旧服务端：required>1 拒绝，错误码/payload 完整。
- 旧端 + 新服务端：kit 握手请求声明 `client_capabilities`（`skills.multi=true`）。
- 单技能 + 旧服务端：既有 takeover 行为不变。
- 缓存命中/过期/失败三条单测；`npm test` 全绿；README 双语 + CHANGELOG Unreleased 同步。