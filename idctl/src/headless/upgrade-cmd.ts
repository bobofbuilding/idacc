/**
 * The standalone idctl binary is a developer tool and is not published by the
 * unified desktop release. Keep the old verb as a clear migration message
 * instead of polling the desktop feed for an incompatible asset.
 */

import { IDCTL_VERSION } from '../version.ts';

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m' };

export interface UpgradeArgs {
  check: boolean;
  probe: boolean;
  post: boolean;
  configPath?: string;
}

export async function runUpgrade(p: UpgradeArgs): Promise<number> {
  if (p.probe) return 0; // internal: started successfully, exit fast
  if (p.post) {
    process.stdout.write(`${C.green}idctl updated → v${IDCTL_VERSION}${C.reset}\n`);
    return 0;
  }

  process.stdout.write(
    `${C.yellow}Standalone idctl self-update has been retired.${C.reset}\n` +
      `IDACC, the Agent manager, and Brain now ship and update together in the signed desktop application.\n` +
      `This source-only terminal client is currently v${IDCTL_VERSION}; update it with the repository checkout used for development.\n`,
  );
  return 0;
}
