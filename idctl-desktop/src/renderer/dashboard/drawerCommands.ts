// SPDX-License-Identifier: MIT
/**
 * Metadata and the single guarded execution path for mutations exposed by the
 * Dashboard control drawer. Keeping these descriptors separate from the panel
 * opening commands prevents a harmless drawer open from inheriting a mutation's
 * capability or confirmation requirements.
 */
import {
  createCommandIdempotencyKey,
  evaluateCommandGate,
  executeGatedCommand,
  recordDeclinedCommand,
  type CommandEnvironment,
  type CommandMetadata,
  type CommandOperationContext,
  type CommandOutcome,
  type TrackedOperationResult,
} from './commandRuntime.ts';

export const DRAWER_COMMANDS = {
  quickProbe: {
    commandId: 'drawer.quick.probe',
    ownerView: 'teams',
    requiredFeatures: ['observability'],
    risk: 'low',
    confirmation: 'none',
    receiptKind: 'mutation',
  },
  projectSave: {
    commandId: 'drawer.project.save',
    ownerView: 'projects',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  projectDecompose: {
    commandId: 'drawer.project.decompose',
    ownerView: 'projects',
    requiredFeatures: ['control-state'],
    risk: 'low',
    confirmation: 'none',
    receiptKind: 'mutation',
  },
  projectDispatch: {
    commandId: 'drawer.project.dispatch',
    ownerView: 'tasks',
    requiredFeatures: ['control-state'],
    risk: 'high',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  projectTriage: {
    commandId: 'drawer.project.triage',
    ownerView: 'tasks',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  orgAssignLead: {
    commandId: 'drawer.org.assign-lead',
    ownerView: 'teams',
    requiredFeatures: ['control-state'],
    risk: 'high',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  orgSecondaryScope: {
    commandId: 'drawer.org.secondary-scope',
    ownerView: 'teams',
    requiredFeatures: ['control-state'],
    risk: 'high',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  orgSync: {
    commandId: 'drawer.org.sync',
    ownerView: 'teams',
    requiredFeatures: ['control-state'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  planCreate: {
    commandId: 'drawer.plan.create',
    ownerView: 'tasks',
    requiredFeatures: ['brain-control'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  planStatus: {
    commandId: 'drawer.plan.status',
    ownerView: 'tasks',
    requiredFeatures: ['brain-control'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  boardLane: {
    commandId: 'drawer.board.lane',
    ownerView: 'tasks',
    requiredFeatures: ['control-state'],
    risk: 'low',
    confirmation: 'none',
    receiptKind: 'mutation',
  },
  controlProvider: {
    commandId: 'drawer.control.provider',
    ownerView: 'settings',
    requiredFeatures: ['manager-controls'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
  controlConcurrency: {
    commandId: 'drawer.control.concurrency',
    ownerView: 'settings',
    requiredFeatures: ['manager-controls'],
    risk: 'medium',
    confirmation: 'required',
    receiptKind: 'mutation',
  },
} as const satisfies Record<string, CommandMetadata>;

const inFlightDrawerCommands = new Map<string, Promise<TrackedOperationResult<unknown>>>();

export function runDrawerCommand<T>(options: {
  metadata: CommandMetadata;
  environment: CommandEnvironment;
  label: string;
  resourceRefs?: readonly string[];
  operation: (context: CommandOperationContext) => T | Promise<T>;
  classifyOutcome?: (value: T) => CommandOutcome;
  timeoutMs?: number;
}): Promise<TrackedOperationResult<T>> {
  const primaryResource = options.resourceRefs?.[0] ?? options.metadata.ownerView;
  const lockKey = `${options.metadata.commandId}|${primaryResource}`;
  const existing = inFlightDrawerCommands.get(lockKey);
  if (existing) return existing as Promise<TrackedOperationResult<T>>;
  const execution = (async (): Promise<TrackedOperationResult<T>> => {
    const idempotencyKey = createCommandIdempotencyKey(options.metadata.commandId);
    const gate = evaluateCommandGate(options.metadata, options.environment);
    let confirmed = false;
    if (gate.state === 'confirmation-required') {
      confirmed = typeof window !== 'undefined'
        && window.confirm(
          `${options.label}\n\n`
          + `${options.metadata.risk.toUpperCase()} risk · owned by ${options.metadata.ownerView}\n`
          + 'Continue with this command?',
        );
      if (!confirmed) {
        return {
          receipt: recordDeclinedCommand({
            metadata: options.metadata,
            idempotencyKey,
            resourceRefs: options.resourceRefs,
          }),
          executed: false,
        };
      }
    }
    return executeGatedCommand({
      metadata: options.metadata,
      environment: options.environment,
      confirmed,
      idempotencyKey,
      resourceRefs: options.resourceRefs,
      operation: options.operation,
      classifyOutcome: options.classifyOutcome,
      timeoutMs: options.timeoutMs,
    });
  })();
  inFlightDrawerCommands.set(lockKey, execution as Promise<TrackedOperationResult<unknown>>);
  return execution.finally(() => {
    if (inFlightDrawerCommands.get(lockKey) === execution) inFlightDrawerCommands.delete(lockKey);
  });
}

export function drawerCommandStatus(
  label: string,
  result: TrackedOperationResult<unknown>,
  successMessage?: string,
): string {
  const { receipt } = result;
  if (receipt.state === 'succeeded') return successMessage || `${label} completed.`;
  if (receipt.state === 'deferred') return successMessage || `${label} accepted with deferred work; review ${receipt.resourceRefs.join(', ') || 'the owner page'}.`;
  if (receipt.state === 'declined') return `${label} declined; nothing was changed.`;
  if (receipt.state === 'timed-out') return `${label} timed out. ${receipt.recovery ?? ''}`.trim();
  return receipt.error || `${label} ${receipt.state}.`;
}
