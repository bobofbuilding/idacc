import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBrainHttpClient } from './http-client.mjs';
import { BRAIN_MCP_TOOL_NAMES, registerBrainMcpTools } from './tools.mjs';

const DEFAULT_BASE_URL = (process.env.BRAIN_MCP_BASE_URL ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 4200}`)
  .replace(/\/+$/, '');

export function createBrainMcpServer({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const server = new McpServer({
    name: 'brain-mcp',
    version: '0.1.0',
  });
  const client = createBrainHttpClient({ baseUrl, fetchImpl });
  registerBrainMcpTools(server, { client });
  return server;
}

export { BRAIN_MCP_TOOL_NAMES };
