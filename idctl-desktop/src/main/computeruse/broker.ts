/**
 * Computer Use BROKER — the single host-side controller (Phase 1).
 *
 * A loopback-only (127.0.0.1) HTTP server that is the ONLY thing which ever
 * touches the screen + input. The agent-facing MCP server is a dumb proxy that
 * forwards each tool call here over a bearer token; this broker is the one
 * chokepoint where every control is ENFORCED — armed, the caller is blessed,
 * Accessibility is granted, coords are clamped, and every action is audited.
 * An agent can only REQUEST, only the broker ACTS.
 *
 * Phase 1 scope: screenshot + mouse/keyboard/scroll input (gated by armed +
 * bless-list + Accessibility), an append-only audit, and a live JPEG frame pump.
 */
import http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { app } from 'electron';
import { captureDisplay, displayInfos, selectedDisplayInfo, type Frame } from './capture.ts';
import { accessibilityGranted } from './permissions.ts';
import * as driver from './driver.mac.ts';
import {
  audit,
  recentAudit,
  resetComputerUseAuditProfileState,
  type AuditEntry,
} from './audit.ts';
import { copyFilePrivateSync } from '../privateFileCopy.ts';
import {
  classifyComputerUseRisk,
  computerUseActionNeedsApproval,
  mapComputerUsePoint,
  validateComputerUseFrame,
  type ComputerUseControlMode,
  type ComputerUseFrame,
} from '../../shared/computerUsePolicy.ts';
import {
  closeComputerUseServer,
  createComputerUseRequestLifecycle,
  trackComputerUseServerSockets,
  type ComputerUseWorkLease,
} from './requestLifecycle.ts';

const PORT_RANGE = [4180, 4181, 4182, 4183, 4184, 4185];
const PUMP_MS = 450;          // ~2.2 fps live pane (cheap, smooth enough to supervise)
const PUMP_MAX_WIDTH = 1280;  // downscale the pane stream; agent screenshots stay full-res
const PUMP_QUALITY = 55;
const ACTION_FRAME_MAX_AGE_MS = 60_000;
const BROKER_STOP_TIMEOUT_MS = 3_000;
const COMPUTER_USE_UNAVAILABLE_REASON =
  'Computer Use is currently available only on macOS. This Windows/Linux review build does not include the macOS screen-control driver.';

function computerUseAvailable(): boolean {
  return process.platform === 'darwin';
}

function cuDir(): string {
  const d = process.env.IDACC_DATA_DIR?.trim()
    ? join(process.env.IDACC_DATA_DIR.trim(), 'computeruse')
    : join(homedir(), '.config', 'idctl', 'computeruse');
  mkdirSync(d, { recursive: true, mode: 0o700 }); // 0700: the dir holds the broker token
  try { chmodSync(d, 0o700); } catch { /* tighten even if it pre-existed at a looser mode */ }
  return d;
}
function sessionFile(): string { return join(cuDir(), 'session.json'); }
/** Exact profile-owned discovery file injected into every attached MCP process. */
export function brokerSessionPath(): string { return sessionFile(); }
/** Stable absolute path the attached MCP server is run from (copied from the bundle on launch). */
export function brokerServerPath(): string { return join(cuDir(), 'server.mjs'); }

interface BrokerState {
  server: http.Server | null;
  port: number;
  token: string;
  armed: boolean;
  watching: boolean;          // the live pane is on screen → only then do we run the frame pump
  onFrame: ((f: { jpegBase64: string; width: number; height: number; display: Frame['display']; ts: number; driver: 'agent' | 'none' }) => void) | null;
  pump: NodeJS.Timeout | null;
  lastSig: number;            // dirty-frame skip (FNV-1a over the jpeg bytes)
  lastAgent: string;          // most recent caller (for the pane label)
  actions: number;            // lifetime action count
  captureFailing: boolean;    // last pump capture returned null while armed (permission/relaunch hint)
  displayId: number | null;   // operator-selected capture/control display; null follows primary
  blessed: Set<string>;       // scoped agent authorities allowed to act this armed session (synced at arm)
  team: string;               // most recent caller's team (for the audit→Chat mirror)
  lastShot: ComputerUseFrame | null; // agent/display-bound coordinate evidence
  controlMode: ComputerUseControlMode; // supervised by default; full control is explicit and session-scoped
  paused: boolean;            // block input without disarming (user is taking over)
  pending: Map<string, { resolve: (allow: boolean) => void; timer: ReturnType<typeof setTimeout>; entry: PendingAction }>;
  onPending: ((evt: { kind: 'add' | 'remove'; pending: PendingAction[] }) => void) | null;
  stopping: boolean;
}
export interface PendingAction { id: string; agent: string; action: string; preview: string; ts: number; expiresAt: number }
export interface ComputerUseAuthorityTarget { name: string; team?: string }
export interface LegacyComputerUseAuthority {
  agent: string;
  currentAuthorities: string[];
  tokenCount: number;
  source: 'computer-use-agent-tokens';
  note: string;
}
const S: BrokerState = { server: null, port: 0, token: '', armed: false, watching: false, onFrame: null, pump: null, lastSig: 0, lastAgent: '', actions: 0, captureFailing: false, displayId: null, blessed: new Set(), team: '', lastShot: null, controlMode: 'supervised', paused: false, pending: new Map(), onPending: null, stopping: false };
const requestLifecycle = createComputerUseRequestLifecycle();
const brokerSockets = new Set<Socket>();
let brokerStopPromise: Promise<void> | null = null;

const CONFIRM_TIMEOUT_MS = 60 * 1000; // auto-decline a held action if the user doesn't answer

let panicHotkeyOk = false; // did the global PANIC hotkey register? (the on-screen button is the fallback)
export function setPanicHotkey(ok: boolean): void { panicHotkeyOk = ok; }

/** Human-readable, secret-free preview of an action (for the approval prompt + audit). */
function previewAction(type: string, body: Record<string, unknown>): string {
  const num = (k: string) => Math.round(Number(body[k]) || 0);
  switch (type) {
    case 'mouse_move': return `move to ${num('x')},${num('y')}`;
    case 'left_click': return `left-click at ${num('x')},${num('y')}`;
    case 'right_click': return `right-click at ${num('x')},${num('y')}`;
    case 'middle_click': return `middle-click at ${num('x')},${num('y')}`;
    case 'double_click': return `double-click at ${num('x')},${num('y')}`;
    case 'left_click_drag': return `drag ${num('fromX')},${num('fromY')} → ${num('toX')},${num('toY')}`;
    case 'type': return `type ${String(body.text ?? '').length} characters`;
    case 'key': return `press ${driver.describeChordRedacted(String(body.keys ?? body.key ?? ''))}`;
    case 'scroll': return `scroll ${String(body.direction ?? 'down')} ${Math.max(1, Math.min(20, Number(body.amount) || 3))}`;
    default: return type;
  }
}

function pendingList(): PendingAction[] { return [...S.pending.values()].map((p) => p.entry); }
function notifyPending(kind: 'add' | 'remove'): void { try { S.onPending?.({ kind, pending: pendingList() }); } catch { /* */ } }

/** Hold an action awaiting the user's approve/deny (or auto-decline after a timeout). */
function requestApproval(agent: string, action: string, preview: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = randomBytes(8).toString('hex');
    const expiresAt = Date.now() + CONFIRM_TIMEOUT_MS;
    const timer = setTimeout(() => { if (S.pending.delete(id)) { notifyPending('remove'); resolve(false); } }, CONFIRM_TIMEOUT_MS);
    S.pending.set(id, { resolve, timer, entry: { id, agent, action, preview, ts: Date.now(), expiresAt } });
    notifyPending('add');
  });
}

/** User answered an approval prompt. */
export function confirmAction(id: string, allow: boolean): { ok: boolean } {
  const p = S.pending.get(id);
  if (!p) return { ok: false };
  clearTimeout(p.timer);
  S.pending.delete(id);
  notifyPending('remove');
  p.resolve(!!allow);
  return { ok: true };
}
/** Resolve every held action with `allow` (used by disarm/panic to flush). */
function flushPending(allow: boolean): void {
  for (const [, p] of S.pending) { clearTimeout(p.timer); p.resolve(allow); }
  S.pending.clear();
  notifyPending('remove');
}
export function pendingActions(): PendingAction[] { return pendingList(); }
export function setSupervised(on: boolean): { ok: boolean; supervised: boolean; fullControl: boolean; controlMode: ComputerUseControlMode } {
  flushPending(false);
  S.controlMode = on ? 'supervised' : 'guarded';
  return { ok: true, supervised: S.controlMode === 'supervised', fullControl: false, controlMode: S.controlMode };
}
export function setFullControl(on: boolean): { ok: boolean; supervised: boolean; fullControl: boolean; controlMode: ComputerUseControlMode } {
  if (on) {
    if (!computerUseAvailable()) throw new Error(COMPUTER_USE_UNAVAILABLE_REASON);
    if (!S.armed || !S.blessed.size) throw new Error('Arm Computer Use with at least one blessed agent before granting Full control.');
    if (!driver.driverCapability().ok) throw new Error('The native input controller is unavailable in this build.');
    if (!accessibilityGranted()) throw new Error('Accessibility permission is required before Full control can be enabled.');
  }
  flushPending(false);
  S.controlMode = on ? 'full-control' : 'guarded';
  return { ok: true, supervised: false, fullControl: S.controlMode === 'full-control', controlMode: S.controlMode };
}
export function setPaused(on: boolean): { ok: boolean; paused: boolean } { S.paused = !!on; if (S.paused) flushPending(false); return { ok: true, paused: S.paused }; }

const INPUT_VERBS = new Set(['mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'left_click_drag', 'type', 'key', 'scroll']);

/** Map screenshot pixels only through the exact frame reviewed by the caller. */
function mapPoint(frame: ComputerUseFrame, x: number, y: number): { gx: number; gy: number; ok: boolean } {
  const point = mapComputerUsePoint(frame, x, y);
  return point.ok ? { ...point, ok: true } : { gx: 0, gy: 0, ok: false };
}

function currentFrameState(frame: ComputerUseFrame | null, agent: string) {
  return validateComputerUseFrame(
    frame,
    agent,
    selectedDisplayInfo(S.displayId),
    Date.now(),
    ACTION_FRAME_MAX_AGE_MS,
  );
}

const TOKEN_RE = /^[0-9a-f]{48}$/; // randomBytes(24).toString('hex')
const AUTHORITY_LIMIT = 160;
function normalizeAuthority(agent: string): string {
  return String(agent).slice(0, AUTHORITY_LIMIT);
}
function teamFromAuthority(agent: string): string {
  const i = agent.indexOf(':');
  return i > 0 ? agent.slice(0, i).slice(0, 64) : '';
}
function currentAuthority(target: ComputerUseAuthorityTarget): string {
  const name = String(target.name || '');
  const team = target.team ? String(target.team) : undefined;
  return team ? `${team}:${name}` : name;
}
function loadOrMakeToken(): { token: string } {
  try {
    const j = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (j && typeof j.token === 'string' && TOKEN_RE.test(j.token)) return { token: j.token };
  } catch { /* generate fresh */ }
  return { token: randomBytes(24).toString('hex') };
}

/** Copy the bundled MCP server next to the session file so the agent runs a stable absolute path. */
function stageServerFile(): void {
  try {
    const src = app.isPackaged
      ? join(process.resourcesPath, 'computeruse-mcp', 'server.mjs')
      : join(__dirname, '../../resources/computeruse-mcp/server.mjs');
    if (existsSync(src)) {
      copyFilePrivateSync(src, brokerServerPath(), { overwrite: true });
    }
  } catch { /* the view surfaces 'server unavailable' if attach later fails */ }
}

function writeSession(): void {
  const payload = JSON.stringify({ url: `http://127.0.0.1:${S.port}`, token: S.token, port: S.port, pid: process.pid, updatedAt: Date.now() });
  try { writeFileSync(sessionFile(), payload, { mode: 0o600 }); chmodSync(sessionFile(), 0o600); } catch { /* mode option only applies on create → force-tighten a pre-existing file */ }
}

// Per-agent tokens: each blessed agent gets its OWN bearer token, so the broker
// derives the caller's identity from the TOKEN (authoritative) rather than trusting
// a self-reported name behind a shared secret. Persisted (0600) so the token baked
// into an agent's .mcp.json env stays valid across app restarts.
const agentTokens = new Map<string, string>(); // token → scoped agent authority
function agentTokensFile(): string { return join(cuDir(), 'agent-tokens.json'); }
function loadAgentTokens(): void {
  // The active profile is authoritative. Startup recovery can retry in this
  // process, so never merge another profile's persisted bearer map.
  agentTokens.clear();
  try {
    const j = JSON.parse(readFileSync(agentTokensFile(), 'utf8'));
    if (j && typeof j === 'object') for (const [tok, a] of Object.entries(j)) {
      if (TOKEN_RE.test(tok) && typeof a === 'string') {
        const authority = normalizeAuthority(a);
        if (authority) agentTokens.set(tok, authority);
      }
    }
  } catch { /* none yet */ }
}
function saveAgentTokens(): void {
  try { writeFileSync(agentTokensFile(), JSON.stringify(Object.fromEntries(agentTokens)), { mode: 0o600 }); chmodSync(agentTokensFile(), 0o600); } catch { /* force-tighten even if the file pre-existed at a looser mode */ }
}
/** Mint (or reuse) a per-agent token — called at bless; injected into the agent's MCP env. */
export function mintAgentToken(agent: string): string {
  const name = normalizeAuthority(agent);
  for (const [tok, a] of agentTokens) if (a === name) return tok; // reuse: the agent's .mcp.json already carries it
  const tok = randomBytes(24).toString('hex');
  agentTokens.set(tok, name);
  saveAgentTokens();
  return tok;
}
/** Revoke an agent's token (called at unbless). */
export function revokeAgentToken(agent: string): void {
  const name = normalizeAuthority(agent);
  let changed = false;
  for (const [tok, a] of [...agentTokens]) if (a === name) { agentTokens.delete(tok); changed = true; }
  if (changed) saveAgentTokens();
}
export function legacyAgentTokenReport(targets: ComputerUseAuthorityTarget[]): LegacyComputerUseAuthority[] {
  if (!agentTokens.size) loadAgentTokens();
  const byName = new Map<string, Set<string>>();
  for (const target of targets ?? []) {
    const name = String(target.name || '').trim();
    if (!name) continue;
    byName.set(name, (byName.get(name) ?? new Set()).add(currentAuthority(target)));
  }
  const rows: LegacyComputerUseAuthority[] = [];
  for (const [agent, currentSet] of byName) {
    if (agent.includes(':')) continue;
    let tokenCount = 0;
    for (const authority of agentTokens.values()) {
      if (authority === agent) tokenCount++;
    }
    if (!tokenCount) continue;
    rows.push({
      agent,
      currentAuthorities: [...currentSet].filter((a) => a !== agent).sort(),
      tokenCount,
      source: 'computer-use-agent-tokens',
      note: 'Bare-name Computer Use tokens are blocked by scoped arming. Re-bless the scoped agent before deleting legacy tokens.',
    });
  }
  return rows.filter((row) => row.currentAuthorities.length > 0);
}
export function brokerUrl(): string { return `http://127.0.0.1:${S.port || 4180}`; }

declare const __dirname: string;

async function listen(server: http.Server, isCurrent: () => boolean): Promise<number> {
  for (const p of PORT_RANGE) {
    if (!isCurrent()) throw new Error('Computer Use broker stopped during startup.');
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = () => { server.removeListener('error', onErr); resolve(false); };
      server.once('error', onErr);
      try {
        server.listen(p, '127.0.0.1', () => {
          server.removeListener('error', onErr);
          resolve(true);
        });
      } catch {
        server.removeListener('error', onErr);
        resolve(false);
      }
    });
    if (ok && isCurrent()) return p;
    if (ok) throw new Error('Computer Use broker stopped during startup.');
  }
  throw new Error('no free loopback port for the computer-use broker');
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = ''; let n = 0; let settled = false;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (c) => {
      n += c.length;
      if (n > 1_000_000) {
        req.destroy();
        finish('');
        return;
      }
      b += c;
    });
    req.on('end', () => finish(b));
    req.on('aborted', () => finish(''));
    req.on('close', () => {
      if (!req.complete) finish('');
    });
    req.on('error', () => finish(''));
  });
}

function blk(reason: string, message: string): { status: number; json: Record<string, unknown> } {
  return { status: 200, json: { ok: false, blocked: true, reason, message } };
}
function stoppedAction(): { status: number; json: Record<string, unknown> } {
  return blk('stopped', 'Computer Use stopped before this request completed.');
}
function rec(agent: string, action: string, detail: string, decision: 'executed' | 'blocked', reason?: string): void {
  if (S.stopping) return;
  audit({ ts: Date.now(), agent: agent || '(unknown)', action, detail, decision, reason }, S.team);
}

/** Phase 1 action handler: screenshot + gated mouse/keyboard input, all audited. */
async function handleAction(
  body: Record<string, unknown>,
  lease: ComputerUseWorkLease,
): Promise<{ status: number; json: Record<string, unknown> }> {
  if (!lease.isCurrent()) return stoppedAction();
  const type = String(body?.type || '');
  const agent = body?.agent ? normalizeAuthority(String(body.agent)) : '';
  if (agent) S.lastAgent = agent;
  S.team = body?.team ? String(body.team).slice(0, 64) : teamFromAuthority(agent);

  if (type === 'status' || type === 'ping') {
    return { status: 200, json: { ok: true, armed: S.armed, phase: 1, capability: driver.driverCapability().ok } };
  }

  // Every screenshot + input requires: armed, AND the caller is blessed for this session.
  if (!S.armed) {
    rec(agent, type, previewAction(type, body), 'blocked', 'disarmed');
    return blk('disarmed', 'Computer Use is off — open ID Agents Control Center → Computer Use and press Arm.');
  }
  if (!S.blessed.has(agent)) {
    rec(agent, type, previewAction(type, body), 'blocked', 'agent_not_blessed');
    return blk('agent_not_blessed', `"${agent || 'this agent'}" isn't blessed for Computer Use. Bless it in the app, then it must be re-armed.`);
  }

  if (type === 'screenshot') {
    const f = await captureDisplay(S.displayId, { format: 'png' });
    if (!lease.isCurrent()) return stoppedAction();
    if (!f) {
      rec(agent, type, 'capture selected display', 'blocked', 'screen_recording_permission');
      return blk('screen_recording_permission', 'Screen Recording permission is not granted to ID Agents Control Center.');
    }
    S.lastShot = {
      agent,
      displayId: f.display.id,
      width: f.width,
      height: f.height,
      bounds: { ...f.display.bounds },
      scaleFactor: f.display.scaleFactor,
      capturedAt: f.ts,
    };
    S.actions++;
    rec(agent, type, `${f.display.label} ${f.width}×${f.height}`, 'executed');
    return { status: 200, json: { ok: true, image: f.buf.toString('base64'), mimeType: 'image/png', width: f.width, height: f.height, display: f.display } };
  }

  if (INPUT_VERBS.has(type)) {
    // Input additionally requires Accessibility + a working native driver.
    if (!driver.driverCapability().ok) { rec(agent, type, '', 'blocked', 'driver_unavailable'); return blk('driver_unavailable', 'The native input module is unavailable in this build.'); }
    if (!accessibilityGranted()) { rec(agent, type, '', 'blocked', 'accessibility_permission'); return blk('accessibility_permission', 'Accessibility permission is not granted to ID Agents Control Center — input is blocked. Grant it in System Settings → Privacy & Security → Accessibility, then relaunch.'); }
    // Require a screenshot first: it anchors the coordinate frame AND keeps input
    // tied to something the agent (and the watching user) actually saw.
    const actionShot = S.lastShot;
    if (!actionShot) {
      rec(agent, type, '', 'blocked', 'no_screenshot');
      return blk('no_screenshot', 'Call computer_screenshot first — actions are tied to the latest selected-display frame.');
    }
    const initialFrame = currentFrameState(actionShot, agent);
    if (!initialFrame.ok) {
      rec(agent, type, '', 'blocked', initialFrame.reason);
      const message = initialFrame.reason === 'wrong_agent'
        ? 'This screenshot belongs to another Agent. Call computer_screenshot before acting.'
        : initialFrame.reason === 'display_changed'
          ? 'The selected display or its geometry changed. Call computer_screenshot again before acting.'
          : initialFrame.reason === 'stale_screenshot'
            ? 'The screenshot is stale. Call computer_screenshot again before acting.'
            : 'Call computer_screenshot first — actions are tied to the latest selected-display frame.';
      return blk(initialFrame.reason, message);
    }
    // You can pause the agent (block input) without disarming.
    if (S.paused) { rec(agent, type, previewAction(type, body), 'blocked', 'paused'); return blk('paused', 'You paused Computer Use — resume it in the app to continue.'); }
    // Decide whether to HOLD this action for approval: supervised holds every
    // action; guarded autonomy holds only classified risky actions; an explicit
    // session-scoped Full control grant holds none. Scope, frame, permission,
    // pause, disarm, and audit enforcement remain active in every mode.
    const risk = classifyComputerUseRisk(type, body);
    if (computerUseActionNeedsApproval(S.controlMode, type, body)) {
      const label = previewAction(type, body) + (risk.risky ? ` — ⚠ ${risk.reason}` : '');
      const approved = await requestApproval(agent, type, label);
      if (!lease.isCurrent()) return stoppedAction();
      if (!approved) { rec(agent, type, label, 'blocked', 'declined'); return blk('declined', 'You declined this action in the app.'); }
      // Re-validate AFTER approval: disarm/panic/pause could have fired between the
      // user clicking Allow and now — a just-approved action must NOT run post-stop.
      if (!S.armed || S.paused || !S.blessed.has(agent)) { rec(agent, type, label, 'blocked', 'stopped'); return blk('stopped', 'Computer Use was stopped before this action ran.'); }
    }
    const finalFrame = currentFrameState(actionShot, agent);
    if (S.lastShot !== actionShot) {
      rec(agent, type, previewAction(type, body), 'blocked', 'screenshot_changed');
      return blk('screenshot_changed', 'The screenshot changed while this action was pending. Review the fresh screenshot and try again.');
    }
    if (!finalFrame.ok) {
      rec(agent, type, previewAction(type, body), 'blocked', finalFrame.reason);
      return blk(finalFrame.reason, 'The selected display changed while this action was pending. Review a fresh screenshot and try again.');
    }
    const n = (k: string): number => { const v = Number((body as Record<string, unknown>)[k]); return Number.isFinite(v) ? v : NaN; };
    let ok = false; let detail = '';
    if (type === 'mouse_move') {
      const p = mapPoint(actionShot, n('x'), n('y')); if (!p.ok) { rec(agent, type, `${n('x')},${n('y')}`, 'blocked', 'out_of_bounds'); return blk('out_of_bounds', 'Coordinates are outside the captured screen.'); }
      ok = driver.moveMouse(p.gx, p.gy); detail = `→ ${Math.round(n('x'))},${Math.round(n('y'))}`;
    } else if (type === 'left_click' || type === 'right_click' || type === 'middle_click' || type === 'double_click') {
      const p = mapPoint(actionShot, n('x'), n('y')); if (!p.ok) { rec(agent, type, `${n('x')},${n('y')}`, 'blocked', 'out_of_bounds'); return blk('out_of_bounds', 'Coordinates are outside the captured screen.'); }
      const button = type === 'right_click' ? 'right' : type === 'middle_click' ? 'middle' : 'left';
      ok = driver.click(p.gx, p.gy, button, type === 'double_click'); detail = `${button}${type === 'double_click' ? '×2' : ''} @ ${Math.round(n('x'))},${Math.round(n('y'))}`;
    } else if (type === 'left_click_drag') {
      const a = mapPoint(actionShot, n('fromX'), n('fromY')); const b = mapPoint(actionShot, n('toX'), n('toY'));
      if (!a.ok || !b.ok) { rec(agent, type, 'drag', 'blocked', 'out_of_bounds'); return blk('out_of_bounds', 'Drag coordinates are outside the captured screen.'); }
      ok = driver.drag(a.gx, a.gy, b.gx, b.gy); detail = `drag ${Math.round(n('fromX'))},${Math.round(n('fromY'))} → ${Math.round(n('toX'))},${Math.round(n('toY'))}`;
    } else if (type === 'type') {
      const text = String((body as Record<string, unknown>).text ?? '');
      if (text.length > 1000) { rec(agent, type, `typed ${text.length} chars`, 'blocked', 'text_too_long'); return blk('text_too_long', 'Text is too long for one type action (max 1000 chars) — split it up.'); }
      ok = driver.typeText(text); detail = `typed ${text.length} char${text.length === 1 ? '' : 's'}`; // never log the literal text
    } else if (type === 'key') {
      const keys = String((body as Record<string, unknown>).keys ?? (body as Record<string, unknown>).key ?? '');
      ok = driver.key(keys); detail = driver.describeChordRedacted(keys); // redacted: never log raw key text (could be a secret)
    } else if (type === 'scroll') {
      const dir = String((body as Record<string, unknown>).direction ?? 'down');
      const amt = Math.max(1, Math.min(20, Number((body as Record<string, unknown>).amount) || 3));
      const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
      const dy = dir === 'up' ? amt : dir === 'down' ? -amt : 0;
      const hasX = body.x !== undefined;
      const hasY = body.y !== undefined;
      if (hasX !== hasY) {
        rec(agent, type, 'scroll', 'blocked', 'invalid_coordinates');
        return blk('invalid_coordinates', 'Scroll coordinates must include both x and y, or neither.');
      }
      const p = hasX
        ? mapPoint(actionShot, n('x'), n('y'))
        : mapPoint(actionShot, actionShot.width / 2, actionShot.height / 2);
      if (!p.ok) {
        rec(agent, type, 'scroll', 'blocked', 'out_of_bounds');
        return blk('out_of_bounds', 'Scroll coordinates are outside the captured screen.');
      }
      if (!driver.moveMouse(p.gx, p.gy)) {
        rec(agent, type, 'scroll', 'blocked', 'driver_failed');
        return blk('driver_failed', 'The pointer could not be moved onto the selected captured display.');
      }
      ok = driver.scroll(dx, dy); detail = `scroll ${dir} ${amt}`;
    }
    S.actions++;
    rec(agent, type, detail, ok ? 'executed' : 'blocked', ok ? undefined : 'driver_failed');
    if (!ok) return blk('driver_failed', `The ${type} action could not be performed.`);
    return { status: 200, json: { ok: true, action: type, detail } };
  }

  rec(agent, type || '(empty)', '', 'blocked', 'unknown_action');
  return blk('unknown_action', `unknown action "${type}"`);
}

export function auditTail(n?: number): AuditEntry[] { return recentAudit(n); }

export async function startBroker(onFrame: BrokerState['onFrame'], onPending?: BrokerState['onPending']): Promise<void> {
  if (!computerUseAvailable()) {
    S.armed = false;
    S.watching = false;
    S.paused = false;
    S.blessed.clear();
    S.onFrame = onFrame;
    if (onPending) S.onPending = onPending;
    return;
  }
  if (brokerStopPromise) await brokerStopPromise;
  if (S.stopping) await stopBroker();
  if (S.server) { S.onFrame = onFrame; if (onPending) S.onPending = onPending; return; }
  S.stopping = false;
  requestLifecycle.openAdmission();
  const startupLease = requestLifecycle.begin();
  if (!startupLease) throw new Error('Computer Use broker is not accepting startup work.');
  S.onFrame = onFrame;
  if (onPending) S.onPending = onPending;
  S.token = loadOrMakeToken().token;
  loadAgentTokens();
  stageServerFile();
  const server = http.createServer(async (req, res) => {
    const lease = requestLifecycle.begin();
    if (!lease) {
      req.destroy();
      if (!res.destroyed) res.destroy();
      return;
    }
    const send = (status: number, json: unknown): void => {
      if (
        S.stopping
        || !requestLifecycle.isAccepting()
        || res.destroyed
        || res.writableEnded
      ) {
        return;
      }
      const serialized = JSON.stringify(json);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(serialized),
      });
      res.end(serialized);
    };
    try {
      // DNS-rebinding / cross-origin defense: the legitimate caller is the MCP
      // server (Node fetch — no Origin header, Host = 127.0.0.1).
      if (req.headers['origin']) {
        send(403, { ok: false, blocked: true, reason: 'forbidden_origin' });
        return;
      }
      const host = String(req.headers['host'] || '').split(':')[0];
      if (host && host !== '127.0.0.1' && host !== 'localhost') {
        send(403, { ok: false, blocked: true, reason: 'forbidden_host' });
        return;
      }
      const auth = req.headers['authorization'] || '';
      const tok = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (req.method === 'POST' && req.url === '/action') {
        const agent = agentTokens.get(tok);
        if (!agent) {
          send(401, { ok: false, blocked: true, reason: 'stale_token', message: 'This agent isn’t authorized for Computer Use (or its access was upgraded) — re-bless it in the app’s Computer Use tab.' });
          return;
        }
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(await readBody(req)); } catch { /* */ }
        if (!lease.isCurrent()) {
          const stopped = stoppedAction();
          send(stopped.status, stopped.json);
          return;
        }
        parsed.agent = agent;
        const result = await handleAction(parsed, lease);
        if (!lease.isCurrent()) {
          const stopped = stoppedAction();
          send(stopped.status, stopped.json);
          return;
        }
        send(result.status, result.json);
        return;
      }
      send(404, { ok: false, error: 'not found' });
    } catch {
      send(500, { ok: false, blocked: true, reason: 'broker_error' });
    } finally {
      lease.finish();
    }
  });
  S.server = server;
  trackComputerUseServerSockets(server, brokerSockets);
  server.on('connection', (socket) => {
    if (S.stopping || !requestLifecycle.isAccepting()) socket.destroy();
  });
  try {
    const port = await listen(server, () => startupLease.isCurrent());
    if (!startupLease.isCurrent()) throw new Error('Computer Use broker stopped during startup.');
    S.port = port;
    writeSession();
  } catch (error) {
    if (!S.stopping && S.server === server) {
      try { server.close(); } catch { /* listener did not start */ }
      S.server = null;
    }
    throw error;
  } finally {
    startupLease.finish();
  }
}

function hashBuf(b: Buffer): number {
  // FNV-1a over the whole jpeg — full coverage (no false "unchanged" collisions),
  // ~negligible cost at this size/cadence. Static screen → identical → skipped.
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

async function pumpOnce(): Promise<void> {
  const lease = requestLifecycle.begin();
  if (!lease) return;
  try {
    if (!S.armed || !S.watching || !S.onFrame) return;
    const f = await captureDisplay(S.displayId, { maxWidth: PUMP_MAX_WIDTH, format: 'jpeg', quality: PUMP_QUALITY });
    if (!lease.isCurrent()) return;
    if (!f) { S.captureFailing = true; return; } // permission/relaunch — the view surfaces a hint
    S.captureFailing = false;
    if (!S.armed || !S.watching) return;
    const sig = hashBuf(f.buf);
    if (sig === S.lastSig) return; // unchanged screen → don't flood the renderer
    S.lastSig = sig;
    S.onFrame?.({ jpegBase64: f.buf.toString('base64'), width: f.width, height: f.height, display: f.display, ts: f.ts, driver: 'agent' });
  } finally {
    lease.finish();
  }
}

/** The pump (full-screen capture) runs ONLY while armed AND someone is watching the
 *  live pane — so navigating away or hiding the view stops the capture entirely.
 *  (The agent's on-demand screenshot tool still works while armed, independent of this.) */
function reconcilePump(): void {
  const want = S.armed && S.watching;
  if (want && !S.pump) { S.lastSig = 0; S.pump = setInterval(() => { void pumpOnce(); }, PUMP_MS); void pumpOnce(); }
  else if (!want && S.pump) { clearInterval(S.pump); S.pump = null; }
}

export function armBroker(blessed?: string[]): { ok: boolean; port: number; blessed: string[]; error?: string } {
  if (!computerUseAvailable()) {
    return {
      ok: false,
      port: 0,
      blessed: [],
      error: COMPUTER_USE_UNAVAILABLE_REASON,
    };
  }
  if (S.stopping || !requestLifecycle.isAccepting()) {
    return { ok: false, port: 0, blessed: [] };
  }
  if (!S.server || !S.port || !existsSync(brokerServerPath())) {
    return { ok: false, port: S.port, blessed: [], error: 'The bundled Computer Use controller is not staged. Restart or repair IDACC before arming.' };
  }
  // The blessed set is captured AT ARM from the agents that currently have the
  // computer-use tool attached — so disarming + re-arming is the way to refresh it.
  if (Array.isArray(blessed)) S.blessed = new Set(blessed.map((s) => normalizeAuthority(String(s))).filter(Boolean)); // match handleAction's truncation of the caller id
  S.armed = true;
  reconcilePump();
  return { ok: true, port: S.port, blessed: [...S.blessed] };
}

export function disarmBroker(): { ok: boolean } {
  requestLifecycle.invalidateActiveWork();
  S.armed = false;
  S.captureFailing = false;
  S.blessed = new Set();
  S.lastShot = null;
  S.paused = false;
  S.controlMode = 'supervised'; // every new armed session requires a fresh explicit autonomy/full-control grant
  flushPending(false);                              // decline anything held for approval
  try { driver.releaseAll(); } catch { /* */ }      // backstop: never leave a button held after disarm
  reconcilePump();
  return { ok: true };
}

/** PANIC — the nuclear stop: decline everything held, release buttons, fully disarm. */
export function panicBroker(): { ok: boolean } {
  rec('(operator)', 'panic', 'stopped Computer Use', 'executed');
  return disarmBroker();
}

/** The renderer calls this when the Computer Use view mounts (true) / unmounts (false). */
export function setWatching(on: boolean): { ok: boolean } {
  S.watching = computerUseAvailable() && !S.stopping && !!on;
  reconcilePump();
  return { ok: computerUseAvailable() };
}

export function setBrokerDisplay(displayId: number): { ok: boolean; display: Frame['display'] } {
  if (!computerUseAvailable()) {
    throw new Error(COMPUTER_USE_UNAVAILABLE_REASON);
  }
  const displays = displayInfos();
  const selected = displays.find((display) => display.id === Number(displayId));
  if (!selected) throw new Error('The selected display is no longer connected.');
  requestLifecycle.invalidateActiveWork();
  flushPending(false);
  S.displayId = selected.id;
  S.lastShot = null;
  S.lastSig = 0;
  S.captureFailing = false;
  if (S.armed && S.watching) void pumpOnce();
  return { ok: true, display: selected };
}

export function brokerStatus() {
  if (!computerUseAvailable()) {
    return {
      available: false,
      unavailableReason: COMPUTER_USE_UNAVAILABLE_REASON,
      armed: false,
      watching: false,
      port: 0,
      url: '',
      lastAgent: '',
      actions: S.actions,
      serverStaged: false,
      captureFailing: false,
      display: undefined,
      displays: [],
      blessed: [],
      driverOk: false,
      accessibility: false,
      supervised: S.controlMode === 'supervised',
      fullControl: S.controlMode === 'full-control',
      controlMode: S.controlMode,
      paused: false,
      pending: [],
      panicHotkey: false,
    };
  }
  const displays = displayInfos();
  const display = selectedDisplayInfo(S.displayId);
  if (!displays.some((row) => row.id === S.displayId)) {
    flushPending(false);
    S.displayId = display.id;
    S.lastShot = null;
    S.lastSig = 0;
  }
  return { available: true, armed: S.armed, watching: S.watching, port: S.port, url: S.port ? `http://127.0.0.1:${S.port}` : '', lastAgent: S.lastAgent, actions: S.actions, serverStaged: existsSync(brokerServerPath()), captureFailing: S.captureFailing, display, displays, blessed: [...S.blessed], driverOk: driver.driverCapability().ok, accessibility: accessibilityGranted(), supervised: S.controlMode === 'supervised', fullControl: S.controlMode === 'full-control', controlMode: S.controlMode, paused: S.paused, pending: pendingList(), panicHotkey: panicHotkeyOk };
}

export function stopBroker(): Promise<void> {
  if (brokerStopPromise) return brokerStopPromise;

  // Revoke admission and every pre-stop generation before yielding. A capture,
  // approval, body read, or pump pass already across an await can no longer
  // expose data, execute input, append audit state, or write a response.
  S.stopping = true;
  requestLifecycle.closeAdmission();
  S.onFrame = null;
  S.onPending = null;
  S.watching = false;
  disarmBroker();

  const server = S.server;
  const listenerClose = closeComputerUseServer(
    server,
    brokerSockets,
    BROKER_STOP_TIMEOUT_MS,
  );

  const attempt = (async () => {
    const [activitiesDrained, listenerClosed] = await Promise.all([
      requestLifecycle.drain(BROKER_STOP_TIMEOUT_MS),
      listenerClose,
    ]);
    if (!listenerClosed) {
      throw new Error('Computer Use listener did not close before its guarded deadline.');
    }
    if (!activitiesDrained) {
      throw new Error(
        `Computer Use could not drain ${requestLifecycle.activeCount()} active request(s) before its guarded deadline.`,
      );
    }

    // Profile-scoped state is reset only after no old-generation handler can
    // mutate it. A failed attempt remains stopped and can be retried safely.
    S.server = null;
    S.port = 0;
    S.token = '';
    S.lastAgent = '';
    S.team = '';
    S.actions = 0;
    S.displayId = null;
    S.lastSig = 0;
    S.lastShot = null;
    S.captureFailing = false;
    brokerSockets.clear();
    agentTokens.clear();
    resetComputerUseAuditProfileState();
  })();
  let tracked: Promise<void>;
  tracked = attempt.finally(() => {
    if (brokerStopPromise === tracked) brokerStopPromise = null;
  });
  brokerStopPromise = tracked;
  return tracked;
}

/** Current display geometry for the pane's coordinate overlay. */
export function brokerDisplay() { return selectedDisplayInfo(S.displayId); }
