#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'idacc-updater-download-'));
const bundledUpdater = join(scratch, 'updater.cjs');
const bundledReviewUpdater = join(scratch, 'updater-review.cjs');
const stateKey = '__IDACC_UPDATER_DOWNLOAD_TEST_STATE__';
const require = createRequire(import.meta.url);
let instance = 0;
const originalFetch = globalThis.fetch;

const mockModules = {
  electron: `
    const { EventEmitter } = require('node:events');
    const state = globalThis.${stateKey};
    class MockNotification extends EventEmitter {
      static isSupported() { return false; }
      show() {}
    }
    module.exports = {
      app: {
        getVersion: () => state.currentVersion,
        get isPackaged() { return true; },
        getAppPath: () => '/mock/IDACC/resources/app.asar',
      },
      BrowserWindow: class BrowserWindow {},
      Notification: MockNotification,
    };
  `,
  'electron-updater': `
    const { EventEmitter } = require('node:events');
    const state = globalThis.${stateKey};
    const updater = new EventEmitter();
    Object.assign(updater, {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      autoRunAppAfterInstall: true,
      allowDowngrade: true,
      allowPrerelease: true,
      setFeedURL(feed) {
        state.feeds.push({ ...feed });
      },
      checkForUpdates() {
        state.checkCalls += 1;
        return state.checkImpl(updater);
      },
      downloadUpdate() {
        state.downloadCalls += 1;
        return state.downloadImpl(updater);
      },
      quitAndInstall(...args) {
        state.installCalls += 1;
        state.installArgs.push(args);
      },
    });
    state.autoUpdater = updater;
    module.exports = { autoUpdater: updater };
  `,
  settings: `
    const state = globalThis.${stateKey};
    module.exports = { loadSettings: () => ({ update: { ...state.settings } }) };
  `,
  schema: `
    module.exports = { DEFAULT_UPDATE_REPO: 'bobofbuilding/idacc' };
  `,
  target: `
    module.exports = { evaluateUpdateTarget: () => ({ ok: true }) };
  `,
};

try {
  await build({
    entryPoints: [join(desktopRoot, 'src', 'main', 'updater.ts')],
    outfile: bundledUpdater,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    define: {
      __IDACC_REVIEW_BUILD__: 'false',
      __IDACC_UPDATE_CHANNEL_POLICY__: JSON.stringify(
        'idacc-production-updater-enabled:v1',
      ),
    },
    plugins: [{
      name: 'updater-runtime-mocks',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
        esbuild.onResolve({ filter: /^electron-updater$/ }, () => ({ path: 'electron-updater', namespace: 'mock' }));
        esbuild.onResolve({ filter: /settings\/store\.ts$/ }, () => ({ path: 'settings', namespace: 'mock' }));
        esbuild.onResolve({ filter: /settings\/schema\.ts$/ }, () => ({ path: 'schema', namespace: 'mock' }));
        esbuild.onResolve({ filter: /updateTarget\.ts$/ }, () => ({ path: 'target', namespace: 'mock' }));
        esbuild.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents: mockModules[path],
          loader: 'js',
        }));
      },
    }],
  });

  await build({
    entryPoints: [join(desktopRoot, 'src', 'main', 'updater.ts')],
    outfile: bundledReviewUpdater,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    define: {
      __IDACC_REVIEW_BUILD__: 'true',
      __IDACC_UPDATE_CHANNEL_POLICY__: JSON.stringify(
        'idacc-review-updater-enabled:v1',
      ),
    },
    plugins: [{
      name: 'review-updater-runtime-mocks',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'mock' }));
        esbuild.onResolve({ filter: /^electron-updater$/ }, () => ({ path: 'electron-updater', namespace: 'mock' }));
        esbuild.onResolve({ filter: /settings\/store\.ts$/ }, () => ({ path: 'settings', namespace: 'mock' }));
        esbuild.onResolve({ filter: /settings\/schema\.ts$/ }, () => ({ path: 'schema', namespace: 'mock' }));
        esbuild.onResolve({ filter: /updateTarget\.ts$/ }, () => ({ path: 'target', namespace: 'mock' }));
        esbuild.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          contents: mockModules[path],
          loader: 'js',
        }));
      },
    }],
  });

  function loadUpdater(overrides = {}, review = false) {
    const state = {
      currentVersion: '1.0.0',
      settings: {
        autoUpgrade: false,
        checkIntervalHours: 4,
        updateRepo: 'attacker/untrusted-feed',
        updateManifestUrl: 'https://attacker.invalid/latest.yml',
      },
      feeds: [],
      checkCalls: 0,
      downloadCalls: 0,
      installCalls: 0,
      installArgs: [],
      latestCalls: 0,
      latestStableVersion: '1.1.0',
      checkImpl: async () => ({ updateInfo: { version: '1.1.0' } }),
      downloadImpl: async () => [],
      autoUpdater: null,
      ...overrides,
    };
    globalThis.fetch = async () => {
      state.latestCalls += 1;
      return {
        status: 302,
        headers: {
          get: (name) => name.toLowerCase() === 'location'
            ? `https://github.com/bobofbuilding/idacc/releases/tag/v${state.latestStableVersion}`
            : null,
        },
      };
    };
    const instancePath = join(scratch, `updater-${instance += 1}.cjs`);
    copyFileSync(review ? bundledReviewUpdater : bundledUpdater, instancePath);
    globalThis[stateKey] = state;
    const api = require(instancePath);
    delete globalThis[stateKey];
    return { api, state };
  }

  {
    let finishCheck;
    const checkPending = new Promise((resolveCheck) => { finishCheck = resolveCheck; });
    const { api, state } = loadUpdater({ checkImpl: () => checkPending });

    const acceptedCheck = api.beginUpdateCheck();
    assert.equal(
      typeof acceptedCheck?.then,
      'undefined',
      'metadata checks must never retain the renderer IPC request',
    );
    assert.equal(acceptedCheck.checking, true);
    const check = api.checkForUpdate();
    const blocked = api.beginUpdateDownload();
    assert.equal(
      typeof blocked?.then,
      'undefined',
      'manual download initiation must never retain the renderer IPC request',
    );
    assert.equal(state.downloadCalls, 0, 'manual download must not race an active metadata check');
    assert.match(blocked.error, /check is still in progress/i);

    for (let attempt = 0; attempt < 5 && !finishCheck; attempt += 1) {
      await Promise.resolve();
    }
    finishCheck({ updateInfo: { version: '1.1.0' } });
    const checked = await check;
    assert.equal(checked.available, true);
    assert.deepEqual(
      state.feeds.at(-1),
      {
        provider: 'github',
        owner: 'bobofbuilding',
        repo: 'idacc',
        private: false,
        channel: 'latest',
      },
      'profile data must never redirect the executable update feed',
    );
    assert.equal(state.autoUpdater.autoDownload, false);
    assert.equal(state.autoUpdater.autoInstallOnAppQuit, false);
    assert.equal(state.autoUpdater.allowDowngrade, false);
    assert.equal(state.autoUpdater.allowPrerelease, false);
    assert.equal(state.autoUpdater.channel, 'latest');
  }

  {
    const { api, state } = loadUpdater({
      currentVersion: '1.2.0',
      checkImpl: async () => ({ updateInfo: { version: '1.2.1' } }),
      downloadImpl: async (updater) => {
        updater.emit('update-downloaded', { version: '1.2.1' });
        return ['/mock/review-update'];
      },
    }, true);
    const checked = await api.checkForUpdate();
    assert.equal(checked.channel, 'review');
    assert.equal(checked.available, true, 'review-channel updates must use a newer stable application version');
    assert.equal(state.latestCalls, 0, 'review builds must not probe the stable Latest route');
    assert.equal(state.autoUpdater.allowPrerelease, true);
    assert.equal(state.autoUpdater.channel, 'review');
    assert.deepEqual(state.feeds.at(-1), {
      provider: 'github',
      owner: 'bobofbuilding',
      repo: 'idacc',
      private: false,
      channel: 'review',
    });
    const staged = await api.downloadUpdate();
    assert.equal(staged.staged, true);
    assert.equal(staged.latest, '1.2.1');
  }

  {
    const previousNoOpen = process.env.IDCTL_UPDATE_NOOPEN;
    process.env.IDCTL_UPDATE_NOOPEN = '1';
    try {
      const { api, state } = loadUpdater({
        currentVersion: '1.2.0',
        checkImpl: async () => ({ updateInfo: { version: '1.2.1' } }),
        downloadImpl: async (updater) => {
          updater.emit('update-downloaded', { version: '1.2.1' });
          return ['/mock/review-update'];
        },
      }, true);
      await api.checkForUpdate();
      await api.downloadUpdate();
      assert.equal(api.prepareStagedUpdateInstall(), true);
      api.installPreparedUpdateAndQuit();
      assert.equal(state.autoUpdater.autoRunAppAfterInstall, false);
      assert.deepEqual(state.installArgs, [[false, true]]);
    } finally {
      if (previousNoOpen == null) delete process.env.IDCTL_UPDATE_NOOPEN;
      else process.env.IDCTL_UPDATE_NOOPEN = previousNoOpen;
    }
  }

  {
    const { api, state } = loadUpdater({
      currentVersion: '1.2.0',
      latestStableVersion: '1.1.0',
      checkImpl: async () => { throw new Error('legacy metadata must not be requested'); },
    });
    const checked = await api.checkForUpdate();
    assert.equal(checked.latest, '1.1.0');
    assert.equal(checked.available, false);
    assert.equal(checked.error, undefined);
    assert.equal(state.latestCalls, 1);
    assert.equal(state.checkCalls, 0, 'an ahead build must not request missing legacy metadata');
  }

  {
    let finishDownload;
    const downloadPending = new Promise((resolveDownload) => { finishDownload = resolveDownload; });
    const { api, state } = loadUpdater({
      settings: {
        autoUpgrade: true,
        checkIntervalHours: 4,
      },
      downloadImpl: () => downloadPending,
    });
    const acceptedCheck = api.beginUpdateCheck();
    assert.equal(typeof acceptedCheck?.then, 'undefined');
    await api.checkForUpdate();
    assert.equal(
      state.downloadCalls,
      1,
      'an automatic download must start once after the metadata check',
    );
    assert.equal(api.getStatus().downloading, true);

    let drained = false;
    const drain = api.drainUpdater().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(
      drained,
      false,
      'automatic download must remain owned after its metadata check settles',
    );
    state.autoUpdater.emit('update-downloaded', { version: '1.1.0' });
    finishDownload(['/mock/automatic-update']);
    await drain;
    assert.equal(drained, true);
    assert.equal(api.getStatus().staged, true);
  }

  {
    const { api, state } = loadUpdater({
      settings: {
        autoUpgrade: true,
        checkIntervalHours: 4,
        updateRepo: 'attacker/untrusted-feed',
      },
      downloadImpl: async (updater) => {
        updater.emit('download-progress', { percent: 64 });
        updater.emit('update-downloaded', { version: '1.1.0' });
        return ['/mock/automatic-update'];
      },
    });
    const checked = await api.checkForUpdate();
    assert.equal(state.downloadCalls, 1, 'automatic mode must retain its one-download behavior');
    assert.equal(checked.staged, true);
    assert.equal(checked.downloadPercent, 100);
  }

  {
    let finishDownload;
    const downloadPending = new Promise((resolveDownload) => { finishDownload = resolveDownload; });
    const { api, state } = loadUpdater({ downloadImpl: () => downloadPending });
    await api.checkForUpdate();

    const accepted = api.beginUpdateDownload();
    assert.equal(
      typeof accepted?.then,
      'undefined',
      'manual download initiation must acknowledge before the transfer settles',
    );
    assert.equal(accepted.downloading, true);
    const first = api.downloadUpdate();
    const second = api.downloadUpdate();
    assert.strictEqual(second, first, 'concurrent manual requests must share one promise');
    assert.equal(state.downloadCalls, 1, 'concurrent manual requests must start one underlying download');
    assert.equal(api.getStatus().downloading, true);
    assert.equal(api.getStatus().downloadPercent, 0);

    state.autoUpdater.emit('download-progress', { percent: 37.4 });
    assert.equal(api.getStatus().downloadPercent, 37.4);

    let drained = false;
    const drain = api.drainUpdater().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false, 'shutdown drain must wait for the active download');

    state.autoUpdater.emit('update-downloaded', {
      version: '1.1.0',
      releaseNotes: 'Unified application update.',
    });
    finishDownload(['/mock/idacc-update']);
    const [downloaded] = await Promise.all([first, drain]);
    assert.equal(drained, true);
    assert.equal(downloaded.downloading, false);
    assert.equal(downloaded.downloadPercent, 100);
    assert.equal(downloaded.staged, true);
    assert.equal(downloaded.latest, '1.1.0');
    assert.equal(downloaded.error, undefined);

    await api.checkForUpdate();
    assert.equal(state.checkCalls, 1, 'a staged artifact must keep its checked version binding');
  }

  {
    const { api, state } = loadUpdater({
      downloadImpl: async () => { throw new Error('network interrupted'); },
    });
    await api.checkForUpdate();
    const failed = await api.downloadUpdate();
    assert.equal(state.downloadCalls, 1);
    assert.equal(failed.downloading, false);
    assert.equal(failed.staged, false);
    assert.match(failed.error, /network interrupted/);
  }

  {
    let candidate = '0.9.9';
    const { api, state } = loadUpdater({
      checkImpl: async () => ({ updateInfo: { version: candidate } }),
    });
    assert.equal((await api.checkForUpdate()).available, false, 'downgrades must remain unavailable');
    assert.match((await api.downloadUpdate()).error, /No newer stable IDACC update/);
    assert.equal(state.downloadCalls, 0);

    candidate = '2.0.0-beta.1';
    assert.equal((await api.checkForUpdate()).available, false, 'prereleases must remain unavailable');
    assert.match((await api.downloadUpdate()).error, /No newer stable IDACC update/);
    assert.equal(state.downloadCalls, 0);
  }

  {
    let finishDownload;
    const downloadPending = new Promise((resolveDownload) => { finishDownload = resolveDownload; });
    const { api, state } = loadUpdater({ downloadImpl: () => downloadPending });
    await api.checkForUpdate();
    const download = api.downloadUpdate();
    state.autoUpdater.emit('update-downloaded', { version: '1.2.0' });
    finishDownload(['/mock/wrong-update']);
    const mismatched = await download;
    assert.equal(mismatched.staged, false, 'a different downloaded version must never be staged');
    assert.match(mismatched.error, /did not match the stable release that was checked/);
  }

  process.stdout.write('unified updater manual download smoke: ok\n');
} finally {
  globalThis.fetch = originalFetch;
  delete globalThis[stateKey];
  rmSync(scratch, { recursive: true, force: true });
}
