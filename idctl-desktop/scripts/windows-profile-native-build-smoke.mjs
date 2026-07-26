#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildMode = JSON.parse(readFileSync(join(desktop, 'out', 'build-mode.json'), 'utf8'));
const main = readFileSync(join(desktop, 'out', 'main', 'main.cjs'), 'utf8');
const source = readFileSync(join(desktop, 'src', 'main', 'profilePrivacy.ts'), 'utf8');
const buildSource = readFileSync(join(desktop, 'scripts', 'build.mjs'), 'utf8');
const provenance = buildMode.windowsProfileNative || {};

assert.equal(provenance.buildPlatform, process.platform);
assert.match(String(provenance.sourceSha256 || ''), /^[0-9a-f]{64}$/);
assert.equal(
  main.includes(provenance.sourceSha256),
  true,
  'the bundled loader must bind to the native C# source provenance',
);
assert.match(source, /WINDOWS_PROFILE_HELPER_BUILD_DEFINED/);
assert.match(source, /this Windows bundle does not contain its native privacy helper/);
assert.match(source, /\$nativeBundleMode -eq 'raw-source'[\s\S]*Add-Type -TypeDefinition/);
assert.match(source, /\$nativeBundleMode -eq 'embedded'[\s\S]*ComputeHash/);
assert.match(source, /\$nativeSourceHasher\.ComputeHash\(\$nativeSourceBytes\)/);
assert.match(source, /\[Reflection\.Assembly\]::Load\(\$nativeAssemblyBytes\)/);
assert.match(source, /\$script:diagnosticPhase = 'load-native'/);
assert.match(buildSource, /System\.CodeDom\.Compiler\.CompilerParameters/);
assert.match(buildSource, /-CompilerParameters \$compilerParameters/);
assert.match(buildSource, /\[firstOutput, secondOutput\]/);
assert.match(buildSource, /assembly\.equals\(reproducedAssembly\)/);
assert.doesNotMatch(
  buildSource,
  /Add-Type[^\n]*-CompilerOptions/,
  'Windows PowerShell 5.1 does not support the PowerShell 7 CompilerOptions parameter',
);

if (process.platform === 'win32') {
  assert.equal(provenance.embedded, true);
  assert.match(String(provenance.assemblySha256 || ''), /^[0-9a-f]{64}$/);
  assert.ok(
    Number.isSafeInteger(provenance.byteLength)
      && provenance.byteLength >= 1_024
      && provenance.byteLength <= 4 * 1024 * 1024,
  );
  assert.match(String(provenance.powershellVersion || ''), /^\d+(?:\.\d+)+$/);
  assert.match(String(provenance.clrVersion || ''), /^\d+(?:\.\d+)+$/);
  assert.ok(String(provenance.compilerFileVersion || '').trim());
  assert.match(String(provenance.compilerSha256 || ''), /^[0-9a-f]{64}$/);
  assert.match(String(provenance.codeDomAssembly || ''), /Microsoft\.CSharp/i);
  assert.equal(
    main.includes(provenance.assemblySha256),
    true,
    'the bundled loader must contain the build-verified assembly digest',
  );
} else {
  assert.equal(provenance.embedded, false);
  assert.equal(provenance.assemblySha256, null);
  assert.equal(provenance.byteLength, null);
  assert.equal(provenance.powershellVersion, null);
  assert.equal(provenance.clrVersion, null);
  assert.equal(provenance.compilerFileVersion, null);
  assert.equal(provenance.compilerSha256, null);
  assert.equal(provenance.codeDomAssembly, null);
}

console.log('Windows profile native build smoke: ok');
