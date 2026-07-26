/**
 * Test an MCP server before attaching it — launch it, do the MCP initialize
 * handshake, and list its tools. Makes the "does this server actually work?"
 * question deterministic instead of finding out only after an agent rebuild.
 *
 * Runs in the Electron main process on the same machine as the manager, so
 * npx/uvx resolve the same way the agent's spawn would. stdio is fully
 * supported (the common case); http does a best-effort initialize POST.
 */

import crossSpawn from 'cross-spawn';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { McpServerSpec } from '../../../idctl/src/api/client.ts';
import {
  executableCandidatePaths,
  executableRequiresShell,
} from '../shared/subscriptionPortability.ts';

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  serverInfo?: { name?: string; version?: string };
  error?: string;
}

export interface McpStdioLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  pathDelimiter?: string;
}

export interface McpStdioLaunch {
  command: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

function mcpCliDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  pathDelimiter: string,
): string[] {
  const platformDirs = platform === 'win32'
    ? [
        env.APPDATA ? join(env.APPDATA, 'npm') : undefined,
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
        env.ProgramFiles ? join(env.ProgramFiles, 'nodejs') : undefined,
        env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'nodejs') : undefined,
        env.NVM_HOME,
        env.NVM_SYMLINK,
      ]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return Array.from(new Set([
    ...platformDirs,
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    env.PNPM_HOME,
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : join(home, '.volta', 'bin'),
    ...(env.PATH ? env.PATH.split(pathDelimiter) : []),
  ].filter((value): value is string => Boolean(value))));
}

function resolveMcpExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  directories: string[],
): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }
  for (const directory of directories) {
    const found = executableCandidatePaths(directory, command, {
      platform,
      pathExt: env.PATHEXT,
    }).find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return command;
}

/** Resolve stdio MCP commands using the host PATH/PATHEXT before spawning. */
export function resolveMcpStdioLaunch(
  command: string,
  specEnv: Record<string, string> = {},
  options: McpStdioLaunchOptions = {},
): McpStdioLaunch {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const pathDelimiter = options.pathDelimiter ?? delimiter;
  const env = { ...(options.env ?? process.env), ...specEnv };
  const directories = mcpCliDirectories(env, platform, home, pathDelimiter);
  env.PATH = directories.join(pathDelimiter);
  const executable = resolveMcpExecutable(command, env, platform, directories);
  return {
    command: executable,
    env,
    shell: executableRequiresShell(executable, platform),
  };
}

function testStdio(spec: McpServerSpec, timeoutMs: number): Promise<McpTestResult> {
  return new Promise((resolve) => {
    if (!spec.command) return resolve({ ok: false, error: 'stdio server needs a command' });
    let child;
    try {
      const launch = resolveMcpStdioLaunch(spec.command, spec.env);
      child = crossSpawn(launch.command, spec.args ?? [], {
        env: launch.env,
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
