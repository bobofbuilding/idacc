#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
} from './main-process-startup-policy.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(desktop, 'out');

function walk(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

for (const path of [
  'main/main.cjs',
  'main/managed-service-bootstrap.cjs',
  'main/mcp-probe-runner.cjs',
  'preload/preload.cjs',
  'renderer/index.html',
  'renderer/renderer.js',
  'renderer/renderer.css',
  'build-mode.json',
]) {
  assert.ok(existsSync(join(out, path)), `release output is missing ${path}`);
}
const buildMode = JSON.parse(readFileSync(join(out, 'build-mode.json'), 'utf8'));
const compiledMainProcess = readFileSync(join(out, 'main', 'main.cjs'), 'utf8');
assert.equal(buildMode.mode, 'production');
const sourcePackage = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const expectedReviewBuild = process.env.IDACC_REVIEW_BUILD === '1';
const expectedStartupPolicyMode = buildMode.mode === 'development'
  ? 'development'
  : expectedReviewBuild ? 'review' : 'production';
assert.equal(
  buildMode.reviewOnly,
  expectedReviewBuild,
  'release build provenance must identify normal versus review-only output',
);
assert.equal(
  buildMode.updaterEnabled,
  true,
  'every packaged build must retain its compiled update channel',
);
assert.equal(buildMode.updaterChannel, expectedReviewBuild ? 'review' : 'production');
assert.equal(buildMode.sourceVersion, sourcePackage.version);
assert.deepEqual(buildMode.mainProcessStartupPolicy, {
  mode: expectedStartupPolicyMode,
  marker: mainProcessStartupPolicyMarker(expectedStartupPolicyMode),
  rejectsLinuxSandboxDisableSwitches: buildMode.mode === 'production',
});
assert.equal(
  compiledMainProcess.startsWith(
    mainProcessStartupBanner(expectedStartupPolicyMode),
  ),
  true,
  'main process must begin with the exact deterministic startup policy banner',
);
assert.equal(
  buildMode.applicationVersion,
  expectedReviewBuild
    ? process.env.IDACC_REVIEW_VERSION
    : sourcePackage.version,
  'build provenance must carry the exact packaged application identity',
);
if (expectedReviewBuild) {
  assert.equal(
    buildMode.applicationVersion,
    sourcePackage.version,
    'review channel must not alter the stable application version',
  );
}
assert.ok(
  compiledMainProcess.includes(
    expectedReviewBuild
      ? 'idacc-review-updater-enabled:v1'
      : 'idacc-production-updater-enabled:v1',
  ),
  'the compiled updater must carry the expected fail-closed channel policy',
);
if (expectedReviewBuild) {
  assert.equal(
    compiledMainProcess.includes('idacc-production-updater-enabled:v1'),
    false,
    'review-only output must not compile the production updater policy',
  );
}
assert.match(String(buildMode.runtimeManifestSha256 || ''), /^[0-9a-f]{64}$/, 'release output must bind to its runtime manifest');
assert.equal(buildMode.windowsProfileNative?.buildPlatform, process.platform);
assert.equal(buildMode.windowsJobHost?.buildPlatform, process.platform);
assert.match(
  String(buildMode.windowsJobHost?.sourceSha256 || ''),
  /^[0-9a-f]{64}$/,
  'release output must record its Windows Job Host source',
);
assert.match(
  String(buildMode.windowsJobHost?.bootstrapSha256 || ''),
  /^[0-9a-f]{64}$/,
  'release output must bind to its managed-service bootstrap',
);
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(out, 'main', 'managed-service-bootstrap.cjs')))
    .digest('hex'),
  buildMode.windowsJobHost?.bootstrapSha256,
  'the shipped managed-service bootstrap must match build provenance',
);
assert.match(
  String(buildMode.mcpProbeRunnerSha256 || ''),
  /^[0-9a-f]{64}$/,
  'release output must bind to its MCP probe runner',
);
assert.equal(
  createHash('sha256')
    .update(readFileSync(join(out, 'main', 'mcp-probe-runner.cjs')))
    .digest('hex'),
  buildMode.mcpProbeRunnerSha256,
  'the shipped MCP probe runner must match build provenance',
);
assert.ok(
  readFileSync(join(out, 'main', 'main.cjs'), 'utf8')
    .includes(buildMode.mcpProbeRunnerSha256),
  'the main-process bundle must embed the shipped MCP probe runner digest',
);
assert.match(
  String(buildMode.windowsProfileNative?.sourceSha256 || ''),
  /^[0-9a-f]{64}$/,
  'release output must record its Windows native-helper source',
);
if (process.platform === 'win32') {
  const jobHostPath = join(out, 'native', 'idacc-job-host.exe');
  assert.equal(existsSync(jobHostPath), true, 'Windows release output must contain its Job Host');
  assert.equal(buildMode.windowsJobHost?.available, true);
  assert.match(
    String(buildMode.windowsJobHost?.executableSha256 || ''),
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    createHash('sha256').update(readFileSync(jobHostPath)).digest('hex'),
    buildMode.windowsJobHost?.executableSha256,
    'the unsigned build-stage Job Host must match its deterministic digest',
  );
  assert.ok(
    Number.isSafeInteger(buildMode.windowsJobHost?.byteLength)
      && buildMode.windowsJobHost.byteLength >= 4_096
      && buildMode.windowsJobHost.byteLength <= 8 * 1024 * 1024,
  );
  assert.match(
    String(buildMode.windowsJobHost?.compilerSha256 || ''),
    /^[0-9a-f]{64}$/,
    'Windows release output must identify the Job Host compiler',
  );
  assert.ok(String(buildMode.windowsJobHost?.compilerFileVersion || '').trim());
  assert.match(String(buildMode.windowsJobHost?.compilerAssembly || ''), /^csc,/i);
  assert.equal(buildMode.windowsJobHost?.compilerKind, 'visual-studio-roslyn');
  assert.equal(buildMode.windowsJobHost?.targetFramework, 'net48');
  assert.equal(buildMode.windowsJobHost?.deterministic, true);
  assert.match(
    String(buildMode.windowsJobHost?.compilerTreeSha256 || ''),
    /^[0-9a-f]{64}$/,
  );
  assert.ok(Number.isSafeInteger(buildMode.windowsJobHost?.compilerTreeFileCount));
  assert.ok(buildMode.windowsJobHost.compilerTreeFileCount >= 3);
  assert.ok(Number.isSafeInteger(buildMode.windowsJobHost?.compilerTreeByteLength));
  assert.ok(buildMode.windowsJobHost.compilerTreeByteLength > 0);
  assert.match(
    String(buildMode.windowsJobHost?.referenceSetSha256 || ''),
    /^[0-9a-f]{64}$/,
  );
  assert.equal(buildMode.windowsJobHost?.referenceFileCount, 3);
  assert.ok(Number.isSafeInteger(buildMode.windowsJobHost?.referenceByteLength));
  assert.ok(buildMode.windowsJobHost.referenceByteLength > 0);
  assert.match(
    String(buildMode.windowsJobHost?.compilationInputsSha256 || ''),
    /^[0-9a-f]{64}$/,
  );
  if (buildMode.windowsJobHost?.expectedPublisher) {
    assert.equal(buildMode.windowsJobHost?.verificationMode, 'authenticode-publisher');
  } else {
    assert.equal(buildMode.windowsJobHost?.verificationMode, 'sha256');
  }
  assert.equal(buildMode.windowsProfileNative?.embedded, true);
  assert.match(
    String(buildMode.windowsProfileNative?.assemblySha256 || ''),
    /^[0-9a-f]{64}$/,
    'Windows release output must embed a verified native privacy helper',
  );
  assert.ok(
    Number.isSafeInteger(buildMode.windowsProfileNative?.byteLength)
      && buildMode.windowsProfileNative.byteLength >= 1_024
      && buildMode.windowsProfileNative.byteLength <= 4 * 1024 * 1024,
  );
  assert.match(
    String(buildMode.windowsProfileNative?.compilerSha256 || ''),
    /^[0-9a-f]{64}$/,
    'Windows release output must identify its Roslyn compiler',
  );
  assert.ok(String(buildMode.windowsProfileNative?.compilerFileVersion || '').trim());
  assert.match(String(buildMode.windowsProfileNative?.compilerAssembly || ''), /^csc,/i);
  assert.equal(buildMode.windowsProfileNative?.compilerKind, 'visual-studio-roslyn');
  assert.equal(buildMode.windowsProfileNative?.targetFramework, 'net48');
  assert.equal(buildMode.windowsProfileNative?.deterministic, true);
  assert.equal(
    buildMode.windowsProfileNative?.compilerTreeSha256,
    buildMode.windowsJobHost?.compilerTreeSha256,
  );
  assert.equal(
    buildMode.windowsProfileNative?.referenceSetSha256,
    buildMode.windowsJobHost?.referenceSetSha256,
  );
  assert.equal(
    buildMode.windowsProfileNative?.compilationInputsSha256,
    buildMode.windowsJobHost?.compilationInputsSha256,
  );
} else {
  assert.equal(buildMode.windowsJobHost?.available, false);
  assert.equal(buildMode.windowsJobHost?.executableSha256, null);
  assert.equal(buildMode.windowsJobHost?.byteLength, null);
  assert.equal(buildMode.windowsJobHost?.verificationMode, 'unavailable');
  assert.equal(buildMode.windowsJobHost?.compilerSha256, null);
  assert.equal(buildMode.windowsJobHost?.compilerAssembly, null);
  assert.equal(buildMode.windowsJobHost?.compilerKind, null);
  assert.equal(buildMode.windowsJobHost?.targetFramework, null);
  assert.equal(buildMode.windowsJobHost?.deterministic, null);
  assert.equal(buildMode.windowsJobHost?.compilerTreeSha256, null);
  assert.equal(buildMode.windowsJobHost?.compilerTreeFileCount, null);
  assert.equal(buildMode.windowsJobHost?.compilerTreeByteLength, null);
  assert.equal(buildMode.windowsJobHost?.referenceSetSha256, null);
  assert.equal(buildMode.windowsJobHost?.referenceFileCount, null);
  assert.equal(buildMode.windowsJobHost?.referenceByteLength, null);
  assert.equal(buildMode.windowsJobHost?.compilationInputsSha256, null);
  assert.equal(existsSync(join(out, 'native', 'idacc-job-host.exe')), false);
  assert.equal(buildMode.windowsProfileNative?.embedded, false);
  assert.equal(buildMode.windowsProfileNative?.assemblySha256, null);
  assert.equal(buildMode.windowsProfileNative?.compilerSha256, null);
  assert.equal(buildMode.windowsProfileNative?.compilerAssembly, null);
  assert.equal(buildMode.windowsProfileNative?.compilerKind, null);
  assert.equal(buildMode.windowsProfileNative?.targetFramework, null);
  assert.equal(buildMode.windowsProfileNative?.deterministic, null);
  assert.equal(buildMode.windowsProfileNative?.compilerTreeSha256, null);
  assert.equal(buildMode.windowsProfileNative?.compilerTreeFileCount, null);
  assert.equal(buildMode.windowsProfileNative?.compilerTreeByteLength, null);
  assert.equal(buildMode.windowsProfileNative?.referenceSetSha256, null);
  assert.equal(buildMode.windowsProfileNative?.referenceFileCount, null);
  assert.equal(buildMode.windowsProfileNative?.referenceByteLength, null);
  assert.equal(buildMode.windowsProfileNative?.compilationInputsSha256, null);
}
const files = walk(out);
assert.equal(files.some((path) => path.endsWith('.map')), false, 'production bundles must not ship source maps');
console.log(`release build output smoke: ok (${files.length} files, no source maps)`);
