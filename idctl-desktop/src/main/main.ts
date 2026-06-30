/**
 * Electron main process: creates the window, wires the IPC bridge to the
 * id-agents manager, and loads the React renderer.
 */

import { app, BrowserWindow, ipcMain, shell, Menu, MenuItem, globalShortcut, screen, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { call as bridgeCall, startGoalDriver, startOrgSync, startModelRefreshLoop } from './bridge.ts';
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
import { getMaterial, importMaterialFiles, listMaterials, markRecommendation, pickMaterialFiles, pickMaterialFolder, processMaterial, processNextMaterial, removeMaterial, saveMaterial, updateMaterialPriority, type CreateMaterialInput, type LearnMaterial, type LearnPriority, type LearnReviewState, type ProcessMaterialContext } from './materialstore.ts';
import { generateImage, readImage, imageModels, getImageServer, detectImageServer } from './images.ts';
import { readWiki } from './wiki.ts';
import { loadSettings, removeEvmRpc, saveSettings, setUpdateSettings, setImageServer, upsertEvmRpc, recordEvmRpcRequest } from '../../../idctl/src/settings/store.ts';
import type { EvmRpcKeySource, EvmRpcProfile, EvmRpcRequest, ImageServerConfig } from '../../../idctl/src/settings/schema.ts';
import { startBroker, armBroker, disarmBroker, setWatching, brokerStatus, auditTail, panicBroker, setSupervised, setPaused, confirmAction, pendingActions, setPanicHotkey, mintAgentToken, brokerUrl, stopBroker, legacyAgentTokenReport } from './computeruse/broker.ts';
import { getPermissions, openPermissionSettings, relaunchApp, type CuPermissionPane } from './computeruse/permissions.ts';
import { driverCapability, getMousePos } from './computeruse/driver.mac.ts';
import { syncDomainsForMethod, type StoreChangeEvent } from '../shared/syncDomains.ts';

// Bundled as CommonJS → __dirname is the output dir (out/main/).
declare const __dirname: string;

let win: BrowserWindow | null = null;
let brainDashboardWin: BrowserWindow | null = null;
let stopGoalDriver: (() => void) | null = null;

type EvmRpcRow = Omit<EvmRpcProfile, 'apiKey' | 'apiKeyEncrypted'> & { keySource: EvmRpcKeySource };
type BrainDashboardTab = 'fleet' | 'health' | 'skills' | 'learning' | 'agents' | 'graph';

const BRAIN_DASHBOARD_TABS: Record<BrainDashboardTab, { title: string; path: string }> = {
  fleet: { title: 'Brain Fleet', path: '/dashboard' },
  health: { title: 'Brain Health', path: '/dashboard/health' },
  skills: { title: 'Brain Skills', path: '/dashboard/skills' },
  learning: { title: 'Brain Learning', path: '/dashboard/learning' },
  agents: { title: 'Brain Agents', path: '/dashboard/agents' },
  graph: { title: 'Brain Graph', path: '/dashboard/graph' },
};

async function syncGoalInstructionsAfterMutation(action: string): Promise<void> {
  try {
    await bridgeCall('goals:syncInstructions', []);
  } catch (e) {
    console.warn(`[goals] ${action}: saved locally, but instruction sync failed:`, e);
  }
}

function normalizeBrainDashboardTab(value: unknown): BrainDashboardTab {
  const tab = String(value || 'fleet').toLowerCase();
  if (tab in BRAIN_DASHBOARD_TABS) return tab as BrainDashboardTab;
  throw new Error(`Unsupported Brain dashboard tab "${tab}"`);
}

async function openBrainDashboard(value: unknown): Promise<{ ok: true; tab: BrainDashboardTab; url: string }> {
  const tab = normalizeBrainDashboardTab(value);
  const cfg = BRAIN_DASHBOARD_TABS[tab];
  const url = `http://127.0.0.1:4200${cfg.path}`;
  if (!brainDashboardWin || brainDashboardWin.isDestroyed()) {
    brainDashboardWin = new BrowserWindow({
      width: 1100,
      height: 800,
      title: cfg.title,
      webPreferences: {
        contextIsolation: true,
      },
    });
    brainDashboardWin.on('closed', () => { brainDashboardWin = null; });
  }
  brainDashboardWin.setTitle(cfg.title);
  brainDashboardWin.show();
  brainDashboardWin.focus();
  if (brainDashboardWin.webContents.getURL() !== url) {
    await brainDashboardWin.loadURL(url);
  }
  return { ok: true, tab, url };
}

type ComputerUseAttachedAgent = { id?: string; name?: string; team?: string; authority?: string };

function sortedComputerUseKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}

function scopedComputerUseAuthority(agent: ComputerUseAttachedAgent, fallbackTeam: string): string {
  return String(agent.authority ?? `${agent.team ?? fallbackTeam}:${agent.name ?? ''}`).trim();
}

function attachedComputerUseStamp(agents: ComputerUseAttachedAgent[], team: string): string {
  return sortedComputerUseKey(agents.map((a) => `${a.id ?? ''}:${scopedComputerUseAuthority(a, team)}`));
}

async function armComputerUseFromCurrentAttached(teamArg: unknown, expectedAttachedStampArg?: unknown) {
  const team = typeof teamArg === 'string' && teamArg.trim() ? teamArg.trim() : 'default';
  const attached = await bridgeCall('cu:attached', [team]) as ComputerUseAttachedAgent[];
  const expected = typeof expectedAttachedStampArg === 'string' ? expectedAttachedStampArg : '';
  const actualStamp = attachedComputerUseStamp(attached ?? [], team);
  if (expected && expected !== actualStamp) {
    throw new Error('Computer Use blessed agents changed before arming; refresh and review Who can drive.');
  }
  const status = brokerStatus();
  const next = sortedComputerUseKey([
    ...(status.blessed ?? []).filter((authority: string) => !authority.startsWith(`${team}:`)),
    ...(attached ?? []).map((agent) => scopedComputerUseAuthority(agent, team)),
  ]).split('|').filter(Boolean);
  return { ...armBroker(next), team, attached: attached?.length ?? 0 };
}

function publishStoreChange(method: string): void {
  const domains = syncDomainsForMethod(method);
  if (!domains.length) return;
  const event: StoreChangeEvent = { method, domains, at: Date.now() };
  try { win?.webContents.send('idagents:sync', event); } catch { /* window may be gone */ }
}

function evmEnvKeyName(id: string): string {
  return `IDCTL_EVM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function encryptSecret(secret: string): string {
  return safeStorage.encryptString(secret).toString('base64');
}

function decryptSecret(encrypted?: string): string | undefined {
  if (!encrypted) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

function evmKeySourceOf(rpc: EvmRpcProfile): EvmRpcKeySource {
  if (rpc.apiKeyEncrypted) return 'encrypted';
  if (rpc.apiKey || extractEmbeddedRpcKey(rpc.httpsUrl)) return 'config';
  if (process.env[evmEnvKeyName(rpc.id)]) return 'env';
  return 'none';
}

function resolveEvmRpcKey(rpc: EvmRpcProfile): string | undefined {
  return decryptSecret(rpc.apiKeyEncrypted) || rpc.apiKey || process.env[evmEnvKeyName(rpc.id)] || undefined;
}

function redactEvmRpc(rpc: EvmRpcProfile): EvmRpcRow {
  const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...safe } = rpc;
  return { ...safe, httpsUrl: sanitizeRpcUrlForDisplay(rpc.httpsUrl), keySource: evmKeySourceOf(rpc) };
}

function normalizeRpcUrlForStorage(httpsUrl: string, apiKey?: string): string {
  let url = httpsUrl.trim();
  const key = apiKey?.trim();
  if (!key) return url;
  const encoded = encodeURIComponent(key);
  url = url.split(key).join('{API_KEY}');
  if (encoded !== key) url = url.split(encoded).join('{API_KEY}');
  return url;
}

function isSecretLikeRpcValue(value: string | undefined): value is string {
  if (!value) return false;
  if (/^\{API_KEY\}$|^\$API_KEY$|^placeholder$/i.test(value)) return false;
  return /^[A-Za-z0-9._~:-]{12,}$/.test(value);
}

function extractEmbeddedRpcKey(httpsUrl: string | undefined): string | undefined {
  if (!httpsUrl) return undefined;
  try {
    const parsed = new URL(httpsUrl.replace(/\{API_KEY\}|\$API_KEY/g, 'placeholder'));
    const queryNames = ['apikey', 'api_key', 'key', 'token', 'access_token', 'auth', 'x-api-key'];
    for (const [name, value] of new URLSearchParams(parsed.searchParams)) {
      if (queryNames.includes(name.toLowerCase()) && isSecretLikeRpcValue(value)) return value;
    }
    const parts = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    for (let i = 1; i < parts.length; i++) {
      if (/^v[23]$/i.test(parts[i - 1]) && isSecretLikeRpcValue(parts[i])) return parts[i];
    }
    if (/quicknode|quiknode/i.test(parsed.hostname)) {
      const candidate = parts.find(isSecretLikeRpcValue);
      if (candidate) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeRpcForStorage(httpsUrl: string, explicitApiKey?: string): { httpsUrl: string; apiKey?: string } {
  const explicit = explicitApiKey?.trim() || undefined;
  const embedded = extractEmbeddedRpcKey(httpsUrl);
  let normalized = normalizeRpcUrlForStorage(httpsUrl, explicit || embedded);
  if (explicit && embedded && embedded !== explicit) {
    normalized = normalizeRpcUrlForStorage(normalized, embedded);
  }
  return { httpsUrl: normalized, apiKey: explicit || embedded };
}

function sanitizeRpcUrlForDisplay(httpsUrl: string): string {
  const embedded = extractEmbeddedRpcKey(httpsUrl);
  return embedded ? normalizeRpcUrlForStorage(httpsUrl, embedded) : httpsUrl;
}

function redactRpcSecretText(text: string | undefined, rpc: EvmRpcProfile, apiKey?: string): string | undefined {
  if (!text) return text;
  const keys = [apiKey, rpc.apiKey, extractEmbeddedRpcKey(rpc.httpsUrl)].filter((k): k is string => Boolean(k));
  let out = text;
  for (const key of keys) {
    const encoded = encodeURIComponent(key);
    out = out.split(key).join('{API_KEY}');
    if (encoded !== key) out = out.split(encoded).join('{API_KEY}');
  }
  return out;
}

function loadEvmRpcsMigratingSecrets(): EvmRpcProfile[] {
  const cfg = loadSettings();
  const rpcs = cfg.evmRpcs ?? [];
  let changed = false;
  for (const rpc of rpcs) {
    const legacyKey = rpc.apiKey?.trim();
    const embeddedKey = extractEmbeddedRpcKey(rpc.httpsUrl);
    const keyToEncrypt = legacyKey || (!rpc.apiKeyEncrypted ? embeddedKey : undefined);
    if (keyToEncrypt && !rpc.apiKeyEncrypted) {
      rpc.apiKeyEncrypted = encryptSecret(keyToEncrypt);
      changed = true;
    }
    if (rpc.apiKey) {
      delete rpc.apiKey;
      changed = true;
    }
    if (embeddedKey) {
      rpc.httpsUrl = normalizeRpcUrlForStorage(rpc.httpsUrl, embeddedKey);
      changed = true;
    }
  }
  if (changed) {
    cfg.evmRpcs = rpcs;
    saveSettings(cfg);
  }
  return rpcs;
}

function rpcUrlForRequest(httpsUrl: string, apiKey?: string): string {
  const key = apiKey?.trim();
  let url = httpsUrl.trim();
  if (key) {
    url = url.replace(/\{API_KEY\}|\$API_KEY/g, encodeURIComponent(key));
    if (!/\{API_KEY\}|\$API_KEY/.test(httpsUrl) && /\/v[23]\/?$/.test(url)) {
      url = `${url.replace(/\/?$/, '/')}${encodeURIComponent(key)}`;
    }
  }
  return url;
}

function validateEvmRpcInput(input: EvmRpcProfile): void {
  if (!input.network?.trim()) throw new Error('network is required');
  const url = input.httpsUrl?.trim();
  if (!url) throw new Error('HTTPS URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/\{API_KEY\}|\$API_KEY/g, 'placeholder'));
  } catch {
    throw new Error('HTTPS URL must be a valid URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('EVM RPC URL must use https');
}

async function probeEvmRpc(id: string): Promise<{ rpcs: EvmRpcRow[]; outcome: EvmRpcRequest }> {
  const rpc = loadEvmRpcsMigratingSecrets().find((x) => x.id === id);
  if (!rpc) throw new Error('EVM RPC endpoint not found');
  const key = resolveEvmRpcKey(rpc);
  const started = Date.now();
  const outcome: EvmRpcRequest = { at: started, method: 'eth_blockNumber', status: 'unknown', keySource: evmKeySourceOf(rpc) };
  try {
    const res = await fetch(rpcUrlForRequest(rpc.httpsUrl, key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    outcome.httpStatus = res.status;
    const body = await res.json().catch(() => null) as { result?: string; error?: { message?: string; code?: number } } | null;
    outcome.latencyMs = Date.now() - started;
    if (res.status === 401 || res.status === 403 || body?.error?.code === 401) {
      outcome.status = 'auth-error';
      outcome.error = redactRpcSecretText(body?.error?.message ?? `HTTP ${res.status}`, rpc, key);
    } else if (!res.ok) {
      outcome.status = 'unreachable';
      outcome.error = redactRpcSecretText(body?.error?.message ?? `HTTP ${res.status}`, rpc, key);
    } else if (typeof body?.result === 'string') {
      outcome.status = 'available';
      outcome.blockNumber = Number.parseInt(body.result, 16);
    } else {
      outcome.status = 'error';
      outcome.error = redactRpcSecretText(body?.error?.message ?? 'missing eth_blockNumber result', rpc, key);
    }
  } catch (err) {
    outcome.latencyMs = Date.now() - started;
    outcome.status = 'unreachable';
    outcome.error = redactRpcSecretText(err instanceof Error ? err.message : String(err), rpc, key);
  }
  recordEvmRpcRequest(id, outcome);
  return { rpcs: loadEvmRpcsMigratingSecrets().map(redactEvmRpc), outcome };
}

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
    case 'evmRpc:list':
      return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
    case 'evmRpc:save':
      {
        const input = (args[0] as EvmRpcProfile) ?? {};
        const apiKeyInput = typeof (input as any).apiKey === 'string' ? (input as any).apiKey.trim() : '';
        const normalized = normalizeRpcForStorage(input.httpsUrl ?? '', apiKeyInput);
        const apiKeyEncrypted = normalized.apiKey ? encryptSecret(normalized.apiKey) : input.apiKeyEncrypted;
        const rpc: EvmRpcProfile = {
          ...input,
          httpsUrl: normalized.httpsUrl,
          apiKey: undefined,
          apiKeyEncrypted,
        };
        validateEvmRpcInput(rpc);
        upsertEvmRpc(rpc);
        return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
      }
    case 'evmRpc:remove':
      removeEvmRpc(String(args[0] ?? ''));
      return loadEvmRpcsMigratingSecrets().map(redactEvmRpc);
    case 'evmRpc:probe':
      return probeEvmRpc(String(args[0] ?? ''));
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
    case 'brain:openDashboard':
      return openBrainDashboard(args[0]);
    case 'brain:openGraph':
      return openBrainDashboard('graph');
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
    case 'goals:save': {
      const result = saveGoal(args[0] as Goal);
      await syncGoalInstructionsAfterMutation('save');
      return result;
    }
    case 'goals:remove': {
      const result = removeGoal(args[0] as string);
      await syncGoalInstructionsAfterMutation('remove');
      return result;
    }
    // Brain plans: read-only LIVE view of <projectsRoot>/brain/plans (README index + files).
    case 'brain:plans':
      return listBrainPlans(args[0] as string | undefined);
    case 'brain:plan':
      return getBrainPlan(args[0] as string, args[1] as string | undefined);
    case 'brain:setPlanStatus':
      return setBrainPlanStatus(
        args[0] as string,
        args[1] as string,
        args[2] == null ? undefined : String(args[2]),
        args[3] as { status?: string; mtime?: number } | undefined,
      );
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
    // Learn materials: Work > Learn queue, guarded extraction, active-goal comparison, review gates.
    case 'materials:list':
      return listMaterials();
    case 'materials:get':
      return getMaterial(args[0] as string);
    case 'materials:save':
      return saveMaterial(args[0] as CreateMaterialInput | LearnMaterial);
    case 'materials:remove':
      return removeMaterial(args[0] as string);
    case 'materials:pickFiles':
      return pickMaterialFiles();
    case 'materials:pickFolder':
      return pickMaterialFolder();
    case 'materials:importFiles':
      return importMaterialFiles(
        Array.isArray(args[0]) ? args[0].map(String) : [],
        (args[1] as { priority?: LearnPriority; prioritized?: boolean } | undefined) ?? {},
      );
    case 'materials:priority':
      return updateMaterialPriority(args[0] as string, args[1] as LearnPriority, args[2] as boolean | undefined);
    case 'materials:processNext':
      return processNextMaterial((args[0] as ProcessMaterialContext | undefined) ?? {});
    case 'materials:process':
      return processMaterial(args[0] as string, (args[1] as ProcessMaterialContext | undefined) ?? {});
    case 'materials:markRecommendation':
      return markRecommendation(args[0] as string, args[1] as string, args[2] as LearnReviewState);
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
      return armComputerUseFromCurrentAttached(args[0], args[1]);
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
    case 'cu:legacyAuthority':
      return legacyAgentTokenReport((args[0] as { name: string; team?: string }[] | undefined) ?? []);
    case 'cu:openPermission':
      return openPermissionSettings(args[0] as CuPermissionPane);
    case 'cu:relaunch':
      relaunchApp();
      return { ok: true };
    default:
      return bridgeCall(method, args);
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
    publishStoreChange(method);
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
