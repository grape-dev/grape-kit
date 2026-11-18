#!/usr/bin/env node
/** stdio 入口：node grape-kit-mcp.mjs */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './src/server.mjs'
import { checkUpdate } from './src/update-check.mjs'
import { readFileSync } from 'node:fs'

const server = createServer()
await server.connect(new StdioServerTransport())

// check_update：启动后异步比对 npm registry latest，旧版仅 stderr 一次性提醒（24h 缓存，失败静默）
try {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))
  const upd = await checkUpdate(version)
  if (upd && upd.latest) {
    process.stderr.write(`[grape-kit] 有新版本：${version} → ${upd.latest}（npm i -g @grape-dev/grape-kit 更新；GRAPE_KIT_SKIP_UPDATE_CHECK=1 关闭提醒）\n`)
  }
} catch { /* 版本检查绝不影响工具可用性 */ }
