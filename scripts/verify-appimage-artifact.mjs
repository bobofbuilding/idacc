#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
} from '../idctl-desktop/scripts/main-process-startup-policy.mjs';

export const REQUIRED_APPIMAGE_TOOLSET = '1.0.3';
export const REQUIRED_ELECTRON_BUILDER_VERSION = '26.15.7';
export const REQUIRED_APP_BUILDER_LIB_VERSION = '26.15.7';
const MAX_APP_RUN_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_BUILD_MODE_BYTES = 64 * 1024;
const MAX_MAIN_PROCESS_BYTES = 64 * 1024 * 1024;
const PACKAGED_MAIN_ENTRY = 'out/main/main.cjs';
const FORBIDDEN_DESKTOP_EXEC_ARGUMENT =
  /(?:^|[^A-Za-z0-9_-])--(?:no-sandbox|disable-setuid-sandbox)(?=$|[^A-Za-z0-9_-])/i;
const USAGE = 'usage: node scripts/verify-appimage-artifact.mjs '
  + '(--config-only | --appimage <path-to-AppImage> '
  + '--expected-build production|review)';
const CONDITIONAL_FALLBACK = `HAVE_NO_SANDBOX=0
for arg in "\${args[@]}" ; do
  if [ "$arg" = --no-sandbox ] ; then
    HAVE_NO_SANDBOX=1
    break
  fi
done
NO_SANDBOX=()
# Use 'unshare -Ur true' as a heuristic to detect whether user namespaces are available.`;
const CONDITIONAL_ASSIGNMENT =
  'if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then\n'
  + '  NO_SANDBOX=(--no-sandbox)\n'
  + 'fi';
const EXPECTED_EXEC_LINES = [
  'exec "$BIN" "${NO_SANDBOX[@]}"',
  'exec "$BIN" "${NO_SANDBOX[@]}" "${args[@]}"',
];

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const desktop = join(root, 'idctl-desktop');
const packageJsonPath = join(desktop, 'package.json');
const requireFromDesktop = createRequire(packageJsonPath);
const { extractFile } = requireFromDesktop('@electron/asar');
const { generateAppRunScript } = requireFromDesktop(
  'app-builder-lib/out/targets/appimage/appImageUtil.js',
);

function fail(message) {
  throw new Error(`AppImage artifact verification failed: ${message}`);
}

function safeBaseName(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || basename(value) !== value
    || !/^[A-Za-z0-9._ -]+$/.test(value)
  ) {
    fail(`${label} must be a safe file basename`);
  }
  return value;
}

function decodeBoundedUtf8(content, label, maximumBytes, minimumBytes = 1) {
  if (
    !Buffer.isBuffer(content)
    || content.length < minimumBytes
    || content.length > maximumBytes
  ) {
    fail(
      `${label} must be between ${minimumBytes} and ${maximumBytes} bytes`,
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
  if (text.includes('\0')) fail(`${label} must not contain NUL bytes`);
  return text.replace(/\r\n?/g, '\n');
}

function readBoundedUtf8(path, label, maximumBytes, minimumBytes = 1) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    fail(`${label} must be a regular file: ${path}`);
  }
  if (entry.size < minimumBytes || entry.size > maximumBytes) {
    fail(
      `${label} must be between ${minimumBytes} and ${maximumBytes} bytes: ${path}`,
    );
  }
  return decodeBoundedUtf8(
    readFileSync(path),
    label,
    maximumBytes,
    minimumBytes,
  );
}

export function parseAppImageVerifierArgs(args) {
  if (args.length === 1 && args[0] === '--config-only') {
    return { mode: 'config' };
  }
  if (
    args.length === 4
    && args[0] === '--appimage'
    && args[1]
    && !args[1].startsWith('--')
    && args[2] === '--expected-build'
    && ['production', 'review'].includes(args[3])
  ) {
    return {
      mode: 'artifact',
      appImage: resolve(args[1]),
      expectedBuild: args[3],
    };
  }
  throw new Error(USAGE);
}

export function verifyAppImageBuildConfig(pkg) {
  const electronBuilderVersion = pkg?.devDependencies?.['electron-builder'];
  if (electronBuilderVersion !== REQUIRED_ELECTRON_BUILDER_VERSION) {
    fail(
      `electron-builder must be exactly ${REQUIRED_ELECTRON_BUILDER_VERSION}; `
      + `received ${JSON.stringify(electronBuilderVersion)}`,
    );
  }
  const appBuilderPackage = JSON.parse(
    readFileSync(
      join(desktop, 'node_modules', 'app-builder-lib', 'package.json'),
      'utf8',
    ),
  );
  if (appBuilderPackage.version !== REQUIRED_APP_BUILDER_LIB_VERSION) {
    fail(
      `installed app-builder-lib must be exactly ${REQUIRED_APP_BUILDER_LIB_VERSION}; `
      + `received ${JSON.stringify(appBuilderPackage.version)}`,
    );
  }

  const toolset = pkg?.build?.toolsets?.appimage;
  if (toolset !== REQUIRED_APPIMAGE_TOOLSET) {
    fail(
      `build.toolsets.appimage must be exactly ${REQUIRED_APPIMAGE_TOOLSET}; `
      + `received ${JSON.stringify(toolset)}`,
    );
  }

  const executableArgs = pkg?.build?.appImage?.executableArgs;
  if (!Array.isArray(executableArgs) || executableArgs.length !== 0) {
    fail(
      'build.appImage.executableArgs must be an explicit empty array so no '
      + 'unconditional Electron sandbox-disabling argument can enter the desktop launcher',
    );
  }

  const desktopName = safeBaseName(pkg?.desktopName, 'desktopName');
  if (!desktopName.endsWith('.desktop')) {
    fail('desktopName must end with .desktop');
  }

  return {
    toolset,
    electronBuilderVersion,
    appBuilderLibVersion: appBuilderPackage.version,
    executableName: safeBaseName(
      pkg?.build?.linux?.executableName,
      'build.linux.executableName',
    ),
    desktopName,
    productName: safeBaseName(pkg?.productName, 'productName'),
  };
}

function decodeDesktopExec(value) {
  return value
    .replace(/\\s/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\(.)/g, '$1');
}

export function desktopExecDisablesSandbox(value) {
  return FORBIDDEN_DESKTOP_EXEC_ARGUMENT.test(decodeDesktopExec(String(value)));
}

export function inspectAppRunContent(text) {
  if (!text.startsWith('#!/usr/bin/env bash\nset -e\n')) {
    fail('AppRun must start with the pinned builder bash fail-fast prologue');
  }
  if (/--disable-setuid-sandbox/i.test(text)) {
    fail('AppRun contains forbidden --disable-setuid-sandbox behavior');
  }
  if ((text.match(/--no-sandbox/g) || []).length !== 3) {
    fail('AppRun does not contain exactly the pinned conditional --no-sandbox structure');
  }
  const fallback = text.indexOf(CONDITIONAL_FALLBACK);
  const assignment = text.indexOf(CONDITIONAL_ASSIGNMENT);
  const atexit = text.indexOf('\natexit()\n');
  if (
    fallback < 0
    || assignment <= fallback
    || atexit <= assignment
    || text.indexOf(CONDITIONAL_FALLBACK, fallback + 1) >= 0
    || text.indexOf(CONDITIONAL_ASSIGNMENT, assignment + 1) >= 0
  ) {
    fail('AppRun does not preserve the pinned ordered user-namespace fallback');
  }

  const execLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('exec '));
  if (
    execLines.length !== EXPECTED_EXEC_LINES.length
    || EXPECTED_EXEC_LINES.some((line, index) => execLines[index] !== line)
  ) {
    fail('AppRun contains an unconditional or replacement application launcher');
  }
  if (/\b(?:eval|bash|sh)\s+-c\b/.test(text)) {
    fail('AppRun contains a dynamic replacement launcher');
  }
  return {
    noSandboxOccurrences: 3,
    execCount: execLines.length,
  };
}

function expectedAppRun(config) {
  return generateAppRunScript({
    DesktopFileName: config.desktopName,
    ExecutableName: config.executableName,
    ProductName: config.productName,
    ProductFilename: config.productName,
    ResourceName: `appimagekit-${config.executableName}`,
  }).replace(/\r\n?/g, '\n');
}

function requireRegularExecutable(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail(`${label} must be a regular file: ${path}`);
  }
  if ((entry.mode & 0o111) === 0) {
    fail(`${label} is not executable: ${path}`);
  }
}

function requireRegularFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail(`${label} must be a regular file: ${path}`);
  }
}

function collectDesktopFiles(extractedRoot) {
  const files = [];
  const pending = [extractedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith('.desktop')) {
          fail(`desktop entry must not be a symbolic link: ${path}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.desktop')) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function readDesktopExecEntries(path) {
  const text = readBoundedUtf8(
    path,
    'desktop entry',
    1024 * 1024,
  );
  return text
    .split('\n')
    .map((line, index) => {
      const match = /^\s*Exec\s*=(.*)$/.exec(line);
      return match
        ? {
            line: index + 1,
            value: match[1].trim(),
          }
        : null;
    })
    .filter(Boolean);
}

function assertContained(rootPath, path, label) {
  const realRoot = realpathSync(rootPath);
  const realPath = realpathSync(path);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
    fail(`${label} escapes the extracted AppImage root`);
  }
}

export function verifyPackagedMainProcess(
  packageJsonContent,
  buildModeContent,
  mainProcessContent,
  expectedBuild,
) {
  if (!['production', 'review'].includes(expectedBuild)) {
    fail('expected AppImage build identity must be production or review');
  }
  const packageJsonText = decodeBoundedUtf8(
    packageJsonContent,
    'packaged package.json',
    MAX_PACKAGE_JSON_BYTES,
  );
  let packaged;
  try {
    packaged = JSON.parse(packageJsonText);
  } catch {
    fail('packaged package.json is not valid JSON');
  }
  if (packaged?.main !== PACKAGED_MAIN_ENTRY) {
    fail(
      `packaged Electron main entry must be exactly ${PACKAGED_MAIN_ENTRY}`,
    );
  }
  const buildModeText = decodeBoundedUtf8(
    buildModeContent,
    'packaged build-mode.json',
    MAX_BUILD_MODE_BYTES,
  );
  let buildMode;
  try {
    buildMode = JSON.parse(buildModeText);
  } catch {
    fail('packaged build-mode.json is not valid JSON');
  }
  const expectedMode = expectedBuild === 'review' ? 'review' : 'production';
  if (
    buildMode?.mode !== 'production'
    || buildMode?.reviewOnly !== (expectedBuild === 'review')
    || buildMode?.mainProcessStartupPolicy?.mode !== expectedMode
    || buildMode?.mainProcessStartupPolicy?.marker
      !== mainProcessStartupPolicyMarker(expectedMode)
    || buildMode?.mainProcessStartupPolicy?.rejectsLinuxSandboxDisableSwitches
      !== true
  ) {
    fail(`packaged build mode does not match the ${expectedBuild} startup policy`);
  }

  const mainProcess = decodeBoundedUtf8(
    mainProcessContent,
    'packaged main process',
    MAX_MAIN_PROCESS_BYTES,
    1024,
  );
  const banner = mainProcessStartupBanner(expectedMode);
  const marker = mainProcessStartupPolicyMarker(expectedMode);
  if (
    !mainProcess.startsWith(banner)
    || mainProcess.indexOf(marker, banner.length) >= 0
  ) {
    fail(`packaged main process does not start with the exact ${expectedMode} policy banner`);
  }
  for (const required of [
    'electron.app.enableSandbox()',
    'disable-setuid-sandbox',
    '.deb package',
    'process.stderr.write',
    'process.exit(78)',
  ]) {
    if (!banner.includes(required)) {
      fail(`packaged main-process policy banner is missing ${required}`);
    }
  }
  return {
    expectedBuild,
    policyMode: expectedMode,
    marker,
  };
}

function inspectPackagedMainProcess(extractedRoot, expectedBuild) {
  const asarPath = join(extractedRoot, 'resources', 'app.asar');
  requireRegularFile(asarPath, 'packaged app.asar');
  assertContained(extractedRoot, asarPath, 'packaged app.asar');
  let packageJsonContent;
  let buildModeContent;
  let mainProcessContent;
  try {
    packageJsonContent = extractFile(asarPath, 'package.json');
    buildModeContent = extractFile(asarPath, 'out/build-mode.json');
    mainProcessContent = extractFile(asarPath, 'out/main/main.cjs');
  } catch (error) {
    fail(`cannot extract packaged startup policy evidence: ${error.message}`);
  }
  return verifyPackagedMainProcess(
    packageJsonContent,
    buildModeContent,
    mainProcessContent,
    expectedBuild,
  );
}

export function inspectExtractedAppImage(
  extractedRoot,
  config,
  expectedBuild,
) {
  const rootPath = resolve(extractedRoot);
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    fail(`extracted AppImage root is missing: ${rootPath}`);
  }

  const appRun = join(rootPath, 'AppRun');
  const executable = join(rootPath, config.executableName);
  const primaryDesktop = join(rootPath, config.desktopName);
  requireRegularExecutable(appRun, 'AppRun');
  requireRegularExecutable(executable, 'packaged application executable');
  if (!existsSync(primaryDesktop) || !lstatSync(primaryDesktop).isFile()) {
    fail(`primary desktop entry is missing: ${primaryDesktop}`);
  }
  assertContained(rootPath, appRun, 'AppRun');
  assertContained(rootPath, executable, 'packaged application executable');
  assertContained(rootPath, primaryDesktop, 'primary desktop entry');

  const appRunText = readBoundedUtf8(
    appRun,
    'AppRun',
    MAX_APP_RUN_BYTES,
    1024,
  );
  const appRunPolicy = inspectAppRunContent(appRunText);
  if (appRunText !== expectedAppRun(config)) {
    fail(
      'AppRun does not exactly match the lockfile-pinned app-builder-lib launcher',
    );
  }

  const desktopFiles = collectDesktopFiles(rootPath);
  if (desktopFiles.length === 0) fail('no desktop entries were extracted');

  let execCount = 0;
  let primaryExecUsesAppRun = false;
  for (const desktopFile of desktopFiles) {
    const entries = readDesktopExecEntries(desktopFile);
    for (const entry of entries) {
      execCount += 1;
      if (desktopExecDisablesSandbox(entry.value)) {
        fail(
          `${desktopFile}:${entry.line} contains an unconditional Electron `
          + 'sandbox-disabling argument in Exec=',
        );
      }
      if (
        desktopFile === primaryDesktop
        && /^AppRun(?:\s|$)/.test(decodeDesktopExec(entry.value))
      ) {
        primaryExecUsesAppRun = true;
      }
    }
  }
  if (execCount === 0) fail('no desktop Exec= entries were extracted');
  if (!primaryExecUsesAppRun) {
    fail('primary desktop Exec= does not launch AppRun');
  }

  const mainProcessPolicy = inspectPackagedMainProcess(rootPath, expectedBuild);
  return {
    appRun,
    executable,
    desktopFiles,
    execCount,
    appRunPolicy,
    mainProcessPolicy,
  };
}

export function verifyAppImageArtifact(
  appImagePath,
  pkg,
  expectedBuild,
) {
  const config = verifyAppImageBuildConfig(pkg);
  if (process.platform !== 'linux') {
    fail('artifact extraction must run on Linux');
  }
  if (!appImagePath.endsWith('.AppImage')) {
    fail(`artifact must use the .AppImage extension: ${appImagePath}`);
  }
  if (!existsSync(appImagePath)) fail(`artifact is missing: ${appImagePath}`);
  const artifact = lstatSync(appImagePath);
  if (artifact.isSymbolicLink() || !artifact.isFile()) {
    fail(`artifact must be a regular file: ${appImagePath}`);
  }
  if ((artifact.mode & 0o111) === 0) {
    fail(`artifact is not executable: ${appImagePath}`);
  }

  const extractionParent = mkdtempSync(join(tmpdir(), 'idacc-appimage-verify-'));
  try {
    const execution = spawnSync(realpathSync(appImagePath), ['--appimage-extract'], {
      cwd: extractionParent,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        APPIMAGE_SILENT_INSTALL: '1',
      },
    });
    if (execution.error || execution.status !== 0) {
      fail(
        `--appimage-extract failed (status=${execution.status}, `
        + `signal=${execution.signal || 'none'}, `
        + `error=${execution.error?.message || 'none'})`
        + `\nstdout:\n${execution.stdout || ''}`
        + `\nstderr:\n${execution.stderr || ''}`,
      );
    }

    const extractedRoot = join(extractionParent, 'squashfs-root');
    const inspected = inspectExtractedAppImage(
      extractedRoot,
      config,
      expectedBuild,
    );
    return {
      ...config,
      expectedBuild,
      policyMode: inspected.mainProcessPolicy.policyMode,
      desktopCount: inspected.desktopFiles.length,
      execCount: inspected.execCount,
    };
  } finally {
    rmSync(extractionParent, { recursive: true, force: true });
  }
}

function loadPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseAppImageVerifierArgs(process.argv.slice(2));
    const pkg = loadPackageJson();
    if (options.mode === 'config') {
      const config = verifyAppImageBuildConfig(pkg);
      console.log(
        `AppImage build policy verified: electron-builder@${config.electronBuilderVersion}, `
        + `app-builder-lib@${config.appBuilderLibVersion}, appimage@${config.toolset}, `
        + 'an explicit empty desktop executable argument list, and a pinned conditional launcher.',
      );
    } else {
      const result = verifyAppImageArtifact(
        options.appImage,
        pkg,
        options.expectedBuild,
      );
      console.log(
        `AppImage artifact verified: ${result.expectedBuild} ${result.policyMode} `
        + `startup guard, appimage@${result.toolset}, pinned conditional AppRun, `
        + `${result.executableName}, ${result.desktopCount} desktop file(s), `
        + `and ${result.execCount} safe Exec= entry(ies).`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
