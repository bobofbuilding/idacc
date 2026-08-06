// SPDX-License-Identifier: MIT
/**
 * Shared command metadata gates and durable, bounded completion receipts.
 *
 * The runtime is deliberately UI-agnostic so palette, Dashboard chat, drawers,
 * and rendered smoke tests all exercise the same idempotency and timeout rules.
 */

export type CommandRisk = 'none' | 'low' | 'medium' | 'high';
export type CommandConfirmation = 'none' | 'required';
export type CommandReceiptKind = 'navigation' | 'drawer' | 'mutation' | 'message' | 'refresh';

export interface CommandMetadata {
  commandId: string;
  ownerView: string;
  requiredFeatures: readonly string[];
  risk: CommandRisk;
  confirmation: CommandConfirmation;
  receiptKind: CommandReceiptKind;
}

export interface CommandEnvironment {
  online: boolean;
  /** undefined = still checking; null = unavailable/incompatible. */
  features: readonly string[] | null | undefined;
}

export interface CommandGate {
  state: 'allowed' | 'confirmation-required' | 'blocked';
  reason?: string;
  recovery?: string;
  missingFeatures: string[];
}

export type CommandReceiptState =
  | 'running'
  | 'reconciling'
  | 'succeeded'
  | 'deferred'
  | 'failed'
  | 'timed-out'
  | 'blocked'
  | 'declined';

/** Stable receipt shape shared by every Dashboard command entry point. */
export interface CommandReceipt {
  commandId: string;
  idempotencyKey: string;
  state: CommandReceiptState;
  resourceRefs: string[];
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  recovery: string | null;
}

export interface ReceiptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TrackedOperationResult<T = unknown> {
  receipt: CommandReceipt;
  value?: T;
  executed: boolean;
}

export interface CommandOperationContext {
  idempotencyKey: string;
}

export interface CommandOutcome {
  state: 'succeeded' | 'deferred';
  resourceRefs?: readonly string[];
  recovery?: string | null;
}

const STORAGE_KEY = 'idacc.dashboard.command-receipts.v1';
export const MAX_COMMAND_RECEIPTS = 48;
export const COMMAND_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const SHORT_COMMAND_TIMEOUT_MS = 5_000;
const TERMINAL_STATES = new Set<CommandReceiptState>([
  'succeeded',
  'deferred',
  'failed',
  'timed-out',
  'blocked',
  'declined',
]);
const KNOWN_OWNER_VIEWS = new Set([
  'dashboard',
  'inbox',
  'tasks',
  'projects',
  'health',
  'teams',
  'modules',
  'identity',
  'computer',
  'settings',
]);
const KNOWN_MANAGER_FEATURES = new Set([
  'observability',
  'manager-controls',
  'runtime-preflight',
  'agent-config',
  'team-config',
  'library',
  'brain-context',
  'brain-control',
  'control-events',
  'control-state',
  'stalled-sweep',
]);
const RISKS = new Set<CommandRisk>(['none', 'low', 'medium', 'high']);
const CONFIRMATIONS = new Set<CommandConfirmation>(['none', 'required']);
const RECEIPT_KINDS = new Set<CommandReceiptKind>([
  'navigation',
  'drawer',
  'mutation',
  'message',
  'refresh',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeString(value: unknown, max = 240): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeResourceRefs(refs: readonly string[] | undefined): string[] {
  return Array.from(new Set((refs ?? []).map((ref) => safeString(ref, 160)).filter(Boolean))).slice(0, 16);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalizeReceipt(value: unknown): CommandReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CommandReceipt>;
  const commandId = safeString(row.commandId, 120);
  const idempotencyKey = safeString(row.idempotencyKey, 180);
  if (!commandId || !idempotencyKey || !validTimestamp(row.startedAt)) return null;
  if (!row.state || !new Set<CommandReceiptState>(['running', 'reconciling', ...TERMINAL_STATES]).has(row.state)) return null;
  return {
    commandId,
    idempotencyKey,
    state: row.state,
    resourceRefs: safeResourceRefs(Array.isArray(row.resourceRefs) ? row.resourceRefs : []),
    startedAt: row.startedAt,
    finishedAt: validTimestamp(row.finishedAt) ? row.finishedAt : null,
    error: safeString(row.error, 500) || null,
    recovery: safeString(row.recovery, 500) || null,
  };
}

export function validateCommandMetadata(metadata: CommandMetadata): string[] {
  const errors: string[] = [];
  if (!safeString(metadata.commandId, 120)) errors.push('commandId is required');
  if (!safeString(metadata.ownerView, 80)) errors.push('ownerView is required');
  else if (!KNOWN_OWNER_VIEWS.has(metadata.ownerView)) errors.push(`unsupported ownerView ${metadata.ownerView}`);
  if (!Array.isArray(metadata.requiredFeatures)) errors.push('requiredFeatures must be an array');
  else if (metadata.requiredFeatures.some((feature) => !safeString(feature, 100))) {
    errors.push('requiredFeatures must contain non-empty feature names');
  } else {
    const unknown = metadata.requiredFeatures.filter((feature) => !KNOWN_MANAGER_FEATURES.has(feature));
    if (unknown.length) errors.push(`unsupported requiredFeatures: ${unknown.join(', ')}`);
  }
  if (!RISKS.has(metadata.risk)) errors.push(`unsupported risk ${String(metadata.risk)}`);
  if (!CONFIRMATIONS.has(metadata.confirmation)) {
    errors.push(`unsupported confirmation ${String(metadata.confirmation)}`);
  }
  if (!RECEIPT_KINDS.has(metadata.receiptKind)) {
    errors.push(`unsupported receiptKind ${String(metadata.receiptKind)}`);
  }
  if ((metadata.risk === 'medium' || metadata.risk === 'high') && metadata.confirmation !== 'required') {
    errors.push(`${metadata.risk}-risk commands require confirmation`);
  }
  return errors;
}

export function evaluateCommandGate(
  metadata: CommandMetadata,
  environment: CommandEnvironment,
  confirmed = false,
): CommandGate {
  const metadataErrors = validateCommandMetadata(metadata);
  if (metadataErrors.length) {
    return {
      state: 'blocked',
      reason: `Command metadata is invalid: ${metadataErrors.join('; ')}`,
      recovery: `Open ${metadata.ownerView || 'the owning page'} and use its guarded control.`,
      missingFeatures: [],
    };
  }
  const managerBound = metadata.requiredFeatures.length > 0
    || metadata.receiptKind === 'mutation'
    || metadata.receiptKind === 'message';
  if (managerBound && !environment.online) {
    return {
      state: 'blocked',
      reason: 'Manager is offline; no command was sent.',
      recovery: `Reconnect the unified application, then review ${metadata.ownerView}.`,
      missingFeatures: [...metadata.requiredFeatures],
    };
  }
  if (metadata.requiredFeatures.length && environment.features === undefined) {
    return {
      state: 'blocked',
      reason: 'Manager compatibility is still being checked.',
      recovery: 'Wait for the compatibility check, then retry.',
      missingFeatures: [...metadata.requiredFeatures],
    };
  }
  if (metadata.requiredFeatures.length && environment.features === null) {
    return {
      state: 'blocked',
      reason: 'The connected Manager did not provide a compatible capability manifest.',
      recovery: 'Repair or update the unified application from Settings.',
      missingFeatures: [...metadata.requiredFeatures],
    };
  }
  const available = new Set(environment.features ?? []);
  const missingFeatures = metadata.requiredFeatures.filter((feature) => !available.has(feature));
  if (missingFeatures.length) {
    return {
      state: 'blocked',
      reason: `Manager is missing required feature${missingFeatures.length === 1 ? '' : 's'}: ${missingFeatures.join(', ')}.`,
      recovery: 'Repair or update the unified application from Settings.',
      missingFeatures,
    };
  }
  if (metadata.confirmation === 'required' && !confirmed) {
    return {
      state: 'confirmation-required',
      reason: `${metadata.risk}-risk command requires explicit confirmation.`,
      recovery: `Review the command and its ${metadata.ownerView} owner before confirming.`,
      missingFeatures: [],
    };
  }
  return { state: 'allowed', missingFeatures: [] };
}

let idSequence = 0;
export function createCommandIdempotencyKey(commandId: string, now = Date.now()): string {
  idSequence = (idSequence + 1) % 1_000_000;
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${now.toString(36)}-${idSequence.toString(36)}`;
  return `${safeString(commandId, 80) || 'command'}:${random}`;
}

export class CommandReceiptStore {
  private receipts: CommandReceipt[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage?: ReceiptStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.receipts = this.load();
    const interruptedAt = this.now();
    let recovered = false;
    this.receipts = this.receipts.map((receipt) => {
      if (receipt.state !== 'running' && receipt.state !== 'reconciling') return receipt;
      recovered = true;
      return {
        ...receipt,
        state: 'failed',
        finishedAt: interruptedAt,
        error: 'Application closed before command completion could be confirmed.',
        recovery: receipt.recovery || 'Review the owning page before retrying with a new command.',
      };
    });
    this.receipts = this.prune(this.receipts);
    if (recovered) this.persist();
  }

  private load(): CommandReceipt[] {
    if (!this.storage) return [];
    try {
      const parsed: unknown = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeReceipt).filter((row): row is CommandReceipt => !!row);
    } catch {
      return [];
    }
  }

  private prune(receipts: CommandReceipt[]): CommandReceipt[] {
    const cutoff = this.now() - COMMAND_RECEIPT_MAX_AGE_MS;
    return receipts
      .filter((receipt) => receipt.state === 'running' || receipt.state === 'reconciling' || receipt.startedAt >= cutoff)
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_COMMAND_RECEIPTS);
  }

  private persist(): void {
    if (!this.storage) return;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(this.receipts)); } catch { /* best-effort local durability */ }
  }

  private commit(next: CommandReceipt[]): void {
    this.receipts = this.prune(next);
    this.persist();
    for (const listener of this.listeners) listener();
  }

  snapshot = (): readonly CommandReceipt[] => this.receipts;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  find(idempotencyKey: string): CommandReceipt | undefined {
    return this.receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
  }

  start(
    commandId: string,
    idempotencyKey: string,
    resourceRefs: readonly string[] = [],
    recovery: string | null = null,
  ): CommandReceipt {
    const existing = this.find(idempotencyKey);
    if (existing) return existing;
    const receipt: CommandReceipt = {
      commandId: safeString(commandId, 120),
      idempotencyKey: safeString(idempotencyKey, 180),
      state: 'running',
      resourceRefs: safeResourceRefs(resourceRefs),
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      recovery: safeString(recovery, 500) || null,
    };
    this.commit([receipt, ...this.receipts]);
    return receipt;
  }

  finish(
    idempotencyKey: string,
    state: Exclude<CommandReceiptState, 'running'>,
    options: {
      error?: string | null;
      recovery?: string | null;
      resourceRefs?: readonly string[];
      allowTerminalOverride?: boolean;
    } = {},
  ): CommandReceipt {
    const current = this.find(idempotencyKey);
    if (!current) throw new Error(`Unknown command receipt ${idempotencyKey}`);
    if (TERMINAL_STATES.has(current.state) && !options.allowTerminalOverride) return current;
    const receipt: CommandReceipt = {
      ...current,
      state,
      resourceRefs: options.resourceRefs
        ? safeResourceRefs([...current.resourceRefs, ...options.resourceRefs])
        : current.resourceRefs,
      finishedAt: state === 'reconciling' ? null : this.now(),
      error: safeString(options.error, 500) || null,
      recovery: options.recovery === null
        ? null
        : safeString(options.recovery, 500) || current.recovery,
    };
    this.commit(this.receipts.map((row) => row.idempotencyKey === idempotencyKey ? receipt : row));
    return receipt;
  }

  terminal(
    metadata: Pick<CommandMetadata, 'commandId' | 'ownerView'>,
    state: 'blocked' | 'declined',
    idempotencyKey: string,
    options: { error?: string | null; recovery?: string | null; resourceRefs?: readonly string[] } = {},
  ): CommandReceipt {
    const recovery = options.recovery || `Open ${metadata.ownerView} to review this command.`;
    this.start(metadata.commandId, idempotencyKey, options.resourceRefs, recovery);
    return this.finish(idempotencyKey, state, { error: options.error, recovery });
  }

  remove(idempotencyKey: string): void {
    const current = this.find(idempotencyKey);
    if (current && (current.state === 'running' || current.state === 'reconciling' || current.state === 'timed-out')) return;
    this.commit(this.receipts.filter((receipt) => receipt.idempotencyKey !== idempotencyKey));
  }

  clearTerminal(): void {
    this.commit(this.receipts.filter((receipt) =>
      receipt.state === 'running' || receipt.state === 'reconciling' || receipt.state === 'timed-out',
    ));
  }
}

let browserStore: CommandReceiptStore | undefined;
export function commandReceiptStore(): CommandReceiptStore {
  if (!browserStore) {
    let storage: ReceiptStorage | undefined;
    try { storage = typeof window !== 'undefined' ? window.localStorage : undefined; } catch { /* storage unavailable */ }
    browserStore = new CommandReceiptStore(storage);
  }
  return browserStore;
}

export function resetCommandReceiptStoreForTests(): void {
  browserStore = undefined;
}

export function receiptRecovery(metadata: Pick<CommandMetadata, 'ownerView'>, idempotencyKey: string): string {
  return `Open ${metadata.ownerView} to verify current state before retrying. Receipt: ${idempotencyKey}`;
}

export async function runTrackedOperation<T>(options: {
  metadata: CommandMetadata;
  operation: (context: CommandOperationContext) => T | Promise<T>;
  resourceRefs?: readonly string[];
  idempotencyKey?: string;
  timeoutMs?: number;
  classifyOutcome?: (value: T) => CommandOutcome;
  store?: CommandReceiptStore;
}): Promise<TrackedOperationResult<T>> {
  const store = options.store ?? commandReceiptStore();
  const idempotencyKey = options.idempotencyKey
    ?? createCommandIdempotencyKey(options.metadata.commandId);
  const existing = store.find(idempotencyKey);
  if (existing) return { receipt: existing, executed: false };
  const recovery = receiptRecovery(options.metadata, idempotencyKey);
  store.start(options.metadata.commandId, idempotencyKey, options.resourceRefs, recovery);
  const defaultTimeout = options.metadata.receiptKind === 'navigation'
    || options.metadata.receiptKind === 'drawer'
    || options.metadata.receiptKind === 'refresh'
    ? SHORT_COMMAND_TIMEOUT_MS
    : DEFAULT_COMMAND_TIMEOUT_MS;
  const timeoutMs = Math.max(1, options.timeoutMs ?? defaultTimeout);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settleSuccess = (value: T, allowTerminalOverride = false): CommandReceipt => {
    const outcome = options.classifyOutcome?.(value) ?? { state: 'succeeded' as const };
    return store.finish(idempotencyKey, outcome.state, {
      recovery: outcome.recovery ?? null,
      resourceRefs: outcome.resourceRefs,
      allowTerminalOverride,
    });
  };
  try {
    const operation = Promise.resolve().then(() => options.operation({ idempotencyKey }));
    // A timed-out request can still resolve. Keep its receipt tied to the same
    // invocation and reconcile that late terminal outcome instead of creating a
    // second command or leaving a known success marked unknown.
    operation.then(
      (value) => {
        const current = store.find(idempotencyKey);
        if (current?.state === 'timed-out' || current?.state === 'reconciling') {
          settleSuccess(value, true);
        }
      },
      (error) => {
        const current = store.find(idempotencyKey);
        if (current?.state === 'timed-out' || current?.state === 'reconciling') {
          store.finish(idempotencyKey, 'failed', {
            error: errorMessage(error),
            recovery,
            allowTerminalOverride: true,
          });
        }
      },
    );
    const timeoutResult = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const value = await Promise.race([operation, timeoutResult]);
    if (timeout) clearTimeout(timeout);
    return {
      receipt: settleSuccess(value),
      value,
      executed: true,
    };
  } catch (error) {
    if (timeout) clearTimeout(timeout);
    const message = errorMessage(error);
    const timedOut = /^Command timed out after \d+ms$/.test(message);
    return {
      receipt: store.finish(idempotencyKey, timedOut ? 'timed-out' : 'failed', {
        error: message,
        recovery: timedOut
          ? `${recovery} The original request may still finish; do not issue a new command until this receipt reconciles or the owner page confirms current state.`
          : recovery,
      }),
      executed: true,
    };
  }
}

export async function executeGatedCommand<T>(options: {
  metadata: CommandMetadata;
  environment: CommandEnvironment;
  confirmed?: boolean;
  operation: (context: CommandOperationContext) => T | Promise<T>;
  resourceRefs?: readonly string[];
  idempotencyKey?: string;
  timeoutMs?: number;
  classifyOutcome?: (value: T) => CommandOutcome;
  store?: CommandReceiptStore;
}): Promise<TrackedOperationResult<T>> {
  const store = options.store ?? commandReceiptStore();
  const idempotencyKey = options.idempotencyKey
    ?? createCommandIdempotencyKey(options.metadata.commandId);
  const gate = evaluateCommandGate(options.metadata, options.environment, options.confirmed);
  if (gate.state !== 'allowed') {
    return {
      receipt: store.terminal(
        options.metadata,
        'blocked',
        idempotencyKey,
        {
          error: gate.reason || 'Command execution was blocked.',
          recovery: gate.recovery,
          resourceRefs: options.resourceRefs,
        },
      ),
      executed: false,
    };
  }
  return runTrackedOperation({
    ...options,
    idempotencyKey,
    store,
  });
}

export function recordDeclinedCommand(options: {
  metadata: CommandMetadata;
  resourceRefs?: readonly string[];
  idempotencyKey?: string;
  store?: CommandReceiptStore;
}): CommandReceipt {
  const store = options.store ?? commandReceiptStore();
  return store.terminal(
    options.metadata,
    'declined',
    options.idempotencyKey ?? createCommandIdempotencyKey(options.metadata.commandId),
    {
      resourceRefs: options.resourceRefs,
      recovery: `No changes were made. Reopen ${options.metadata.ownerView} when ready.`,
    },
  );
}
