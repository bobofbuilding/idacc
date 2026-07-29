import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  externalChildEnvironment,
  isInternalCredentialEnvironmentKey,
} from '../src/main/externalChildEnvironment.ts';
import { resolveMcpStdioLaunch } from '../src/main/mcpTest.ts';

const ambient: NodeJS.ProcessEnv = {
  PATH: process.env.PATH || '',
  IDACC_SAFE_MARKER: 'preserved',
  OPENAI_API_KEY: 'provider-key-must-remain-available',
  BRAIN_TOKEN: 'ambient-brain',
  brain_bearer_token: 'ambient-brain-alias',
  IDACC_ADMIN_TOKEN: 'ambient-admin',
  IDACC_MANAGER_SERVICE_TOKEN: 'ambient-manager-service',
  IDACC_BRAIN_TOKEN: 'ambient-idacc-brain',
  IDACC_SERVICE_BEARER: 'ambient-service',
  IDCTL_MANAGER_TOKEN: 'ambient-legacy-manager',
  ID_AGENTS_ADMIN_BEARER_TOKEN: 'ambient-legacy-admin',
  ID_CU_TOKEN: 'ambient-computer-use',
};

for (const key of [
  'BRAIN_TOKEN',
  'brain_bearer_token',
  'IDACC_ADMIN_TOKEN',
  'IDACC_MANAGER_SERVICE_TOKEN',
  'IDACC_BRAIN_TOKEN',
  'IDACC_SERVICE_BEARER',
  'IDCTL_MANAGER_TOKEN',
  'ID_AGENTS_ADMIN_BEARER_TOKEN',
  'ID_CU_TOKEN',
]) {
  assert.equal(isInternalCredentialEnvironmentKey(key), true, `${key} was not classified as internal`);
}
assert.equal(isInternalCredentialEnvironmentKey('OPENAI_API_KEY'), false);
assert.equal(isInternalCredentialEnvironmentKey('GITHUB_TOKEN'), false);

const scrubbed = externalChildEnvironment(ambient);
assert.equal(scrubbed.IDACC_SAFE_MARKER, 'preserved');
assert.equal(scrubbed.OPENAI_API_KEY, ambient.OPENAI_API_KEY);
for (const key of Object.keys(scrubbed)) {
  assert.equal(
    isInternalCredentialEnvironmentKey(key),
    false,
    `scrubbed environment retained ${key}`,
  );
}

const probe = spawnSync(process.execPath, [
  '-e',
  [
    'const internal = Object.keys(process.env)',
    "  .filter((key) => /^(?:BRAIN|MANAGER|IDACC|IDCTL|ID_AGENTS|ID_CU)_/i.test(key))",
    "  .filter((key) => /(?:^|_)(?:TOKEN|BEARER)(?:_|$)/i.test(key));",
    'process.stdout.write(JSON.stringify({ internal, safe: process.env.IDACC_SAFE_MARKER, provider: process.env.OPENAI_API_KEY }));',
  ].join('\n'),
], {
  env: scrubbed,
  encoding: 'utf8',
  timeout: 5000,
});
assert.equal(probe.status, 0, probe.stderr || 'external environment probe failed');
assert.deepEqual(JSON.parse(probe.stdout), {
  internal: [],
  safe: 'preserved',
  provider: 'provider-key-must-remain-available',
});

const mcpLaunch = resolveMcpStdioLaunch(process.execPath, {
  BRAIN_TOKEN: 'explicit-user-configured-mcp-token',
}, {
  env: ambient,
});
assert.equal(mcpLaunch.env.IDACC_ADMIN_TOKEN, undefined);
assert.equal(mcpLaunch.env.IDACC_MANAGER_SERVICE_TOKEN, undefined);
assert.equal(mcpLaunch.env.IDACC_BRAIN_TOKEN, undefined);
assert.equal(mcpLaunch.env.ID_CU_TOKEN, undefined);
assert.equal(
  mcpLaunch.env.BRAIN_TOKEN,
  'explicit-user-configured-mcp-token',
  'an explicitly configured MCP credential must not be confused with ambient app authority',
);

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const externalLauncherFiles = [
  '../src/main/system.ts',
  '../src/main/subscriptions.ts',
  '../src/main/bridge.ts',
  '../src/main/headroom.ts',
  '../src/main/projects.ts',
  '../src/main/computeruse/permissions.ts',
  '../src/main/materialstore.ts',
  '../src/main/headroomPlugin.ts',
  '../src/main/mcpTest.ts',
];
for (const path of externalLauncherFiles) {
  assert.match(
    source(path),
    /externalChildEnvironment/,
    `${path} does not route external processes through the credential boundary`,
  );
}

const unifiedStack = source('../src/main/unifiedStack.ts');
assert.doesNotMatch(
  unifiedStack,
  /process\.env\.BRAIN_TOKEN\s*=|delete\s+process\.env\.BRAIN_TOKEN/,
  'the generated Brain bearer must remain module-local',
);
assert.match(unifiedStack, /export function unifiedStackPayloadContainsCredential\(/);
assert.match(
  unifiedStack,
  /\[stackBrainToken,\s*stackAdminToken,\s*stackManagerServiceToken\]\.some/,
);
assert.match(unifiedStack, /export function unifiedStackCredentialGuardSelftest\(/);
assert.match(unifiedStack, /stackManagerServiceToken = randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(
  unifiedStack,
  /name === 'brain-listener' && stackManagerServiceToken[\s\S]*env\.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken/,
);
assert.match(
  unifiedStack,
  /\(service\.spec\.name === 'manager' \|\| service\.spec\.name === 'brain'\)[\s\S]*childEnv\.IDACC_MANAGER_SERVICE_TOKEN = stackManagerServiceToken/,
);
assert.match(unifiedStack, /\.\.\.externalChildEnvironment\(\)[\s\S]*BRAIN_TOKEN:\s*stackBrainToken\s*\?\?\s*''/);
assert.match(unifiedStack, /subscriptionRuntimeEnvironment\(\)[\s\S]*BRAIN_TOKEN:\s*stackBrainToken\s*\?\?\s*''/);

const main = source('../src/main/main.ts');
assert.match(
  main,
  /!unifiedStackCredentialGuardSelftest\(\)[\s\S]*unifiedStackPayloadContainsCredential\(serialized\)/,
  'the stack self-test must positively verify and apply the module-local credential leak detector',
);

const projects = source('../src/main/projects.ts');
assert.equal(
  (projects.match(/execFileP\('git'/g) || []).length,
  6,
  'new Git launchers must be added to the credential-boundary regression',
);
assert.match(projects, /const env = gitEnvironment\(/);
assert.equal(
  (projects.match(/env:\s*gitEnvironment\(\)/g) || []).length,
  5,
  'every direct Git launcher, including hook-capable operations, must use the scrubbed environment',
);

console.log('credential environment smoke: ok');
