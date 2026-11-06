#!/usr/bin/env node
/** stdio 入口：node grape-kit-mcp.mjs */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './src/server.mjs'

const server = createServer()
await server.connect(new StdioServerTransport())
