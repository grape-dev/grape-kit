# Grape 端云协同端到端测试报告

- 日期：2026-11-16
- 被测仓库：`qq_44826240/eos-cloud-album`（GitCode，静态 OBS 云端相册）
- 平台：`https://www.grapedev.cn`
- 场景：`custom-38d22dc5`（通用开发，节点 vod → issue → coding → qa → sre）
- 工具链：`@grape-dev/grape-kit@0.3.1`、grape worker `h-6aedab5afaf2`、`grape` CLI 0.3.3
- 本机环境：Linux aarch64 容器，Node 22.11，Python 3.12.5，无 systemd、无 bwrap 权限
- 结论：云端流水线可跑通；**本机 worker 接入与端云协同（takeover）环节存在多处环境/平台级缺陷**，其中 4 项 P0 直接阻断任务。

---

## 1. 测试目标与方法

目标：

1. 验证 `grape-kit` 在本机接入 Grape 平台的能力（安装、worker 注册、引擎探测）。
2. 验证流水线各节点（vod/issue/coding/qa/sre）端到端可用性。
3. 验证「本地承接指定节点」的端云协同能力，并观察多轮 coding↔QA 交互上下文的可获取性。

方法：通过 `grape-kit` 的原生 HTTP 接口（`/api/issues`、`/api/pipeline`、`/api/a2a`、`/api/runtime/*`）和 `grape` CLI（`git-repo`、`tasks`、`a2a`）驱动，逐条新建需求并跟踪事件。

瓶颈说明：`grape_` 用户级 API Key 不能调用 `git-repo` 系列接口（见 P1-12），因此部分操作必须依赖任务会话令牌（`tk_`），由此衍生出「占位触发 → 取消 → 用令牌执行」的绕行路径。

---

## 2. 环境搭建过程与阻断点

| 步骤 | 结果 | 阻断点 |
|---|---|---|
| `npm i -g @grape-dev/grape-kit@latest` | 成功（0.3.1，96 包） | `grape-kit --version` 未实现，仅打印 setup 用法（P2-14） |
| `curl /api/runtime/install` 安装 worker | 成功注册 | 离线 wheel 缺 aarch64 `aiohttp>=3.9`，回退在线（P2-16）；bwrap/AppArmor 降级、systemd 不可用降级 nohup（P2-17） |
| 引擎可用 | 初始 `engines=[]` | 默认 `--engine none`（P0-2）；手动装 `opencode-ai 1.19.5` 后仍需等 10 分钟探针（P1-13） |
| worker 内 `grape` CLI | 修复后可用 | `PYTHONPATH=/app` 抢占 venv 的 `src` 包（P0-1） |
| sre 节点 | 不可用 | 场景绑定引擎全部离线（P0-4） |

### 2.1 本机已实施的临时修复（未上游）

1. `/opt/grape/.venv/bin/grape` 入口在 `import` 前强制将 venv `site-packages` 置顶：

```python
import re
import sys
_sp = "/opt/grape/.venv/lib/python3.12/site-packages"
while _sp in sys.path:
    sys.path.remove(_sp)
sys.path.insert(0, _sp)
from src.cli import main
```

2. `/opt/grape/start-worker.sh` 在 `cd /opt/grape` 后加入 `unset PYTHONPATH`（下次重启生效）。

---

## 3. 需求执行结果

| Issue | 需求 | 执行路径 | 结果 |
|---|---|---|---|
| #24 | README 顶部加徽章行 | 全云端 | PR #12，QA pass，`pending_review` |
| #25 | README 末尾加「项目说明」 | 云端 2 分钟跑完 vod+issue；取消时已进入 coding | issue 已交付，coding cancelled，无 PR |
| #27 | README 末尾加「许可证」(MIT) | 本机 issue（Spec/标签/负责人）+ 云端 coding/qa | PR #13，QA pass；页面 vod/issue 灰 |
| #28 | 新增 `docs/CONTRIBUTING.md` + README 链接 | 云端 coding ×2 + 本机 QA ×2 | PR #14（2 文件 +102 行），复审 pass；页面 qa 灰 |

关键事件：

- #24：`seq 77151–77169`，coding 由 `opencode-worker-vector-open-web-2` 执行，QA 由 `hermes-worker-ecs-grape-mas-004` 执行。
- #27：本机 Spec 评论 `201125483`、分诊评论 `201125493`、标签 `documentation/P2/spec-ready/triaged`、负责人 `grape_bot`；coding `seq 77245`，QA `seq 77248`。
- #28：Q1 打回评论 `201138766`（Required：`docs/CONTRIBUTING.md` 末尾缺换行）；Q2 通过评论 `201140956`；coding 两轮 `t_50d51e104972`、`t_551ae67160f4`。

### 3.1 每轮 coding 上下文（takeover-context 抓取）

**第 1 轮 `t_50d51e104972`**（skill `implementation` v2.3.0，runtime 17267）：

1. 读取 `implementation/SKILL.md` 与 `implementation-runbook.md`；
2. 预检 `token=` 为空，`grape tasks current` 报 `Missing token: set GRAPE_SESSION_TOKEN ...`；
3. 发现 `GRAPE_AUTH_FILE=.grape-sess-923a0a46.tok`，读取文件导入环境变量自救；
4. 读 Issue 详情、Spec、README/index.html 与 git log，实现并创建 PR #14。

**第 2 轮 `t_551ae67160f4`**（runtime 17259）：

1. 由 `PR_NUMBER=14` 判定为 scenario B（代码优化），读取 `pr-optimization-flow.md`；
2. 同样遇 token 未注入，从 `.grape-sess-cc11182d.tok` 自救；
3. 读取 `.project-info` 基线，按审查意见做最小修复。

两轮均验证「每轮 coding 的处理上下文可通过 takeover-context 获取」，但前提是任务处于 `running` 且依赖会话令牌注入。

---

## 4. 问题清单

### P0 —— 直接阻断任务

#### P0-1 worker 内 `grape` CLI 被 `PYTHONPATH=/app` 污染

- 现象：`/opt/grape/.venv/bin/grape --version` 报 `ModuleNotFoundError: No module named 'src.cli'`。
- 证据：`/proc/814/environ` 中 `PYTHONPATH=/app`；venv 的 `site-packages` 已在 `sys.path` 但排在 `/app` 之后，`if _sp not in sys.path` 判断导致前置补丁失效。
- 复现：

```bash
cd /tmp && PYTHONPATH=/app /opt/grape/.venv/bin/grape --version
# ModuleNotFoundError: No module named 'src.cli'
```

- 影响：worker 执行 skill 的工具链失效，任务会失败或被迫自救。

#### P0-2 worker 安装默认 `--engine none`，注册后无引擎

- 现象：worker.log `RuntimeAgent registered: engines=[]`，平台侧 `machine health` 无该设备引擎记录。
- 证据：`[install-worker] Engine install skipped (default --engine none)`。
- 复现：按默认参数执行安装脚本，随后查 `grape runtime machine health` 过滤本机设备名，结果为空。
- 影响：安装完成 ≠ 可接任务。

#### P0-3 云端 coding 任务 `GRAPE_SESSION_TOKEN` 未注入

- 现象：#28 两轮 coding 的日志均为 `token=`（空），`grape tasks current` 报 `Missing token`。
- 证据：takeover-context 日志中 agent 自行查找 `.grape-sess-*.tok` 并 `export GRAPE_SESSION_TOKEN`。
- 影响：每个任务都浪费上下文排障；自救失败即 STOP。

#### P0-4 `sre` 节点派发失败（场景引擎全离线）

- 现象：#12 的 sre 事件 `seq=66125` 直接 failed。
- 证据：

```json
{"code":"a2a_dispatch_failed","target_stage":"sre","target_node":"sre","phase":"dispatch"}
"result": "A2A 交办派发失败（target=sre, node=sre）：场景绑定的引擎全部离线（scene=custom-38d22dc5, agent=sre）"
```

- 影响：QA 通过后无法部署验证，链路断在最后一步。

### P1 —— 功能显著受损

#### P1-5 cancelled 状态下 A2A 被拒，`force` 无效

```bash
grape a2a handoff --json '{"agent":"coding","force":true,"payload":{...}}'
# {"ok": false, "skipped": "task_cancelled"}
```

规避：先 `resume` 再派发。

#### P1-6 `resume` 与 pipeline 状态不一致

- `GET /api/pipeline/...` 返回 `status=cancelled`，`POST /api/issues/{id}/resume` 返回 400「仅已取消需求可恢复」，而 listIssues 侧状态为 `processing`。

#### P1-7 无「单节点暂停/接管」原语

- 只有整链 `cancel`。为获取会话令牌必须「占位触发 → 取消」，导致被牺牲的节点事件为 `cancelled`，页面灰色（#27 vod/issue、#28 qa）。

#### P1-8 A2A `engine_config` 不生效

```json
{"agent":"issue","payload":{"issue_number":27,"engine_config":{"runtime_id":17364,"engine":"opencode-grape-kit-nacre-202-0001"}}}
```

- 结果：`seq 77234` 落在 `codearts-worker-devkit-test`，非指定引擎。
- 影响：无法定向派发；本机 worker 只能参与池竞争。

#### P1-9 事件模型无法记录外部执行

- 本机通过会话令牌在 GitCode 完成 Spec/标签/负责人与 QA 审查，Grape 侧无对应事件，页面只能显示 cancelled/灰。

#### P1-10 coding 未完成即派发 QA

- #28 首次出现 `coding:running` 与 `qa:running` 并存；coding 出现 `completed` 后又有 `running` 的重复段。

#### P1-11 vod 任务假死

- #28 首个 vod `running` 超过 6 分钟，takeover-context 仅 1 条日志（`skill unbound`），无进展；取消重触发后 90 秒完成。

#### P1-12 `grape_` API Key 不能调 git-repo

```json
{"error":"403: Git 仓库接口仅支持会话级临时 token（agent 专用）"}
```

- 影响：端云协同被迫依赖短命 `tk_`，衍生 P1-5、P1-7、P1-9。

#### P1-13 引擎探针周期 10 分钟

- 18:44 安装 worker，18:54 才出现 `worker engine probe: opencode -> ok (6.7s)`。

### P2 —— 体验/一致性

| 编号 | 问题 | 证据 |
|---|---|---|
| P2-14 | `grape-kit --version` 未实现 | 输出 `用法: node setup.mjs install|uninstall|doctor` |
| P2-15 | `machine health` 默认 localhost:8000 | 未加 `--base-url` 时 Connection refused |
| P2-16 | 离线 wheel 缺 aarch64 `aiohttp>=3.9` | `Could not find a version that satisfies the requirement aiohttp>=3.9` |
| P2-17 | bwrap/systemd 降级 | `yum install of bwrap failed`；`systemd unavailable` |
| P2-18 | `listIssues.assignee` 与 GitCode 不一致 | 列表为空，GitCode API 为 `grape_bot` |
| P2-19 | 节点状态数字无文档 | `statuses=[4,4,2,2,0]` 需由事件反推语义 |
| P2-20 | runbook 与 CLI 偏差 | runbook 提 `grape issues update`（不存在）；契约 2.2.0 vs CLI 0.3.3 |
| P2-21 | `tasks_without_events` 含未出现在 issue 列表的编号 | 列出 `#2`、`#3`，列表 19 条中无此二者 |

---

## 5. 安全事件

排查 `takeover-context` 时误将 `env_extra` 按对象逐字符打印，导致 #25 会话的 `ACCESS_TOKEN`、`REFRESH_TOKEN`、`SESSION_TOKEN(tk_)` 以及用户提供的 `grape_` API Key 出现在对话记录中。

处置建议：

1. 吊销/轮换 `grape_` API Key；
2. 吊销 runtime 凭据 `rta_...`（本机 worker 使用）；
3. `tk_` 与任务同生命周期，已随终态失效，确认无残留运行任务即可。

---

## 6. 改进建议

1. 修复 worker 启动环境：清理 `PYTHONPATH`，并保证 `GRAPE_SESSION_TOKEN` 注入 agent shell。
2. 安装脚本默认安装引擎或强制提示；探针周期降至 30–60 秒。
3. 提供单节点 `pause/handover` 原语，或允许外部上报 `tasks complete`，使本机执行的节点能变绿。
4. 让 A2A `engine_config`/`runtime_ids` 真正生效，支持定向派发。
5. 对齐 cancel/resume 状态机，允许 `force` 在 cancelled 状态下交办。
6. sre 派发前做引擎心跳预检，避免 `a2a_dispatch_failed` 直接吞掉节点。
7. vod/coding 增加任务超时自愈，避免假死。
8. 文档补齐：`statuses` 数字语义、`--version`、`machine health` 默认 base-url。

---

## 7. 遗留待办

- PR #12、#13、#14 均已 QA 通过，待合入 `main`。
- #27 的 vod/issue、#28 的 qa 页面为灰色：产物真实、事件缺失；建议按第 6 节第 3 条从平台侧解决，而非重跑。
- 本机 worker（`opencode-grape-kit-nacre-202-0001`，runtime 17364）仍在运行；不再需要时停用并吊销凭据。

---

## 附录：关键接口

| 用途 | 接口 |
|---|---|
| issue 列表/详情 | `GET /api/issues/{owner}/{repo}`、`GET /api/issues/{owner}/{repo}/{n}` |
| 流水线节点 | `GET /api/pipeline/{owner}/{repo}/{n}` |
| 事件详情 | `GET /api/events/detail/{seq}` |
| 接管上下文 | `GET /api/runtime/issues/takeover-context?repo_key=&issue_number=` |
| A2A 派发 | `POST /api/a2a`（body: agent/payload/force） |
| 取消/恢复 | `POST /api/issues/{id}/cancel`、`POST /api/issues/{id}/resume` |
| 引擎健康 | `GET /api/runtime/machine/health` |
| GitCode 仓库操作 | `grape git-repo ...`（仅会话 token） |