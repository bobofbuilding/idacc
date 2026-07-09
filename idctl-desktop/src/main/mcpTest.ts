/**
 * Test an MCP server before attaching it — launch it, do the MCP initialize
 * handshake, and list its tools. Makes the "does this server actually work?"
 * question deterministic instead of finding out only after an agent rebuild.
 *
 * Runs in the Electron main process on the same machine as the manager, so
 * npx/uvx resolve the same way the agent's spawn would. stdio is fully
 * supported (the common case); http does a best-effort initialize POST.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { McpServerSpec } from '../../../idctl/src/api/client.ts';

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

function cliPath(): string {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  const existing = process.env.PATH ? process.env.PATH.split(':') : [];
  return [...dirs, ...existing].join(':');
}

function testStdio(spec: McpServerSpec, timeoutMs: number): Promise<McpTestResult> {
  return new Promise((resolve) => {
    if (!spec.command) return resolve({ ok: false, error: 'stdio server needs a command' });
    let child;
    try {
      child = spawn(spec.command, spec.args ?? [], {
        env: { ...process.env, ...(spec.env ?? {}), PATH: cliPath() },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    let buf = '';
    let stderr = '';
    let done = false;
    let serverInfo: McpTestResult['serverInfo'];
    const finish = (r: McpTestResult) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(r);
    };
    const send = (o: unknown) => { try { child.stdin?.write(JSON.stringify(o) + '\n'); } catch { /* ignore */ } };
    child.stdout?.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[]; serverInfo?: { name?: string; version?: string } }; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: msg.error.message ?? 'initialize failed' });
          serverInfo = msg.result?.serverInfo;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        }
        if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, error: msg.error.message ?? 'tools/list failed' });
          finish({ ok: true, tools: (msg.result?.tools ?? []).map((t) => t.name), serverInfo });
        }
      }
    });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      const command = spec.command ?? 'MCP command';
      const message = e.code === 'ENOENT'
        ? `command not found: ${command}. Install it or edit this MCP server to use an absolute command path.`
        : e.message;
      finish({ ok: false, error: message });
    });
    child.on('exit', (code) => {
      if (!done) finish({ ok: false, error: `server exited (code ${code})${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` });
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idctl', version: '1' } } });
    setTimeout(() => finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s (first run may download the package — try again)` }), timeoutMs);
  });
}

async function testHttp(spec: McpServerSpec): Promise<McpTestResult> {
  if (!spec.url) return { ok: false, error: 'http server needs a url' };
  try {
    const res = await fetch(spec.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(spec.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idctl', version: '1' } } }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `${res.status} — reachable, auth rejected (check headers)` };
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    return { ok: true, tools: [], error: 'reachable (full tool list requires a streaming client)' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function testMcpServer(spec: McpServerSpec): Promise<McpTestResult> {
  const transport = spec.transport ?? 'stdio';
  if (transport === 'stdio') return testStdio(spec, 45000);
  if (transport === 'http') return testHttp(spec);
  return { ok: false, error: 'Test supports stdio (and basic http); sse is verified at runtime.' };
}
