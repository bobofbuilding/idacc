// SPDX-License-Identifier: MIT
import { useEffect } from 'react';

export interface DrawerGuardState {
  dirty: boolean;
  busy: boolean;
  detail?: string;
}

export type DrawerGuardReporter = (state: DrawerGuardState) => void;

/** Report interruption-sensitive panel state to the owning drawer. */
export function useDrawerGuard(
  report: DrawerGuardReporter | undefined,
  dirty: boolean,
  busy: boolean,
  detail?: string,
): void {
  useEffect(() => {
    report?.({ dirty, busy, detail });
  }, [report, dirty, busy, detail]);
  useEffect(() => () => {
    report?.({ dirty: false, busy: false });
  }, [report]);
}
