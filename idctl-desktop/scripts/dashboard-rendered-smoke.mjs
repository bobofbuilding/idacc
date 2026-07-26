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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (selector, timeout = 2500) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const element = document.querySelector(selector);
      if (element) return element;
      await sleep(10);
    }
    throw new Error('Timed out waiting for ' + selector + ' during ' + (window.__dashboardStep || 'unknown') + '; debug=' + JSON.stringify(window.__dashboardDebug || {}) + '; body=' + document.body.innerText.slice(0, 800));
  };
  const button = (label, root = document) => {
    const match = [...root.querySelectorAll('button')].find((element) => element.textContent.trim() === label);
    if (!match) throw new Error('Button not found: ' + label);
    return match;
  };
  const setInput = (element, value) => {
    const previous = element.value;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    if (element._valueTracker) element._valueTracker.setValue(previous);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const key = (element, value, options = {}) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
  };
  const ensure = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  document.querySelector('#open-palette').click();
  const paletteInput = await waitFor('.cmdk-input');
  await sleep(30);
  ensure(document.activeElement === paletteInput, 'palette input did not receive focus');
  setInput(paletteInput, '/ask lead inspect durable receipts');
  await sleep(30);
  key(paletteInput, 'Enter');
  await waitFor('.cmdk-confirm[role="alertdialog"]');
  button('Decline', document.querySelector('.cmdk-confirm')).click();
  await waitFor('[data-command-id="remote.ask"][data-command-state="declined"]');
  ensure(window.__dashboardHarness.calls.filter((row) => row.method === 'remote').length === 0, 'declined command executed');

  key(paletteInput, 'Enter');
  const confirm = await waitFor('.cmdk-confirm[role="alertdialog"]');
  const confirmButton = button('Confirm', confirm);
  confirmButton.click();
  confirmButton.click();
  await waitFor('[data-command-id="remote.ask"][data-command-state="succeeded"]');
  ensure(window.__dashboardHarness.calls.filter((row) => row.method === 'remote').length === 1, 'confirmed command did not execute exactly once');
  key(paletteInput, 'Escape');
  await sleep(30);
  ensure(!document.querySelector('.cmdk'), 'palette did not close with Escape');

  const projectTrigger = document.querySelector('#open-project-drawer');
  projectTrigger.focus();
  projectTrigger.click();
  const drawer = await waitFor('.drawer');
  const closeButton = await waitFor('button[aria-label="Close control drawer"]');
  closeButton.focus();
  key(closeButton, 'Tab', { shiftKey: true });
  ensure(drawer.contains(document.activeElement), 'Shift+Tab escaped the drawer focus trap');
  const nameInput = await waitFor('.driver-fields label:first-child input');
  const objectiveInput = await waitFor('.driver-objective textarea');
  objectiveInput.focus();
  window.__dashboardStep = 'project dirty guard';
  setInput(objectiveInput, 'Ship a consumer-ready project');
  await sleep(40);
  window.__dashboardDebug = {
    nameValue: nameInput.value,
    objectiveValue: objectiveInput.value,
    active: document.activeElement === objectiveInput,
    tracker: objectiveInput._valueTracker ? objectiveInput._valueTracker.getValue() : 'missing',
    ownSetter: Boolean(Object.getOwnPropertyDescriptor(objectiveInput, 'value')),
  };
  await waitFor('.drawer-guard-badge');
  key(objectiveInput, 'Escape');
  const dirtyPrompt = await waitFor('.drawer-close-guard[role="alertdialog"]');
  ensure(document.querySelector('.drawer'), 'dirty Escape closed the drawer');
  button('Keep working', dirtyPrompt).click();
  await sleep(20);
  ensure(objectiveInput.value === 'Ship a consumer-ready project', 'keep working lost the draft');

  closeButton.click();
  const xPrompt = await waitFor('.drawer-close-guard[role="alertdialog"]');
  button('Discard changes', xPrompt).click();
  await sleep(40);
  ensure(!document.querySelector('.drawer'), 'explicit discard did not close the drawer');
  ensure(document.activeElement === projectTrigger, 'drawer did not restore trigger focus');

  const quickTrigger = document.querySelector('#open-quick-drawer');
  quickTrigger.focus();
  quickTrigger.click();
  const quickDrawer = await waitFor('.drawer');
  button('Probe all', quickDrawer).click();
  window.__dashboardStep = 'quick busy guard';
  await waitFor('.drawer-guard-badge');
  document.querySelector('[data-dashboard-drawer-overlay]').dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
  }));
  const busyPrompt = await waitFor('.drawer-close-guard[role="alertdialog"]');
  const protectedClose = button('Close drawer', busyPrompt);
  ensure(protectedClose.disabled, 'in-flight drawer close was not disabled');
  ensure(document.querySelector('.drawer'), 'in-flight backdrop click closed the drawer');
  await sleep(240);
  ensure(!protectedClose.disabled, 'drawer remained locked after command completion');
  protectedClose.click();
  await sleep(40);
  ensure(!document.querySelector('.drawer'), 'settled drawer did not close explicitly');
  ensure(document.activeElement === quickTrigger, 'quick drawer did not restore trigger focus');

  return {
    remoteCalls: window.__dashboardHarness.calls.filter((row) => row.method === 'remote').length,
    probeCalls: window.__dashboardHarness.calls.filter((row) => row.method === 'probeAll').length,
  };
})()
`;

try {
  await build({
    entryPoints: [
      fileURLToPath(new URL('./fixtures/dashboard-command-surface-harness.tsx', import.meta.url)),
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
    process.stdout.write('[dashboard-rendered-smoke] OK ' + JSON.stringify(result) + '\\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write('[dashboard-rendered-smoke] FAIL ' + (error && error.stack ? error.stack : String(error)) + '\\n');
    app.exit(1);
  }
});
`);

  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = process.platform === 'linux' && process.env.CI
    ? ['--disable-setuid-sandbox', main]
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
  assert.match(stdout, /\[dashboard-rendered-smoke\] OK/);
  process.stdout.write(stdout);
} finally {
  await rm(temp, { recursive: true, force: true });
}
