#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { unifiedStackReleaseSmokePolicy } from './unified-stack-release-smoke-policy.mjs';

let cli;
try {
  cli = unifiedStackReleaseSmokePolicy(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const SUDO = '/usr/bin/sudo';
const CHMOD = '/usr/bin/chmod';
const CP = '/usr/bin/cp';
const MKDIR = '/usr/bin/mkdir';
const MKTEMP = '/usr/bin/mktemp';
const RM = '/usr/bin/rm';
const STAT = '/usr/bin/stat';
const ISOLATED_PARENT = '/tmp';
const ISOLATED_PREFIX = 'idacc-unified-stack-sandbox-';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function regularFileIdentitySnapshot(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link file: ${path}`);
  }
  return {
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode & 0o7777,
    nlink: entry.nlink,
    size: entry.size,
  };
}

function regularFileSnapshot(path, label) {
  return {
    ...regularFileIdentitySnapshot(path, label),
    sha256: sha256File(path),
  };
}

function privateDirectory(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symbolic-link directory: ${path}`);
  }
  return entry;
}

function directorySnapshot(path, label) {
  const entry = privateDirectory(path, label);
  return {
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    gid: entry.gid,
    mode: entry.mode & 0o7777,
  };
}

function privilegedDirectorySnapshot(path, label) {
  const execution = privileged(
    STAT,
    ['--format=%d:%i:%u:%g:%a:%F', '--', path],
    label,
  );
  const match =
    /^([0-9]+):([0-9]+):([0-9]+):([0-9]+):([0-7]+):directory\n?$/.exec(
      String(execution.stdout || ''),
    );
  if (!match) {
    throw new Error(`${label} is not an exact non-symbolic-link directory`);
  }
  const snapshot = {
    dev: Number(match[1]),
    ino: Number(match[2]),
    uid: Number(match[3]),
    gid: Number(match[4]),
    mode: Number.parseInt(match[5], 8),
  };
  if (
    !Number.isSafeInteger(snapshot.dev)
    || !Number.isSafeInteger(snapshot.ino)
    || !Number.isSafeInteger(snapshot.uid)
    || !Number.isSafeInteger(snapshot.gid)
    || !Number.isSafeInteger(snapshot.mode)
  ) {
    throw new Error(`${label} contains an invalid metadata field`);
  }
  return snapshot;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateIsolatedParent() {
  if (realpathSync(ISOLATED_PARENT) !== ISOLATED_PARENT) {
    throw new Error('Linux sandbox smoke parent must resolve exactly to /tmp');
  }
  const parent = directorySnapshot(
    ISOLATED_PARENT,
    'Linux sandbox smoke parent',
  );
  if (
    parent.uid !== 0
    || parent.gid !== 0
    || parent.mode !== 0o1777
  ) {
    throw new Error(
      'Linux sandbox smoke parent must be the root-owned 01777 /tmp directory',
    );
  }
  return parent;
}

function privileged(command, args, label) {
  for (const executable of [SUDO, command]) {
    const entry = lstatSync(executable);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} requires a regular absolute executable: ${executable}`);
    }
  }
  const execution = spawnSync(
    SUDO,
    ['--non-interactive', '--', command, ...args],
    {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin',
      },
    },
  );
  if (execution.error || execution.signal || execution.status !== 0) {
    throw new Error(
      `${label} failed (status=${execution.status}, `
      + `signal=${execution.signal || 'none'}, `
      + `error=${execution.error?.message || 'none'})`
      + `\nstdout:\n${execution.stdout || ''}`
      + `\nstderr:\n${execution.stderr || ''}`,
    );
  }
  return execution;
}

function validateIsolatedPaths(temporaryRoot, isolatedApp) {
  if (
    dirname(temporaryRoot) !== ISOLATED_PARENT
    || !basename(temporaryRoot).startsWith(ISOLATED_PREFIX)
    || isolatedApp !== join(temporaryRoot, 'linux-unpacked')
    || temporaryRoot === '/'
    || isolatedApp === '/'
  ) {
    throw new Error('refusing ambiguous Linux sandbox smoke cleanup path');
  }
}

function removeIsolatedLinuxCopy(copy) {
  validateIsolatedParent();
  validateIsolatedPaths(copy.temporaryRoot, copy.packagedApp);
  const cleanupErrors = [];
  if (existsSync(copy.temporaryRoot)) {
    let stableForRemoval = false;
    let cleanupSnapshots = null;
    try {
      const root = directorySnapshot(
        copy.temporaryRoot,
        'isolated Linux sandbox smoke root during cleanup',
      );
      const expectedRoot = copy.preparedSnapshots?.root
        || copy.stagedSnapshots?.root
        || copy.rootSnapshot;
      if (
        root.uid !== 0
        || root.gid !== 0
        || (root.mode & 0o022) !== 0
        || (expectedRoot && !sameIdentity(root, expectedRoot))
      ) {
        throw new Error(
          'isolated Linux sandbox smoke root identity changed before cleanup',
        );
      }
      stableForRemoval = true;
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (stableForRemoval) {
      try {
        cleanupSnapshots = copy.preparedSnapshots || copy.stagedSnapshots;
        if (!cleanupSnapshots && existsSync(copy.packagedApp)) {
          const app = directorySnapshot(
            copy.packagedApp,
            'partially copied isolated packaged application during cleanup',
          );
          const helperPath = join(copy.packagedApp, 'chrome-sandbox');
          if (existsSync(helperPath)) {
            const helper = regularFileIdentitySnapshot(
              helperPath,
              'partially copied isolated chrome-sandbox during cleanup',
            );
            cleanupSnapshots = {
              root: copy.rootSnapshot,
              app,
              helper,
            };
          }
        }
        if (cleanupSnapshots) {
          const app = directorySnapshot(
            copy.packagedApp,
            'isolated packaged application during cleanup',
          );
          const helper = regularFileIdentitySnapshot(
            join(copy.packagedApp, 'chrome-sandbox'),
            'isolated chrome-sandbox during cleanup',
          );
          if (
            !sameIdentity(app, cleanupSnapshots.app)
            || !sameIdentity(helper, cleanupSnapshots.helper)
            || app.uid !== 0
            || app.gid !== 0
            || (app.mode & 0o022) !== 0
            || helper.uid !== 0
            || helper.gid !== 0
          ) {
            throw new Error(
              'isolated Linux sandbox smoke hierarchy changed before cleanup',
            );
          }
        }
      } catch (error) {
        // The root itself remains safe to delete even when a partial or
        // malformed copy cannot be deprivileged by its expected helper path.
        cleanupSnapshots = null;
        cleanupErrors.push(error);
      }
    }

    if (stableForRemoval && cleanupSnapshots) {
      const copiedSandbox = join(copy.packagedApp, 'chrome-sandbox');
      let deprivileged = false;
      try {
        privileged(
          CHMOD,
          ['--', '0755', copiedSandbox],
          'isolated chrome-sandbox cleanup mode',
        );
        deprivileged = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (deprivileged) {
        try {
          const helper = regularFileIdentitySnapshot(
            copiedSandbox,
            'deprivileged isolated chrome-sandbox during cleanup',
          );
          if (
            !sameIdentity(helper, cleanupSnapshots.helper)
            || helper.uid !== 0
            || helper.gid !== 0
            || helper.mode !== 0o755
          ) {
            throw new Error(
              'isolated chrome-sandbox identity changed while clearing SUID',
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (stableForRemoval) {
      try {
        // Deletion is attempted even if clearing the SUID bit failed. The
        // validated root is non-replaceable under root-owned sticky /tmp.
        privileged(
          RM,
          ['-rf', '--', copy.temporaryRoot],
          'isolated Linux sandbox smoke cleanup',
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (existsSync(copy.temporaryRoot)) {
    cleanupErrors.push(
      new Error(
        'isolated Linux sandbox smoke copy was not removed; '
        + 'privileged cleanup refused a changed path',
      ),
    );
  }

  try {
    const after = regularFileSnapshot(
      copy.sourceSandbox,
      'source packaged chrome-sandbox',
    );
    if (
      after.dev !== copy.sourceSnapshot.dev
      || after.ino !== copy.sourceSnapshot.ino
      || after.uid !== copy.sourceSnapshot.uid
      || after.gid !== copy.sourceSnapshot.gid
      || after.mode !== copy.sourceSnapshot.mode
      || after.nlink !== copy.sourceSnapshot.nlink
      || after.size !== copy.sourceSnapshot.size
      || after.sha256 !== copy.sourceSnapshot.sha256
    ) {
      throw new Error('source packaged chrome-sandbox was mutated by the smoke harness');
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      'isolated Linux sandbox smoke cleanup had multiple failures',
    );
  }
}

function prepareIsolatedLinuxCopy(sourcePackagedApp) {
  privateDirectory(sourcePackagedApp, 'source packaged application');
  const sourceRoot = realpathSync(sourcePackagedApp);
  validateIsolatedParent();

  const sourceSandbox = join(sourceRoot, 'chrome-sandbox');
  const sourceSnapshot = regularFileSnapshot(
    sourceSandbox,
    'source packaged chrome-sandbox',
  );
  if (sourceSnapshot.nlink !== 1) {
    throw new Error('source packaged chrome-sandbox must have exactly one link');
  }

  const creation = privileged(
    MKTEMP,
    ['-d', join(ISOLATED_PARENT, `${ISOLATED_PREFIX}XXXXXX`)],
    'isolated Linux sandbox smoke root creation',
  );
  const temporaryRoot = String(creation.stdout || '').trim();
  if (
    !new RegExp(`^${ISOLATED_PARENT}/${ISOLATED_PREFIX}[A-Za-z0-9]{6,}$`).test(
      temporaryRoot,
    )
  ) {
    throw new Error('privileged mktemp returned an invalid isolated smoke path');
  }
  const packagedApp = join(temporaryRoot, 'linux-unpacked');
  const copy = {
    temporaryRoot,
    packagedApp,
    sourceSandbox,
    sourceSnapshot,
    rootSnapshot: null,
    stagedSnapshots: null,
    preparedSnapshots: null,
  };

  try {
    validateIsolatedPaths(temporaryRoot, packagedApp);
    const createdRoot = directorySnapshot(
      temporaryRoot,
      'new isolated Linux sandbox smoke root',
    );
    if (
      createdRoot.uid !== 0
      || createdRoot.gid !== 0
      || createdRoot.mode !== 0o700
      || realpathSync(temporaryRoot) !== temporaryRoot
    ) {
      throw new Error(
        'privileged mktemp did not create the expected root-owned private directory',
      );
    }
    copy.rootSnapshot = createdRoot;
    privileged(
      MKDIR,
      ['--mode=0700', '--', packagedApp],
      'isolated application directory creation',
    );
    const emptyApp = privilegedDirectorySnapshot(
      packagedApp,
      'empty isolated application directory',
    );
    if (
      emptyApp.uid !== 0
      || emptyApp.gid !== 0
      || emptyApp.mode !== 0o700
    ) {
      throw new Error(
        'isolated application directory was not created root-owned and private',
      );
    }
    privileged(
      CP,
      [
        '-R',
        '-P',
        '-T',
        '--',
        sourceRoot,
        packagedApp,
      ],
      'isolated packaged application copy',
    );
    const privateCopiedApp = privilegedDirectorySnapshot(
      packagedApp,
      'private copied application directory',
    );
    if (
      !sameIdentity(privateCopiedApp, emptyApp)
      || privateCopiedApp.uid !== 0
      || privateCopiedApp.gid !== 0
      || privateCopiedApp.mode !== 0o700
    ) {
      throw new Error(
        'isolated application directory identity or private mode changed during copy',
      );
    }
    // Pinned GNU cp copies into the exact pre-created directory and never
    // follows source symlinks or preserves hard-link relationships. Without
    // -a, -p, or --preserve, each new file retains its ordinary source mode
    // while GNU cp removes SUID, SGID, and sticky bits before applying the
    // process umask. Keep the hierarchy inaccessible while root normalizes the
    // copied application directory, then expose traversal only after both
    // ancestors are root-owned and non-writable by the runner.
    privileged(
      CHMOD,
      ['--', '0755', packagedApp],
      'isolated application directory inspection mode',
    );
    privileged(
      CHMOD,
      ['--', '0755', temporaryRoot],
      'isolated staging root inspection mode',
    );
    const rootAfterCopy = directorySnapshot(
      temporaryRoot,
      'isolated Linux sandbox smoke root after copy',
    );
    if (
      !sameIdentity(rootAfterCopy, createdRoot)
      || rootAfterCopy.uid !== 0
      || rootAfterCopy.gid !== 0
      || rootAfterCopy.mode !== 0o755
    ) {
      throw new Error(
        'isolated Linux sandbox smoke root changed or remained inaccessible after copy',
      );
    }
    const appBeforeMode = directorySnapshot(
      packagedApp,
      'isolated packaged application',
    );
    if (
      !sameIdentity(appBeforeMode, privateCopiedApp)
      || appBeforeMode.uid !== 0
      || appBeforeMode.gid !== 0
      || appBeforeMode.mode !== 0o755
    ) {
      throw new Error('isolated packaged application is not root-owned and immutable');
    }
    const copiedSandbox = join(packagedApp, 'chrome-sandbox');
    const copiedSandboxIdentity = regularFileIdentitySnapshot(
      copiedSandbox,
      'isolated packaged chrome-sandbox',
    );
    copy.stagedSnapshots = {
      root: rootAfterCopy,
      app: appBeforeMode,
      helper: copiedSandboxIdentity,
    };
    // Normalize the already non-SUID copy only after the helper was proven to
    // be a regular file beneath the root-owned, non-writable application
    // directory.
    privileged(
      CHMOD,
      ['--', '0755', copiedSandbox],
      'isolated chrome-sandbox copied baseline mode',
    );
    const copiedSandboxBaseline = regularFileIdentitySnapshot(
      copiedSandbox,
      'isolated packaged chrome-sandbox baseline',
    );
    if (
      !sameIdentity(copiedSandboxBaseline, copiedSandboxIdentity)
      || copiedSandboxBaseline.uid !== 0
      || copiedSandboxBaseline.gid !== 0
      || copiedSandboxBaseline.mode !== 0o755
    ) {
      throw new Error(
        'isolated chrome-sandbox identity changed while clearing its copied mode',
      );
    }
    const before = regularFileSnapshot(
      copiedSandbox,
      'isolated packaged chrome-sandbox',
    );
    if (
      !sameIdentity(before, copiedSandboxIdentity)
      || before.uid !== 0
      || before.gid !== 0
      || before.mode !== 0o755
      || before.nlink !== 1
      || before.size !== sourceSnapshot.size
      || before.sha256 !== sourceSnapshot.sha256
    ) {
      throw new Error('isolated chrome-sandbox does not exactly copy the packaged helper');
    }

    // The runner can traverse the prepared hierarchy but cannot rename its
    // root or replace the root-owned, non-writable application directory.
    privileged(CHMOD, ['--', '4755', copiedSandbox], 'isolated chrome-sandbox mode');

    const stagingRoot = directorySnapshot(
      temporaryRoot,
      'prepared isolated staging root',
    );
    const parent = directorySnapshot(
      packagedApp,
      'prepared isolated packaged application',
    );
    const prepared = regularFileSnapshot(
      copiedSandbox,
      'prepared isolated chrome-sandbox',
    );
    if (
      !sameIdentity(stagingRoot, createdRoot)
      || !sameIdentity(parent, appBeforeMode)
      || !sameIdentity(prepared, before)
      || stagingRoot.uid !== 0
      || stagingRoot.gid !== 0
      || stagingRoot.mode !== 0o755
      || parent.uid !== 0
      || parent.gid !== 0
      || parent.mode !== 0o755
      || prepared.uid !== 0
      || prepared.gid !== 0
      || prepared.mode !== 0o4755
      || prepared.nlink !== 1
      || prepared.size !== sourceSnapshot.size
      || prepared.sha256 !== sourceSnapshot.sha256
    ) {
      throw new Error('isolated chrome-sandbox ownership, mode, or content verification failed');
    }
    copy.preparedSnapshots = {
      root: stagingRoot,
      app: parent,
      helper: prepared,
    };
    return copy;
  } catch (error) {
    try {
      removeIsolatedLinuxCopy(copy);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Linux sandbox smoke preparation and cleanup both failed',
      );
    }
    throw error;
  }
}

function executable(path) {
  if (basename(path).endsWith('.app')) return join(path, 'Contents', 'MacOS', 'ID Agents Control Center');
  if (process.platform === 'win32') return join(path, 'ID Agents Control Center.exe');
  return join(path, 'idagents-control-center');
}

let isolatedLinuxCopy = null;
let packagedApp = resolve(cli.packagedApp);
const profile = mkdtempSync(join(tmpdir(), 'idacc-clean-profile-'));
const resultFile = join(profile, 'stack-selftest-result.json');

try {
  if (cli.prepareLinuxGithubActionsSandbox) {
    isolatedLinuxCopy = prepareIsolatedLinuxCopy(packagedApp);
    packagedApp = isolatedLinuxCopy.packagedApp;
  }
  const binary = executable(packagedApp);
  if (!existsSync(binary)) {
    throw new Error(`packaged executable is missing: ${binary}`);
  }
  const useXvfb = process.platform === 'linux';
  const command = useXvfb ? 'xvfb-run' : binary;
  const commandArgs = useXvfb ? ['-a', binary] : [];
  const execution = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: 360_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      IDACC_DATA_DIR: profile,
      IDACC_STACK_SELFTEST: '1',
      IDACC_STACK_AUTH_SELFTEST: '1',
      IDACC_STACK_SELFTEST_RESULT_FILE: resultFile,
      // Reserve 90 seconds for readiness and leave the remaining 270 seconds
      // for the expanded cross-platform contract and orderly shutdown.
      IDACC_STACK_SELFTEST_READY_TIMEOUT_MS: '90_000',
      IDACC_STACK_RANDOM_PORTS: '1',
      IDACC_RUNTIME_ROOT: '',
      MANAGER_URL: '',
      BRAIN_URL: '',
      IDACC_BRAIN_URL: '',
    },
  });
  const stdout = String(execution.stdout || '');
  const stderr = String(execution.stderr || '');
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith('IDACC_STACK_SELFTEST '));
  let status;
  let resultSource;
  if (existsSync(resultFile)) {
    const resultText = readFileSync(resultFile, 'utf8');
    status = JSON.parse(resultText);
    resultSource = 'private result file';
    if (process.platform !== 'win32' && (statSync(resultFile).mode & 0o777) !== 0o600) {
      throw new Error('packaged app stack result is not permissioned 0600');
    }
    if (/"[^"]*(?:token|bearer|credential|secret|password|private[_-]?key)[^"]*"\s*:/i.test(resultText)) {
      throw new Error('packaged app stack result contains a credential-shaped field');
    }
  } else if (line) {
    // Console parsing is retained for useful diagnostics from an older or
    // interrupted build, but new builds publish the private result file.
    status = JSON.parse(line.slice('IDACC_STACK_SELFTEST '.length));
    resultSource = 'stdout fallback';
  } else {
    throw new Error(
      `packaged app returned no stack result\nstatus=${execution.status} signal=${execution.signal || 'none'}`
      + `\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (execution.error || execution.status !== 0) {
    throw new Error(
      `packaged app stack self-test failed (${resultSource})`
      + `\nstatus=${execution.status} signal=${execution.signal || 'none'}`
      + `\nerror=${execution.error?.message || 'none'}`
      + `\nresult=${JSON.stringify(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (status.ready !== true || status.services?.length !== 2 || status.services.some((service) => !service.bundled || !service.healthy)) {
    throw new Error(`unified stack did not become ready: ${JSON.stringify(status)}`);
  }
  const manager = status.services.find((service) => service.name === 'manager');
  const brain = status.services.find((service) => service.name === 'brain');
  const listener = status.companions?.find((companion) => companion.name === 'brain-listener');
  if (!manager?.url || !brain?.url || listener?.healthy !== true || listener?.phase !== 'running') {
    throw new Error(`unified stack did not report its live listener and service endpoints: ${JSON.stringify(status)}`);
  }
  if (
    status.authPassed !== true
    || status.managerCompatibility?.ready !== true
    || status.runtimeContract?.managerCapabilities !== true
    || status.runtimeContract?.mcpCompareAndSet !== true
    || status.runtimeContract?.controlStateCompareAndSet !== true
    || status.runtimeContract?.controlEventIdempotency !== true
    || status.runtimeContract?.brainLearnedControlEvent !== true
    || status.runtimeContract?.brainLearnedSecondaryTeamEvent !== true
    || status.runtimeContract?.brainListenerCursorAdvanced !== true
    || status.runtimeContract?.brainMultiTeamCursors !== true
    || status.runtimeContract?.brainTimelineReplaySafe !== true
    || status.runtimeContract?.localAgentSpawn !== true
    || status.runtimeContract?.localAgentPrivateLog !== true
    || status.runtimeContract?.localAgentStop !== true
  ) {
    throw new Error(`unified runtime behavior contract failed: ${JSON.stringify(status)}`);
  }
  const profileMetadata = JSON.parse(readFileSync(join(profile, 'profile.json'), 'utf8'));
  if (!Number.isInteger(profileMetadata.schemaVersion) || profileMetadata.schemaVersion < 1) {
    throw new Error('clean profile was not initialized');
  }
  console.log(
    `Unified clean-profile stack check passed on ${process.platform}`
    + ` via ${resultSource}: manager ${manager.url}, Brain ${brain.url}`,
  );
} finally {
  const cleanupErrors = [];
  if (isolatedLinuxCopy) {
    try {
      removeIsolatedLinuxCopy(isolatedLinuxCopy);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 2,
      retryDelay: 200,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(
      cleanupErrors,
      'unified stack release-smoke cleanup had multiple failures',
    );
  }
}
