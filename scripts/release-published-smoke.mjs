#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts', 'check-release-published.mjs');

function startMock(releases, requests) {
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization || '' });
    const tag = decodeURIComponent(req.url.split('/releases/tags/')[1] || '');
    const release = releases[tag];
    if (!release) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(release));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// spawnSync would block this process's own event loop while the child's fetch call waits on
// the mock server hosted right here — a deadlock, since that server can only accept the
// connection once the event loop is free. Use async spawn instead so both run concurrently.
function spawnGuard(args, apiBase) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guard, ...args], {
      cwd: root,
      env: { ...process.env, GITHUB_API_BASE: apiBase, GH_TOKEN: 'release-smoke-token' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function run(apiBase, tag) {
  return spawnGuard([tag, '--repo', 'bobofbuilding/idacc'], apiBase);
}

const requests = [];
const server = await startMock({
  'v0.1.636': { draft: false, tag_name: 'v0.1.636' },
  'v0.1.637': { draft: true, tag_name: 'v0.1.637' },
}, requests);
const { port } = server.address();
const apiBase = `http://127.0.0.1:${port}`;

try {
  const published = await run(apiBase, '0.1.636');
  assert.equal(published.status, 0, `expected a published release to pass: ${published.stderr}`);
  assert.match(published.stdout, /published GitHub release/);

  const draftOnly = await run(apiBase, '0.1.637');
  assert.notEqual(draftOnly.status, 0, 'a draft-only release must not count as published');
  assert.match(draftOnly.stderr, /only a draft release/);

  const missing = await run(apiBase, '0.1.999');
  assert.notEqual(missing.status, 0, 'a tag with no release at all must fail the guard');
  assert.match(missing.stderr, /no GitHub release found/);

  assert.equal(requests.length, 3, 'each release lookup should reach the mock API once');
  assert.equal(requests.every((request) => request.authorization === 'Bearer release-smoke-token'), true, 'release lookups must use the configured token');

  const usage = await spawnGuard([], apiBase);
  assert.equal(usage.status, 2, 'missing version argument should be a usage error');
} finally {
  server.closeAllConnections();
  server.close();
}

console.log('✓ release-published-smoke passed');
process.exit(0);
