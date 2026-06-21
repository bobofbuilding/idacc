/**
 * Electron main process: creates the window, wires the IPC bridge to the
 * id-agents manager, and loads the React renderer.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { call } from './bridge.ts';
import { startUpdater, stopUpdater, checkForUpdate, getStatus, applyStagedAndRelaunch } from './updater.ts';
import { subsStatus, subsSignin, subsSignout, subsInstall, type SubProvider } from './subscriptions.ts';
import { ollamaTags, ollamaPull, ollamaRemove } from './ollama.ts';
import { getHardware, runInTerminal } from './system.ts';
import { pickProjectFolder, openProjectFolder, projectReadme, projectGit, projectGitRun, githubMeta, cloneGithub, detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { loadSettings, setUpdateSettings } from '../../../idctl/src/settings/store.ts';

// Bundled as CommonJS → __dirname is the output dir (out/main/).
declare const __dirname: string;

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'ID Agents Control Center',
    backgroundColor: '#0e1116',
    titleBarStyle: 'hiddenInset', // native traffic lights over our custom chrome
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const initialView = process.env.IDCTL_VIEW;
  win.loadFile(join(__dirname, '../renderer/index.html'), initialView ? { search: `view=${initialView}` } : undefined);

  // Verification hook: with IDCTL_SHOT=<path>, capture the rendered window once
  // data has loaded, write a PNG, and quit. Lets the build be proven headlessly.
  const shot = process.env.IDCTL_SHOT;
  if (shot) {
    // Optional: scroll before capturing so sections below the fold can be
    // verified headlessly. 'bottom' or a CSS selector / text fragment.
    const shotScroll = process.env.IDCTL_SHOT_SCROLL;
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (shotScroll) {
            const js = shotScroll === 'bottom'
              ? 'window.scrollTo(0, document.body.scrollHeight)'
              : `(${((sel: string) => {
                  const bySel = document.querySelector(sel);
                  if (bySel) { bySel.scrollIntoView({ block: 'start' }); return; }
                  const el = [...document.querySelectorAll('h2,h3,section,.card')]
                    .find((n) => (n.textContent || '').toLowerCase().includes(sel.toLowerCase()));
                  el?.scrollIntoView({ block: 'start' });
                }).toString()})(${JSON.stringify(shotScroll)})`;
            await win!.webContents.executeJavaScript(js);
            await new Promise((r) => setTimeout(r, 350));
          }
          // Optional: click a control (by CSS selector or button text) and wait,
          // so async UI (e.g. a discovery scan) can be captured headlessly.
          const shotClick = process.env.IDCTL_SHOT_CLICK;
          if (shotClick) {
            // Pipe-separated sequence: click each (by CSS selector or button text)
            // with a gap between — lets navigation flows be exercised headlessly.
            for (const sel of shotClick.split('|')) {
              const clickJs = `(${((s: string) => {
                const bySel = document.querySelector(s) as HTMLElement | null;
                const el = bySel || [...document.querySelectorAll('button')]
                  .find((b) => (b.textContent || '').toLowerCase().includes(s.toLowerCase())) as HTMLElement | undefined;
                el?.click();
                return !!el;
              }).toString()})(${JSON.stringify(sel)})`;
              await win!.webContents.executeJavaScript(clickJs);
              await new Promise((r) => setTimeout(r, 500));
            }
            await new Promise((r) => setTimeout(r, Number(process.env.IDCTL_SHOT_CLICK_WAIT) || 2000));
          }
          const img = await win!.webContents.capturePage();
          await import('node:fs').then((fs) => fs.writeFileSync(shot, img.toPNG()));
        } catch (err) {
          console.error('screenshot failed:', err);
        }
        app.quit();
      }, 3500);
    });
  }
}

// App-level (main-process) methods that don't go through the manager bridge.
async function appCall(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'app:version':
      return app.getVersion();
    case 'update:status':
      return getStatus();
    case 'update:check':
      return checkForUpdate();
    case 'update:applyNow':
      return { applying: applyStagedAndRelaunch() };
    case 'update:getSettings':
      return loadSettings().update ?? null;
    case 'update:setSettings':
      return setUpdateSettings((args[0] as Record<string, unknown>) ?? {}).update ?? null;
    case 'subs:status':
      return subsStatus();
    case 'subs:signin':
      return subsSignin(args[0] as SubProvider);
    case 'subs:signout':
      return subsSignout(args[0] as SubProvider);
    case 'subs:install':
      return subsInstall(args[0] as SubProvider);
    case 'ollama:tags':
      return ollamaTags();
    case 'ollama:pull':
      return ollamaPull(args[0] as string);
    case 'ollama:remove':
      return ollamaRemove(args[0] as string);
    case 'app:hardware':
      return getHardware();
    case 'project:pickFolder':
      return pickProjectFolder(args[0] as string | undefined);
    case 'project:openFolder':
      return openProjectFolder(args[0] as string);
    case 'project:readme':
      return projectReadme(args[0] as string);
    case 'project:git':
      return projectGit(args[0] as string);
    case 'project:gitRun':
      return projectGitRun(args[0] as string, args[1] as string);
    case 'project:githubMeta':
      return githubMeta(args[0] as string);
    case 'project:cloneGithub':
      return cloneGithub(args[0] as string, args[1] as string);
    case 'project:detectRoot':
      return detectProjectsRoot(args[0] as string | undefined);
    case 'project:scanRoot':
      return scanProjectsRoot(args[0] as string);
    case 'app:runInTerminal':
      return runInTerminal(args[0] as string);
    default:
      return call(method, args);
  }
}

// Single IPC entry point → app methods + allowlisted bridge methods.
ipcMain.handle('idagents:call', async (_e, method: string, args: unknown[]) => {
  try {
    return { ok: true, result: await appCall(method, args) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Headless self-test of the update flow (no window). IDCTL_UPDATE_SELFTEST=
//   check → run a manifest check, print status, quit.
//   apply → check, then swap the staged bundle in place (IDCTL_UPDATE_NOOPEN
//           skips the relaunch) so the swap can be verified.
const selftest = process.env.IDCTL_UPDATE_SELFTEST;
if (selftest) {
  app.whenReady().then(async () => {
    const st = await checkForUpdate();
    console.log('SELFTEST_STATUS ' + JSON.stringify(st));
    if (selftest === 'apply' && st.staged) {
      const applied = applyStagedAndRelaunch(); // spawns detached swapper, then quits
      console.log('SELFTEST_APPLY ' + applied);
    } else {
      app.quit();
    }
  });
} else {
  app.whenReady().then(() => {
    createWindow();
    if (win) startUpdater(win);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', stopUpdater);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
