import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMcpStdioLaunch } from '../src/main/mcpTest.ts';
import { resolveSubscriptionAction } from '../src/shared/subscriptionAction.ts';
import {
  executableCandidatePaths,
  executableExtensions,
  executableRequiresShell,
  installCommandSupported,
  terminalAutomationSupported,
} from '../src/shared/subscriptionPortability.ts';

assert.deepEqual(
  executableExtensions('win32', '.EXE;.CMD'),
  ['.exe', '.cmd'],
  'Windows executable discovery must honor PATHEXT',
);
const executableDirectory = join(tmpdir(), 'idacc-subscription-portability-tools');
const windowsCandidates = executableCandidatePaths(executableDirectory, 'claude', {
  platform: 'win32',
  pathExt: '.EXE;.CMD',
});
assert.deepEqual(
  windowsCandidates,
  [
    join(executableDirectory, 'claude.exe'),
    join(executableDirectory, 'claude.cmd'),
  ],
  'Windows executable discovery must append PATHEXT candidates using host-native filesystem paths',
);
assert.deepEqual(
  executableCandidatePaths(executableDirectory, 'claude', { platform: 'linux' }),
  [join(executableDirectory, 'claude')],
  'non-Windows executable discovery must preserve an extensionless host-native filesystem path',
);
assert.equal(executableRequiresShell('C:\\Tools\\claude.cmd', 'win32'), true);
assert.equal(executableRequiresShell('C:\\Tools\\claude.exe', 'win32'), false);

assert.equal(installCommandSupported('npm install -g @anthropic-ai/claude-code', 'win32'), true);
assert.equal(installCommandSupported('curl https://example.test/install | bash', 'win32'), false);
assert.equal(installCommandSupported('curl https://example.test/install | bash', 'linux'), true);

assert.equal(terminalAutomationSupported('darwin'), true);
assert.equal(terminalAutomationSupported('linux'), false);
assert.equal(terminalAutomationSupported('win32'), false);

const manualSignin = resolveSubscriptionAction('signin', {
  started: false,
  command: 'claude auth login',
  error: 'automatic terminal launch is unavailable',
});
assert.equal(manualSignin.kind, 'manual', 'a returned sign-in command must be a manual handoff, not an error');
assert.equal(manualSignin.kind === 'manual' ? manualSignin.command : '', 'claude auth login');
const manualInstall = resolveSubscriptionAction('install', {
  ran: false,
  command: 'npm install -g @openai/codex',
  error: 'automatic terminal launch is unavailable',
});
assert.equal(manualInstall.kind, 'manual', 'a returned install command must be a manual handoff, not an error');
assert.equal(resolveSubscriptionAction('signin', { started: true }).kind, 'launched');
assert.equal(resolveSubscriptionAction('install', { ran: false, error: 'unsupported installer' }).kind, 'error');

const temporary = mkdtempSync(join(tmpdir(), 'idacc-mcp-portability-'));
try {
  const commandShim = join(temporary, 'example-mcp.cmd');
  writeFileSync(commandShim, '@echo off\r\n');
  const launch = resolveMcpStdioLaunch('example-mcp', {
    BRAIN_TOKEN: 'explicit-mcp-token',
  }, {
    platform: 'win32',
    env: {
      PATH: temporary,
      PATHEXT: '.EXE;.CMD',
      BRAIN_TOKEN: 'ambient-brain-token',
      IDACC_ADMIN_TOKEN: 'ambient-admin-token',
      IDACC_BRAIN_TOKEN: 'ambient-brain-alias',
    },
    home: temporary,
    pathDelimiter: ';',
  });
  assert.equal(launch.command, commandShim, 'MCP launch must resolve a Windows .cmd shim through PATHEXT');
  assert.equal(launch.shell, true, 'Windows .cmd MCP shims must launch through the platform shell');
  assert.ok(launch.env.PATH?.split(';').includes(temporary), 'MCP launch must retain the configured PATH');
  assert.equal(launch.env.IDACC_ADMIN_TOKEN, undefined, 'MCP launch inherited the app Manager bearer');
  assert.equal(launch.env.IDACC_BRAIN_TOKEN, undefined, 'MCP launch inherited an app Brain bearer alias');
  assert.equal(launch.env.BRAIN_TOKEN, 'explicit-mcp-token', 'explicit MCP env must override scrubbed ambient state');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const subscriptions = readFileSync(new URL('../src/main/subscriptions.ts', import.meta.url), 'utf8');
assert.ok(subscriptions.includes('env.PATH.split(delimiter)'), 'PATH parsing must use the host path delimiter');
assert.ok(subscriptions.includes('cliDirs().join(delimiter)'), 'augmented PATH assembly must use the host path delimiter');
assert.ok(subscriptions.includes('pathExt: process.env.PATHEXT'), 'Windows CLI discovery must use PATHEXT');
assert.ok(subscriptions.includes('executableCandidatePaths(directory, bin'), 'subscription probes must test executable suffix candidates');
assert.ok(
  subscriptions.includes('export function subscriptionRuntimeEnvironment()')
    && subscriptions.includes('CLAUDE_PATH: claude')
    && subscriptions.includes('ID_AGENT_CODEX_BIN: codex'),
  'desktop subscription detection must expose its augmented PATH and resolved core CLI paths to Manager',
);

const system = readFileSync(new URL('../src/main/system.ts', import.meta.url), 'utf8');
const platformGuard = system.indexOf('if (!terminalAutomationSupported(process.platform))');
const osascriptCall = system.indexOf("execFileP('osascript'");
assert.ok(platformGuard >= 0 && osascriptCall > platformGuard, 'non-macOS terminal actions must return before osascript');
assert.ok(system.includes('process.env.PATH.split(delimiter)'), 'system CLI PATH parsing must use the host delimiter');
assert.ok(system.includes('Set(dirs)).join(delimiter)'), 'system CLI PATH assembly must use the host delimiter');

const bridge = readFileSync(new URL('../src/main/bridge.ts', import.meta.url), 'utf8');
assert.ok(bridge.includes('process.env.PATH.split(delimiter)'), 'runtime model discovery must use the host PATH delimiter');
assert.ok(bridge.includes('Set(dirs)).join(delimiter)'), 'runtime model PATH assembly must use the host delimiter');

const wizard = readFileSync(new URL('../src/renderer/components/FirstRunWizard.tsx', import.meta.url), 'utf8');
assert.ok(
  wizard.includes('navigator.clipboard.writeText(resolution.command)'),
  'first-run subscription actions must copy a returned manual command',
);
assert.ok(
  wizard.includes("resolution.kind === 'manual'"),
  'first-run subscription actions must handle a manual command before surfacing an error',
);
assert.ok(
  wizard.includes('${resolution.command}'),
  'first-run subscription actions must keep the manual command visible when clipboard access is unavailable',
);

const unifiedStack = readFileSync(new URL('../src/main/unifiedStack.ts', import.meta.url), 'utf8');
assert.ok(
  unifiedStack.includes("service.spec.name === 'manager'")
    && unifiedStack.includes('? subscriptionRuntimeEnvironment()')
    && unifiedStack.includes(': externalChildEnvironment()'),
  'the bundled Manager must inherit the desktop subscription runtime environment',
);
assert.ok(
  !unifiedStack.includes('process.env.BRAIN_TOKEN ='),
  'the generated Brain bearer must never be written to the Electron process environment',
);

const mcpTest = readFileSync(new URL('../src/main/mcpTest.ts', import.meta.url), 'utf8');
assert.ok(mcpTest.includes('pathExt: env.PATHEXT'), 'MCP command resolution must honor PATHEXT');
assert.ok(mcpTest.includes('crossSpawn(launch.command, spec.args'), 'MCP launch must safely escape Windows command-shim arguments');
assert.ok(!mcpTest.includes('shell: launch.shell'), 'MCP launch must not interpolate configured arguments into a raw shell command');

console.log('subscription portability smoke: ok');
