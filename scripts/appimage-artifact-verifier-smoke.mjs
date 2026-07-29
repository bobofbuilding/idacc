#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  mainProcessStartupBanner,
  mainProcessStartupPolicyMarker,
  RELEASE_LINUX_SANDBOX_EXIT_CODE,
  RELEASE_LINUX_SANDBOX_GUIDANCE,
} from '../idctl-desktop/scripts/main-process-startup-policy.mjs';
import {
  REQUIRED_APP_BUILDER_LIB_VERSION,
  REQUIRED_APPIMAGE_TOOLSET,
  REQUIRED_ELECTRON_BUILDER_VERSION,
  desktopExecDisablesSandbox,
  inspectAppRunContent,
  inspectExtractedAppImage,
  parseAppImageVerifierArgs,
  verifyAppImageBuildConfig,
  verifyPackagedMainProcess,
} from './verify-appimage-artifact.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'idctl-desktop');
const requireFromDesktop = createRequire(join(desktop, 'package.json'));
const { createPackage } = requireFromDesktop('@electron/asar');
const { generateAppRunScript } = requireFromDesktop(
  'app-builder-lib/out/targets/appimage/appImageUtil.js',
);
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const builderSchema = JSON.parse(
  readFileSync(join(desktop, 'node_modules', 'app-builder-lib', 'scheme.json'), 'utf8'),
);
const appImageTargetSource = readFileSync(
  join(
    desktop,
    'node_modules',
    'app-builder-lib',
    'out',
    'targets',
    'appimage',
    'AppImageTarget.js',
  ),
  'utf8',
);
const appImageUtilSource = readFileSync(
  join(
    desktop,
    'node_modules',
    'app-builder-lib',
    'out',
    'targets',
    'appimage',
    'appImageUtil.js',
  ),
  'utf8',
);
const config = verifyAppImageBuildConfig(pkg);

assert.equal(config.toolset, REQUIRED_APPIMAGE_TOOLSET);
assert.equal(config.electronBuilderVersion, REQUIRED_ELECTRON_BUILDER_VERSION);
assert.equal(config.appBuilderLibVersion, REQUIRED_APP_BUILDER_LIB_VERSION);
assert.equal(config.executableName, 'idagents-control-center');
assert.equal(config.desktopName, 'idagents-control-center.desktop');
assert.equal(config.productName, 'ID Agents Control Center');
assert.ok(
  builderSchema.definitions.ToolsetConfig.properties.appimage.anyOf[0].enum
    .includes(REQUIRED_APPIMAGE_TOOLSET),
  'the installed, lockfile-pinned electron-builder must support the selected AppImage toolset',
);
assert.match(
  appImageTargetSource,
  /appimageTool == null \|\| appimageTool === "0\.0\.0"[\s\S]*buildLegacyFuse2AppImage[\s\S]*buildStaticRuntimeAppImage/,
  'the installed builder must route the non-legacy 1.0.3 pin through its static-runtime AppImage build path',
);
assert.match(
  appImageTargetSource,
  /const args = \(_b = this\.options\.executableArgs\)[^;]+defaultArgs;/,
  'the explicit empty AppImage executableArgs array must override builder defaults',
);
assert.match(
  appImageUtilSource,
  /if \[ \$HAVE_NO_SANDBOX -eq 0 \] && ! unshare -Ur true 2>\/dev\/null ; then[\s\S]*NO_SANDBOX=\(--no-sandbox\)[\s\S]*exec "\$BIN" "\\\$\{NO_SANDBOX\[@\]\}"/,
  'the pinned builder must retain its known conditional user-namespace fallback',
);

assert.deepEqual(parseAppImageVerifierArgs(['--config-only']), { mode: 'config' });
assert.deepEqual(
  parseAppImageVerifierArgs([
    '--appimage',
    './review.AppImage',
    '--expected-build',
    'review',
  ]),
  {
    mode: 'artifact',
    appImage: join(process.cwd(), 'review.AppImage'),
    expectedBuild: 'review',
  },
);
for (const args of [
  [],
  ['review.AppImage'],
  ['--appimage'],
  ['--appimage', './review.AppImage'],
  ['--appimage', './review.AppImage', '--expected-build', 'development'],
  ['--appimage', './review.AppImage', '--expected-build'],
  ['--expected-build', 'review', '--appimage', './review.AppImage'],
  ['--config-only', '--appimage', 'review.AppImage'],
]) {
  assert.throws(() => parseAppImageVerifierArgs(args), /usage:/);
}

for (const value of [
  'AppRun --no-sandbox %U',
  'AppRun "--disable-setuid-sandbox" %U',
  'AppRun --no\\-sandbox %U',
]) {
  assert.equal(desktopExecDisablesSandbox(value), true, value);
}
assert.equal(desktopExecDisablesSandbox('AppRun %U'), false);
assert.equal(desktopExecDisablesSandbox('AppRun --sandbox %U'), false);

for (const [name, mutate, pattern] of [
  [
    'missing toolset',
    (value) => {
      delete value.build.toolsets;
    },
    /build\.toolsets\.appimage must be exactly/,
  ],
  [
    'legacy toolset',
    (value) => {
      value.build.toolsets.appimage = '0.0.0';
    },
    /build\.toolsets\.appimage must be exactly/,
  ],
  [
    'unreviewed electron-builder',
    (value) => {
      value.devDependencies['electron-builder'] = '^26.15.7';
    },
    /electron-builder must be exactly/,
  ],
  [
    'sandbox-disabling desktop args',
    (value) => {
      value.build.appImage.executableArgs = ['--no-sandbox'];
    },
    /must be an explicit empty array/,
  ],
  [
    'nonempty desktop args',
    (value) => {
      value.build.appImage.executableArgs = ['--safe-example'];
    },
    /must be an explicit empty array/,
  ],
]) {
  const candidate = structuredClone(pkg);
  mutate(candidate);
  assert.throws(() => verifyAppImageBuildConfig(candidate), pattern, name);
}

function startupPolicyFixture(mode, {
  platform = 'linux',
  argv = ['electron'],
  switches = [],
  electronAvailable = true,
  dialogThrows = false,
} = {}) {
  const writes = [];
  const dialogs = [];
  let sandboxCalls = 0;
  let exitCode = null;
  const electron = electronAvailable
    ? {
        app: {
          commandLine: {
            hasSwitch(name) {
              return switches.includes(name);
            },
          },
          enableSandbox() {
            sandboxCalls += 1;
          },
        },
        dialog: {
          showErrorBox(title, message) {
            if (dialogThrows) throw new Error('dialog unavailable');
            dialogs.push({ title, message });
          },
        },
      }
    : null;
  const context = {
    require(name) {
      assert.equal(name, 'electron');
      if (!electronAvailable) throw new Error('electron unavailable');
      return electron;
    },
    process: {
      platform,
      argv,
      stderr: {
        write(value) {
          writes.push(String(value));
        },
      },
      exitCode: 0,
      exit(code) {
        exitCode = code;
        throw new Error(`fixture-exit:${code}`);
      },
    },
  };
  let error = null;
  try {
    runInNewContext(`${mainProcessStartupBanner(mode)}globalThis.afterBanner=true;`, context);
  } catch (caught) {
    error = caught;
  }
  return {
    afterBanner: context.afterBanner === true,
    dialogs,
    error,
    exitCode,
    sandboxCalls,
    writes,
  };
}

for (const mode of ['production', 'review']) {
  const allowed = startupPolicyFixture(mode);
  assert.equal(allowed.afterBanner, true, `${mode} banner must continue after enabling sandbox`);
  assert.equal(allowed.sandboxCalls, 1, `${mode} banner must call app.enableSandbox`);
  assert.equal(allowed.exitCode, null);

  for (const blocked of [
    ...[
      '--no-sandbox',
      '--no-sandbox=1',
      '--disable-setuid-sandbox',
      '--disable-setuid-sandbox=1',
    ].map((argument) => startupPolicyFixture(mode, {
      argv: ['electron', argument],
    })),
    startupPolicyFixture(mode, { switches: ['disable-setuid-sandbox'] }),
    startupPolicyFixture(mode, { electronAvailable: false }),
    startupPolicyFixture(mode, {
      argv: ['electron', '--no-sandbox'],
      dialogThrows: true,
    }),
  ]) {
    assert.equal(blocked.afterBanner, false);
    assert.equal(blocked.exitCode, RELEASE_LINUX_SANDBOX_EXIT_CODE);
    assert.match(String(blocked.error?.message), /fixture-exit:78/);
    assert.equal(blocked.sandboxCalls, 0);
    assert.match(blocked.writes.join(''), new RegExp(RELEASE_LINUX_SANDBOX_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}
for (const mode of ['production', 'review']) {
  const nonLinux = startupPolicyFixture(mode, {
    platform: 'darwin',
    argv: ['electron', '--no-sandbox'],
    electronAvailable: false,
  });
  assert.equal(nonLinux.afterBanner, true);
  assert.equal(nonLinux.exitCode, null);
  assert.equal(nonLinux.sandboxCalls, 0);
  assert.deepEqual(nonLinux.writes, []);
}
const development = startupPolicyFixture('development', {
  argv: ['electron', '--no-sandbox'],
  electronAvailable: false,
});
assert.equal(development.afterBanner, true);
assert.equal(development.exitCode, null);
assert.equal(development.sandboxCalls, 0);
assert.match(
  mainProcessStartupBanner('production'),
  new RegExp(`^/\\* ${mainProcessStartupPolicyMarker('production')} \\*/`),
);
assert.match(
  mainProcessStartupBanner('review'),
  new RegExp(`^/\\* ${mainProcessStartupPolicyMarker('review')} \\*/`),
);
assert.doesNotMatch(
  mainProcessStartupBanner('development'),
  /no-sandbox|disable-setuid-sandbox|enableSandbox/,
);

const generatedAppRun = generateAppRunScript({
  DesktopFileName: config.desktopName,
  ExecutableName: config.executableName,
  ProductName: config.productName,
  ProductFilename: config.productName,
  ResourceName: `appimagekit-${config.executableName}`,
}).replace(/\r\n?/g, '\n');
assert.deepEqual(inspectAppRunContent(generatedAppRun), {
  noSandboxOccurrences: 3,
  execCount: 2,
});
for (const [name, replacement, pattern] of [
  [
    'unconditional no-sandbox',
    `${generatedAppRun}\nexec "$BIN" --no-sandbox\n`,
    /exactly the pinned conditional/,
  ],
  [
    'disable-setuid',
    generatedAppRun.replace('set -e', 'set -e\ntrue --disable-setuid-sandbox'),
    /forbidden --disable-setuid-sandbox/,
  ],
  [
    'replacement launcher',
    generatedAppRun.replace(
      'exec "$BIN" "${NO_SANDBOX[@]}"',
      'exec "$BIN" "${NO_SANDBOX[@]}"\nexec "$BIN"',
    ),
    /replacement application launcher/,
  ],
  [
    'unconditional assignment',
    generatedAppRun.replace(
      'NO_SANDBOX=()',
      'NO_SANDBOX=(--no-sandbox)',
    ),
    /exactly the pinned conditional/,
  ],
]) {
  assert.throws(() => inspectAppRunContent(replacement), pattern, name);
}

function buildMode(expectedBuild) {
  const policyMode = expectedBuild === 'review' ? 'review' : 'production';
  return {
    mode: 'production',
    reviewOnly: expectedBuild === 'review',
    updaterEnabled: expectedBuild !== 'review',
    mainProcessStartupPolicy: {
      mode: policyMode,
      marker: mainProcessStartupPolicyMarker(policyMode),
      rejectsLinuxSandboxDisableSwitches: true,
    },
  };
}

function packagedMetadata() {
  return Buffer.from(JSON.stringify({
    name: 'idagents-control-center',
    main: 'out/main/main.cjs',
  }));
}

function mainProcess(expectedBuild) {
  const mode = expectedBuild === 'review' ? 'review' : 'production';
  return Buffer.from(
    `${mainProcessStartupBanner(mode)}"use strict";\n${'x'.repeat(2048)}\n`,
  );
}

for (const expectedBuild of ['production', 'review']) {
  assert.equal(
    verifyPackagedMainProcess(
      packagedMetadata(),
      Buffer.from(JSON.stringify(buildMode(expectedBuild))),
      mainProcess(expectedBuild),
      expectedBuild,
    ).policyMode,
    expectedBuild,
  );
}
assert.throws(
  () => verifyPackagedMainProcess(
    packagedMetadata(),
    Buffer.from(JSON.stringify(buildMode('review'))),
    mainProcess('review'),
    'production',
  ),
  /does not match the production startup policy/,
);
assert.throws(
  () => verifyPackagedMainProcess(
    packagedMetadata(),
    Buffer.from(JSON.stringify(buildMode('production'))),
    Buffer.from(`tampered\n${mainProcess('production').toString('utf8')}`),
    'production',
  ),
  /does not start with the exact production policy banner/,
);
assert.throws(
  () => verifyPackagedMainProcess(
    Buffer.from(JSON.stringify({
      name: 'idagents-control-center',
      main: 'out/main/unguarded.cjs',
    })),
    Buffer.from(JSON.stringify(buildMode('production'))),
    mainProcess('production'),
    'production',
  ),
  /Electron main entry must be exactly out\/main\/main\.cjs/,
);

const scratch = mkdtempSync(join(tmpdir(), 'idacc-appimage-verifier-smoke-'));
const appRun = join(scratch, 'AppRun');
const executable = join(scratch, config.executableName);
const primaryDesktop = join(scratch, config.desktopName);
const nestedDesktop = join(scratch, 'usr', 'share', 'applications', 'secondary.desktop');
const asarSource = join(scratch, 'asar-source');
const asarPath = join(scratch, 'resources', 'app.asar');

function writeExecutable(path, content = '#!/usr/bin/env sh\nexit 0\n') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function writeDesktop(path, exec = 'AppRun %U') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `[Desktop Entry]\nType=Application\nExec=${exec}\n`);
}

try {
  writeExecutable(appRun, generatedAppRun);
  writeExecutable(executable);
  writeDesktop(primaryDesktop);
  writeDesktop(nestedDesktop, 'AppRun --safe-example %F');
  mkdirSync(join(asarSource, 'out', 'main'), { recursive: true });
  writeFileSync(
    join(asarSource, 'package.json'),
    packagedMetadata(),
  );
  writeFileSync(
    join(asarSource, 'out', 'build-mode.json'),
    JSON.stringify(buildMode('production')),
  );
  writeFileSync(
    join(asarSource, 'out', 'main', 'main.cjs'),
    mainProcess('production'),
  );
  mkdirSync(dirname(asarPath), { recursive: true });
  await createPackage(asarSource, asarPath);

  const inspected = inspectExtractedAppImage(scratch, config, 'production');
  assert.equal(inspected.desktopFiles.length, 2);
  assert.equal(inspected.execCount, 2);
  assert.equal(inspected.mainProcessPolicy.policyMode, 'production');

  writeDesktop(nestedDesktop, 'AppRun "--no-sandbox" %F');
  assert.throws(
    () => inspectExtractedAppImage(scratch, config, 'production'),
    /contains an unconditional Electron sandbox-disabling argument/,
  );

  writeDesktop(nestedDesktop, 'AppRun --safe-example %F');
  writeDesktop(primaryDesktop, 'idagents-control-center %U');
  assert.throws(
    () => inspectExtractedAppImage(scratch, config, 'production'),
    /primary desktop Exec= does not launch AppRun/,
  );

  writeDesktop(primaryDesktop);
  chmodSync(appRun, 0o644);
  assert.throws(
    () => inspectExtractedAppImage(scratch, config, 'production'),
    /AppRun is not executable/,
  );

  chmodSync(appRun, 0o755);
  rmSync(executable);
  assert.throws(
    () => inspectExtractedAppImage(scratch, config, 'production'),
    /packaged application executable is missing/,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(
  `AppImage artifact verifier smoke: ok (electron-builder@${REQUIRED_ELECTRON_BUILDER_VERSION}, `
  + `appimage@${REQUIRED_APPIMAGE_TOOLSET}, guarded conditional launcher)`,
);
