#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrainMcpServer } from './mcp/server.mjs';

async function main() {
  const server = createBrainMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const baseUrl = process.env.BRAIN_MCP_BASE_URL ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 4200}`;
  console.error(`brain-mcp listening on stdio for ${baseUrl}`);
}

main().catch((error) => {
  console.error('brain-mcp failed:', error);
  process.exit(1);
});
