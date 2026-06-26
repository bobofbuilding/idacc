/**
 * Electron main process: creates the window, wires the IPC bridge to the
 * id-agents manager, and loads the React renderer.
 */

import { app, BrowserWindow, ipcMain, shell, Menu, MenuItem, globalShortcut, screen } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { call, startGoalDriver, startOrgSync, startModelRefreshLoop } from './bridge.ts';
import { recordControlAction } from './controlLog.ts';
import { startUpdater, stopUpdater, checkForUpdate, getStatus, applyStagedAndRelaunch } from './updater.ts';
import { subsStatus, subsSignin, subsSignout, subsInstall, type SubProvider } from './subscriptions.ts';
import { ollamaTags, ollamaPull, ollamaRemove } from './ollama.ts';
import { getHardware, runInTerminal } from './system.ts';
import { pickProjectFolder, openProjectFolder, projectReadme, projectGit, projectGitRun, githubMeta, cloneGithub, projectDiff, createGithubRepo, linkGithubRepo, forkGithub, commitProject, detectProjectsRoot, scanProjectsRoot } from './projects.ts';
import { pickChatFiles, saveChatFiles, savePastedFile } from './chatfiles.ts';
import { listChats, listInflightChats, getChat, saveChat, renameChat, removeChat, genTitle, genReason, unreadChatCount, markChatRead, patchChat, type ChatSession, type ChatPatch } from './chatstore.ts';
import { listPlans, getPlan, savePlan, removePlan, type Plan } from './planstore.ts';
import { listBrainPlans, getBrainPlan, setBrainPlanStatus, createBrainPlan } from './brainplans.ts';
import { listLoops, getLoop, saveLoop, removeLoop, type Loop } from './loopstore.ts';
import { listGoals, getGoal, saveGoal, removeGoal, type Goal } from './goalstore.ts';
import { listDreams, getDream, saveDream, removeDream, type Dream } from './dreamstore.ts';
import { listQuestions, addQuestion, removeQuestion, type BlockerQuestion } from './questionstore.ts';
import { generateImage, readImage, imageModels, getImageServer, detectImageServer } from './images.ts';
import { readWiki } from './wiki.ts';
import { loadSettings, setUpdateSettings, setImageServer } from '../../../idctl/src/settings/store.ts';
import type { ImageServerConfig } from '../../../idctl/src/settings/schema.ts';
import { startBroker, armBroker, disarmBroker, setWatching, brokerStatus, auditTail, panicBroker, setSupervised, setPaused, confirmAction, pendingActions, setPanicHotkey, mintAgentToken, brokerUrl, stopBroker } from './computeruse/broker.ts';
import { getPermissions, openPermissionSettings, relaunchApp } from './computeruse/permissions.ts';
import { driverCapability, getMousePos } from './computeruse/driver.mac.ts';

// Bundled as CommonJS → __dirname is the output dir (out/main/).
declare const __dirname: string;

let win: BrowserWindow | null = null;
let stopGoalDriver: (() => void) | null = null;

// --- window state: reopen the app where/how the user left it ---
interface WinState { x?: number; y?: number; width: number; height: number; fullScreen?: boolean }
function winStatePath(): string { return join(app.getPath('userData'), 'window-state.json'); }
function loadWinState(): WinState {
  try {
    const s = JSON.parse(readFileSync(winStatePath(), 'utf8')) as WinState;
    if (typeof s.width === 'number' && typeof s.height === 'number') return s;
  } catch { /* first run / corrupt → defaults */ }
  return { width: 1180, height: 780 };
}
function saveWinState(w: BrowserWindow): void {
  try {
    if (w.isDestroyed()) return;
    // Persist the ACTUAL on-screen bounds so the window reopens exactly where/how it was —
    // including when it was zoomed/"maximized" (those bounds already fill the work area). The
    // old approach saved getNormalBounds() + an isMaximized() flag and re-ran maximize() on
    // launch, but on macOS isMaximized()≈zoom false-positives on a big manually-sized window,
    // so the app kept reopening zoomed instead of at the user's real position. For true
    // macOS fullscreen we save the pre-fullscreen bounds and re-enter fullscreen on restore.
    const fullScreen = w.isFullScreen();
    const b = fullScreen ? w.getNormalBounds() : w.getBounds();
    writeFileSync(winStatePath(), JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height, fullScreen }));
  } catch { /* best-effort */ }
}
/** Only restore a saved position if a usable chunk of the titlebar lands on some
 *  display — otherwise (display unplugged / resolution changed) center via defaults. */
function isOnScreen(s: WinState): boolean {
  if (typeof s.x !== 'number' || typeof s.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x! + Math.min(s.width, 200) > a.x && s.x! < a.x + a.width && s.y! + 30 > a.y && s.y! < a.y + a.height;
  });
}

function createWindow() {
  const st = loadWinState();
  const placeAt = isOnScreen(st) && typeof st.x === 'number' && typeof st.y === 'number';
  win = new BrowserWindow({
    width: st.width,
    height: st.height,
    ...(placeAt ? { x: st.x, y: st.y } : {}),
    minWidth: 900,
    minHeight: 600,
    title: 'ID Agents Control Center',
    backgroundColor: '#0e1116',
    titleBarStyle: 'hiddenInset', // native traffic lights over our custom chrome
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true, // squiggles + suggestions in the chat composer and other text fields
    },
  });

  if (st.fullScreen) win.setFullScreen(true);
  // Persist geometry (debounced on move/resize; immediate on close + before-quit) so the next
  // launch — including after a self-update relaunch — reopens at the same size/position.
  let saveT: ReturnType<typeof setTimeout> | null = null;
  const saveNow = () => { if (saveT) { clearTimeout(saveT); saveT = null; } if (win) saveWinState(win); };
  const scheduleSave = () => { if (saveT) clearTimeout(saveT); saveT = setTimeout(saveNow, 400); };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('close', saveNow);

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click menu: spelling corrections for a misspelled word, plus the
  // standard edit actions — so highlighted chat text (output included) can be
  // copied and the composer's flagged words can be fixed.
  win.webContents.on('context-menu', (_e, params) => {
    const wc = win?.webContents;
    if (!wc) return;
    const menu = new Menu();
    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      for (const s of suggestions) menu.append(new MenuItem({ label: s, click: () => wc.replaceMisspelling(s) }));
      if (suggestions.length === 0) menu.append(new MenuItem({ label: 'No suggestions', enabled: false }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Add to Dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    const editable = params.isEditable;
    const hasSelection = params.selectionText.trim().length > 0;
    if (editable) menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
    if (editable || hasSelection) menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
    if (editable) menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
    if (editable || hasSelection) menu.append(new MenuItem({ role: 'selectAll' }));
    if (menu.items.length > 0) menu.popup({ window: win ?? undefined });
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
    case 'brain:openGraph':
      await shell.openExternal('http://127.0.0.1:4200/dashboard/graph');
      return { ok: true };
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
    case 'project:diff':
      return projectDiff(args[0] as string);
    case 'project:createRepo':
      return createGithubRepo(args[0] as string, (args[1] as { name?: string; description?: string; private?: boolean }) ?? {});
    case 'project:linkRepo':
      return linkGithubRepo(args[0] as string, args[1] as string);
    case 'project:commit':
      return commitProject(args[0] as string, args[1] as string);
    case 'project:fork':
      return forkGithub(args[0] as string, args[1] as string);
    case 'project:detectRoot':
      return detectProjectsRoot(args[0] as string | undefined);
    case 'project:scanRoot':
      return scanProjectsRoot(args[0] as string);
    case 'chat:pickFiles':
      return pickChatFiles();
    case 'chat:saveFiles':
      return saveChatFiles(args[0] as string, args[1] as string[]);
    case 'chat:savePasted':
      return savePastedFile(args[0] as string, args[1] as string);
    case 'chats:list':
      return listChats(args[0] as string | undefined);
    case 'chats:inflight':
      return listInflightChats(args[0] as string | undefined);
    case 'chats:get':
      return getChat(args[0] as string);
    case 'chats:save':
      return saveChat(args[0] as ChatSession);
    case 'chats:rename':
      return renameChat(args[0] as string, args[1] as string);
    case 'chats:remove':
      return removeChat(args[0] as string);
    case 'chats:unreadCount':
      return unreadChatCount(args[0] as string | undefined);
    case 'chats:markRead':
      return markChatRead(args[0] as string);
    case 'chats:patch':
      return patchChat(args[0] as string, (args[1] as ChatPatch) ?? {});
    case 'chat:genTitle':
      return genTitle(args[0] as string);
    case 'chat:genReason':
      return genReason(args[0] as string);
    case 'plans:list':
      return listPlans(args[0] as string | undefined);
    case 'plans:get':
      return getPlan(args[0] as string);
    case 'plans:save':
      return savePlan(args[0] as Plan);
    case 'plans:remove':
      return removePlan(args[0] as string);
    // Goals: saved per-project goals (goalstore).
    case 'goals:list':
      return listGoals(args[0] as string | undefined);
    case 'goals:get':
      return getGoal(args[0] as string);
    case 'goals:save':
      return saveGoal(args[0] as Goal);
    case 'goals:remove':
      return removeGoal(args[0] as string);
    // Brain plans: read-only LIVE view of <projectsRoot>/brain/plans (README index + files).
    case 'brain:plans':
      return listBrainPlans(args[0] as string | undefined);
    case 'brain:plan':
      return getBrainPlan(args[0] as string, args[1] as string | undefined);
    case 'brain:setPlanStatus':
      return setBrainPlanStatus(args[0] as string, args[1] as string, args[2] as string | undefined);
    case 'brain:createPlan':
      return createBrainPlan(args[0] as string, args[1] as string, args[2] as string | undefined);
    // Loops: saved sequential agent→task chains (definition + last-run results).
    case 'loops:list':
      return listLoops(args[0] as string | undefined);
    case 'loops:get':
      return getLoop(args[0] as string);
    case 'loops:save':
      return saveLoop(args[0] as Loop);
    case 'loops:remove':
      return removeLoop(args[0] as string);
    // Dreams: saved offline-reflection reports (consolidation/insights/ideas/simulations).
    case 'dreams:list':
      return listDreams(args[0] as string | undefined);
    case 'dreams:get':
      return getDream(args[0] as string);
    case 'dreams:save':
      return saveDream(args[0] as Dream);
    case 'dreams:remove':
      return removeDream(args[0] as string);
    // Blocker-question queue (app-side; shown in the Inbox with options).
    case 'questions:list':
      return listQuestions(args[0] as string | undefined);
    case 'questions:add':
      return addQuestion(args[0] as BlockerQuestion);
    case 'questions:remove':
      return removeQuestion(args[0] as string);
    case 'image:generate':
      return generateImage(args[0] as string, args[1] as string | undefined);
    case 'image:read':
      return readImage(args[0] as string);
    case 'image:models':
      return imageModels();
    case 'image:getServer':
      return getImageServer();
    case 'image:setServer':
      return setImageServer((args[0] as ImageServerConfig | null) ?? null).imageServer ?? null;
    case 'image:detectServer':
      return detectImageServer();
    case 'app:runInTerminal':
      return runInTerminal(args[0] as string);
    case 'wiki:get':
      return readWiki();
    // Computer Use (broker + macOS permissions live in the Electron main process)
    case 'cu:status':
      return brokerStatus();
    case 'cu:arm':
      return armBroker(args[0] as string[] | undefined);
    case 'cu:disarm':
      return disarmBroker();
    case 'cu:watch':
      return setWatching(Boolean(args[0]));
    case 'cu:audit':
      return auditTail(args[0] as number | undefined);
    case 'cu:panic':
      return panicBroker();
    case 'cu:setSupervised':
      return setSupervised(Boolean(args[0]));
    case 'cu:pause':
      return setPaused(Boolean(args[0]));
    case 'cu:confirm':
      return confirmAction(args[0] as string, Boolean(args[1]));
    case 'cu:pending':
      return pendingActions();
    case 'cu:permissions':
      return getPermissions();
    case 'cu:openPermission':
      return openPermissionSettings(args[0] as 'screen' | 'accessibility');
    case 'cu:relaunch':
      relaunchApp();
      return { ok: true };
    default:
      return call(method, args);
  }
}

// Single IPC entry point → app methods + allowlisted bridge methods.
ipcMain.handle('idagents:call', async (_e, method: string, args: unknown[]) => {
  try {
    const result = await appCall(method, args);
    // Mirror successful control actions to the self-learning brain (best-effort, fire-and-forget):
    // this is the single choke point every renderer mutation flows through, so the brain learns
    // config/org/project changes that never reach the manager. Never awaited — can't delay the reply.
    recordControlAction(method, Array.isArray(args) ? args : [], result);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// Headless self-test of the update flow (no window). IDCTL_UPDATE_SELFTEST=
//   check → run a manifest check, print status, quit.
//   apply → check, then swap the staged bundle in place (IDCTL_UPDATE_NOOPEN
//           skips the relaunch) so the swap can be verified.
// Headless self-test of the Computer Use broker (no real window interaction):
// arm the broker, hit its loopback /action screenshot endpoint with the token,
// print whether a real frame came back, then quit. Verifies capture + auth + arm.
// Dev-only (never in the packaged app) so the shipped build can't be coaxed into
// serving screenshots headlessly via an env var.
const cuSelftest = !app.isPackaged && process.env.IDCTL_CU_SELFTEST;
if (cuSelftest) {
  setTimeout(() => { console.log('CU_SELFTEST_TIMEOUT'); app.exit(1); }, 15000).unref?.();
  app.whenReady().then(async () => {
    await startBroker(() => {});
    setWatching(true);
    armBroker(['selftest']);
    setSupervised(false); // headless: no UI to approve, so test the raw input path
    const st = brokerStatus();
    try {
      const tok = mintAgentToken('selftest'); // per-agent token (the broker now authenticates by token)
      const url = brokerUrl();
      const post = (b: Record<string, unknown>) => fetch(`${url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(b) }).then((r) => r.json());
      const shot = await post({ type: 'screenshot' }) as { ok?: boolean; image?: string; width?: number; height?: number; reason?: string };
      // Then exercise the INPUT path (mouse_move). If Accessibility is granted it
      // executes (real move); otherwise it's correctly blocked — both prove the gate.
      const mv = await post({ type: 'mouse_move', x: Math.round((shot.width || 100) / 2), y: Math.round((shot.height || 100) / 2) }) as { ok?: boolean; detail?: string; reason?: string };
      // Supervised round-trip: re-enable supervised, fire an action (held), approve it, confirm it executes.
      setSupervised(true);
      const held = post({ type: 'left_click', x: 10, y: 10 }) as Promise<{ ok?: boolean; reason?: string }>;
      await new Promise((r) => setTimeout(r, 500));
      const pend = pendingActions();
      if (pend.length) confirmAction(pend[0].id, true);
      const heldRes = await held;
      // Classifier: in AUTONOMOUS mode a normal move auto-executes, but a dangerous
      // typed command is HELD. Deny the risky one (never executes).
      setSupervised(false);
      const normal = await post({ type: 'mouse_move', x: 20, y: 20 }) as { ok?: boolean };
      const risky = post({ type: 'type', text: 'sudo rm -rf /tmp/x' }) as Promise<{ ok?: boolean; reason?: string }>;
      await new Promise((r) => setTimeout(r, 400));
      const riskyPend = pendingActions();
      if (riskyPend.length) confirmAction(riskyPend[0].id, false);
      const riskyRes = await risky;
      console.log('CU_SELFTEST ' + JSON.stringify({ port: st.port, shotOk: shot.ok, imageBytes: shot.image ? Buffer.from(shot.image, 'base64').length : 0, width: shot.width, height: shot.height, driverOk: st.driverOk, accessibility: st.accessibility, moveOk: mv.ok, moveDetail: mv.detail, moveReason: mv.reason, supervisedHeld: pend.length, supervisedApprovedOk: heldRes.ok, autoNormalOk: normal.ok, autoRiskyHeld: riskyPend.length, autoRiskyDenied: riskyRes.reason === 'declined' }));
    } catch (e) {
      console.log('CU_SELFTEST_ERR ' + (e instanceof Error ? e.message : String(e)));
    }
    app.quit();
  });
}

// Read-only driver probe (safe in packaged builds): report whether the native
// input addon loads + the current mouse position, then quit. No synthetic input.
const driverProbe = process.env.IDCTL_CU_DRIVERPROBE;
const selftest = process.env.IDCTL_UPDATE_SELFTEST;
if (cuSelftest) { /* handled above */ } else if (driverProbe) {
  app.whenReady().then(() => {
    console.log('CU_DRIVER ' + JSON.stringify({ cap: driverCapability(), mouse: getMousePos() }));
    app.exit(0);
  });
} else if (selftest) {
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
    // Persist window geometry on EVERY quit path (Cmd-Q, menu, and the self-update relaunch,
    // which calls app.quit()) before the window is destroyed — registered once, app-wide.
    app.on('before-quit', () => { if (win && !win.isDestroyed()) saveWinState(win); });
    // Reactive org-sync: keep every agent's goals & instructions file composed from the lead
    // hierarchy + brain team-instructions (first pass ~15s after boot, then every 5 min).
    try { startOrgSync(); } catch (e) { console.warn('[org-sync] failed to start:', e); }
    // Keep each runtime's model list current: re-probe backing providers on boot + every 6h.
    try { startModelRefreshLoop(); } catch (e) { console.warn('[model-refresh] failed to start:', e); }
    // Disabled by default: when enabled, active+autopilot goals gap-fill fleet tasks.
    try { stopGoalDriver = startGoalDriver(); } catch (e) { console.warn('[goaldriver] failed to start:', e); }
    // Computer Use broker: loopback controller + live frame pump + approval prompts → the renderer.
    void startBroker(
      (frame) => { try { win?.webContents.send('computeruse:frame', frame); } catch { /* window gone */ } },
      (evt) => { try { win?.webContents.send('computeruse:pending', evt); } catch { /* window gone */ } },
    );
    // Global PANIC hotkey: instant stop from anywhere, even when the app isn't focused.
    try {
      const ok = globalShortcut.register('CommandOrControl+Alt+Shift+P', () => {
        panicBroker();
        try { win?.webContents.send('computeruse:panic', { ts: Date.now() }); } catch { /* */ }
      });
      setPanicHotkey(ok);
      if (!ok) console.warn('[cu] PANIC hotkey not registered (already taken); use the on-screen button');
    } catch { /* the on-screen PANIC button is the fallback */ }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('will-quit', stopUpdater);
app.on('will-quit', stopBroker);
app.on('will-quit', () => { try { stopGoalDriver?.(); } catch { /* */ } });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch { /* */ } });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
