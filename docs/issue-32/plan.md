# Issue #32 · 方案设计

## 模块

| 模块 | 改动 |
|------|------|
| `src/api.mjs` | 新增 `health()`（GET `/api/health`，5s 超时，404/网络错误不抛错） |
| `src/capabilities.mjs` | 新增：握手/归一化/缓存/gate/错误码/payload/`normalizeSkills()` |
| `src/tools.mjs` | `grape_takeover_start` native 前置 gate、render 披露、description |
| `test/capabilities.test.mjs` | 握手、缓存、gate、payload |
| `test/takeover-capabilities.test.mjs` | takeover_start 拒绝/通过路径 |
| `README.md` / `README.zh.md` / `CHANGELOG.md` | 行为与错误码同步 |

## 关键设计

- **握手**：`getServerCapabilities({ force, env })` 调 `api.health()`；归一化兼容
  `string[]` / `{name:boolean}` / `items[]`，缺字段 → `[]`。
- **缓存**：模块内单例 `{ data, fetchedAt }`；TTL 内复用；过期/强制刷新重取；
  重取失败且已有缓存 → `stale-cache`（保留旧 `fetched_at`）；无缓存 → `unknown` 且不写缓存。
- **技能清单**：`normalizeSkills(source)` 单一入口，来源优先级
  `skills[]` > `assets.skill` > `env.GRAPE_BOUND_SKILL`；元素取 `name`/`skill`/字符串。
- **gate**：`evaluateTakeoverGate(skills, caps)`；`required` 缺失且数量 >1 按全部 required 保守计。
  拒绝返回结构化 `{ ok:false, refused:true, code, ... }`，由 render 渲染。
- **takeover_start**：native 先握手 + 解析技能（调用方可选传 `bundle`/`skills`；否则 best-effort
  读 takeover context 的绑定技能），拒绝时**不发起** takeover 请求；通过后把
  `client_capabilities` 元数据附在返回体，供 render 披露。
- **client_capabilities 声明**：握手请求头 `X-Grape-Client-Capabilities: skills.multi=true`。

## 与同批的关系

- 不新增工具（39 不变）。
- `normalizeSkills()` 导出为单一入口，供 #28 复用。
- 不触碰 #30 的 `seqOf`/派发判据与 #31 的凭据链路。