#!/usr/bin/env node
/**
 * Bundle the three Electron entry points with esbuild:
 *   main    → out/main/main.cjs        (Node, CommonJS)
 *   preload → out/preload/preload.cjs  (Node, CommonJS)
 *   renderer→ out/renderer/renderer.js (+ lazy ESM chunks + .css)
 * Then copy index.html. The main/preload bundles pull in the idctl ManagerClient
 * (pure TS) from the sibling project; node: builtins stay external.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from '../../scripts/lib/runtime-provenance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(ROOT, '..');
const runtimeManifestPath = resolve(ROOT, 'resources/idacc-runtime/manifest.json');
const runtimeLockPath = resolve(SOURCE_ROOT, 'release/runtime-lock.json');
const managedBootstrapPath = resolve(ROOT, 'src/main/managed-service-bootstrap.cjs');
const requireRuntime = process.argv.includes('--require-runtime');
const releaseBuild = requireRuntime || process.argv.includes('--release');

function extractWindowsProfileNativeSource() {
  const sourcePath = resolve(ROOT, 'src/main/profilePrivacy.ts');
  const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
  const opening = "  $nativeSource = @'\n";
  const closing = "\n'@\n  $nativeBundleMode = ";
  const start = source.indexOf(opening);
  const end = source.indexOf(closing, start + opening.length);
  if (
    start < 0
    || end < 0
    || source.indexOf(opening, start + opening.length) >= 0
    || source.indexOf(closing, end + closing.length) >= 0
  ) {
    throw new Error('Windows profile native source markers are missing or ambiguous');
  }
  const nativeSource = source.slice(start + opening.length, end);
  if (
    nativeSource.length < 1_000
    || nativeSource.length > 1_000_000
    || nativeSource.includes('\0')
    || !nativeSource.includes('public static class IdaccProfileFileProbe')
  ) {
    throw new Error('Windows profile native source is invalid');
  }
  return nativeSource;
}

function windowsPowerShellExecutable() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim();
  const normalized = win32.normalize(systemRoot);
  if (
    !systemRoot
    || !win32.isAbsolute(normalized)
    || !/^[A-Za-z]:\\/.test(normalized)
    || normalized.startsWith('\\\\')
    || normalized.slice(win32.parse(normalized).root.length).includes(':')
  ) {
    throw new Error('Windows system directory is unavailable');
  }
  const executable = win32.join(
    normalized,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!existsSync(executable)) {
    throw new Error('Windows PowerShell 5.1 is unavailable');
  }
  return executable;
}

function runWindowsPowerShell(executable, script, input, extraEnvironment = {}, timeout = 120_000) {
  const environment = {
    SystemRoot: process.env.SystemRoot || process.env.WINDIR,
    WINDIR: process.env.WINDIR || process.env.SystemRoot,
    ...extraEnvironment,
  };
  for (const key of ['ComSpec', 'PSModulePath', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const result = spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-InputFormat',
    'Text',
    '-OutputFormat',
    'Text',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    env: environment,
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });
  if (
    result.error
    || result.signal
    || result.status !== 0
    || String(result.stderr || '').replaceAll('\0', '').trim()
  ) {
    throw new Error('Windows native helper preparation failed');
  }
  return String(result.stdout || '').replaceAll('\0', '').trim();
}

function prepareWindowsProfileNativeHelper(nativeSource) {
  const sourceSha256 = createHash('sha256').update(nativeSource).digest('hex');
  if (process.platform !== 'win32') {
    return {
      sourceSha256,
      embedded: false,
      assemblySha256: null,
      byteLength: null,
      base64: '',
      powershellVersion: null,
      clrVersion: null,
      compilerFileVersion: null,
      compilerSha256: null,
      codeDomAssembly: null,
    };
  }

  const executable = windowsPowerShellExecutable();
  const scratch = mkdtempSync(join(tmpdir(), 'idacc-profile-native-'));
  const firstRoot = join(scratch, 'first');
  const secondRoot = join(scratch, 'second');
  mkdirSync(firstRoot, { recursive: false });
  mkdirSync(secondRoot, { recursive: false });
  const firstOutput = join(firstRoot, 'IdaccProfileFileProbe.dll');
  const secondOutput = join(secondRoot, 'IdaccProfileFileProbe.dll');
  try {
    const compiler = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($source)) { exit 1 }
$compilerParameters = [System.CodeDom.Compiler.CompilerParameters]::new()
$compilerParameters.CompilerOptions = '/optimize+ /debug- /deterministic'
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $env:IDACC_PROFILE_NATIVE_OUTPUT -OutputType Library -CompilerParameters $compilerParameters
if (-not [System.IO.File]::Exists($env:IDACC_PROFILE_NATIVE_OUTPUT)) { exit 1 }
`;
    for (const output of [firstOutput, secondOutput]) {
      runWindowsPowerShell(
        executable,
        compiler,
        nativeSource,
        { IDACC_PROFILE_NATIVE_OUTPUT: output },
      );
    }
    const assembly = readFileSync(firstOutput);
    const reproducedAssembly = readFileSync(secondOutput);
    for (const candidate of [assembly, reproducedAssembly]) {
      if (
        candidate.length < 1_024
        || candidate.length > 4 * 1024 * 1024
        || candidate[0] !== 0x4d
        || candidate[1] !== 0x5a
      ) {
        throw new Error('Windows profile native helper output is invalid');
      }
    }
    if (!assembly.equals(reproducedAssembly)) {
      throw new Error('Windows profile native helper compilation was not reproducible');
    }
    const assemblySha256 = createHash('sha256').update(assembly).digest('hex');
    const loader = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = [BitConverter]::ToString(
      $hasher.ComputeHash($bytes)
    ).Replace('-', '').ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
  if (-not [string]::Equals(
    $digest,
    [string]$env:IDACC_PROFILE_NATIVE_SHA256,
    [StringComparison]::Ordinal
  )) { exit 1 }
  $assembly = [Reflection.Assembly]::Load($bytes)
  $type = $assembly.GetType('IdaccProfileFileProbe', $false, $false)
  if (
    $null -eq $type -or
    $type.Assembly -ne $assembly -or
    -not $type.IsAbstract -or
    -not $type.IsSealed -or
    $null -eq $type.GetMethod('OpenLockedObject') -or
    $null -eq $type.GetMethod('GetObjectIdentity') -or
    $null -eq $type.GetMethod('AssertLockedPath') -or
    $null -eq $type.GetMethod('ReadLockedSecurityDescriptor') -or
    $null -eq $type.GetMethod('SetSecurityWithoutPropagation')
  ) { exit 1 }
  $runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $compilerPath = [System.IO.Path]::Combine($runtimeDirectory, 'csc.exe')
  if (-not [System.IO.File]::Exists($compilerPath)) { exit 1 }
  $compilerHasher = [Security.Cryptography.SHA256]::Create()
  try {
    $compilerStream = [System.IO.File]::OpenRead($compilerPath)
    try {
      $compilerDigest = [BitConverter]::ToString(
        $compilerHasher.ComputeHash($compilerStream)
      ).Replace('-', '').ToLowerInvariant()
    } finally {
      $compilerStream.Dispose()
    }
  } finally {
    $compilerHasher.Dispose()
  }
  [Console]::Out.WriteLine((@{
    powershellVersion = [string]$PSVersionTable.PSVersion
    clrVersion = [string][Environment]::Version
    compilerFileVersion = [string](
      [System.Diagnostics.FileVersionInfo]::GetVersionInfo(
        $compilerPath
      ).FileVersion
    )
    compilerSha256 = $compilerDigest
    codeDomAssembly = [string][Microsoft.CSharp.CSharpCodeProvider].Assembly.FullName
  } | ConvertTo-Json -Compress))
  exit 0
} catch {
  exit 1
}
`;
    const metadata = JSON.parse(runWindowsPowerShell(
      executable,
      loader,
      assembly.toString('base64'),
      { IDACC_PROFILE_NATIVE_SHA256: assemblySha256 },
    ));
    const corrupted = Buffer.from(assembly);
    corrupted[corrupted.length - 1] ^= 0x01;
    let corruptedAccepted = false;
    try {
      runWindowsPowerShell(
        executable,
        loader,
        corrupted.toString('base64'),
        { IDACC_PROFILE_NATIVE_SHA256: assemblySha256 },
      );
      corruptedAccepted = true;
    } catch {
      // Expected: the load path hashes bytes before loading the assembly.
    }
    if (corruptedAccepted) {
      throw new Error('Windows profile native helper accepted corrupted bytes');
    }
    return {
      sourceSha256,
      embedded: true,
      assemblySha256,
      byteLength: assembly.length,
      base64: assembly.toString('base64'),
      powershellVersion: String(metadata.powershellVersion || ''),
      clrVersion: String(metadata.clrVersion || ''),
      compilerFileVersion: String(metadata.compilerFileVersion || ''),
      compilerSha256: String(metadata.compilerSha256 || ''),
      codeDomAssembly: String(metadata.codeDomAssembly || ''),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function prepareWindowsJobHost(compilerProvenance) {
  const sourcePath = resolve(ROOT, 'src/native/IdaccJobHost.cs');
  const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
  if (
    source.length < 8_000
    || source.length > 1_000_000
    || source.includes('\0')
    || !source.includes('internal static class IdaccJobHost')
    || !source.includes('PROC_THREAD_ATTRIBUTE_JOB_LIST')
    || !source.includes('PROC_THREAD_ATTRIBUTE_HANDLE_LIST')
    || !source.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
  ) {
    throw new Error('Windows Job Host source is invalid');
  }
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  if (process.platform !== 'win32') {
    return {
      sourceSha256,
      available: false,
      executableSha256: null,
      byteLength: null,
      executable: null,
      expectedPublisher: '',
      verificationMode: 'unavailable',
      powershellVersion: null,
      clrVersion: null,
      compilerFileVersion: null,
      compilerSha256: null,
      codeDomAssembly: null,
    };
  }

  const signingRequested = Boolean(
    String(process.env.WIN_CSC_LINK || process.env.CSC_LINK || '').trim(),
  );
  const expectedPublisher = signingRequested
    ? String(process.env.WINDOWS_EXPECTED_PUBLISHER_SUBJECT || '').trim()
    : '';
  if (signingRequested && !expectedPublisher) {
    throw new Error(
      'WINDOWS_EXPECTED_PUBLISHER_SUBJECT is required for a signed Windows Job Host',
    );
  }

  const powershell = windowsPowerShellExecutable();
  const scratch = mkdtempSync(join(tmpdir(), 'idacc-job-host-'));
  const firstRoot = join(scratch, 'first');
  const secondRoot = join(scratch, 'second');
  mkdirSync(firstRoot, { recursive: false });
  mkdirSync(secondRoot, { recursive: false });
  const firstOutput = join(firstRoot, 'idacc-job-host.exe');
  const secondOutput = join(secondRoot, 'idacc-job-host.exe');
  try {
    const compiler = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($source)) { exit 1 }
$compilerParameters = [System.CodeDom.Compiler.CompilerParameters]::new()
$compilerParameters.GenerateExecutable = $true
$compilerParameters.GenerateInMemory = $false
$compilerParameters.IncludeDebugInformation = $false
$compilerParameters.MainClass = 'IdaccJobHost'
$compilerParameters.CompilerOptions = '/optimize+ /debug- /deterministic /platform:anycpu'
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $env:IDACC_JOB_HOST_OUTPUT -OutputType ConsoleApplication -CompilerParameters $compilerParameters
if (-not [System.IO.File]::Exists($env:IDACC_JOB_HOST_OUTPUT)) { exit 1 }
`;
    for (const output of [firstOutput, secondOutput]) {
      runWindowsPowerShell(
        powershell,
        compiler,
        source,
        { IDACC_JOB_HOST_OUTPUT: output },
      );
    }
    const executable = readFileSync(firstOutput);
    const reproducedExecutable = readFileSync(secondOutput);
    for (const candidate of [executable, reproducedExecutable]) {
      if (
        candidate.length < 4_096
        || candidate.length > 8 * 1024 * 1024
        || candidate[0] !== 0x4d
        || candidate[1] !== 0x5a
      ) {
        throw new Error('Windows Job Host compiler output is invalid');
      }
    }
    if (!executable.equals(reproducedExecutable)) {
      throw new Error('Windows Job Host compilation was not reproducible');
    }
    if (
      !/^[0-9a-f]{64}$/.test(String(compilerProvenance.compilerSha256 || ''))
      || !String(compilerProvenance.compilerFileVersion || '').trim()
      || !/Microsoft\.CSharp/i.test(String(compilerProvenance.codeDomAssembly || ''))
    ) {
      throw new Error('Windows Job Host compiler provenance is unavailable');
    }
    return {
      sourceSha256,
      available: true,
      executableSha256: createHash('sha256').update(executable).digest('hex'),
      byteLength: executable.length,
      executable,
      expectedPublisher,
      verificationMode: expectedPublisher ? 'authenticode-publisher' : 'sha256',
      powershellVersion: compilerProvenance.powershellVersion,
      clrVersion: compilerProvenance.clrVersion,
      compilerFileVersion: compilerProvenance.compilerFileVersion,
      compilerSha256: compilerProvenance.compilerSha256,
      codeDomAssembly: compilerProvenance.codeDomAssembly,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (requireRuntime && !existsSync(runtimeManifestPath)) {
  throw new Error(`release build requires a staged runtime manifest at ${runtimeManifestPath}`);
}
if (requireRuntime && !existsSync(runtimeLockPath)) {
  throw new Error(`release build requires a runtime lock at ${runtimeLockPath}`);
}
if (requireRuntime) {
  const runtimeManifest = readJson(runtimeManifestPath, 'runtime manifest');
  const runtimeLock = readJson(runtimeLockPath, 'runtime lock');
  const applicationPackage = readJson(resolve(ROOT, 'package.json'), 'desktop package');
  const errors = [
    ...validateRuntimeLock(runtimeLock),
    ...verifyRuntimeManifest(resolve(ROOT, 'resources/idacc-runtime'), runtimeManifest, runtimeLock),
  ];
  const git = (args) => execFileSync('git', args, {
    cwd: SOURCE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (runtimeManifest.application?.name !== applicationPackage.name) {
    errors.push('runtime manifest application name does not match the desktop package');
  }
  if (runtimeManifest.application?.dirty !== false) {
    errors.push('runtime manifest was staged from a dirty application checkout');
  }
  if (runtimeManifest.application?.version !== applicationPackage.version) {
    errors.push(`runtime manifest application version does not match ${applicationPackage.version}`);
  }
  if (runtimeManifest.application?.commit !== git(['rev-parse', 'HEAD'])) {
    errors.push('runtime manifest application commit does not match the release checkout');
  }
  if (runtimeManifest.application?.tree !== git(['rev-parse', 'HEAD^{tree}'])) {
    errors.push('runtime manifest application tree does not match the release checkout');
  }
  if (runtimeManifest.build?.platform !== process.platform) {
    errors.push(`runtime manifest platform ${runtimeManifest.build?.platform || '(missing)'} does not match ${process.platform}`);
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all'])) {
    errors.push('release build requires a clean application checkout');
  }
  if (errors.length) {
    throw new Error(`release runtime validation failed:\n- ${[...new Set(errors)].join('\n- ')}`);
  }
}
const runtimeManifestSha256 = existsSync(runtimeManifestPath)
  ? createHash('sha256').update(readFileSync(runtimeManifestPath)).digest('hex')
  : '';
const managedBootstrapSha256 = createHash('sha256')
  .update(readFileSync(managedBootstrapPath))
  .digest('hex');
const windowsProfileNative = prepareWindowsProfileNativeHelper(
  extractWindowsProfileNativeSource(),
);
const windowsJobHost = prepareWindowsJobHost(windowsProfileNative);
rmSync(resolve(ROOT, 'out'), { recursive: true, force: true });
mkdirSync(resolve(ROOT, 'out/renderer'), { recursive: true });
if (windowsJobHost.executable) {
  mkdirSync(resolve(ROOT, 'out/native'), { recursive: true });
  writeFileSync(
    resolve(ROOT, 'out/native/idacc-job-host.exe'),
    windowsJobHost.executable,
  );
}

const common = {
  bundle: true,
  sourcemap: !releaseBuild,
  minify: releaseBuild,
  legalComments: releaseBuild ? 'none' : 'inline',
  logLevel: 'info',
  loader: { '.ts': 'ts', '.tsx': 'tsx' },
  define: releaseBuild ? { 'process.env.NODE_ENV': '"production"' } : {},
};

await build({
  ...common,
  entryPoints: [resolve(ROOT, 'src/main/main.ts')],
  outfile: resolve(ROOT, 'out/main/main.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Native input binding (Computer Use mouse/keyboard) stays external — it's a
  // .node addon required at runtime from the shipped node_modules, not bundled.
  external: ['electron', '@nut-tree-fork/libnut-darwin', 'bindings'],
  define: {
    ...common.define,
    __IDACC_RUNTIME_MANIFEST_SHA256__: JSON.stringify(runtimeManifestSha256),
    __IDACC_WINDOWS_PROFILE_HELPER_EMBEDDED__: JSON.stringify(
      windowsProfileNative.embedded,
    ),
    __IDACC_WINDOWS_PROFILE_HELPER_BASE64__: JSON.stringify(
      windowsProfileNative.base64,
    ),
    __IDACC_WINDOWS_PROFILE_HELPER_SHA256__: JSON.stringify(
      windowsProfileNative.assemblySha256 || '',
    ),
    __IDACC_WINDOWS_PROFILE_HELPER_SOURCE_SHA256__: JSON.stringify(
      windowsProfileNative.sourceSha256,
    ),
    __IDACC_WINDOWS_JOB_HOST_AVAILABLE__: JSON.stringify(
      windowsJobHost.available,
    ),
    __IDACC_WINDOWS_JOB_HOST_SHA256__: JSON.stringify(
      windowsJobHost.executableSha256 || '',
    ),
    __IDACC_WINDOWS_JOB_HOST_EXPECTED_PUBLISHER__: JSON.stringify(
      windowsJobHost.expectedPublisher,
    ),
    __IDACC_MANAGED_SERVICE_BOOTSTRAP_SHA256__: JSON.stringify(
      managedBootstrapSha256,
    ),
    // Test-only post-CreateProcess abort injection must remain impossible to
    // activate from packaged application inputs.
    __IDACC_WINDOWS_JOB_HOST_ABORT_AFTER_READY_TEST__: 'false',
  },
});

await build({
  ...common,
  entryPoints: [resolve(ROOT, 'src/preload/preload.ts')],
  outfile: resolve(ROOT, 'out/preload/preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: { renderer: resolve(ROOT, 'src/renderer/main.tsx') },
  outdir: resolve(ROOT, 'out/renderer'),
  platform: 'browser',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: 'chrome120',
  jsx: 'automatic',
});

cpSync(resolve(ROOT, 'src/renderer/index.html'), resolve(ROOT, 'out/renderer/index.html'));
cpSync(
  managedBootstrapPath,
  resolve(ROOT, 'out/main/managed-service-bootstrap.cjs'),
);
writeFileSync(resolve(ROOT, 'out/build-mode.json'), JSON.stringify({
  mode: releaseBuild ? 'production' : 'development',
  runtimeManifestSha256: runtimeManifestSha256 || null,
  windowsProfileNative: {
    buildPlatform: process.platform,
    sourceSha256: windowsProfileNative.sourceSha256,
    embedded: windowsProfileNative.embedded,
    assemblySha256: windowsProfileNative.assemblySha256,
    byteLength: windowsProfileNative.byteLength,
    powershellVersion: windowsProfileNative.powershellVersion,
    clrVersion: windowsProfileNative.clrVersion,
    compilerFileVersion: windowsProfileNative.compilerFileVersion,
    compilerSha256: windowsProfileNative.compilerSha256,
    codeDomAssembly: windowsProfileNative.codeDomAssembly,
  },
  windowsJobHost: {
    buildPlatform: process.platform,
    sourceSha256: windowsJobHost.sourceSha256,
    available: windowsJobHost.available,
    executableSha256: windowsJobHost.executableSha256,
    byteLength: windowsJobHost.byteLength,
    verificationMode: windowsJobHost.verificationMode,
    expectedPublisher: windowsJobHost.expectedPublisher || null,
    bootstrapSha256: managedBootstrapSha256,
    powershellVersion: windowsJobHost.powershellVersion,
    clrVersion: windowsJobHost.clrVersion,
    compilerFileVersion: windowsJobHost.compilerFileVersion,
    compilerSha256: windowsJobHost.compilerSha256,
    codeDomAssembly: windowsJobHost.codeDomAssembly,
  },
}) + '\n');
console.log(`built ${releaseBuild ? 'production' : 'development'} bundle → out/`);
