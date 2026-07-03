import type { ProviderProfile } from '../../../idctl/src/settings/schema.ts';
import type { RuntimeModelLaneKind } from '../../../idctl/src/settings/runtimeCatalog.ts';
import { call, currentSyncVersion } from './store.ts';

export type RuntimeCatalogProvider = ProviderProfile & {
  keySource?: string;
  needsKey?: boolean;
};

export type ManagedRuntimeStatus = {
  runtime?: string;
  installed?: boolean;
  loggedIn?: boolean;
  linked?: boolean;
  statusSupported?: boolean;
};

export type RuntimeFreshnessRow = {
  runtime: string;
  label?: string;
  kind?: 'harness' | RuntimeModelLaneKind;
  models?: string[];
  count: number;
  source: 'codex-cache' | 'grok-cli' | 'antigravity-cli' | 'provider' | 'curated' | 'none';
  provider?: string;
  lastCheckedMs: number | null;
  selectable?: boolean;
  detail?: string;
};

export type RuntimeCatalogSnapshot = {
  version: number;
  modelCatalog: Record<string, string[]>;
  providers: RuntimeCatalogProvider[];
  managedRuntimes: Record<string, ManagedRuntimeStatus>;
  freshness?: RuntimeFreshnessRow[];
  at: number;
};

type RuntimeCatalogPatch = Partial<Omit<RuntimeCatalogSnapshot, 'version' | 'at'>>;

let snapshot: RuntimeCatalogSnapshot | null = null;
let inFlight: Promise<RuntimeCatalogSnapshot> | null = null;

export function getRuntimeCatalogSnapshot(version?: number): RuntimeCatalogSnapshot | null {
  if (version == null) return snapshot;
  return snapshot?.version === version ? snapshot : null;
}

export function primeRuntimeCatalogSnapshot(
  version: number,
  patch: RuntimeCatalogPatch,
): RuntimeCatalogSnapshot {
  const previous = snapshot?.version === version ? snapshot : null;
  snapshot = {
    version,
    modelCatalog: patch.modelCatalog ?? previous?.modelCatalog ?? {},
    providers: patch.providers ?? previous?.providers ?? [],
    managedRuntimes: patch.managedRuntimes ?? previous?.managedRuntimes ?? {},
    freshness: patch.freshness ?? previous?.freshness,
    at: Date.now(),
  };
  return snapshot;
}

export function currentRuntimeCatalogVersion(): number {
  return currentSyncVersion(['runtime-catalog']);
}

export function primeCurrentRuntimeCatalogSnapshot(patch: RuntimeCatalogPatch): RuntimeCatalogSnapshot {
  return primeRuntimeCatalogSnapshot(currentRuntimeCatalogVersion(), patch);
}

export async function loadRuntimeCatalogSnapshot(
  version: number,
  options: { freshness?: boolean } = {},
): Promise<RuntimeCatalogSnapshot> {
  const wantsFreshness = Boolean(options.freshness);
  const cached = getRuntimeCatalogSnapshot(version);
  if (cached && (!wantsFreshness || cached.freshness)) return cached;

  if (inFlight) {
    const pending = await inFlight;
    if (pending.version === version && (!wantsFreshness || pending.freshness)) return pending;
  }

  inFlight = Promise.all([
    call<Record<string, string[]>>('runtime:models').catch(() => ({})),
    call<RuntimeCatalogProvider[]>('providers:list').catch(() => [] as RuntimeCatalogProvider[]),
    call<Record<string, ManagedRuntimeStatus>>('subs:status').catch(() => ({})),
    wantsFreshness
      ? call<RuntimeFreshnessRow[]>('runtime:freshness').catch(() => [] as RuntimeFreshnessRow[])
      : Promise.resolve(cached?.freshness),
  ]).then(([modelCatalog, providers, managedRuntimes, freshness]) =>
    primeRuntimeCatalogSnapshot(version, {
      modelCatalog,
      providers,
      managedRuntimes,
      freshness,
    }),
  ).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export async function refreshCurrentRuntimeCatalogSnapshot(
  options: { freshness?: boolean } = {},
): Promise<RuntimeCatalogSnapshot> {
  return loadRuntimeCatalogSnapshot(currentRuntimeCatalogVersion(), options);
}
