#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_ELECTRON_BUILDER_VERSION = '26.15.7';
export const PINNED_ELECTRON_BUILDER_INTEGRITY =
  'sha512-DBpaNzxsPs1BvEblzFoNriSbzsBqDCy/gseIngeEhYzQG1IxfB7Hvc2tBBVmpWE2BTQGP9J1RrAvDT+Vc/uAxg==';
export const PINNED_APP_BUILDER_LIB_INTEGRITY =
  'sha512-C7APoYISPExUmrEntNhDpz9Tccb4uWuEDfLaC0WPPc7/pwzz0WZGznCz/ycPfkkzw6tKOalceD8g6TgHmVz1QA==';
export const PINNED_AFTER_INSTALL_TEMPLATE_SHA256 =
  '228d700c9698f3d879d03d395f40aa979ed0729d8b5a376b6fcf35a4a72c6006';
export const PINNED_APPARMOR_TEMPLATE_SHA256 =
  '602d133ff00bea2636778e10eb7981b51e96038d1fe398ac9a51790071f79699';

const EXPECTED_PRODUCT_NAME = 'ID Agents Control Center';
const EXPECTED_EXECUTABLE = 'idagents-control-center';
const DPKG_DEB_PATH = '/usr/bin/dpkg-deb';
const TAR_PATH = '/usr/bin/tar';
const MAX_LISTING_BYTES = 128 * 1024 * 1024;
const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
export const DEFAULT_DEB_PIPELINE_TIMEOUT_MS = 300_000;
const FORBIDDEN_SANDBOX_ARGUMENT =
  /(?:^|[^A-Za-z0-9_-])--(?:no-sandbox|disable-setuid-sandbox)(?:=[^\s"'\\]*)?(?=$|[^A-Za-z0-9_-])/i;
const USAGE = 'usage: node scripts/verify-deb-artifact.mjs '
  + '(--config-only | --deb <path-to-deb>)';

const scriptPath = fileURLToPath(import.meta.url);
const root = dirname(dirname(scriptPath));
const desktopRoot = join(root, 'idctl-desktop');
const packageJsonPath = join(desktopRoot, 'package.json');
const packageLockPath = join(desktopRoot, 'package-lock.json');
const builderPackagePath = join(
  desktopRoot,
  'node_modules',
  'app-builder-lib',
  'package.json',
);
const afterInstallTemplatePath = join(
  desktopRoot,
  'node_modules',
  'app-builder-lib',
  'templates',
  'linux',
  'after-install.tpl',
);
const appArmorTemplatePath = join(
  desktopRoot,
  'node_modules',
  'app-builder-lib',
  'templates',
  'linux',
  'apparmor-profile.tpl',
);

function fail(message) {
  throw new Error(`DEB artifact verification failed: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    fail(`${label} must be exactly ${JSON.stringify(expected)}; received ${JSON.stringify(value)}`);
  }
}

function requireSafeConfiguredName(value, expected, label) {
  requireExact(value, expected, label);
  if (
    basename(value) !== value
    || value === '.'
    || value === '..'
    || /[\0\r\n/\\]/.test(value)
  ) {
    fail(`${label} is not a safe single path component`);
  }
  return value;
}

function renderPinnedTemplate(template, replacements, label) {
  const rendered = template.replace(
    /\$\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, key) => {
      if (!Object.hasOwn(replacements, key)) {
        fail(`${label} contains unsupported placeholder ${match}`);
      }
      return replacements[key];
    },
  );
  if (/\$\{[A-Za-z][A-Za-z0-9]*\}/.test(rendered)) {
    fail(`${label} contains an unresolved placeholder`);
  }
  return rendered;
}

function assertPinnedTemplate(template, expectedHash, label) {
  requireExact(sha256(template), expectedHash, `${label} SHA-256`);
}

export function parseDebVerifierArgs(args) {
  if (args.length === 1 && args[0] === '--config-only') {
    return { mode: 'config' };
  }
  if (
    args.length === 2
    && args[0] === '--deb'
    && args[1]
    && !args[1].startsWith('--')
  ) {
    return {
      mode: 'artifact',
      deb: resolve(args[1]),
    };
  }
  throw new Error(USAGE);
}

export function verifyDebBuildConfig({
  packageJson,
  packageLock,
  builderPackage,
  afterInstallTemplate,
  appArmorTemplate,
}) {
  const productName = requireSafeConfiguredName(
    packageJson?.productName,
    EXPECTED_PRODUCT_NAME,
    'productName',
  );
  const executable = requireSafeConfiguredName(
    packageJson?.build?.linux?.executableName,
    EXPECTED_EXECUTABLE,
    'build.linux.executableName',
  );
  const targets = packageJson?.build?.linux?.target;
  if (!Array.isArray(targets) || targets.filter((target) => target === 'deb').length !== 1) {
    fail('build.linux.target must contain exactly one deb target');
  }

  requireExact(
    packageJson?.devDependencies?.['electron-builder'],
    PINNED_ELECTRON_BUILDER_VERSION,
    'package.json electron-builder pin',
  );
  requireExact(
    packageLock?.packages?.['']?.devDependencies?.['electron-builder'],
    PINNED_ELECTRON_BUILDER_VERSION,
    'package-lock root electron-builder pin',
  );
  const electronBuilderLock = packageLock?.packages?.['node_modules/electron-builder'];
  requireExact(
    electronBuilderLock?.version,
    PINNED_ELECTRON_BUILDER_VERSION,
    'package-lock electron-builder version',
  );
  requireExact(
    electronBuilderLock?.integrity,
    PINNED_ELECTRON_BUILDER_INTEGRITY,
    'package-lock electron-builder integrity',
  );
  const appBuilderLock = packageLock?.packages?.['node_modules/app-builder-lib'];
  requireExact(
    appBuilderLock?.version,
    PINNED_ELECTRON_BUILDER_VERSION,
    'package-lock app-builder-lib version',
  );
  requireExact(
    appBuilderLock?.integrity,
    PINNED_APP_BUILDER_LIB_INTEGRITY,
    'package-lock app-builder-lib integrity',
  );
  requireExact(
    builderPackage?.version,
    PINNED_ELECTRON_BUILDER_VERSION,
    'installed app-builder-lib version',
  );

  assertPinnedTemplate(
    afterInstallTemplate,
    PINNED_AFTER_INSTALL_TEMPLATE_SHA256,
    'after-install.tpl',
  );
  assertPinnedTemplate(
    appArmorTemplate,
    PINNED_APPARMOR_TEMPLATE_SHA256,
    'apparmor-profile.tpl',
  );

  const replacements = {
    executable,
    sanitizedProductName: productName,
    productFilename: productName,
  };
  const postinst = renderPinnedTemplate(
    afterInstallTemplate,
    replacements,
    'after-install.tpl',
  );
  const appArmorProfile = renderPinnedTemplate(
    appArmorTemplate,
    replacements,
    'apparmor-profile.tpl',
  );
  if (FORBIDDEN_SANDBOX_ARGUMENT.test(postinst)) {
    fail('the pinned postinst template contains a sandbox-disabling Electron argument');
  }

  const helperInstallPath = `/opt/${productName}/chrome-sandbox`;
  const userNamespaceProbe =
    'if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then';
  requireExact(
    (postinst.match(new RegExp(escapeRegExp(userNamespaceProbe), 'g')) || []).length,
    1,
    'postinst user-namespace probe count',
  );
  for (const mode of ['4755', '0755']) {
    const command = `chmod ${mode} '${helperInstallPath}' || true`;
    requireExact(
      (postinst.match(new RegExp(escapeRegExp(command), 'g')) || []).length,
      1,
      `postinst chmod ${mode} helper command count`,
    );
  }

  const archivePrefix = `./opt/${productName}`;
  return {
    productName,
    executable,
    postinst,
    appArmorProfile,
    helperInstallPath,
    helperArchivePath: `${archivePrefix}/chrome-sandbox`,
    appArmorArchivePath: `${archivePrefix}/resources/apparmor-profile`,
    postinstArchivePath: './postinst',
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function loadDebVerificationPolicy() {
  return verifyDebBuildConfig({
    packageJson: JSON.parse(readFileSync(packageJsonPath, 'utf8')),
    packageLock: JSON.parse(readFileSync(packageLockPath, 'utf8')),
    builderPackage: JSON.parse(readFileSync(builderPackagePath, 'utf8')),
    afterInstallTemplate: readFileSync(afterInstallTemplatePath, 'utf8'),
    appArmorTemplate: readFileSync(appArmorTemplatePath, 'utf8'),
  });
}

function archivePathFromListing(type, displayedPath) {
  if (type === 'l') {
    const separator = displayedPath.lastIndexOf(' -> ');
    if (separator >= 0) return displayedPath.slice(0, separator);
  }
  if (type === 'h') {
    const separator = displayedPath.lastIndexOf(' link to ');
    if (separator >= 0) return displayedPath.slice(0, separator);
  }
  return displayedPath;
}

export function parseTarVerboseListing(text, label = 'tar listing') {
  if (typeof text !== 'string' || text.length === 0) {
    fail(`${label} is empty`);
  }
  if (text.includes('\0')) fail(`${label} contains a NUL byte`);

  const entries = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.length === 0) continue;
    const match =
      /^([bcdhlps-][rwxStTs-]{9})\s+([0-9]+)\/([0-9]+)\s+([0-9]+)\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s+([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)(?:\s+[+-][0-9]{4})?\s+(.+)$/.exec(
        line,
      );
    if (!match) {
      fail(`${label} line ${index + 1} is not an expected numeric-owner GNU tar record`);
    }
    const permissions = match[1];
    const type = permissions[0];
    const displayedPath = match[7];
    entries.push({
      permissions,
      type,
      uid: Number(match[2]),
      gid: Number(match[3]),
      size: Number(match[4]),
      path: archivePathFromListing(type, displayedPath),
      displayedPath,
    });
  }
  if (entries.length === 0) fail(`${label} contains no archive entries`);
  return entries;
}

function isSafeArchivePath(value) {
  if (
    typeof value !== 'string'
    || !value.startsWith('./')
    || value.length <= 2
    || /[\0-\x1f\x7f\\]/.test(value)
  ) {
    return false;
  }
  const segments = value.slice(2).split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

function requireUniqueSensitiveEntry(entries, expectedPath, basenameToRejectElsewhere, label) {
  if (!isSafeArchivePath(expectedPath)) {
    fail(`internal ${label} path is not safe: ${expectedPath}`);
  }
  const candidates = entries.filter((entry) => (
    entry.path === expectedPath
    || posix.basename(entry.path) === basenameToRejectElsewhere
  ));
  if (candidates.length !== 1 || candidates[0].path !== expectedPath) {
    fail(
      `${label} must appear exactly once at ${expectedPath}; found `
      + `${candidates.length} matching or conflicting archive entr${candidates.length === 1 ? 'y' : 'ies'}`,
    );
  }
  if (!isSafeArchivePath(candidates[0].path)) {
    fail(`${label} archive path is unsafe: ${candidates[0].path}`);
  }
  return candidates[0];
}

function requireRegularRootEntry(entry, allowedPermissions, label) {
  if (entry.type !== '-') fail(`${label} must be a regular non-link file`);
  if (entry.uid !== 0 || entry.gid !== 0) {
    fail(`${label} must be owned by numeric uid:gid 0:0`);
  }
  if (!allowedPermissions.includes(entry.permissions)) {
    fail(
      `${label} mode must be ${allowedPermissions.join(' or ')}; `
      + `received ${entry.permissions}`,
    );
  }
}

export function inspectDebArtifactRecords({
  dataListing,
  controlListing,
  postinst,
  appArmorProfile,
}, policy) {
  const dataEntries = parseTarVerboseListing(dataListing, 'DEB data archive listing');
  const controlEntries = parseTarVerboseListing(
    controlListing,
    'DEB control archive listing',
  );

  const helper = requireUniqueSensitiveEntry(
    dataEntries,
    policy.helperArchivePath,
    'chrome-sandbox',
    'chrome-sandbox',
  );
  requireRegularRootEntry(
    helper,
    ['-rwxr-xr-x', '-rwsr-xr-x'],
    'chrome-sandbox',
  );

  const packagedAppArmor = requireUniqueSensitiveEntry(
    dataEntries,
    policy.appArmorArchivePath,
    'apparmor-profile',
    'bundled AppArmor profile',
  );
  requireRegularRootEntry(
    packagedAppArmor,
    ['-rw-r--r--'],
    'bundled AppArmor profile',
  );

  const packagedPostinst = requireUniqueSensitiveEntry(
    controlEntries,
    policy.postinstArchivePath,
    'postinst',
    'postinst',
  );
  requireRegularRootEntry(packagedPostinst, ['-rwxr-xr-x'], 'postinst');

  if (postinst !== policy.postinst) {
    fail('postinst does not exactly match the pinned, deterministically rendered template');
  }
  if (FORBIDDEN_SANDBOX_ARGUMENT.test(postinst)) {
    fail('postinst contains a sandbox-disabling Electron argument');
  }
  if (appArmorProfile !== policy.appArmorProfile) {
    fail(
      'bundled AppArmor profile does not exactly match the pinned, '
      + 'deterministically rendered template',
    );
  }

  return {
    helperPath: helper.path,
    helperPermissions: helper.permissions,
    postinstPath: packagedPostinst.path,
    appArmorPath: packagedAppArmor.path,
  };
}

function appendBounded(chunks, state, chunk, maximum, label, children) {
  state.bytes += chunk.length;
  if (state.bytes > maximum) {
    state.error ||= new Error(`${label} exceeded ${maximum} bytes`);
    for (const child of children) killChildProcessGroup(child);
    return;
  }
  chunks.push(chunk);
}

function completion(child, label, onError) {
  let executionError = null;
  return new Promise((resolvePromise) => {
    child.once('error', (error) => {
      executionError = new Error(`${label}: ${error.message}`);
      onError(executionError);
    });
    child.once('close', (code, signal) => resolvePromise({
      code,
      signal,
      executionError,
    }));
  });
}

function killChildProcessGroup(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {}
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have completed between the liveness check and the signal.
  }
}

function safeToolEnvironment() {
  const env = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    PATH: '/usr/bin:/bin',
  };
  delete env.TAR_OPTIONS;
  return env;
}

export async function runDebTarCommand(
  debPath,
  dpkgMode,
  tarArguments,
  maximum,
  label,
  {
    dpkgDebPath = DPKG_DEB_PATH,
    tarPath = TAR_PATH,
    timeoutMs = DEFAULT_DEB_PIPELINE_TIMEOUT_MS,
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('DEB pipeline timeout must be a positive integer');
  }
  const env = safeToolEnvironment();
  const detached = process.platform !== 'win32';
  const dpkg = spawn(dpkgDebPath, [dpkgMode, debPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  const tar = spawn(tarPath, tarArguments, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
  });
  const children = [dpkg, tar];
  const output = [];
  const outputState = { bytes: 0, error: null };
  const dpkgDiagnostics = [];
  const dpkgDiagnosticState = { bytes: 0, error: null };
  const tarDiagnostics = [];
  const tarDiagnosticState = { bytes: 0, error: null };

  tar.stdout.on('data', (chunk) => appendBounded(
    output,
    outputState,
    chunk,
    maximum,
    `${label} output`,
    children,
  ));
  dpkg.stderr.on('data', (chunk) => appendBounded(
    dpkgDiagnostics,
    dpkgDiagnosticState,
    chunk,
    MAX_DIAGNOSTIC_BYTES,
    'dpkg-deb diagnostics',
    children,
  ));
  tar.stderr.on('data', (chunk) => appendBounded(
    tarDiagnostics,
    tarDiagnosticState,
    chunk,
    MAX_DIAGNOSTIC_BYTES,
    'tar diagnostics',
    children,
  ));

  // Avoid an unhandled EPIPE if tar rejects a malformed archive before dpkg-deb
  // has finished writing it.
  tar.stdin.on('error', () => {});
  dpkg.stdout.pipe(tar.stdin);

  let timeoutError = null;
  let childExecutionError = null;
  const stopChildren = () => {
    for (const child of children) killChildProcessGroup(child);
  };
  const watchdog = setTimeout(() => {
    timeoutError = new Error(
      `${label} timed out after ${timeoutMs} milliseconds`,
    );
    stopChildren();
  }, timeoutMs);
  watchdog.unref();

  const completions = [
    completion(dpkg, `unable to execute ${dpkgDebPath}`, (error) => {
      childExecutionError ||= error;
      stopChildren();
    }),
    completion(tar, `unable to execute ${tarPath}`, (error) => {
      childExecutionError ||= error;
      stopChildren();
    }),
  ];
  let results;
  try {
    results = await Promise.all(completions);
  } finally {
    clearTimeout(watchdog);
  }

  const [dpkgResult, tarResult] = results;
  const boundedError =
    timeoutError
    || childExecutionError
    || outputState.error
    || dpkgDiagnosticState.error
    || tarDiagnosticState.error;
  if (boundedError) fail(boundedError.message);
  if (dpkgResult.code !== 0 || tarResult.code !== 0) {
    fail(
      `${label} inspection failed `
      + `(dpkg-deb status=${dpkgResult.code}, signal=${dpkgResult.signal || 'none'}; `
      + `tar status=${tarResult.code}, signal=${tarResult.signal || 'none'})`
      + `\ndpkg-deb stderr:\n${Buffer.concat(dpkgDiagnostics).toString('utf8')}`
      + `\ntar stderr:\n${Buffer.concat(tarDiagnostics).toString('utf8')}`,
    );
  }
  return Buffer.concat(output);
}

async function readArchiveListing(debPath, dpkgMode, label) {
  return (
    await runDebTarCommand(
      debPath,
      dpkgMode,
      [
        '--list',
        '--verbose',
        '--numeric-owner',
        '--full-time',
        '--quoting-style=escape',
        '--file=-',
      ],
      MAX_LISTING_BYTES,
      label,
    )
  ).toString('utf8');
}

async function readArchiveMember(debPath, dpkgMode, memberPath, label) {
  return (
    await runDebTarCommand(
      debPath,
      dpkgMode,
      [
        '--extract',
        '--to-stdout',
        '--file=-',
        memberPath,
      ],
      MAX_MEMBER_BYTES,
      label,
    )
  ).toString('utf8');
}

export async function verifyDebArtifact(debPath, policy = loadDebVerificationPolicy()) {
  if (process.platform !== 'linux') {
    fail('artifact inspection must run on Linux');
  }
  if (!existsSync(DPKG_DEB_PATH) || !existsSync(TAR_PATH)) {
    fail('artifact inspection requires /usr/bin/dpkg-deb and /usr/bin/tar');
  }
  if (!debPath.endsWith('.deb')) {
    fail(`artifact must use the .deb extension: ${debPath}`);
  }
  if (!existsSync(debPath)) fail(`artifact is missing: ${debPath}`);
  const artifact = lstatSync(debPath);
  if (artifact.isSymbolicLink() || !artifact.isFile()) {
    fail(`artifact must be a regular non-link file: ${debPath}`);
  }
  const resolvedDeb = realpathSync(debPath);

  const [dataListing, controlListing, postinst, appArmorProfile] = await Promise.all([
    readArchiveListing(resolvedDeb, '--fsys-tarfile', 'DEB data archive listing'),
    readArchiveListing(resolvedDeb, '--ctrl-tarfile', 'DEB control archive listing'),
    readArchiveMember(
      resolvedDeb,
      '--ctrl-tarfile',
      policy.postinstArchivePath,
      'DEB postinst',
    ),
    readArchiveMember(
      resolvedDeb,
      '--fsys-tarfile',
      policy.appArmorArchivePath,
      'DEB AppArmor profile',
    ),
  ]);

  return inspectDebArtifactRecords(
    {
      dataListing,
      controlListing,
      postinst,
      appArmorProfile,
    },
    policy,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseDebVerifierArgs(process.argv.slice(2));
    const policy = loadDebVerificationPolicy();
    if (options.mode === 'config') {
      console.log(
        `DEB policy verified: electron-builder ${PINNED_ELECTRON_BUILDER_VERSION}, `
        + 'pinned postinst/AppArmor templates, exact helper paths and conditional '
        + 'user-namespace fallback.',
      );
    } else {
      const result = await verifyDebArtifact(options.deb, policy);
      console.log(
        `DEB artifact verified: ${result.helperPath} is ${result.helperPermissions} `
        + 'and root:root; postinst and AppArmor policy exactly match pinned templates.',
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
