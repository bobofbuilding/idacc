import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { HeadroomPilotSettings } from '../../../idctl/src/settings/schema.ts';
import { contextBudgetReport, type ContextBudgetReport } from './contextBudget.ts';
import { replayContextBudgetFromChatHistory, type ContextBudgetHistoryReplayReport } from './contextReplay.ts';
import type { HeadroomPluginPathAudit } from './headroomPlugin.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';

export interface HeadroomStatus {
  cli: {
    found: boolean;
    version?: string;
    error?: string;
  };
  proxy: {
    url: string;
    reachable: boolean;
    httpStatus?: number;
    error?: string;
  };
}

export interface HeadroomCoreAudit {
  coreReady: boolean;
  healthSurface: 'hidden';
  decision: 'not-ready' | 'ready-for-explicit-pilot';
  status: HeadroomStatus;
  reasons: string[];
  blockedInsertionPoints: string[];
  requiredForCore: string[];
  safeToday: string[];
  contextBudget?: Pick<ContextBudgetReport, 'coreEnabled' | 'frontendSurface' | 'inspected' | 'optimized' | 'direct' | 'protectedDirect' | 'savedTokens' | 'savingsRatio' | 'persisted' | 'policy' | 'qualityGuards'>;
  policy?: Pick<HeadroomPilotSettings, 'enabled' | 'mode' | 'minContextTokens' | 'passthroughContent' | 'validationGates' | 'updatedAt'>;
}

export interface HeadroomBackendContractAudit {
  coreReady: false;
  validationReady: true;
  decision: 'validate-idacc-plugin-path-first';
  managerChangeLevel: 'none-now-minimal-later';
  recommendedPath: 'idacc-owned-plugin-candidate';
  status: HeadroomStatus;
  historyReplay: Pick<ContextBudgetHistoryReplayReport, 'corpus' | 'dryRunOnly' | 'rawPromptPersisted' | 'managerContacted' | 'scannedSessions' | 'eligibleMessages' | 'totals' | 'guardrails'>;
  phases: string[];
  pluginCandidate: {
    name: string;
    installSurface: 'Capabilities or Settings reviewed install';
    managerRequirement: 'existing id-agents plugin/skill/MCP attachment and rebuild flows; manager retrieval contract before core routing';
    purpose: string;
  };
  pluginPath?: Pick<HeadroomPluginPathAudit, 'coreReady' | 'pilotReady' | 'verdict' | 'candidate' | 'manager' | 'headroom' | 'runtimeCoverage' | 'guardrails' | 'blockers'>;
  requiredContract: string[];
  validationGates: string[];
  blockers: string[];
}

function cliPath(): string {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  const existing = process.env.PATH ? process.env.PATH.split(':') : [];
  return [...dirs, ...existing].join(':');
}

function headroomVersion(timeoutMs = 3000): Promise<HeadroomStatus['cli']> {
  return new Promise((resolve) => {
    const child = execFile('headroom', ['--version'], {
      env: externalChildEnvironment(process.env, { PATH: cliPath() }),
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        resolve({ found: false, error: msg || 'headroom CLI not found' });
        return;
      }
      resolve({ found: true, version: (stdout || stderr).trim() || 'installed' });
    });
    child.on('error', (err) => resolve({ found: false, error: err.message }));
  });
}

async function probeHeadroomProxy(url = 'http://127.0.0.1:8787/mcp'): Promise<HeadroomStatus['proxy']> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idctl', version: '1' } } }),
      signal: AbortSignal.timeout(2500),
    });
    return { url, reachable: res.ok || res.status === 400 || res.status === 405, httpStatus: res.status };
  } catch (err) {
    return { url, reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function headroomStatus(): Promise<HeadroomStatus> {
  const [cli, proxy] = await Promise.all([headroomVersion(), probeHeadroomProxy()]);
  return { cli, proxy };
}

export async function headroomCoreAudit(pilot?: HeadroomPilotSettings): Promise<HeadroomCoreAudit> {
  const status = await headroomStatus();
  const budget = contextBudgetReport();
  const reasons: string[] = [];
  if (!status.cli.found) reasons.push('Headroom CLI is not installed or not on the app PATH.');
  if (!status.proxy.reachable) reasons.push('Headroom proxy/MCP endpoint is not reachable at the local default URL.');
  if (!pilot?.enabled) reasons.push('Saved Headroom policy is not enabled; Headroom-specific routing remains direct.');
  reasons.push('IDACC has no manager-side contract that proves a compressed prompt can recover the original source before an agent acts.');
  reasons.push('Work prompts contain protected content classes such as source under active review, instructions, secrets/auth references, and validator evidence that must remain direct unless explicitly proven safe.');

  const reversibleReady = status.cli.found && status.proxy.reachable && pilot?.enabled === true;
  return {
    coreReady: false,
    healthSurface: 'hidden',
    decision: reversibleReady ? 'ready-for-explicit-pilot' : 'not-ready',
    status,
    reasons,
    blockedInsertionPoints: [
      'Dashboard and Chat /ask prompts: user intent must remain exact, especially for active goals and project focus.',
      'Work Plans automation: plan content and blocker scans must not lose dependency, evidence, or status details.',
      'Work Tasks triage/re-dispatch: task descriptions are already clipped and need exact refs/status commands.',
      'Work Learn routing: source excerpts are untrusted and already summarized/classified under injection guardrails.',
      'Validator return path: completed-work evidence must cite originals, not lossy summaries.',
    ],
    requiredForCore: [
      'Installable Headroom CLI or bundled local service with stable version detection.',
      'Smoke-tested MCP/proxy tools that compress, retrieve, and verify original recovery before any Work prompt uses them.',
      'Manager support for retrieval handles or a required MCP attachment so agents can fetch originals before acting.',
      'Per-dispatch audit records showing original size, compressed size, recovery id, protected-content decision, and fallback route.',
      'A quality gate that keeps protected content and low-context prompts on the direct route.',
    ],
    safeToday: [
      'Keep token-throughput analytics visible on Health.',
      'Keep Headroom out of the Health UI so it does not look like active token savings.',
      'Use hidden deterministic context budgeting for eligible /ask prompts: exact duplicate/background compaction only, with protected-content direct fallback.',
      'Continue direct routing for secrets, instruction sidecars, active code patches, wallet/key material, low-context prompts, and prompts that do not clear the savings gate.',
      'Use the existing MCP/provider catalog only for explicit operator experiments, not automatic core routing.',
    ],
    contextBudget: {
      coreEnabled: budget.coreEnabled,
      frontendSurface: budget.frontendSurface,
      inspected: budget.inspected,
      optimized: budget.optimized,
      direct: budget.direct,
      protectedDirect: budget.protectedDirect,
      savedTokens: budget.savedTokens,
      savingsRatio: budget.savingsRatio,
      persisted: budget.persisted,
      policy: budget.policy,
      qualityGuards: budget.qualityGuards,
    },
    policy: pilot ? {
      enabled: pilot.enabled,
      mode: pilot.mode,
      minContextTokens: pilot.minContextTokens,
      passthroughContent: pilot.passthroughContent,
      validationGates: pilot.validationGates,
      updatedAt: pilot.updatedAt,
    } : undefined,
  };
}

export async function headroomBackendContractAudit(pluginPath?: HeadroomPluginPathAudit): Promise<HeadroomBackendContractAudit> {
  const [status, historyReplay] = await Promise.all([
    headroomStatus(),
    Promise.resolve(replayContextBudgetFromChatHistory({ limitSessions: 50, maxMessages: 500, sampleLimit: 0 })),
  ]);
  return {
    coreReady: false,
    validationReady: true,
    decision: 'validate-idacc-plugin-path-first',
    managerChangeLevel: 'none-now-minimal-later',
    recommendedPath: 'idacc-owned-plugin-candidate',
    status,
    historyReplay: {
      corpus: historyReplay.corpus,
      dryRunOnly: historyReplay.dryRunOnly,
      rawPromptPersisted: historyReplay.rawPromptPersisted,
      managerContacted: historyReplay.managerContacted,
      scannedSessions: historyReplay.scannedSessions,
      eligibleMessages: historyReplay.eligibleMessages,
      totals: historyReplay.totals,
      guardrails: historyReplay.guardrails,
    },
    phases: [
      'Phase 0: keep deterministic context budgeting as the hidden core path; no manager changes.',
      'Phase 1: replay local chat history as an aggregate dry-run corpus; no manager contact and no raw prompt output.',
      'Phase 2: validate the bundled IDACC context-retrieval portable plugin package, including native plugin, Skill, MCP, and direct-fallback adapters.',
      'Phase 3: keep native-plugin-only routing pilot-scoped because native plugin loaders are runtime-specific; use portable adapters or manager retrieval contracts for runtime-neutral core routing.',
      'Phase 4: require manager /capabilities to advertise a retrieval contract before IDACC sends retrieval handles.',
      'Phase 5: enable an explicit pilot only after retrieval, hash verification, expiry, direct fallback, and quality review pass.',
    ],
    pluginCandidate: {
      name: 'idacc-context-retrieval',
      installSurface: 'Capabilities or Settings reviewed install',
      managerRequirement: 'existing id-agents plugin/skill/MCP attachment and rebuild flows; manager retrieval contract before core routing',
      purpose: 'Expose a narrow portable retrieval package for context handles without forking the base manager hot path.',
    },
    pluginPath: pluginPath ? {
      coreReady: pluginPath.coreReady,
      pilotReady: pluginPath.pilotReady,
      verdict: pluginPath.verdict,
      candidate: pluginPath.candidate,
      manager: pluginPath.manager,
      headroom: pluginPath.headroom,
      runtimeCoverage: pluginPath.runtimeCoverage,
      guardrails: pluginPath.guardrails,
      blockers: pluginPath.blockers,
    } : undefined,
    requiredContract: [
      'Capability advertisement: manager /capabilities must report context-retrieval support and a contract version.',
      'Handle shape: compressed prompts must carry a retrieval id, source hash, expiry, protected-content class, and direct fallback summary.',
      'Resolve-before-act: an agent must be able to resolve and hash-check the original context before relying on omitted material.',
      'Protected fallback: secrets, auth material, wallet/key material, instruction sidecars, active patches, and validator evidence remain direct.',
      'Auditability: every routed prompt records token estimates, transform class, retrieval capability state, and fallback route without raw prompt persistence.',
    ],
    validationGates: [
      'Historical replay demonstrates useful savings on real saved chats without surfacing raw text.',
      'Context-budget smoke tests continue to prove protected direct fallback and redacted reports.',
      'Portable plugin smoke tests prove manifest adapter coverage, MCP tool listing/calls, resolve, hash-match, expiry, and protected-content direct fallback.',
      'Manager capability checks prove the retrieval contract is installed before any handle route is eligible.',
      'Quality review compares original objective, compressed payload, resolved context, and final response for material drift.',
    ],
    blockers: [
      'No retrieval handles should be sent to the manager until the optional plugin and /capabilities contract exist.',
      'Headroom CLI/proxy presence alone is not enough; retrieval and direct fallback must be verified at dispatch time.',
      'Native-plugin-only routing is not a core path because it excludes non-Claude runtimes; portable packages must include Skill/MCP/direct-fallback adapters and still prefer a manager contract for core routing.',
      'The downloaded IDACC app must remain useful with a stock or older id-agents manager, so unsupported managers keep direct deterministic routing.',
    ],
  };
}
