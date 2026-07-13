#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const guard = join(root, 'scripts', 'check-release-publication.mjs');
let published = false;

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url?.endsWith('/releases/latest')) {
    response.end(JSON.stringify({ tag_name: 'v0.1.636', draft: false }));
    return;
  }
  if (request.url?.endsWith('/releases/tags/v0.1.637')) {
    if (published) response.end(JSON.stringify({ tag_name: 'v0.1.637', draft: false }));
    else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: 'Not Found' }));
    }
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: 'Not Found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const env = { ...process.env, IDACC_RELEASE_API_BASE: `http://127.0.0.1:${port}` };
function run(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [guard, ...args], { cwd: root, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

try {
  const missing = await run();
  assert.notEqual(missing.status, 0, 'an unpublished frontier tag must block release.sh');
  assert.match(`${missing.stdout}\n${missing.stderr}`, /v0\.1\.637/);

  published = true;
  const verified = await run(['--require-tag', 'v0.1.637']);
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  console.log('✓ release publication CLI smoke test passed');
} finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
