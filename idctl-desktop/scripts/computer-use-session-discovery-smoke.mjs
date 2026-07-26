import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mcpServerPath = join(desktopRoot, 'resources', 'computeruse-mcp', 'server.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'idacc-cu-profile-session-'));
const children = new Set();
const brokers = new Set();

const bridgeSource = readFileSync(join(desktopRoot, 'src', 'main', 'bridge.ts'), 'utf8');
assert.match(
  bridgeSource,
  /ID_CU_SESSION_FILE:\s*brokerSessionPath\(\)/,
  'new Computer Use attachments must receive the exact profile-owned session path',
);

function writeSession(profileRoot, url, token, filePath = join(profileRoot, 'computeruse', 'session.json')) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify({
    url,
    token,
    pid: process.pid,
    updatedAt: Date.now(),
  }), { mode: 0o600 });
  return filePath;
}

async function startBroker(label) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    const payload = JSON.stringify({ ok: true, detail: label });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  brokers.add(server);
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    label,
    requests,
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function startMcp(env, serverPath = mcpServerPath) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.once('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP exited before replying (${code ?? signal}): ${stderr}`));
    }
    pending.clear();
  });
  return {
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP reply timed out for ${method}: ${stderr}`));
        }, 5_000);
        pending.set(id, { resolve: resolveReply, reject, timer });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return reply;
    },
    stop() {
      children.delete(child);
      try { child.stdin.end(); } catch { /* already closed */ }
      try { child.kill(); } catch { /* already closed */ }
    },
  };
}

async function callScreenshot(mcp) {
  const reply = await mcp.request('tools/call', {
    name: 'computer_screenshot',
    arguments: {},
  });
  assert.equal(reply.error, undefined);
  return reply.result;
}

const agentTokenA = 'a'.repeat(48);
const agentTokenB = 'b'.repeat(48);
const legacyToken = 'c'.repeat(48);
const sharedSessionToken = 'f'.repeat(48);

try {
  const profileA = join(scratch, 'Profile A with spaces');
  const profileB = join(scratch, 'Profile B');
  const legacyHome = join(scratch, 'legacy-home');
  const legacyProfile = join(legacyHome, '.config', 'idctl');

  const brokerA1 = await startBroker('profile-a-before-restart');
  const brokerB = await startBroker('profile-b');
  const exactSessionA = writeSession(profileA, brokerA1.url, sharedSessionToken);
  writeSession(profileB, brokerB.url, sharedSessionToken);
  writeSession(legacyProfile, brokerB.url, sharedSessionToken);
  const stagedProfileBServer = join(profileB, 'computeruse', 'server.mjs');
  copyFileSync(mcpServerPath, stagedProfileBServer);

  // Exact injected session path is authoritative over both IDACC_DATA_DIR and a
  // stale injected URL, including when the profile path contains spaces.
  const mcpA = startMcp({
    HOME: legacyHome,
    ID_CU_AGENT: 'team-a:lead',
    ID_CU_SESSION_FILE: exactSessionA,
    IDACC_DATA_DIR: profileB,
    ID_CU_URL: brokerB.url,
    ID_CU_TOKEN: agentTokenA,
  });
  let result = await callScreenshot(mcpA);
  assert.match(result.content[0].text, /profile-a-before-restart/);
  assert.equal(brokerA1.requests.length, 1);
  assert.equal(brokerB.requests.length, 0);
  assert.equal(brokerA1.requests[0].authorization, `Bearer ${agentTokenA}`);

  // The same long-lived MCP process rereads its exact profile session on every
  // call and follows a newly selected random port without changing its agent token.
  const brokerA2 = await startBroker('profile-a-after-restart');
  assert.notEqual(brokerA2.url, brokerA1.url);
  writeSession(profileA, brokerA2.url, 'e'.repeat(48), exactSessionA);
  await new Promise((resolveClose) => brokerA1.server.close(resolveClose));
  brokers.delete(brokerA1.server);
  result = await callScreenshot(mcpA);
  assert.match(result.content[0].text, /profile-a-after-restart/);
  assert.equal(brokerA2.requests.length, 1);
  assert.equal(brokerA2.requests[0].authorization, `Bearer ${agentTokenA}`);

  // Losing a scoped profile session fails closed: no stale URL and no other
  // profile's default/legacy file is consulted.
  rmSync(exactSessionA);
  result = await callScreenshot(mcpA);
  assert.match(result.content[0].text, /Computer Use is unavailable/);
  assert.equal(brokerA2.requests.length, 1);
  assert.equal(brokerB.requests.length, 0);
  mcpA.stop();

  // IDACC_DATA_DIR is the supported derived-path fallback when an exact session
  // path was not injected.
  const mcpB = startMcp({
    HOME: legacyHome,
    IDACC_DATA_DIR: profileB,
    ID_CU_URL: brokerA2.url,
    ID_CU_TOKEN: agentTokenB,
  });
  result = await callScreenshot(mcpB);
  assert.match(result.content[0].text, /profile-b/);
  assert.equal(brokerB.requests.at(-1).authorization, `Bearer ${agentTokenB}`);
  mcpB.stop();

  // Existing attachments from before ID_CU_SESSION_FILE was introduced run a
  // profile-staged server. Its adjacent session remains authoritative and makes
  // a stale injected URL harmless.
  const olderStagedAttachment = startMcp({
    HOME: legacyHome,
    ID_CU_URL: brokerA2.url,
    ID_CU_TOKEN: agentTokenB,
  }, stagedProfileBServer);
  result = await callScreenshot(olderStagedAttachment);
  assert.match(result.content[0].text, /profile-b/);
  olderStagedAttachment.stop();

  // For pre-profile attachments, an explicitly injected URL wins over a stale
  // legacy default-profile file. With no URL, that file remains a deliberate
  // compatibility fallback.
  const legacyInjected = startMcp({
    HOME: legacyHome,
    ID_CU_URL: brokerA2.url,
    ID_CU_TOKEN: legacyToken,
  });
  result = await callScreenshot(legacyInjected);
  assert.match(result.content[0].text, /profile-a-after-restart/);
  legacyInjected.stop();

  const legacyFallback = startMcp({
    HOME: legacyHome,
    USERPROFILE: legacyHome,
    ID_CU_TOKEN: legacyToken,
  });
  result = await callScreenshot(legacyFallback);
  assert.match(result.content[0].text, /profile-b/);
  legacyFallback.stop();

  console.log('computer-use session discovery smoke: ok');
} finally {
  for (const child of children) {
    try { child.kill(); } catch { /* already exited */ }
  }
  for (const server of brokers) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  rmSync(scratch, { recursive: true, force: true });
}
