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
  readdirSync,
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
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
  mainProcessStartupPolicyMode,
} from './main-process-startup-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = resolve(ROOT, '..');
const runtimeManifestPath = resolve(ROOT, 'resources/idacc-runtime/manifest.json');
const runtimeLockPath = resolve(SOURCE_ROOT, 'release/runtime-lock.json');
const managedBootstrapPath = resolve(ROOT, 'src/main/managed-service-bootstrap.cjs');
const mcpProbeRunnerPath = resolve(ROOT, 'src/main/mcp-probe-runner.cjs');
const requireRuntime = process.argv.includes('--require-runtime');
const releaseBuild = requireRuntime || process.argv.includes('--release');
const reviewBuild = releaseBuild && process.env.IDACC_REVIEW_BUILD === '1';
const mainProcessPolicyMode = mainProcessStartupPolicyMode({
  releaseBuild,
  reviewBuild,
});
const mainProcessPolicyMarker =
  mainProcessStartupPolicyMarker(mainProcessPolicyMode);
const sourcePackageVersion = JSON.parse(
  readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
).version;
const reviewVersion = reviewBuild
  ? String(process.env.IDACC_REVIEW_VERSION || '').trim()
  : null;
if (
  reviewBuild
  && !new RegExp(`^${sourcePackageVersion.replaceAll('.', '\\.')}\\-review\\.[1-9][0-9]*$`)
    .test(reviewVersion || '')
) {
  throw new Error(
    'review builds require IDACC_REVIEW_VERSION=<source-version>-review.<positive-run-number>',
  );
}

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

function requireLocalWindowsPath(value, label, expectedBasename = '') {
  const normalized = win32.normalize(String(value || '').trim());
  if (
    !normalized
    || !win32.isAbsolute(normalized)
    || !/^[A-Za-z]:\\/.test(normalized)
    || normalized.startsWith('\\\\')
    || normalized.slice(win32.parse(normalized).root.length).includes(':')
    || (expectedBasename && win32.basename(normalized).toLowerCase() !== expectedBasename)
  ) {
    throw new Error(`${label} is unavailable`);
  }
  return normalized;
}

function windowsRoslynCompilerExecutable() {
  const programFilesX86 = requireLocalWindowsPath(
    process.env['ProgramFiles(x86)'] || process.env.ProgramFiles,
    'Windows Program Files directory',
  );
  const vswhere = requireLocalWindowsPath(
    win32.join(
      programFilesX86,
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    ),
    'Visual Studio discovery tool',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) {
    throw new Error('Visual Studio discovery tool is unavailable');
  }
  const result = spawnSync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.Roslyn.Compiler',
    '-find',
    String.raw`MSBuild\Current\Bin\Roslyn\csc.exe`,
  ], {
    encoding: 'utf8',
    env: {
      SystemRoot: process.env.SystemRoot || process.env.WINDIR,
      WINDIR: process.env.WINDIR || process.env.SystemRoot,
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  const candidates = String(result.stdout || '')
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    result.error
    || result.signal
    || result.status !== 0
    || candidates.length !== 1
  ) {
    throw new Error('Visual Studio Roslyn compiler discovery failed');
  }
  const compiler = requireLocalWindowsPath(
    candidates[0],
    'Visual Studio Roslyn compiler',
    'csc.exe',
  );
  if (
    !/\\MSBuild\\Current\\Bin\\Roslyn\\csc\.exe$/i.test(compiler)
    || !existsSync(compiler)
  ) {
    throw new Error('Visual Studio Roslyn compiler is unavailable');
  }
  return compiler;
}

function windowsNetFrameworkReferences() {
  const programFilesX86 = requireLocalWindowsPath(
    process.env['ProgramFiles(x86)'] || process.env.ProgramFiles,
    'Windows Program Files directory',
  );
  const directory = requireLocalWindowsPath(
    win32.join(
      programFilesX86,
      'Reference Assemblies',
      'Microsoft',
      'Framework',
      '.NETFramework',
      'v4.8',
    ),
    '.NET Framework 4.8 reference directory',
  );
  const references = ['mscorlib.dll', 'System.dll', 'System.Core.dll']
    .map((name) => requireLocalWindowsPath(
      win32.join(directory, name),
      `.NET Framework 4.8 ${name}`,
      name.toLowerCase(),
    ));
  if (references.some((reference) => !existsSync(reference))) {
    throw new Error('.NET Framework 4.8 reference assemblies are unavailable');
  }
  return references;
}

function hashWindowsFileEntries(entries, label) {
  if (entries.length < 1 || entries.length > 4_096) {
    throw new Error(`${label} file set is invalid`);
  }
  const digest = createHash('sha256');
  let byteLength = 0;
  for (const entry of [...entries].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const content = readFileSync(entry.path);
    byteLength += content.length;
    if (
      !entry.name
      || entry.name.includes('\0')
      || byteLength > 1024 * 1024 * 1024
    ) {
      throw new Error(`${label} file set is invalid`);
    }
    digest.update(entry.name, 'utf8');
    digest.update('\0');
    digest.update(String(content.length), 'utf8');
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return {
    sha256: digest.digest('hex'),
    fileCount: entries.length,
    byteLength,
  };
}

function hashWindowsDirectory(root, label) {
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ));
    for (const entry of entries) {
      const path = win32.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push({
          name: win32.relative(root, path).replaceAll('\\', '/'),
          path,
        });
      } else {
        throw new Error(`${label} contains an unsupported filesystem entry`);
      }
      if (files.length > 4_096) {
        throw new Error(`${label} contains too many files`);
      }
    }
  };
  visit(root);
  return hashWindowsFileEntries(files, label);
}

function windowsRoslynToolchain() {
  const executable = windowsRoslynCompilerExecutable();
  const references = windowsNetFrameworkReferences();
  const compilerTree = hashWindowsDirectory(
    win32.dirname(executable),
    'Visual Studio Roslyn compiler tree',
  );
  const referenceSet = hashWindowsFileEntries(
    references.map((path) => ({
      name: win32.basename(path).toLowerCase(),
      path,
    })),
    '.NET Framework 4.8 reference set',
  );
  const compilationInputsSha256 = createHash('sha256')
    .update('visual-studio-roslyn\0net48\0', 'utf8')
    .update(compilerTree.sha256, 'utf8')
    .update('\0')
    .update(referenceSet.sha256, 'utf8')
    .digest('hex');
  return {
    executable,
    references,
    compilerTree,
    referenceSet,
    compilationInputsSha256,
  };
}

function runWindowsCompiler(
  executable,
  source,
  output,
  references,
  target,
  pathMapSource,
  mainClass = '',
) {
  if (/[=,]/.test(pathMapSource)) {
    throw new Error('Windows native helper source root is unsupported');
  }
  const args = [
    '/nologo',
    '/noconfig',
    '/utf8output',
    '/deterministic+',
    '/optimize+',
    '/debug-',
    '/warn:4',
    '/warnaserror+',
    // Win32 fills the declared interop-layout fields outside C#'s assignment
    // analysis. Keep every other compiler warning fatal.
    '/nowarn:0649',
    '/langversion:5',
    '/platform:anycpu',
    '/nostdlib+',
    `/target:${target}`,
    `/out:${output}`,
    `/pathmap:${pathMapSource}=/_/idacc-native`,
    ...references.map((reference) => `/reference:${reference}`),
  ];
  if (mainClass) args.push(`/main:${mainClass}`);
  args.push(source);
  const environment = {
    SystemRoot: process.env.SystemRoot || process.env.WINDIR,
    WINDIR: process.env.WINDIR || process.env.SystemRoot,
  };
  for (const key of ['ComSpec', 'TEMP', 'TMP']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  const result = spawnSync(executable, args, {
    cwd: win32.dirname(executable),
    encoding: 'utf8',
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    const diagnosticCodes = [
      ...String(result.stdout || '').matchAll(/\b(?:CS|BC)\d{4}\b/g),
      ...String(result.stderr || '').matchAll(/\b(?:CS|BC)\d{4}\b/g),
    ].map((match) => match[0]).filter((entry, index, all) => (
      all.indexOf(entry) === index
    )).slice(0, 8);
    const suffix = diagnosticCodes.length > 0
      ? ` (${diagnosticCodes.join(', ')})`
      : '';
    throw new Error(`Windows Roslyn compilation failed${suffix}`);
  }
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
      compilerAssembly: null,
      compilerKind: null,
      targetFramework: null,
      deterministic: null,
      compilerTreeSha256: null,
      compilerTreeFileCount: null,
      compilerTreeByteLength: null,
      referenceSetSha256: null,
      referenceFileCount: null,
      referenceByteLength: null,
      compilationInputsSha256: null,
    };
  }

  const executable = windowsPowerShellExecutable();
  const toolchain = windowsRoslynToolchain();
  const compilerExecutable = toolchain.executable;
  const references = toolchain.references;
  const scratch = mkdtempSync(join(tmpdir(), 'idacc-profile-native-'));
  const firstRoot = join(scratch, 'first');
  const secondRoot = join(scratch, 'second');
  mkdirSync(firstRoot, { recursive: false });
  mkdirSync(secondRoot, { recursive: false });
  const sourcePath = join(scratch, 'IdaccProfileFileProbe.cs');
  const firstOutput = join(firstRoot, 'IdaccProfileFileProbe.dll');
  const secondOutput = join(secondRoot, 'IdaccProfileFileProbe.dll');
  writeFileSync(sourcePath, nativeSource, 'utf8');
  try {
    for (const output of [firstOutput, secondOutput]) {
      runWindowsCompiler(
        compilerExecutable,
        sourcePath,
        output,
        references,
        'library',
        scratch,
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
  $compilerPath = [string]$env:IDACC_PROFILE_NATIVE_COMPILER
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
    compilerAssembly = [string](
      [Reflection.AssemblyName]::GetAssemblyName($compilerPath).FullName
    )
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
      {
        IDACC_PROFILE_NATIVE_SHA256: assemblySha256,
        IDACC_PROFILE_NATIVE_COMPILER: compilerExecutable,
      },
    ));
    const corrupted = Buffer.from(assembly);
    corrupted[corrupted.length - 1] ^= 0x01;
    let corruptedAccepted = false;
    try {
      runWindowsPowerShell(
        executable,
        loader,
        corrupted.toString('base64'),
        {
          IDACC_PROFILE_NATIVE_SHA256: assemblySha256,
          IDACC_PROFILE_NATIVE_COMPILER: compilerExecutable,
        },
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
      compilerAssembly: String(metadata.compilerAssembly || ''),
      compilerKind: 'visual-studio-roslyn',
      targetFramework: 'net48',
      deterministic: true,
      compilerTreeSha256: toolchain.compilerTree.sha256,
      compilerTreeFileCount: toolchain.compilerTree.fileCount,
      compilerTreeByteLength: toolchain.compilerTree.byteLength,
      referenceSetSha256: toolchain.referenceSet.sha256,
      referenceFileCount: toolchain.referenceSet.fileCount,
      referenceByteLength: toolchain.referenceSet.byteLength,
      compilationInputsSha256: toolchain.compilationInputsSha256,
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
      compilerAssembly: null,
      compilerKind: null,
      targetFramework: null,
      deterministic: null,
      compilerTreeSha256: null,
      compilerTreeFileCount: null,
      compilerTreeByteLength: null,
      referenceSetSha256: null,
      referenceFileCount: null,
      referenceByteLength: null,
      compilationInputsSha256: null,
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

  const toolchain = windowsRoslynToolchain();
  const compilerExecutable = toolchain.executable;
  const references = toolchain.references;
  const scratch = mkdtempSync(join(tmpdir(), 'idacc-job-host-'));
  const firstRoot = join(scratch, 'first');
  const secondRoot = join(scratch, 'second');
  mkdirSync(firstRoot, { recursive: false });
  mkdirSync(secondRoot, { recursive: false });
  const sourceFile = join(scratch, 'IdaccJobHost.cs');
  const firstOutput = join(firstRoot, 'idacc-job-host.exe');
  const secondOutput = join(secondRoot, 'idacc-job-host.exe');
  writeFileSync(sourceFile, source, 'utf8');
  try {
    for (const output of [firstOutput, secondOutput]) {
      runWindowsCompiler(
        compilerExecutable,
        sourceFile,
        output,
        references,
        'exe',
        scratch,
        'IdaccJobHost',
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
      || !/^csc,/i.test(String(compilerProvenance.compilerAssembly || ''))
      || compilerProvenance.compilerKind !== 'visual-studio-roslyn'
      || compilerProvenance.targetFramework !== 'net48'
      || compilerProvenance.deterministic !== true
      || toolchain.compilerTree.sha256 !== compilerProvenance.compilerTreeSha256
      || toolchain.compilerTree.fileCount !== compilerProvenance.compilerTreeFileCount
      || toolchain.compilerTree.byteLength !== compilerProvenance.compilerTreeByteLength
      || toolchain.referenceSet.sha256 !== compilerProvenance.referenceSetSha256
      || toolchain.referenceSet.fileCount !== compilerProvenance.referenceFileCount
      || toolchain.referenceSet.byteLength !== compilerProvenance.referenceByteLength
      || toolchain.compilationInputsSha256
        !== compilerProvenance.compilationInputsSha256
      || createHash('sha256').update(readFileSync(compilerExecutable)).digest('hex')
        !== compilerProvenance.compilerSha256
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
      compilerAssembly: compilerProvenance.compilerAssembly,
      compilerKind: compilerProvenance.compilerKind,
      targetFramework: compilerProvenance.targetFramework,
      deterministic: compilerProvenance.deterministic,
      compilerTreeSha256: compilerProvenance.compilerTreeSha256,
      compilerTreeFileCount: compilerProvenance.compilerTreeFileCount,
      compilerTreeByteLength: compilerProvenance.compilerTreeByteLength,
      referenceSetSha256: compilerProvenance.referenceSetSha256,
      referenceFileCount: compilerProvenance.referenceFileCount,
      referenceByteLength: compilerProvenance.referenceByteLength,
      compilationInputsSha256: compilerProvenance.compilationInputsSha256,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes('--probe-windows-native-toolchain')) {
  const profileHelper = prepareWindowsProfileNativeHelper(
    extractWindowsProfileNativeSource(),
  );
  const jobHost = prepareWindowsJobHost(profileHelper);
  if (process.platform === 'win32') {
    if (
      !profileHelper.embedded
      || !jobHost.available
      || profileHelper.compilerKind !== 'visual-studio-roslyn'
      || jobHost.compilerKind !== 'visual-studio-roslyn'
      || profileHelper.compilerSha256 !== jobHost.compilerSha256
      || profileHelper.compilationInputsSha256
        !== jobHost.compilationInputsSha256
    ) {
      throw new Error('Windows native toolchain probe did not produce both helpers');
    }
  }
  console.log(
    process.platform === 'win32'
      ? 'Windows native toolchain probe: ok'
      : 'Windows native toolchain probe: skipped on non-Windows',
  );
  process.exit(0);
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
  entryPoints: [mcpProbeRunnerPath],
  outfile: resolve(ROOT, 'out/main/mcp-probe-runner.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
});
const mcpProbeRunnerSha256 = createHash('sha256')
  .update(readFileSync(resolve(ROOT, 'out/main/mcp-probe-runner.cjs')))
  .digest('hex');

await build({
  ...common,
  entryPoints: [resolve(ROOT, 'src/main/main.ts')],
  outfile: resolve(ROOT, 'out/main/main.cjs'),
  banner: {
    js: mainProcessStartupBanner(mainProcessPolicyMode),
  },
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Native input binding (Computer Use mouse/keyboard) stays external — it's a
  // .node addon required at runtime from the shipped node_modules, not bundled.
  external: ['electron', '@nut-tree-fork/libnut-darwin', 'bindings'],
  define: {
    ...common.define,
    __IDACC_REVIEW_BUILD__: JSON.stringify(reviewBuild),
    __IDACC_SOURCE_PACKAGE_VERSION__: JSON.stringify(sourcePackageVersion),
    __IDACC_PACKAGED_APPLICATION_VERSION__: JSON.stringify(
      reviewVersion || sourcePackageVersion,
    ),
    __IDACC_UPDATE_CHANNEL_POLICY__: JSON.stringify(
      reviewBuild
        ? 'idacc-review-updater-disabled:v1'
        : 'idacc-production-updater-enabled:v1',
    ),
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
    __IDACC_MCP_PROBE_RUNNER_SHA256__: JSON.stringify(
      mcpProbeRunnerSha256,
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
  reviewOnly: reviewBuild,
  updaterEnabled: !reviewBuild,
  mainProcessStartupPolicy: {
    mode: mainProcessPolicyMode,
    marker: mainProcessPolicyMarker,
    rejectsLinuxSandboxDisableSwitches: releaseBuild,
  },
  sourceVersion: sourcePackageVersion,
  applicationVersion: reviewVersion || sourcePackageVersion,
  runtimeManifestSha256: runtimeManifestSha256 || null,
  mcpProbeRunnerSha256,
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
    compilerAssembly: windowsProfileNative.compilerAssembly,
    compilerKind: windowsProfileNative.compilerKind,
    targetFramework: windowsProfileNative.targetFramework,
    deterministic: windowsProfileNative.deterministic,
    compilerTreeSha256: windowsProfileNative.compilerTreeSha256,
    compilerTreeFileCount: windowsProfileNative.compilerTreeFileCount,
    compilerTreeByteLength: windowsProfileNative.compilerTreeByteLength,
    referenceSetSha256: windowsProfileNative.referenceSetSha256,
    referenceFileCount: windowsProfileNative.referenceFileCount,
    referenceByteLength: windowsProfileNative.referenceByteLength,
    compilationInputsSha256: windowsProfileNative.compilationInputsSha256,
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
    compilerAssembly: windowsJobHost.compilerAssembly,
    compilerKind: windowsJobHost.compilerKind,
    targetFramework: windowsJobHost.targetFramework,
    deterministic: windowsJobHost.deterministic,
    compilerTreeSha256: windowsJobHost.compilerTreeSha256,
    compilerTreeFileCount: windowsJobHost.compilerTreeFileCount,
    compilerTreeByteLength: windowsJobHost.compilerTreeByteLength,
    referenceSetSha256: windowsJobHost.referenceSetSha256,
    referenceFileCount: windowsJobHost.referenceFileCount,
    referenceByteLength: windowsJobHost.referenceByteLength,
    compilationInputsSha256: windowsJobHost.compilationInputsSha256,
  },
}) + '\n');
console.log(`built ${releaseBuild ? 'production' : 'development'} bundle → out/`);
