import { runtimeHasManagerHarness, runtimeSupports } from '../../../idctl/src/settings/runtimeCatalog.ts';

export function computerUseRuntimeEligible(runtime: string | undefined): boolean {
  return runtimeHasManagerHarness(runtime) && runtimeSupports(runtime, 'mcp');
}

export type ComputerUseControlMode = 'supervised' | 'guarded' | 'full-control';

const COMPUTER_USE_SHELL_DANGER = /\brm\s+(-[a-z]*[rf]|--(recursive|force))|\bsudo\b|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{|\bdrop\s+(table|database)\b|\bdelete\s+from\b|\btruncate\s+table\b|\bgit\s+(reset\s+--hard|push\b[^\n]*--force|clean\s+-[a-z]*f)|--force\b|\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b|\binit\s+0\b|\bkillall\b|\bpkill\b|\bdiskutil\s+(erase|reformat|partitiondisk|apfs\s+delete)|\bfind\b[^\n]*-delete\b|\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b|>\s*\/dev\/(sda|disk|hd)|\bchmod\s+-R\b|\bchown\s+-R\b|\bformat\s+[a-z]:/i;

export function classifyComputerUseRisk(
  type: string,
  body: Record<string, unknown>,
): { risky: boolean; reason?: string } {
  if (type === 'key') {
    const keys = String(body.keys ?? body.key ?? '').toLowerCase().replace(/\s+/g, '');
    const command = /(cmd|command|meta|super|⌘)/.test(keys);
    if (command && /(delete|backspace|\bdel\b|bksp)/.test(keys)) {
      return { risky: true, reason: 'move to Trash / delete' };
    }
    if (command && /\+q$/.test(keys)) return { risky: true, reason: 'quit the app' };
  }
  if (type === 'type' && COMPUTER_USE_SHELL_DANGER.test(String(body.text ?? ''))) {
    return { risky: true, reason: 'looks like a destructive command' };
  }
  return { risky: false };
}

export function computerUseActionNeedsApproval(
  mode: ComputerUseControlMode,
  type: string,
  body: Record<string, unknown>,
): boolean {
  if (mode === 'supervised') return true;
  if (mode === 'full-control') return false;
  return classifyComputerUseRisk(type, body).risky;
}

export type DisplayChoice = {
  id: number;
  primary?: boolean;
};

export type ComputerUseBounds = { x: number; y: number; width: number; height: number };
export type ComputerUseFrame = {
  agent: string;
  displayId: number;
  width: number;
  height: number;
  bounds: ComputerUseBounds;
  scaleFactor: number;
  capturedAt: number;
};
export type ComputerUseDisplayGeometry = {
  id: number;
  bounds: ComputerUseBounds;
  scaleFactor: number;
};

function sameFiniteNumber(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
}

export function validateComputerUseFrame(
  frame: ComputerUseFrame | null | undefined,
  agent: string,
  display: ComputerUseDisplayGeometry | null | undefined,
  now = Date.now(),
  maxAgeMs = 60_000,
): { ok: true } | { ok: false; reason: 'no_screenshot' | 'wrong_agent' | 'display_changed' | 'stale_screenshot' | 'invalid_frame' } {
  if (!frame) return { ok: false, reason: 'no_screenshot' };
  if (frame.agent !== agent) return { ok: false, reason: 'wrong_agent' };
  if (
    !Number.isFinite(frame.width)
    || !Number.isFinite(frame.height)
    || frame.width <= 0
    || frame.height <= 0
    || !Number.isFinite(frame.capturedAt)
    || frame.capturedAt <= 0
    || !Number.isFinite(maxAgeMs)
    || maxAgeMs <= 0
  ) return { ok: false, reason: 'invalid_frame' };
  if (frame.capturedAt > now || now - frame.capturedAt > maxAgeMs) return { ok: false, reason: 'stale_screenshot' };
  if (
    !display
    || frame.displayId !== display.id
    || !sameFiniteNumber(frame.scaleFactor, display.scaleFactor)
    || !sameFiniteNumber(frame.bounds.x, display.bounds.x)
    || !sameFiniteNumber(frame.bounds.y, display.bounds.y)
    || !sameFiniteNumber(frame.bounds.width, display.bounds.width)
    || !sameFiniteNumber(frame.bounds.height, display.bounds.height)
  ) return { ok: false, reason: 'display_changed' };
  return { ok: true };
}

export function mapComputerUsePoint(
  frame: ComputerUseFrame,
  x: number,
  y: number,
): { ok: true; gx: number; gy: number } | { ok: false } {
  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(frame.width)
    || !Number.isFinite(frame.height)
    || frame.width <= 0
    || frame.height <= 0
    || x < 0
    || y < 0
    || x >= frame.width
    || y >= frame.height
  ) return { ok: false };
  return {
    ok: true,
    gx: frame.bounds.x + (x / frame.width) * frame.bounds.width,
    gy: frame.bounds.y + (y / frame.height) * frame.bounds.height,
  };
}

export function selectComputerUseDisplay<T extends DisplayChoice>(
  displays: T[],
  requestedId: number | null | undefined,
  primaryId?: number,
): T | null {
  if (!displays.length) return null;
  if (Number.isFinite(requestedId)) {
    const requested = displays.find((display) => display.id === requestedId);
    if (requested) return requested;
  }
  return displays.find((display) => display.id === primaryId)
    ?? displays.find((display) => display.primary)
    ?? displays[0];
}
