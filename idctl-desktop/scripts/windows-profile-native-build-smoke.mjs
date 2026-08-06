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
assert.match(buildSource, /Microsoft\.VisualStudio\.Component\.Roslyn\.Compiler/);
assert.match(buildSource, /MSBuild\\Current\\Bin\\Roslyn\\csc\.exe/);
assert.match(buildSource, /function runWindowsCompiler/);
assert.match(buildSource, /function hashWindowsDirectory/);
assert.match(buildSource, /function windowsRoslynToolchain/);
assert.match(buildSource, /'\/deterministic\+'/);
assert.match(buildSource, /'\/nowarn:0649'/);
assert.match(buildSource, /`\/pathmap:\$\{pathMapSource\}=\/_\/idacc-native`/);
assert.match(buildSource, /matchAll\(\/\\b\(\?:CS\|BC\)\\d\{4\}\\b\/g\)/);
assert.match(buildSource, /\[firstOutput, secondOutput\]/);
assert.match(buildSource, /assembly\.equals\(reproducedAssembly\)/);
assert.doesNotMatch(
  buildSource,
  /System\.CodeDom\.Compiler\.CompilerParameters|CSharpCodeProvider/,
  'the build must not route deterministic compilation through the legacy CodeDOM compiler',
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
  assert.match(String(provenance.compilerAssembly || ''), /^csc,/i);
  assert.equal(provenance.compilerKind, 'visual-studio-roslyn');
  assert.equal(provenance.targetFramework, 'net48');
  assert.equal(provenance.deterministic, true);
  assert.match(String(provenance.compilerTreeSha256 || ''), /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(provenance.compilerTreeFileCount));
  assert.ok(provenance.compilerTreeFileCount >= 3);
  assert.ok(Number.isSafeInteger(provenance.compilerTreeByteLength));
  assert.ok(provenance.compilerTreeByteLength > 0);
  assert.match(String(provenance.referenceSetSha256 || ''), /^[0-9a-f]{64}$/);
  assert.equal(provenance.referenceFileCount, 3);
  assert.ok(Number.isSafeInteger(provenance.referenceByteLength));
  assert.ok(provenance.referenceByteLength > 0);
  assert.match(String(provenance.compilationInputsSha256 || ''), /^[0-9a-f]{64}$/);
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
  assert.equal(provenance.compilerAssembly, null);
  assert.equal(provenance.compilerKind, null);
  assert.equal(provenance.targetFramework, null);
  assert.equal(provenance.deterministic, null);
  assert.equal(provenance.compilerTreeSha256, null);
  assert.equal(provenance.compilerTreeFileCount, null);
  assert.equal(provenance.compilerTreeByteLength, null);
  assert.equal(provenance.referenceSetSha256, null);
  assert.equal(provenance.referenceFileCount, null);
  assert.equal(provenance.referenceByteLength, null);
  assert.equal(provenance.compilationInputsSha256, null);
}

console.log('Windows profile native build smoke: ok');
