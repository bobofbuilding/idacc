import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtMain = join(desktop, 'out', 'main', 'main.cjs');
const electron = electronPath;
assert.equal(existsSync(builtMain), true, 'build the desktop app before running this integration smoke');
assert.equal(existsSync(electron), true, 'Electron is not installed');

// Spaces are intentional: staged MCP argv must remain one absolute argument.
const scratch = mkdtempSync(join(tmpdir(), 'idacc supervisor integration '));
const runtime = join(scratch, 'runtime');
const profile = join(scratch, 'profile');
const registeredProject = join(profile, 'workspace', 'projects', 'consumer project, one');
const selftestResult = join(profile, 'stack-selftest-result.json');
const managerEntry = join(runtime, 'manager', 'dist', 'start-agent-manager.js');
const brainEntry = join(runtime, 'brain', 'brain.mjs');
const brainMcpEntry = join(runtime, 'brain', 'brain-mcp.mjs');
const brainListenerEntry = join(runtime, 'brain', 'brain-listener.mjs');
const brainCycleEntry = join(runtime, 'brain', 'brain-cycle.mjs');
const brainSkillEntry = join(runtime, 'manager', 'skills', 'brain', 'SKILL.md');
const managerConfigEntry = join(runtime, 'manager', 'configs', 'default.yaml');
mkdirSync(dirname(managerEntry), { recursive: true });
mkdirSync(dirname(brainEntry), { recursive: true });
mkdirSync(dirname(brainSkillEntry), { recursive: true });
mkdirSync(dirname(managerConfigEntry), { recursive: true });
mkdirSync(join(profile, 'config'), { recursive: true });
mkdirSync(registeredProject, { recursive: true });
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'config', 'config.json'), JSON.stringify({
  version: 1,
  managers: [],
  providers: [],
  projects: [{
    id: 'consumer-project-one',
    name: 'Consumer project one',
    status: 'active',
    path: registeredProject,
    createdAt: 1,
    updatedAt: 1,
  }],
}, null, 2), { mode: 0o600 });
writeFileSync(brainSkillEntry, `---
name: brain
description: Read the profile-owned Brain through its curated MCP tools.
---

# Brain
`, { mode: 0o600 });
writeFileSync(managerConfigEntry, 'defaults: {}\nagents: []\n', { mode: 0o600 });

const managerCapabilities = {
  cc_api_version: 5,
  extension: 'id-agents-control-center',
  features: [
    'observability',
    'manager-controls',
    'runtime-preflight',
    'agent-config',
    'team-config',
    'library',
    'brain-context',
    'brain-control',
    'control-events',
    'control-state',
    'stalled-sweep',
  ],
  routes: [
    ['GET', '/capabilities', 'core'],
    ['POST', '/control/brain', 'brain-control'],
    ['POST', '/control-event', 'control-events'],
    ['GET', '/control/state/:scope', 'control-state'],
    ['GET', '/control/state/:scope/:key', 'control-state'],
    ['POST', '/control/state/:scope/:key', 'control-state'],
    ['DELETE', '/control/state/:scope/:key', 'control-state'],
    ['POST', '/control/memory', 'brain-control'],
    ['GET', '/activity', 'observability'],
    ['POST', '/activity/record', 'observability'],
    ['GET', '/usage', 'observability'],
    ['POST', '/usage/record', 'observability'],
    ['GET', '/usage/by-task', 'observability'],
    ['GET', '/agents/:id/queries/active', 'observability'],
    ['POST', '/runtime/preflight', 'manager-controls'],
    ['GET', '/manager/local-concurrency', 'manager-controls'],
    ['POST', '/manager/local-concurrency', 'manager-controls'],
    ['GET', '/agents/:id/instructions', 'agent-config'],
    ['POST', '/agents/:id/instructions', 'agent-config'],
    ['POST', '/agents/:id/runtime', 'agent-config'],
    ['POST', '/agents/:id/mcp', 'agent-config'],
    ['POST', '/agents/:id/delegates', 'agent-config'],
    ['POST', '/agents/:id/team', 'agent-config'],
    ['POST', '/agents/:id/metadata', 'agent-config'],
    ['GET', '/teams/:name/config', 'team-config'],
    ['POST', '/teams/:name/delegates', 'team-config'],
    ['GET', '/library/plugins', 'library'],
    ['POST', '/library/skills/install', 'library'],
  ].map(([method, path, group]) => ({ method, path, group })),
};

const managerSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const marker = join(process.env.IDACC_DATA_DIR, 'manager-attempts.txt');
let attempt = 0;
try { attempt = Number(readFileSync(marker, 'utf8')) || 0; } catch {}
attempt += 1;
writeFileSync(marker, String(attempt));
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-brain-token.txt'), process.env.BRAIN_TOKEN || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-admin-token.txt'), process.env.IDACC_ADMIN_TOKEN || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-library-root.txt'), process.env.ID_LIBRARY_ROOT || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-plugins-root.txt'), process.env.ID_PLUGINS_ROOT || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-agent-log-root.txt'), process.env.IDACC_AGENT_LOG_DIR || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-mcp-command.txt'), process.env.BRAIN_MCP_COMMAND || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-mcp-args-json.txt'), process.env.BRAIN_MCP_ARGS_JSON || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-database-url.txt'), process.env.DATABASE_URL || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-sqlite-path.txt'), process.env.SQLITE_PATH || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-workspace-path.txt'), process.env.AGENT_MANAGER_WORKDIR || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-shared-workspace-path.txt'), process.env.ID_WORKSPACE_DIR || '');
if (attempt < 3 && process.env.IDACC_TEST_SKIP_STARTUP_CRASHES !== '1') {
  console.error('intentional manager startup crash ' + attempt);
  process.exit(23);
}
let mcpChild = null;
let mcpAttached = false;
let mcpRead = false;
async function probeBrainMcp() {
  try {
    const command = process.env.BRAIN_MCP_COMMAND;
    const args = JSON.parse(process.env.BRAIN_MCP_ARGS_JSON || '[]');
    if (!command || !Array.isArray(args) || args.length !== 1) throw new Error('invalid Brain MCP launch contract');
    mcpChild = spawn(command, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        BRAIN_MCP_BASE_URL: process.env.BRAIN_URL,
        BRAIN_TOKEN: process.env.BRAIN_TOKEN,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-mcp-electron-node.txt'), '1');
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    mcpChild.stdout.setEncoding('utf8');
    mcpChild.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\\n')) {
        const index = buffer.indexOf('\\n');
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id != null && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message || 'MCP error'));
          else entry.resolve(message.result);
        }
      }
    });
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, 5000).unref();
    });
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'idacc-integration', version: '1.0.0' },
    });
    mcpChild.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
    const listed = await request('tools/list');
    const read = await request('tools/call', { name: 'brain_read_skills', arguments: {} });
    mcpAttached = Array.isArray(listed.tools) && listed.tools.some(tool => tool.name === 'brain_read_skills');
    const text = read.content?.find(part => part.type === 'text')?.text || '';
    const parsed = JSON.parse(text);
    mcpRead = parsed?.data?.nodes?.some(node => node.skillId === 'brain') === true;
    writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-mcp-result.json'), JSON.stringify({
      mcpAttached,
      mcpRead,
      command,
      args,
      electronRunAsNode: '1',
    }));
  } catch (error) {
    writeFileSync(join(process.env.IDACC_DATA_DIR, 'manager-mcp-error.txt'), error?.stack || String(error));
  }
}
const port = Number(process.env.AGENT_MANAGER_PORT);
const capabilities = ${JSON.stringify(managerCapabilities)};
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      status: 'ok',
      service: process.env.IDACC_SERVICE_ID,
      runtimeVersion: process.env.IDACC_RUNTIME_VERSION,
      instanceNonce: process.env.IDACC_INSTANCE_NONCE,
      protocolVersion: 'idacc.health.v1',
      agents: 0,
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/capabilities') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(capabilities));
    return;
  }
  if (req.url?.startsWith('/events')) {
    const since = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('since') || 0);
    const events = since < 1 ? [{
      seq: 1,
      team: 'default',
      topic: 'task:done',
      actor: 'coder',
      subject: 'task:consumer-integration',
      data: { title: 'Consumer integration', result: 'completed' },
    }] : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ events }));
    return;
  }
  if (req.url === '/teams') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ teams: [{ name: 'default' }] }));
    return;
  }
  if (req.url?.startsWith('/agents')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      agents: [{
        id: 'agent_coder',
        name: 'coder',
        status: 'running',
        metadata: { skills: ['brain'] },
        brainTools: { skillInstalled: true, mcpAttached, activeToolAccess: mcpAttached },
      }],
    }));
    return;
  }
  if (req.url === '/control/brain') {
    const authorized = req.headers['x-id-admin'] === '1'
      && req.headers.authorization === 'Bearer ' + (process.env.IDACC_ADMIN_TOKEN || '');
    if (!authorized) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'admin bearer required' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      body: {
        ok: true,
        routeInventory: { skew: false, missing: [] },
        sqliteVec: { available: true, degraded: false },
      },
      cacheControl: 'no-store',
      noStore: true,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1', () => setTimeout(() => void probeBrainMcp(), 250));
process.on('SIGTERM', () => {
  try { mcpChild?.kill('SIGTERM'); } catch {}
  server.close(() => process.exit(0));
});
`;

const brainSource = `
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-token.txt'), process.env.BRAIN_TOKEN || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-admin-token.txt'), process.env.IDACC_ADMIN_TOKEN || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-skills-root.txt'), process.env.IDACC_SKILLS_DIR || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-onchain-sync.txt'), process.env.BRAIN_SYNC_ONCHAIN || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-onchain-script.txt'), process.env.BRAIN_SYNC_ONCHAIN_SCRIPT || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-embed-phase.txt'), process.env.BRAIN_EMBED_PHASE || '');
writeFileSync(join(process.env.IDACC_DATA_DIR, 'brain-sqlite-extension.txt'), process.env.BRAIN_SQLITE_VEC_EXTENSION || '');
const ingestFile = join(process.env.IDACC_DATA_DIR, 'brain-listener-ingest.json');
const readIngest = () => {
  try { return JSON.parse(readFileSync(ingestFile, 'utf8')); }
  catch { return { requests: 0, eventIds: [] }; }
};
const body = req => new Promise((resolve, reject) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); }
  });
  req.on('error', reject);
});
const port = Number(process.env.BRAIN_PORT);
const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      service: process.env.IDACC_SERVICE_ID,
      runtimeVersion: process.env.IDACC_RUNTIME_VERSION,
      instanceNonce: process.env.IDACC_INSTANCE_NONCE,
      protocolVersion: 'idacc.health.v1',
      nodes: 0,
      edges: 0,
    }));
    return;
  }
  const authorized = req.headers.authorization === 'Bearer ' + (process.env.BRAIN_TOKEN || '');
  if (!authorized) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: 'Brain bearer required' }));
    return;
  }
  if (req.url?.startsWith('/skills/index')) {
    const root = process.env.IDACC_SKILLS_DIR || '';
    const nodes = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, 'SKILL.md')))
          .map(entry => ({ skillId: entry.name, name: entry.name }))
      : [];
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      data: {
        nodes,
        summary: { idaccCatalogSkills: nodes.length },
      },
      meta: {
        source: {
          authority: 'idacc-library',
          idaccLibraryRows: nodes.length,
        },
      },
    }));
    return;
  }
  if (req.method === 'POST' && req.url === '/listener-ingest') {
    const event = await body(req);
    const current = readIngest();
    current.requests += 1;
    if (!current.eventIds.includes(event.seq)) current.eventIds.push(event.seq);
    writeFileSync(ingestFile, JSON.stringify(current), { mode: 0o600 });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

const brainMcpSource = `
import { createInterface } from 'node:readline';
const reply = message => process.stdout.write(JSON.stringify(message) + '\\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.id == null) return;
  if (request.method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'brain', version: '1.0.0' },
      },
    });
    return;
  }
  if (request.method === 'tools/list') {
    reply({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'brain_read_skills',
          description: 'Read the profile-owned Brain skill catalog',
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'brain_read_skills') {
    try {
      const response = await fetch((process.env.BRAIN_MCP_BASE_URL || '') + '/skills/index?limit=200', {
        headers: { authorization: 'Bearer ' + (process.env.BRAIN_TOKEN || '') },
      });
      const data = await response.json();
      reply({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: JSON.stringify(data) }] },
      });
    } catch (error) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(error) } });
    }
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } });
});
`;

const brainListenerSource = `
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.IDACC_DATA_DIR;
const attemptsPath = join(root, 'brain-listener-attempts.txt');
let attempts = 0;
try { attempts = Number(readFileSync(attemptsPath, 'utf8')) || 0; } catch {}
attempts += 1;
writeFileSync(attemptsPath, String(attempts), { mode: 0o600 });
writeFileSync(join(root, 'brain-listener-admin-token.txt'), process.env.IDACC_ADMIN_TOKEN || '', { mode: 0o600 });
const cursorPath = process.env.BRAIN_LISTENER_CURSOR_FILE;
const statusPath = process.env.BRAIN_LISTENER_STATUS_FILE;
const statusNonce = process.env.BRAIN_LISTENER_INSTANCE_NONCE || '';
const statusMode = process.env.IDACC_TEST_LISTENER_STATUS_MODE || 'valid';
let cursor = 0;
if (cursorPath && existsSync(cursorPath)) {
  cursor = Number(JSON.parse(readFileSync(cursorPath, 'utf8')).seq || 0);
}
const eventsResponse = await fetch(process.env.MANAGER_URL + '/events?since=' + cursor + '&limit=50', {
  headers: { 'X-Id-Team': process.env.ID_TEAM || 'default' },
});
const events = (await eventsResponse.json()).events || [];
for (const event of events) {
  const response = await fetch(process.env.BRAIN_URL + '/listener-ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (process.env.BRAIN_TOKEN || ''),
    },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error('listener ingest failed: ' + response.status);
  cursor = Math.max(cursor, Number(event.seq) || 0);
}
if (cursorPath) {
  writeFileSync(cursorPath, JSON.stringify({
    schemaVersion: 1,
    team: process.env.ID_TEAM || 'default',
    seq: cursor,
  }), { mode: 0o600 });
}
const publishStatus = () => {
  if (!statusPath || !statusNonce) throw new Error('listener readiness environment is missing');
  const temporary = statusPath + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify({
    schemaVersion: 1,
    instanceNonce: statusMode === 'wrong-nonce' ? 'wrong-listener-nonce' : statusNonce,
    pid: process.pid,
    primaryTeam: {
      id: process.env.ID_TEAM || 'default',
      name: process.env.ID_TEAM || 'default',
      active: true,
    },
    teamCount: 1,
    lastSuccessfulPollAt: new Date(
      Date.now() - (statusMode === 'stale' ? 60_000 : 0),
    ).toISOString(),
    cursors: [{
      id: process.env.ID_TEAM || 'default',
      name: process.env.ID_TEAM || 'default',
      seq: cursor,
    }],
  }), { mode: 0o600 });
  renameSync(temporary, statusPath);
  try { chmodSync(statusPath, 0o600); } catch {}
};
if (statusMode !== 'missing') publishStatus();
if (attempts === 1 && process.env.IDACC_TEST_SKIP_STARTUP_CRASHES !== '1') process.exit(23);
setInterval(() => {
  if (statusMode !== 'missing') publishStatus();
}, 2500);
process.on('SIGTERM', () => process.exit(0));
`;

const brainCycleSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.IDACC_DATA_DIR;
const statePath = join(root, 'brain-cycle-observation.json');
let state = { count: 0, active: 0, maxActive: 0, starts: [] };
try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
state.count += 1;
state.active += 1;
state.maxActive = Math.max(state.maxActive, state.active);
state.starts.push(Date.now());
state.environment = {
  plansDir: process.env.BRAIN_PLANS_DIR || '',
  repoDigest: process.env.BRAIN_CYCLE_REPO_DIGEST || '',
  repoPaths: process.env.BRAIN_CYCLE_REPO_PATHS || '',
  repoPathsJson: process.env.BRAIN_CYCLE_REPO_PATHS_JSON || '',
  workspaceDiscovery: process.env.BRAIN_CYCLE_DIGEST_WORKSPACE_REPOS || '',
  onchainSync: process.env.BRAIN_SYNC_ONCHAIN || '',
  onchainScript: process.env.BRAIN_SYNC_ONCHAIN_SCRIPT || '',
  embedPhase: process.env.BRAIN_EMBED_PHASE || '',
  consolidationTakes: process.env.BRAIN_CONSOLIDATION_TAKES || '',
  consolidationTeam: process.env.BRAIN_CONSOLIDATION_TEAM || '',
  sqliteExtension: process.env.BRAIN_SQLITE_VEC_EXTENSION || '',
};
writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
writeFileSync(join(root, 'brain-cycle-admin-token.txt'), process.env.IDACC_ADMIN_TOKEN || '', { mode: 0o600 });
setTimeout(() => {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.active -= 1;
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  process.exit(0);
}, 300);
`;

for (const [path, source] of [
  [managerEntry, managerSource],
  [brainEntry, brainSource],
  [brainMcpEntry, brainMcpSource],
  [brainListenerEntry, brainListenerSource],
  [brainCycleEntry, brainCycleSource],
]) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const runtimeFixtureFiles = [
  ['brain/brain.mjs', brainEntry],
  ['brain/brain-mcp.mjs', brainMcpEntry],
  ['brain/brain-listener.mjs', brainListenerEntry],
  ['brain/brain-cycle.mjs', brainCycleEntry],
  ['manager/dist/start-agent-manager.js', managerEntry],
  ['manager/skills/brain/SKILL.md', brainSkillEntry],
  ['manager/configs/default.yaml', managerConfigEntry],
];
const files = runtimeFixtureFiles.map(([path, absolute]) => ({
  path,
  type: 'file',
  size: statSync(absolute).size,
  sha256: sha256(readFileSync(absolute)),
})).sort((a, b) => a.path.localeCompare(b.path));

function treeHash(prefix = '') {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const lines = files
    .filter((record) => !normalizedPrefix || record.path.startsWith(normalizedPrefix))
    .map((record) => JSON.stringify({
      path: normalizedPrefix ? record.path.slice(normalizedPrefix.length) : record.path,
      type: record.type,
      size: record.size,
      sha256: record.sha256,
    }))
    .join('\n');
  return sha256(lines ? `${lines}\n` : '');
}

writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({
  schemaVersion: 2,
  generatedAt: '2026-07-25T00:00:00.000Z',
  application: {
    name: 'IDACC',
    version: '0.1.646',
    commit: '7'.repeat(40),
    tree: '8'.repeat(40),
    dirty: false,
  },
  components: {
    manager: {
      repository: 'https://example.invalid/manager.git',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      version: '1.2.3',
      packageLockSha256: '3'.repeat(64),
      entrypoint: 'dist/start-agent-manager.js',
      serviceId: 'idacc-manager',
    },
    brain: {
      repository: 'https://example.invalid/brain.git',
      commit: '4'.repeat(40),
      tree: '5'.repeat(40),
      version: '4.5.6',
      packageLockSha256: '6'.repeat(64),
      entrypoint: 'brain.mjs',
      serviceId: 'idacc-brain',
    },
  },
  trees: {
    manager: treeHash('manager'),
    brain: treeHash('brain'),
    runtime: treeHash(),
  },
  files,
}, null, 2));

function canBind(port) {
  return new Promise((resolveBind) => {
    const server = createServer();
    server.once('error', () => resolveBind(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolveBind(true));
    });
  });
}

try {
  const env = {
    ...process.env,
    IDACC_STACK_SELFTEST: '1',
    IDACC_STACK_CONTRACT_SELFTEST: '0',
    IDACC_STACK_AUTH_SELFTEST: '1',
    IDACC_STACK_SELFTEST_ENABLE_BRAIN_CYCLE: '1',
    IDACC_STACK_SELFTEST_CYCLE_OBSERVE_MS: '1200',
    IDACC_STACK_SELFTEST_RESULT_FILE: selftestResult,
    IDACC_STACK_RANDOM_PORTS: '1',
    IDACC_BRAIN_CYCLE_INITIAL_DELAY_MS: '25',
    IDACC_BRAIN_CYCLE_CADENCE_MS: '100',
    IDACC_RUNTIME_ROOT: runtime,
    IDACC_DATA_DIR: profile,
    IDACC_PROFILE: 'supervisor-integration',
    MANAGER_URL: '',
    BRAIN_URL: '',
    IDACC_BRAIN_URL: '',
    BRAIN_TOKEN: 'caller-token-must-not-be-reused',
    IDACC_ADMIN_TOKEN: 'caller-admin-token-must-not-be-reused',
    DATABASE_URL: 'postgres://hostile.invalid/embedded-state',
    BRAIN_PLANS_DIR: join(runtime, 'brain', 'plans'),
    BRAIN_CYCLE_REPO_DIGEST: '1',
    BRAIN_CYCLE_REPO_PATHS: join(runtime, 'brain'),
    BRAIN_CYCLE_REPO_PATHS_JSON: JSON.stringify([join(runtime, 'brain')]),
    BRAIN_CYCLE_DIGEST_WORKSPACE_REPOS: '1',
    BRAIN_EMBED_PHASE: '1',
    BRAIN_CONSOLIDATION_TAKES: '1',
    BRAIN_CONSOLIDATION_TEAM: 'hostile-team',
    BRAIN_SQLITE_VEC_EXTENSION: join(runtime, 'brain', 'hostile-vector-extension.node'),
    BRAIN_SYNC_ONCHAIN: 'true',
    BRAIN_SYNC_ONCHAIN_SCRIPT: join(runtime, 'brain', 'sync-onchain.mjs'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, ['.'], {
    cwd: desktop,
    env,
    encoding: 'utf8',
    timeout: 40_000,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `stack selftest failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  const line = String(result.stdout)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('IDACC_STACK_SELFTEST '));
  assert.ok(line, `stack selftest did not report status\n${result.stdout}`);
  const authLine = String(result.stdout)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('IDACC_STACK_AUTH_SELFTEST '));
  assert.ok(authLine, `stack selftest did not report admin authentication\n${result.stdout}`);
  const auth = JSON.parse(authLine.slice('IDACC_STACK_AUTH_SELFTEST '.length));
  assert.equal(auth.forgedStatus, 403);
  assert.equal(auth.desktopAuthenticated, true);
  const status = JSON.parse(line.slice('IDACC_STACK_SELFTEST '.length));
  assert.equal(existsSync(selftestResult), true, 'stack selftest did not publish its private result file');
  const selftestResultText = readFileSync(selftestResult, 'utf8');
  assert.deepEqual(JSON.parse(selftestResultText), status);
  if (process.platform !== 'win32') {
    assert.equal(statSync(selftestResult).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(
    selftestResultText,
    /"[^"]*(?:token|bearer|credential|secret|password|private[_-]?key)[^"]*"\s*:/i,
  );
  assert.equal(status.ready, true);
  assert.equal(status.authPassed, true);
  assert.equal(status.services.length, 2);
  assert.equal(status.companions.length, 2);
  assert.deepEqual(status.brainAutomation, {
    cycleEnabled: true,
    cycleCadenceHours: 24,
  });
  assert.deepEqual(status.brainCycleOptIn, {
    initiallyDisabled: true,
    initiallyRunning: false,
    listenerRunningBeforeOptIn: true,
    stateAbsentBeforeOptIn: true,
    enabledAt: status.brainCycleOptIn.enabledAt,
    persisted: true,
  });
  assert.ok(Number.isFinite(status.brainCycleOptIn.enabledAt));
  assert.equal(status.brainCatalog.healthy, true);
  assert.equal(status.brainCatalog.profileOwned, true);
  assert.equal(status.brainCatalog.skillCount, 1);
  const listener = status.companions.find((companion) => companion.name === 'brain-listener');
  const cycle = status.companions.find((companion) => companion.name === 'brain-cycle');
  assert.ok(listener);
  assert.ok(cycle);
  assert.equal(listener.enabled, true);
  assert.equal(listener.running, true);
  assert.equal(listener.healthy, true);
  assert.equal(listener.phase, 'running');
  assert.match(listener.lastSuccessfulPollAt || '', /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(cycle.enabled, true);
  const manager = status.services.find((service) => service.name === 'manager');
  const brain = status.services.find((service) => service.name === 'brain');
  assert.ok(manager);
  assert.ok(brain);
  assert.notEqual(new URL(manager.url).port, '4110');
  assert.notEqual(new URL(brain.url).port, '4210');
  assert.equal(manager.identity, 'attested');
  assert.equal(brain.identity, 'attested');
  assert.equal(manager.expectedVersion, '1.2.3');
  assert.equal(brain.expectedVersion, '4.5.6');
  assert.ok(manager.restartCount >= 2, `expected manager restart evidence, received ${manager.restartCount}`);
  assert.equal(readFileSync(join(profile, 'manager-attempts.txt'), 'utf8'), '3');
  const managerBrainToken = readFileSync(join(profile, 'manager-brain-token.txt'), 'utf8');
  const brainToken = readFileSync(join(profile, 'brain-token.txt'), 'utf8');
  const managerAdminToken = readFileSync(join(profile, 'manager-admin-token.txt'), 'utf8');
  const brainAdminToken = readFileSync(join(profile, 'brain-admin-token.txt'), 'utf8');
  const managerLibraryRoot = readFileSync(join(profile, 'manager-library-root.txt'), 'utf8');
  const managerPluginsRoot = readFileSync(join(profile, 'manager-plugins-root.txt'), 'utf8');
  const managerAgentLogRoot = readFileSync(join(profile, 'manager-agent-log-root.txt'), 'utf8');
  const brainSkillsRoot = readFileSync(join(profile, 'brain-skills-root.txt'), 'utf8');
  assert.match(brainToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(managerBrainToken, brainToken, 'Manager and Brain did not receive the same session token');
  assert.notEqual(brainToken, 'caller-token-must-not-be-reused');
  assert.match(managerAdminToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(managerAdminToken, 'caller-admin-token-must-not-be-reused');
  assert.notEqual(managerAdminToken, brainToken, 'Manager admin and Brain credentials must be distinct');
  assert.equal(brainAdminToken, '', 'Brain inherited the Manager admin bearer');
  assert.equal(readFileSync(join(profile, 'brain-onchain-sync.txt'), 'utf8'), 'false');
  assert.equal(readFileSync(join(profile, 'brain-onchain-script.txt'), 'utf8'), '');
  assert.equal(readFileSync(join(profile, 'brain-embed-phase.txt'), 'utf8'), '0');
  assert.equal(readFileSync(join(profile, 'brain-sqlite-extension.txt'), 'utf8'), '');
  assert.equal(managerLibraryRoot, join(profile, 'manager', 'library', 'configs'));
  assert.equal(managerPluginsRoot, join(profile, 'manager', 'library', 'plugins', 'claude-code'));
  assert.equal(managerAgentLogRoot, join(profile, 'logs', 'agents'));
  assert.equal(
    readFileSync(join(profile, 'manager-database-url.txt'), 'utf8'),
    '',
    'Manager inherited a shell-level DATABASE_URL instead of using profile-local SQLite',
  );
  assert.equal(
    readFileSync(join(profile, 'manager-sqlite-path.txt'), 'utf8'),
    join(profile, 'manager', 'id-agents.db'),
  );
  assert.equal(
    readFileSync(join(profile, 'manager-workspace-path.txt'), 'utf8'),
    join(profile, 'workspace'),
  );
  assert.equal(
    readFileSync(join(profile, 'manager-shared-workspace-path.txt'), 'utf8'),
    join(profile, 'workspace'),
  );
  assert.equal(brainSkillsRoot, join(profile, 'manager', 'library', 'skills'));
  assert.equal(managerLibraryRoot.startsWith(runtime), false, 'Manager library remained inside the signed runtime');
  assert.equal(managerPluginsRoot.startsWith(runtime), false, 'Manager plugins remained inside the signed runtime');
  assert.equal(brainSkillsRoot.startsWith(runtime), false, 'Brain indexed skills inside the signed runtime');
  assert.match(readFileSync(join(brainSkillsRoot, 'brain', 'SKILL.md'), 'utf8'), /name: brain/);

  const mcpResult = JSON.parse(readFileSync(join(profile, 'manager-mcp-result.json'), 'utf8'));
  assert.equal(mcpResult.mcpAttached, true, 'Brain-skilled agent did not receive an effective MCP attachment');
  assert.equal(mcpResult.mcpRead, true, 'launched Brain MCP could not read the profile skill catalog');
  assert.equal(mcpResult.electronRunAsNode, '1');
  assert.deepEqual(mcpResult.args, [brainMcpEntry]);
  assert.equal(mcpResult.args[0].includes(' '), true, 'MCP fixture did not exercise a path containing spaces');
  assert.equal(readFileSync(join(profile, 'manager-mcp-electron-node.txt'), 'utf8'), '1');
  assert.equal(existsSync(join(profile, 'manager-mcp-error.txt')), false);

  assert.equal(readFileSync(join(profile, 'brain-listener-attempts.txt'), 'utf8'), '2');
  assert.equal(readFileSync(join(profile, 'brain-listener-admin-token.txt'), 'utf8'), '');
  const cursorFile = join(profile, 'brain', 'brain-listener-cursor.json');
  const listenerCursor = JSON.parse(readFileSync(cursorFile, 'utf8'));
  assert.equal(listenerCursor.seq, 1);
  assert.equal(listenerCursor.team, 'default');
  const listenerStatusFile = join(profile, 'brain', 'brain-listener-status.json');
  const listenerStatus = JSON.parse(readFileSync(listenerStatusFile, 'utf8'));
  assert.equal(listenerStatus.schemaVersion, 1);
  assert.equal(listenerStatus.pid, listener.pid);
  assert.match(listenerStatus.instanceNonce, /^[0-9a-f]{48}$/);
  assert.ok(
    Date.parse(listenerStatus.lastSuccessfulPollAt) >= Date.parse(listener.lastSuccessfulPollAt),
    'private listener status regressed behind the publicly reported successful poll',
  );
  assert.equal(listenerStatus.teamCount, 1);
  assert.deepEqual(listenerStatus.primaryTeam, { id: 'default', name: 'default', active: true });
  assert.deepEqual(listenerStatus.cursors, [{ id: 'default', name: 'default', seq: 1 }]);
  const listenerIngest = JSON.parse(readFileSync(join(profile, 'brain-listener-ingest.json'), 'utf8'));
  assert.deepEqual(listenerIngest.eventIds, [1]);
  assert.equal(listenerIngest.requests, 1, 'listener replayed an already-cursored event after restart');

  const cycleObservation = JSON.parse(readFileSync(join(profile, 'brain-cycle-observation.json'), 'utf8'));
  assert.ok(cycleObservation.count >= 2, `expected repeated time-compressed cycles, got ${cycleObservation.count}`);
  assert.equal(cycleObservation.maxActive, 1, 'Brain cycle scheduler allowed overlapping one-shots');
  assert.ok(
    cycleObservation.starts.every(startedAt => startedAt >= status.brainCycleOptIn.enabledAt),
    'Brain maintenance ran before the explicit Settings opt-in',
  );
  assert.deepEqual(cycleObservation.environment, {
    plansDir: join(profile, 'config', 'brain-plans'),
    repoDigest: '1',
    repoPaths: '',
    repoPathsJson: JSON.stringify([registeredProject]),
    workspaceDiscovery: '0',
    onchainSync: 'false',
    onchainScript: '',
    embedPhase: '0',
    consolidationTakes: '0',
    consolidationTeam: '',
    sqliteExtension: '',
  });
  assert.equal(cycleObservation.environment.plansDir.startsWith(runtime), false);
  assert.equal(cycleObservation.environment.repoPathsJson.includes(runtime), false);
  assert.equal(readFileSync(join(profile, 'brain-cycle-admin-token.txt'), 'utf8'), '');
  const cycleStateFile = join(profile, 'brain', 'brain-cycle-state.json');
  const cycleState = JSON.parse(readFileSync(cycleStateFile, 'utf8'));
  assert.equal(cycleState.schemaVersion, 1);
  assert.equal(cycleState.cadenceMs, 100);
  assert.ok(Number.isFinite(cycleState.nextRunAt));
  const persistedSettings = JSON.parse(readFileSync(join(profile, 'config', 'config.json'), 'utf8'));
  assert.deepEqual(persistedSettings.brainAutomation, {
    cycleEnabled: true,
    cycleCadenceHours: 24,
  });

  assert.equal(line.includes(brainToken), false, 'stack status exposed the session token');
  assert.equal(line.includes(managerAdminToken), false, 'stack status exposed the Manager admin bearer');
  assert.equal(line.includes(listenerStatus.instanceNonce), false, 'stack status exposed the listener process nonce');
  assert.equal(authLine.includes(managerAdminToken), false, 'auth smoke exposed the Manager admin bearer');
  assert.equal(statSync(join(profile, 'logs', 'manager.log')).mode & 0o777, 0o600);
  assert.equal(statSync(join(profile, 'logs', 'brain-listener.log')).mode & 0o777, 0o600);
  assert.equal(statSync(join(profile, 'logs', 'brain-cycle.log')).mode & 0o777, 0o600);
  if (process.platform !== 'win32') {
    assert.equal(statSync(cursorFile).mode & 0o777, 0o600);
    assert.equal(statSync(listenerStatusFile).mode & 0o777, 0o600);
    assert.equal(statSync(cycleStateFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(brainSkillsRoot, 'brain', 'SKILL.md')).mode & 0o777, 0o600);
  }
  assert.equal(await canBind(Number(new URL(manager.url).port)), true, 'manager port remained occupied after shutdown');
  assert.equal(await canBind(Number(new URL(brain.url).port)), true, 'Brain port remained occupied after shutdown');

  for (const [mode, expectedError] of [
    ['missing', /not present/],
    ['wrong-nonce', /managed process/],
    ['stale', /recently/],
  ]) {
    const negativeProfile = join(scratch, `profile-${mode}`);
    const negativeResultFile = join(negativeProfile, 'stack-selftest-result.json');
    mkdirSync(join(negativeProfile, 'config'), { recursive: true });
    writeFileSync(join(negativeProfile, 'config', 'config.json'), JSON.stringify({
      version: 1,
      managers: [],
      providers: [],
      projects: [],
      brainAutomation: {
        cycleEnabled: false,
        cycleCadenceHours: 24,
      },
    }, null, 2), { mode: 0o600 });
    const negative = spawnSync(electron, ['.'], {
      cwd: desktop,
      env: {
        ...env,
        IDACC_DATA_DIR: negativeProfile,
        IDACC_PROFILE: `listener-readiness-${mode}`,
        IDACC_STACK_SELFTEST_RESULT_FILE: negativeResultFile,
        IDACC_STACK_SELFTEST_READY_TIMEOUT_MS: '6000',
        IDACC_STACK_AUTH_SELFTEST: '0',
        IDACC_STACK_SELFTEST_ENABLE_BRAIN_CYCLE: '0',
        IDACC_TEST_SKIP_STARTUP_CRASHES: '1',
        IDACC_TEST_LISTENER_STATUS_MODE: mode,
      },
      encoding: 'utf8',
      timeout: 20_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(
      negative.status,
      1,
      `${mode} listener status unexpectedly satisfied readiness`
      + `\nstdout:\n${negative.stdout}\nstderr:\n${negative.stderr}`,
    );
    assert.equal(existsSync(negativeResultFile), true, `${mode} case did not publish a result`);
    const negativeStatus = JSON.parse(readFileSync(negativeResultFile, 'utf8'));
    const negativeListener = negativeStatus.companions
      .find((companion) => companion.name === 'brain-listener');
    assert.equal(negativeStatus.ready, false);
    assert.ok(negativeListener, `${mode} case omitted listener state`);
    assert.equal(negativeListener.running, true, `${mode} case did not retain a live listener process`);
    assert.equal(negativeListener.healthy, false, `${mode} case trusted an invalid listener status`);
    assert.equal(negativeListener.phase, 'starting');
    assert.match(negativeListener.error || '', expectedError);
    const negativeStatusPath = join(negativeProfile, 'brain', 'brain-listener-status.json');
    assert.equal(
      existsSync(negativeStatusPath),
      mode !== 'missing',
      `${mode} case published an unexpected listener status file state`,
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('unified stack supervisor integration: ok');
