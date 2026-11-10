# grape-kit 无界面 agent 插件 · 事件规划 v1.0

> 生成日期：2026-11-09 · 覆盖窗口：2026-11-02 ~ 2026-11-09（设计与实现期）+ 后续待办
> 关联：@grape-dev/grape-kit@0.2.4（npm）· gitcode qq_44826240/grape-kit（私仓）· 设计文档（OBS plans/20261102）

## A. 已完成事件（时间线）

| # | 日期 | 事件 | 产物 / 证据 |
|---|------|------|------------|
| A1 | 11-02 | 设计调研：grape 契约链路 / grape-dsh / devkit v2 / ORCA 实测 | 设计文档 v1（OBS plans/20261102-grape-plugin-analysis.html） |
| A2 | 11-02 | 两人分工（张/孙志远双轨）+ 八周路线 M1-M4 | 设计文档 §09 |
| A3 | 11-05 | grape-dsh 最新端云协同机制调研（takeover / worker-onboard / 决策三连） | 设计文档 §10 |
| A4 | 11-05 | 无 UI agent 插件架构定稿（CLI 薄壳 + 通道决策树） | 设计文档 §11 |
| A5 | 11-06 | grape-kit MVP 实现：13 工具 MCP 壳 + installer + skill + 22 单测 + smoke | commit 02bebf1 |
| A6 | 11-06 | ECS eng-0002 部署 + live 验证（真实 issue 数据回显） | live-smoke 通过 |
| A7 | 11-06 | 改名 grape-kit + npm 发布配置（publishConfig/bins） | commit a1cf624 |
| A8 | 11-08 | npm org 权限诊断（granular token 404 语义取证）→ **0.1.0 正式发布** | npm view 确认 |
| A9 | 11-08 | 多 agent 测试矩阵：opencode / hermes / codex 真实 E2E 全过；claude 环境受限 | 矩阵报告（OBS plans/20261108） |
| A10 | 11-08 | npm 页面 devkit 化（badges/keywords/homepage/LICENSE） | 0.1.1 |
| A11 | 11-08 | 写链路 E2E：create_issue 建载体 #4 → 流水线自动触发 → 回读 → 本机独立核验 | issue_id 11079 |
| A12 | 11-08 | 能力补齐 v0.2.x：**13 → 31 工具**对齐 grape-dsh（takeover/worker_onboard/cancel 等 18 件） | 0.2.0 |
| A13 | 11-08 | gitcode 私仓 qq_44826240/grape-kit 建立并推送 main | SSH push 记录 |
| A14 | 11-08~09 | live sweep 扫描器 + **6 个真 bug 修复**（派发双契约/动词链/knowledge 参数/重名凭据/悬挂逗号/版本派生） | 0.2.1~0.2.4，sweep 15 PASS |
| A15 | 11-09 | **F7 安全发现**：runtime-credentials 跨租户可见（个人组织分支）；根因定位至组织隔离 P1-P5 兼容分支；披露对象确认（廖堉哲/Xiahouyi） | 取证脚本 + 分支对照 |
| A16 | 11-09 | 新机器部署使用指南（含 hermes/codex 避坑） | 使用指南 md |
| A17 | 11-09 | 双机部署：ai-work-0007 + eng-0001（Miniconda 3.11 + CLI + 插件 + doctor 全绿） | 4 个新安装坑记录 |
| A18 | 11-09 | **B1 takeover 全流程真实闭环**：#7 coding 运行中→取上下文→确认后取消→本机实现（16/16 测试过）→PAT 推分支→PR #1 建立→resume 复活流水线 | PR merge_requests/1 |
| A19 | 11-09 | S1-S9 自然语言场景套件执行：歧义确认/needs-discussion 澄清闭环/redispatch 解锁/确认纪律全过 | 会话 ses_e3f3c12d |

## B. 待办事件

### B1. 端云协同闭环（两条「最后一公里」）

| 事件 | 阻塞点 | 需要什么 | 预计 |
|------|--------|---------|------|
| ~~takeover 全流程实测~~ **✅ 11-09 完成**（A18）：制造 running 任务（澄清+redispatch）→取上下文→确认取消→本机实现→回推 PR | — | — | 已闭环 |
| worker 接入端到端（认领→执行→上报） | eng-0002 已是现网 worker，不能重复接 | 一台干净机器 SSH | 1h |

### B2. agent 适配扩展

| 事件 | 阻塞点 | 需要什么 | 预计 |
|------|--------|---------|------|
| codearts（码道）适配+实测 | 无测试环境；CLI 形态需按原生 MCP 格式写配置 | 码道 web 工作区 / CLI 环境 | 0.5-1 天 |
| officeace 适配 | 无接入规范、无测试实例 | 官方插件/MCP 文档 + 测试账号 | 0.5-1 天 |
| claude code 点亮 | opengw 无 Anthropic 协议端点 | 支持 /v1/messages 的网关 | 端点就绪后 0.5 天 |

### B3. 写链路补测

| 事件 | 说明 | 预计 |
|------|------|------|
| start_issue / confirm_done 实测 | 在评测载体上执行（避免干扰现网） | 0.5h |
| create_project 实测 | 建一个 eval 项目验证模板链路，用完删 | 0.5h |

### B4. 工程增强

| 事件 | 说明 | 预计 |
|------|------|------|
| 高频工具原生化 HTTP | trigger/wait/status 去 CLI 冷启动（~200ms/次） | 1 周 |
| sweep 升级契约驱动自动发现 | 防 2.2.0→2.3.0 契约漂移下人肉清单漏测 | 3 天 |
| grape 插件市场上架 grape-kit | 复用插件市场上传/凭据/L0 校验链路 | 0.5 天 |
| dsh 侧工具语义同步 | grape-dsh 33 工具与 kit 31 工具的语义对齐维护约定 | 0.5 天 |

### B5. 阻塞项（等外部/等用户）

| 事件 | 等什么 |
|------|--------|
| F7 披露 | **✅ 已提交 issue #1772**（公开渠道，敏感明细不入 issue）；修复上线后复验（1 条命令） |
| gitcode 仓 Transfer 到 grape-dev org | **已提交建仓请求 issue #1773**，等 owner 处理 |
| 凭据轮换 | 用户 Revoke npm/GitCode/grape_ 旧 token，新 token 回填本机+ECS |
| 待合入通知需求 #1211 等 16+ 条 | grape 插件开发流水线（独立监控） |

## C. 节奏规划

| 时间窗 | 事件 |
|--------|------|
| 本周 | B3 写链路补测（0.5 天）→ F7 披露跟进 → 抓引擎空窗补 B1 takeover |
| 下周 | B1 worker 接入（等机器）→ B2 codearts 适配（等环境）→ B4 原生化启动 |
| 月内 | B4 全部完成 + officeace/claude 视资源点亮 + 市场上架 + 向 grape-dev org 归位 |

## D. 关键链接

| 项 | 地址 |
|----|------|
| npm 包 | https://www.npmjs.com/package/@grape-dev/grape-kit |
| 源码仓（私，待转 org） | https://gitcode.com/qq_44826240/grape-kit |
| 设计文档 | https://devkit-docs-pub-20261030.obs.cn-north-4.myhuaweicloud.com/plans/20261102-grape-plugin-analysis.html |
| 多 agent 测试矩阵报告 | https://devkit-docs-pub-20261030.obs.cn-north-4.myhuaweicloud.com/plans/20261108-grape-kit-agent-matrix.html |
| 新机器使用指南 | /home/zhangranran/tmp/grape-kit-使用指南-2026-11-09.md |
| grape 官网 / grape-dsh / grape-cli | https://www.grapedev.cn/ · gitcode.com/grape-dev/grape-dsh · gitcode.com/grape-dev/grape-cli |
