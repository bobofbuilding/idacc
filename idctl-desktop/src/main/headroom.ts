import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import type { HeadroomPilotSettings } from '../../../idctl/src/settings/schema.ts';
import { contextBudgetReport, type ContextBudgetReport } from './contextBudget.ts';
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
