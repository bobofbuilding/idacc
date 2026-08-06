import { dirname, join } from 'node:path';

/** Signing keys live beside the selected profile's config, never app-global. */
export function agentSignerVaultPathForConfig(configPath: string): string {
  return join(dirname(configPath), 'agent-signers.json');
}
