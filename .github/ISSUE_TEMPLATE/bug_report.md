---
name: Bug 报告
about: 报告 grape-kit 的缺陷（请先跑 doctor / smoke 自检）
title: "[bug] "
labels: bug
---

## 环境

- grape-kit 版本（`grape-kit --version`）：
- Node 版本：
- 宿主 Agent（opencode / CodeArts / WorkBuddy / hermes / 其他）：
- 操作系统：
- 连接方式（原生 HTTP 直连 / grape CLI 回退）：

## 复现步骤

1.
2.
3.

## 期望 vs 实际

- 期望：
- 实际：

## 相关输出

粘贴前请**打码 token 与实例地址**。

```
（日志 / 报错 / 渲染结果）
```

## 已尝试的自检

- [ ] `npm run smoke`（50 tools 是否全通过）
0c1ec3f (feat(#31): git 写回受控工具（换券+GIT_ASKPASS）与 coding 交回校验（工具面 39→41）)
- [ ] `grape-kit doctor`
- [ ] 确认凭据走环境变量 `GRAPE_API_TOKEN`，未写死在任何配置文件
- [ ] 已在最新版本上复现（`npm i -g @grape-dev/grape-kit@latest`）
