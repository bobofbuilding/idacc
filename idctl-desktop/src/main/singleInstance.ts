export interface PrimaryWindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface DestroyableWindowLike {
  isDestroyed(): boolean;
  destroy(): void;
}

/**
 * Bring an already-created primary window back to the foreground. The caller
 * owns shutdown-state checks and can defer this operation until a window exists.
 */
export function focusExistingPrimaryWindow(
  target: PrimaryWindowLike | null,
): boolean {
  if (!target || target.isDestroyed()) return false;
  if (target.isMinimized()) target.restore();
  if (!target.isVisible()) target.show();
  target.focus();
  return true;
}

/**
 * Drain an already-started macOS activation window load. If shutdown begins
 * while the renderer is loading, destroy that exact late window before the
 * tracked activation pass settles.
 */
export async function guardActivationWindowCreation<T extends DestroyableWindowLike>(
  creation: PromiseLike<unknown>,
  target: T | null,
  isQuiescing: () => boolean,
  clearTarget: (target: T) => void,
): Promise<T | null> {
  try {
    await creation;
  } finally {
    if (isQuiescing() && target) {
      if (!target.isDestroyed()) target.destroy();
      clearTarget(target);
    }
  }
  return isQuiescing() ? null : target;
}
