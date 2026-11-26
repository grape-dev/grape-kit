# 安装与凭据（atomcode 环境）

## 第一步：安装 grape-kit MCP

**方式 A（推荐）**：让 Agent / 终端执行

```bash
npx -y -p @grape-dev/grape-kit grape-kit install --target atomcode
```

安装器自动检测 atomcode 环境，写入 MCP 配置并备份原文件，完成后输出三步上手引导。

**方式 B（手动兜底）**：编辑 `~/.atomcode/mcp.json`，把下面条目**合并**进已有 `mcpServers` 对象（禁止整文件覆盖，先备份）：

```json
{
  "mcpServers": {
    "grape-kit": {
      "command": "npx",
      "args": ["-y", "-p", "@grape-dev/grape-kit", "grape-kit-mcp"],
      "env": {
        "GRAPE_API_TOKEN": "<你的 token>",
        "GRAPE_BASE_URL": "https://www.grapedev.cn"
      }
    }
  }
}
```

装完重启 atomcode，在 MCP 面板确认 `grape-kit` 已加载（应显示 grape_* 系列工具）。

## 第二步：获取凭据

1. 登录 Grape 平台（www.grapedev.cn）→ 账号设置 / 资料页（`https://www.grapedev.cn/app/#account/profile`）。
2. 创建或复制用户级 API Token（`grape_` 前缀）。
3. 把 token 写入上面的 `env.GRAPE_API_TOKEN`（或系统环境变量后重启宿主）。

## 凭据纪律

- token 只存本机配置文件，不写进对话、不提交进任何仓库。
- 凭据过期表现为 401：到账号资料页重新生成，替换 env 值后重启宿主即可。
- `GRAPE_API_TOKEN` 为用户级权限；遇到 403 的会话级端点（tk_ 专属）属预期边界，不要重试、不要升级请求。

## 自检

```bash
npx -y -p @grape-dev/grape-kit grape-kit doctor --probe
```

`doctor` 会检查：Node 版本（≥20）、token 有效性、MCP 握手、更新提示。全部通过即可开始使用本技能。
