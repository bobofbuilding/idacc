import { runtimeHasManagerHarness, runtimeSupports } from '../../../idctl/src/settings/runtimeCatalog.ts';

export function computerUseRuntimeEligible(runtime: string | undefined): boolean {
  return runtimeHasManagerHarness(runtime) && runtimeSupports(runtime, 'mcp');
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
