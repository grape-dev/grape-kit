# grape-kit · AtomCode 插件

Grape DevOps 流水线遥控插件：触发/跟踪多 agent 流水线（vod→issue→coding→qa→sre）、issue 全周期管理、把云端运行中的任务**接管到本地 atomcode 会话**（接管后改码、两阶段交回，链不断）。

## 组成

- **MCP server**：`mcp.json` 声明 `@grape-dev/grape-kit`（npx stdio，50 工具）。**实测（atomcode 5.2.8）插件内 mcp.json 不自动注册**，装完插件后执行下面一条命令注册（也写进了手动兜底）：
  ```bash
  atomcode mcp add --global grape-kit npx -- -y -p @grape-dev/grape-kit grape-kit-mcp
  ```
- **skill**：`skills/grape-remote/` 教模型「什么时候、怎么调用 grape 工具」（遥控纪律、接管两阶段、工具速查）。
- **commands**：`/grape-status` 快捷口令。

## 凭据（必填一次）

```bash
export GRAPE_API_TOKEN=grape_xxx   # www.grapedev.cn 账号资料页创建；或写 ~/.atomcode/config 内 env
```

未配置时 401；详细纪律见 skills/grape-remote/references/install-and-auth.md。

## 手动合并 MCP（兜底路径）

```bash
npx -y @grape-dev/grape-kit install --target atomcode
# 写 ~/.atomcode/mcp.json（合并保留已有条目+备份），重启 atomcode 会话
```

## 自检

```bash
npx -y @grape-dev/grape-kit doctor --target atomcode --probe
```
