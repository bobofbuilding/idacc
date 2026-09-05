import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';
import electronPath from 'electron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'idacc-dashboard-rendered-'));
const renderer = join(temp, 'renderer.js');
const html = join(temp, 'index.html');
const main = join(temp, 'main.cjs');
const productionStyles = new URL('../src/renderer/styles.css', import.meta.url).href;

const interactionScript = String.raw`
(async () => {
 const wait = async (predicate) => { const until = Date.now() + 3000; while (!predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + document.body.innerText); await new Promise(r => setTimeout(r, 20)); } };
 const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent === label);
 const ensure = (value, message) => { if (!value) throw new Error(message); };
 await wait(() => button('Continue'));
 button('Continue').click();
 await wait(() => document.querySelector('[role="alert"]'));
 ensure(!window.inboxHarness.removed, 'Failed delivery removed the question');
 ensure(!window.inboxHarness.calls.includes('tasks:setReview'), 'Failed delivery changed task review');
 window.inboxHarness.fail = false; window.inboxHarness.reviewFail = true;
 button('Continue').click();
 await wait(() => button('Retry finishing update'));
 ensure(!window.inboxHarness.removed, 'Failed review removed the question');
 ensure(!button('Continue'), 'Delivered reply can be sent again');
 const deliveredCalls = window.inboxHarness.calls.filter(m => m === 'dispatch').length;
 window.inboxHarness.reviewFail = false;
 button('Retry finishing update').click();
 await wait(() => window.inboxHarness.removed);
 ensure(window.inboxHarness.calls.filter(m => m === 'dispatch').length === deliveredCalls, 'Retry duplicated a delivered reply');
 return { deliveredCalls, removedAfterAcknowledgement: true };
})()
`;

try {
  await build({
    entryPoints: [
      fileURLToPath(new URL('./fixtures/inbox-delivery-harness.tsx', import.meta.url)),
    ],
    outfile: renderer,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  await writeFile(html, `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="${productionStyles}">
    <style>body { padding: 24px; } main > button { margin-right: 8px; }</style>
  </head>
  <body><div id="root"></div><script src="./renderer.js"></script></body>
</html>`);
  await writeFile(main, `
const { app, BrowserWindow } = require('electron');
const interaction = ${JSON.stringify(interactionScript)};
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadFile(${JSON.stringify(html)});
    const result = await window.webContents.executeJavaScript(interaction, true);
    process.stdout.write('[inbox-delivery-smoke] OK ' + JSON.stringify(result) + '\\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write('[inbox-delivery-smoke] FAIL ' + (error && error.stack ? error.stack : String(error)) + '\\n');
    app.exit(1);
  }
});
`);

  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const isGitHubActionsLinux = process.platform === 'linux'
    && process.env.CI === 'true'
    && process.env.GITHUB_ACTIONS === 'true';
  const electronArgs = isGitHubActionsLinux
    ? ['--no-sandbox', main]
    : [main];
  const child = spawn(electronPath, electronArgs, {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGTERM'), 20_000);
  const [code, signal] = await once(child, 'exit');
  clearTimeout(watchdog);
  assert.equal(code, 0, `rendered smoke exited ${code ?? signal}\n${stdout}\n${stderr}`);
  assert.match(stdout, /\[inbox-delivery-smoke\] OK/);
  process.stdout.write(stdout);
} finally {
  await rm(temp, { recursive: true, force: true });
}
