/**
 * Screen capture for Computer Use — Phase 0, NO native module.
 *
 * Uses Electron's built-in desktopCapturer + screen APIs, so the capture is
 * attributed to THIS app bundle in macOS's Screen Recording permission list
 * (a recognizable name the user can grant), and there's nothing to compile or
 * unpack from the asar. The same single capture feeds BOTH the agent-facing
 * screenshot tool (full-res PNG, lossless so the model can read text) and the
 * live pane (downscaled JPEG, small + smooth).
 */
import { desktopCapturer, screen } from 'electron';
import { selectComputerUseDisplay } from '../../shared/computerUsePolicy.ts';

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  /** Logical (points) bounds of the display — used for pane-click → host-coordinate mapping. */
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}
export interface Frame {
  buf: Buffer;
  /** Pixel dimensions of `buf` (already downscaled for the pump; full-res for screenshots). */
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  display: DisplayInfo;
  ts: number;
}

export function primaryDisplayInfo(): DisplayInfo {
  const d = screen.getPrimaryDisplay();
  return displayInfo(d, true, 0);
}

function displayInfo(
  display: ReturnType<typeof screen.getPrimaryDisplay>,
  primary: boolean,
  index: number,
): DisplayInfo {
  const nativeLabel = typeof display.label === 'string' ? display.label.trim() : '';
  return {
    id: display.id,
    label: nativeLabel || (primary ? 'Primary display' : `Display ${index + 1}`),
    primary,
    bounds: display.bounds,
    scaleFactor: display.scaleFactor,
  };
}

export function displayInfos(): DisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => displayInfo(display, display.id === primaryId, index));
}

export function selectedDisplayInfo(displayId?: number | null): DisplayInfo {
  const primaryId = screen.getPrimaryDisplay().id;
  return selectComputerUseDisplay(displayInfos(), displayId, primaryId) ?? primaryDisplayInfo();
}

/**
 * Grab one display. Returns null when Screen Recording isn't granted
 * (the thumbnail comes back empty), so callers can surface the permission state
 * instead of streaming a black frame.
 */
export async function captureDisplay(
  displayId: number | null | undefined,
  opts: { maxWidth?: number; format?: 'jpeg' | 'png'; quality?: number },
): Promise<Frame | null> {
  const disp = selectedDisplayInfo(displayId);
  const scale = disp.scaleFactor || 1;
  const fullW = Math.max(1, Math.round(disp.bounds.width * scale));
  const fullH = Math.max(1, Math.round(disp.bounds.height * scale));
  const targetW = opts.maxWidth && opts.maxWidth < fullW ? Math.round(opts.maxWidth) : fullW;
  const targetH = Math.max(1, Math.round(targetW * (fullH / fullW)));
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: targetW, height: targetH } });
  } catch {
    return null; // permission denied / capture unavailable
  }
  const src = sources.find((s) => s.display_id === String(disp.id))
    // Some single-display macOS versions omit display_id. Never use positional
    // fallback with multiple sources because it can capture the wrong monitor.
    ?? (disp.primary && sources.length === 1 ? sources[0] : undefined);
  if (!src || src.thumbnail.isEmpty()) return null;
  const img = src.thumbnail;
  const sz = img.getSize();
  const format = opts.format ?? 'jpeg';
  const buf = format === 'jpeg' ? img.toJPEG(Math.min(100, Math.max(1, opts.quality ?? 60))) : img.toPNG();
  return { buf, width: sz.width, height: sz.height, format, display: disp, ts: Date.now() };
}

/** Backward-compatible primary-display capture for callers outside the broker. */
export async function capturePrimary(opts: { maxWidth?: number; format?: 'jpeg' | 'png'; quality?: number }): Promise<Frame | null> {
  return captureDisplay(screen.getPrimaryDisplay().id, opts);
}
