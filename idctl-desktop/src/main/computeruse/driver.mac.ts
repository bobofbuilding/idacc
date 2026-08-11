/**
 * macOS input driver for Computer Use (Phase 1) — mouse + keyboard via the lean
 * @nut-tree-fork/libnut-darwin native binding (CGEvent under the hood, honors the
 * Accessibility TCC grant, attributed to THIS app bundle). Capture stays on
 * Electron desktopCapturer (capture.ts) — this driver is INPUT only.
 *
 * Lazy-loaded + fully guarded: if the native addon can't load, capability() is
 * false and the broker reports input as unavailable rather than crashing.
 *
 * All coordinates here are GLOBAL desktop POINTS (the broker maps from the
 * agent's screenshot-pixel space to global points before calling in).
 */
declare const require: (id: string) => any;

type Libnut = {
  moveMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  mouseToggle(down?: string, button?: string): void;
  dragMouse(x: number, y: number): void;
  scrollMouse(x: number, y: number): void;
  getMousePos(): { x: number; y: number };
  getScreenSize(): { width: number; height: number };
  keyTap(key: string, modifier?: string | string[]): void;
  keyToggle(key: string, down: string, modifier?: string | string[]): void;
  typeString(s: string): void;
  setMouseDelay(ms: number): void;
  setKeyboardDelay(ms: number): void;
};

let _nut: Libnut | null = null;
let _loadErr = '';
let _tried = false;
const heldButtons = new Set<string>();
function nut(): Libnut | null {
  if (_tried) return _nut;
  _tried = true;
  try {
    _nut = require('@nut-tree-fork/libnut-darwin') as Libnut;
    try { _nut.setMouseDelay(2); _nut.setKeyboardDelay(2); } catch { /* */ }
  } catch (e) {
    _loadErr = e instanceof Error ? e.message : String(e);
    _nut = null;
  }
  return _nut;
}

export type DriverCapabilityProbe = 'passive' | 'load';

export function driverCapability(probe: DriverCapabilityProbe = 'load'): { ok: boolean; error?: string } {
  // Dashboard/status polling must not initialize a native CGEvent module.
  // Packaging validation proves the module is present; the explicit enable or
  // first-input path performs the real load and reports any runtime failure.
  if (probe === 'passive' && !_tried) return { ok: true };
  const n = nut();
  return n ? { ok: true } : { ok: false, error: _loadErr || 'native input module unavailable' };
}

export function getMousePos(): { x: number; y: number } | null {
  const n = nut(); if (!n) return null;
  try { return n.getMousePos(); } catch { return null; }
}

const BUTTONS = new Set(['left', 'right', 'middle']);
function btn(b?: string): string { return b && BUTTONS.has(b) ? b : 'left'; }

export function moveMouse(x: number, y: number): boolean {
  const n = nut(); if (!n) return false;
  try { n.moveMouse(Math.round(x), Math.round(y)); return true; } catch { return false; }
}
export function click(x: number, y: number, button?: string, double = false): boolean {
  const n = nut(); if (!n) return false;
  try { n.moveMouse(Math.round(x), Math.round(y)); n.mouseClick(btn(button), double); return true; } catch { return false; }
}
export function mouseDown(x: number, y: number, button?: string): boolean {
  const n = nut(); if (!n) return false;
  const b = btn(button);
  try {
    n.moveMouse(Math.round(x), Math.round(y));
    n.mouseToggle('down', b);
    heldButtons.add(b);
    return true;
  } catch {
    return false;
  }
}
export function mouseUp(x: number, y: number, button?: string): boolean {
  const n = nut(); if (!n) return false;
  const b = btn(button);
  try {
    n.moveMouse(Math.round(x), Math.round(y));
    n.mouseToggle('up', b);
    heldButtons.delete(b);
    return true;
  } catch {
    return false;
  }
}
export function drag(fromX: number, fromY: number, toX: number, toY: number, button?: string): boolean {
  const n = nut(); if (!n) return false;
  const b = btn(button);
  let down = false;
  try {
    n.moveMouse(Math.round(fromX), Math.round(fromY));
    n.mouseToggle('down', b); down = true; heldButtons.add(b);
    n.dragMouse(Math.round(toX), Math.round(toY));
    n.mouseToggle('up', b); down = false; heldButtons.delete(b);
    return true;
  } catch {
    return false;
  } finally {
    // NEVER leave the physical button stuck down if a native call threw mid-drag.
    if (down) {
      try { n.mouseToggle('up', b); heldButtons.delete(b); } catch { /* best effort */ }
    }
  }
}

/**
 * Backstop: release only buttons this driver knows it left held.
 *
 * Shutdown and ordinary disarm must remain passive. In particular, they must
 * never call nut(), because initializing the CGEvent binding is itself an
 * Accessibility-sensitive operation on macOS. A release is necessary only
 * after an explicit mouse-down successfully crossed the native boundary.
 */
export function releaseAll(): void {
  const n = _nut;
  if (!n || heldButtons.size === 0) return;
  for (const b of [...heldButtons]) {
    try {
      n.mouseToggle('up', b);
      heldButtons.delete(b);
    } catch { /* preserve the held marker for a later panic/disarm retry */ }
  }
}
export function scroll(dx: number, dy: number): boolean {
  const n = nut(); if (!n) return false;
  try { n.scrollMouse(Math.round(dx), Math.round(dy)); return true; } catch { return false; }
}
export function typeText(text: string): boolean {
  const n = nut(); if (!n) return false;
  try { n.typeString(String(text)); return true; } catch { return false; }
}

// Map common key names (and a DOM-ish vocabulary) to libnut key identifiers.
const MOD: Record<string, string> = { cmd: 'command', command: 'command', meta: 'command', super: 'command', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift' };
const KEY_ALIAS: Record<string, string> = {
  esc: 'escape', escape: 'escape', enter: 'enter', return: 'enter', ret: 'enter', tab: 'tab', space: 'space', ' ': 'space',
  backspace: 'backspace', bksp: 'backspace', delete: 'delete', del: 'delete', up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', plus: '+', minus: '-',
};
function normKey(k: string): string {
  const low = k.toLowerCase();
  return KEY_ALIAS[low] ?? low;
}
/** A safe-to-log description of a chord — named/special keys + modifiers are shown,
 *  but a multi-character non-special main key (likely bulk text routed through the
 *  key verb) is redacted, so secrets never reach the audit log. */
export function describeChordRedacted(combo: string): string {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let sawMain = false;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MOD[low]) { out.push(MOD[low]); continue; }
    if (sawMain) { out.push('·'); continue; }
    sawMain = true;
    const known = KEY_ALIAS[low] || /^f\d{1,2}$/.test(low);
    out.push(known || p.length <= 1 ? low : '·'); // redact multi-char free text
  }
  return out.join('+') || '·';
}

/** Press a chord like "cmd+s", "ctrl+shift+t", "enter", "escape". */
export function key(combo: string): boolean {
  const n = nut(); if (!n) return false;
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return false;
  const mods: string[] = [];
  let mainKey = '';
  for (const p of parts) {
    const low = p.toLowerCase();
    if (MOD[low]) mods.push(MOD[low]);
    else if (mainKey) return false; // two non-modifier keys → ambiguous; refuse rather than fire the wrong one
    else mainKey = normKey(p);
  }
  if (!mainKey) return false;
  try { n.keyTap(mainKey, mods.length ? mods : undefined); return true; } catch { return false; }
}
