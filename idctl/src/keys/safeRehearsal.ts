import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, resolveConfigPath } from '../settings/paths.ts';

export const SAFE_REHEARSAL_CHAIN_ID = 11155111;
export const SAFE_REHEARSAL_STEPS = ['create', 'scoped-action', 'rotate', 'asset-guard', 'revoke'] as const;

export type SafeRehearsalStep = typeof SAFE_REHEARSAL_STEPS[number];

export interface SafeRehearsalTransactionEvidence {
  kind: 'transaction';
  txHash: string;
  safeAddress: string;
}

export interface SafeRehearsalInspectionEvidence {
  kind: 'inspection';
  blockNumber: number;
  safeAddress: string;
  evidenceHash: string;
}

export type SafeRehearsalEvidence = SafeRehearsalTransactionEvidence | SafeRehearsalInspectionEvidence;

/** Public, non-secret evidence emitted by a complete testnet lifecycle run. */
export interface SafeRehearsalRecord {
  schemaVersion: 1;
  chainId: typeof SAFE_REHEARSAL_CHAIN_ID;
  moduleManifestId: string;
  provider: 'safe-roles';
  providerRevision: string;
  completedAt: string;
  steps: Record<SafeRehearsalStep, SafeRehearsalEvidence>;
}

export function safeRehearsalPath(): string {
  return join(configDir(resolveConfigPath()), 'keys', 'safe-rehearsal.json');
}

function validAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
}

export function readSafeRehearsalRecord(): { record?: SafeRehearsalRecord; error?: string } {
  const file = safeRehearsalPath();
  if (!existsSync(file)) return { error: `No lifecycle evidence exists at ${file}.` };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<SafeRehearsalRecord>;
    if (value.schemaVersion !== 1 || value.chainId !== SAFE_REHEARSAL_CHAIN_ID || value.provider !== 'safe-roles') {
      return { error: 'Lifecycle evidence has an unsupported schema, chain, or provider.' };
    }
    if (typeof value.moduleManifestId !== 'string' || !value.moduleManifestId || typeof value.providerRevision !== 'string' || !value.providerRevision) {
      return { error: 'Lifecycle evidence is missing its module manifest or provider revision.' };
    }
    if (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) {
      return { error: 'Lifecycle evidence has an invalid completion timestamp.' };
    }
    const steps = value.steps as Partial<Record<SafeRehearsalStep, SafeRehearsalEvidence>> | undefined;
    for (const step of SAFE_REHEARSAL_STEPS) {
      const evidence = steps?.[step];
      if (!evidence || !validAddress(evidence.safeAddress)) return { error: `Lifecycle evidence is missing a valid ${step} step.` };
      if (evidence.kind === 'transaction') {
        if (!validHash(evidence.txHash)) return { error: `Lifecycle ${step} has an invalid transaction hash.` };
      } else if (evidence.kind === 'inspection') {
        if (step !== 'asset-guard' || !Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber <= 0 || !validHash(evidence.evidenceHash)) {
          return { error: `Lifecycle ${step} has invalid inspection evidence.` };
        }
      } else {
        return { error: `Lifecycle ${step} has an unsupported evidence kind.` };
      }
    }
    return { record: value as SafeRehearsalRecord };
  } catch (error) {
    return { error: `Lifecycle evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
