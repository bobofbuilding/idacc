#!/usr/bin/env node
/**
 * IDACC coordination MCP server.
 *
 * This process never receives the Manager administrator credential or a
 * Manager port. It is a stateless stdio adapter for the app-owned coordination
 * broker. The broker exposes only the ordinary, audited coordination methods
 * listed below and remains the sole holder of Manager authority.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const SESSION_FILE = String(process.env.IDACC_COORDINATION_SESSION_FILE || '').trim();
const SESSION_LIMIT = 16 * 1024;

const TOOLS = [
  {
    name: 'idacc_manager_health',
    description: 'Read IDACC Manager, team, and managed-agent health through the app-owned coordination boundary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'idacc_project_catalog',
    description: 'List the active IDACC project routing catalog without exposing local project paths or credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional project status filter.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'idacc_catalog',
    description: 'List live IDACC agents and their advertised routing catalogs, availability, skills, and constraints.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Optional exact team name.' },
        status: { type: 'string', description: 'Optional exact agent status.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'idacc_inter_agent',
    description: 'Send ordinary work to one managed IDACC agent, or poll a previously returned query ID.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { enum: ['send', 'poll'] },
        team: { type: 'string', description: 'Exact team name.' },
        agent: { type: 'string', description: 'Exact live agent name for send.' },
        message: { type: 'string', description: 'Bounded work request for send.' },
        queryId: { type: 'string', description: 'Query ID for poll.' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'idacc_task_discipline',
    description: 'Read auditable IDACC task state and durable deliverables, or run bounded reconciliation/evidence audit on existing tasks.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { enum: ['list', 'context', 'reconcile', 'audit-evidence'] },
        team: { type: 'string' },
        projectId: { type: 'string' },
        status: { type: 'string' },
        refs: { type: 'array', maxItems: 50, items: { type: 'string' } },
        ref: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'idacc_team_coordinator',
    description: 'Discover IDACC team leads or delegate a bounded objective through the app-owned Work workflow.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { enum: ['list-leads', 'delegate'] },
        objective: { type: 'string' },
        teams: { type: 'array', maxItems: 32, items: { type: 'string' } },
        currentTeam: { type: 'string' },
        primaryLead: { type: 'string' },
        projectId: { type: 'string' },
        planId: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
];

function session() {
  if (!SESSION_FILE || !isAbsolute(SESSION_FILE)) return null;
  try {
    const raw = readFileSync(SESSION_FILE, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > SESSION_LIMIT) return null;
    const parsed = JSON.parse(raw);
    const url = new URL(String(parsed?.url || ''));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return null;
    const token = String(parsed?.token || '');
    if (!/^[0-9a-f]{48}$/.test(token)) return null;
    return { url: url.origin, token };
  } catch {
    return null;
  }
}

async function callBroker(name, args) {
  const current = session();
  if (!current) {
    return {
      ok: false,
      blocked: true,
      reason: 'app_not_running',
      message: 'IDACC coordination is unavailable. Open ID Agents Control Center, then start a new Codex task if this server was just installed.',
    };
  }
  try {
    const response = await fetch(`${current.url}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${current.token}`,
      },
      body: JSON.stringify({ name, arguments: args || {} }),
      signal: AbortSignal.timeout(65_000),
    });
    const result = await response.json();
    if (!response.ok) {
      return {
        ok: false,
        blocked: true,
        reason: result?.reason || `broker_http_${response.status}`,
        message: result?.message || result?.error || 'IDACC rejected the coordination request.',
      };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      reason: 'broker_unreachable',
      message: `Could not reach the IDACC coordination broker: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value && typeof value === 'object' ? value : { result: value },
    isError: value?.ok === false && value?.blocked !== true,
  };
}

async function handle(message) {
  const { id, method, params } = message || {};
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'idacc-coordination', version: '1.0.0' },
      instructions: 'Use these tools only for ordinary IDACC project, catalog, task, delegation, and health workflows. The IDACC app remains the sole owner of Manager administration, models, runtimes, credentials, processes, and team configuration. Prefer exact project/task/team identifiers and preserve one-live-task-per-agent discipline.',
    });
    return;
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name || '');
    if (!TOOLS.some((tool) => tool.name === name)) {
      reply(id, toolResult({ ok: false, error: `Unknown IDACC coordination tool: ${name}` }));
      return;
    }
    reply(id, toolResult(await callBroker(name, params?.arguments || {})));
    return;
  }
  if (typeof id !== 'undefined') {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      // Invalid JSON-RPC input is ignored without exposing local state.
    }
  }
});
