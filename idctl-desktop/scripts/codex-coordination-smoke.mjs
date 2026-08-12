#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');
const serverPath = join(desktopRoot, 'resources', 'idacc-coordination-mcp', 'server.mjs');
const bridgePath = join(desktopRoot, 'src', 'main', 'codexCoordination.ts');
const mainPath = join(desktopRoot, 'src', 'main', 'main.ts');
const packagePath = join(desktopRoot, 'package.json');
const bridgeSource = readFileSync(bridgePath, 'utf8');
const mainSource = readFileSync(mainPath, 'utf8');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));

assert.match(bridgeSource, /ensurePrivateAppDirectory/);
assert.match(bridgeSource, /writePrivateAppTextFileAtomic/);
assert.match(bridgeSource, /timingSafeEqual/);
assert.match(bridgeSource, /IDACC_COORDINATION_MANAGED/);
assert.match(bridgeSource, /A user-owned Codex MCP server already uses the idacc-coordination name/);
assert.doesNotMatch(bridgeSource, /IDACC_MANAGER_AGENT_TOKEN|X-Id-Admin/);
assert.match(mainSource, /startCodexCoordinationBroker\(bridgeCall\)/);
assert.match(mainSource, /stopCodexCoordinationBroker\(\)/);
assert.equal(packageJson.scripts['test:codex-coordination'], 'node scripts/codex-coordination-smoke.mjs');
assert.ok(packageJson.build.extraResources.some((entry) => (
  entry.from === 'resources/idacc-coordination-mcp'
  && entry.to === 'idacc-coordination-mcp'
)));

const scratch = mkdtempSync(join(tmpdir(), 'idacc-codex-coordination-'));
const sessionFile = join(scratch, 'session.json');
const token = 'a'.repeat(48);
const observations = [];

async function startBroker(label) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    observations.push({ label, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, broker: label, tool: body.name }));
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

const first = await startBroker('first');
const second = await startBroker('second');
writeFileSync(sessionFile, JSON.stringify({ url: first.url, token }), { mode: 0o600 });

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, IDACC_COORDINATION_SESSION_FILE: sessionFile },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
let stdout = '';
let stderr = '';
const replies = new Map();
const waiters = new Map();
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter.resolve(message);
    } else {
      replies.set(message.id, message);
    }
  }
});

function request(id, method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const existing = replies.get(id);
  if (existing) {
    replies.delete(id);
    return Promise.resolve(existing);
  }
  return new Promise((resolveReply, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`MCP reply timed out for ${method}: ${stderr}`));
    }, 5_000);
    waiters.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolveReply(message);
      },
    });
  });
}

try {
  const initialized = await request(1, 'initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'idacc-coordination');
  assert.match(initialized.result.instructions, /app remains the sole owner of Manager administration/i);

  const listed = await request(2, 'tools/list');
  const tools = listed.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'idacc_manager_health',
    'idacc_project_catalog',
    'idacc_catalog',
    'idacc_inter_agent',
    'idacc_task_discipline',
    'idacc_team_coordinator',
  ]);
  assert.equal(tools.find((tool) => tool.name === 'idacc_catalog').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'idacc_team_coordinator').annotations.readOnlyHint, false);

  const firstCall = await request(3, 'tools/call', {
    name: 'idacc_manager_health',
    arguments: {},
  });
  assert.equal(firstCall.result.structuredContent.broker, 'first');
  assert.equal(observations[0].authorization, `Bearer ${token}`);
  assert.equal(observations[0].body.name, 'idacc_manager_health');

  // A long-lived Codex MCP process must follow the current app session after an
  // IDACC restart/profile switch instead of retaining a stale random port.
  writeFileSync(sessionFile, JSON.stringify({ url: second.url, token }), { mode: 0o600 });
  const secondCall = await request(4, 'tools/call', {
    name: 'idacc_catalog',
    arguments: { team: 'default' },
  });
  assert.equal(secondCall.result.structuredContent.broker, 'second');
  assert.equal(observations[1].label, 'second');
  assert.deepEqual(observations[1].body, {
    name: 'idacc_catalog',
    arguments: { team: 'default' },
  });
} finally {
  child.kill('SIGTERM');
  await Promise.all([first.close(), second.close()]);
  rmSync(scratch, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, tools: 6, brokerCalls: observations.length }));
