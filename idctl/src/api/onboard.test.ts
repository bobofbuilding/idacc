import assert from 'node:assert/strict';
import { runOnboarding, type OnboardPlan } from './onboard.ts';
import type { Agent, ProbeResult } from './types.ts';
import type { ManagerClient, McpServerSpec } from './client.ts';

type Call = { method: string; args: unknown[] };

class FakeClient {
  calls: Call[] = [];
  private currentTeam: string | undefined;

  constructor(
    private opts: {
      agents?: Agent[];
      mcpFails?: boolean;
      needsRebuild?: boolean;
    } = {},
    team?: string,
  ) {
    this.currentTeam = team;
  }

  withTeam(team: string | undefined): FakeClient {
    this.calls.push({ method: 'withTeam', args: [team] });
    const next = new FakeClient(this.opts, team);
    next.calls = this.calls;
    return next;
  }

  async agents(): Promise<Agent[]> {
    this.calls.push({ method: 'agents', args: [this.currentTeam] });
    return this.opts.agents ?? [];
  }

  async spawnAgent(spec: unknown): Promise<{ id: string; name: string; port: number }> {
    this.calls.push({ method: 'spawnAgent', args: [spec] });
    return { id: 'agent-1', name: 'builder', port: 4444 };
  }

  async setAgentMcp(agentId: string, servers: McpServerSpec[]): Promise<{ agent: string; mcpServers: McpServerSpec[]; needsRebuild: boolean }> {
    this.calls.push({ method: 'setAgentMcp', args: [agentId, servers] });
    if (this.opts.mcpFails) throw new Error('mcp unavailable');
    return { agent: agentId, mcpServers: servers, needsRebuild: this.opts.needsRebuild ?? true };
  }

  async restartAgent(name: string): Promise<void> {
    this.calls.push({ method: 'restartAgent', args: [name] });
  }

  async probeOne(name: string): Promise<ProbeResult> {
    this.calls.push({ method: 'probeOne', args: [name] });
    return { team: this.currentTeam ?? 'default', probed: 1, passed: 1, failed: 0, results: [{ name, status: 'ok' }] };
  }
}

const plan: OnboardPlan = {
  name: 'builder',
  team: 'lab',
  runtime: 'codex',
  model: 'gpt-5.3-codex',
  role: 'builder',
  expertise: ['typescript'],
  skills: ['code-review'],
  wallet: true,
  mcpServers: [{ name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }],
};

async function testHappyPath() {
  const client = new FakeClient({ needsRebuild: true });
  const result = await runOnboarding(client as unknown as ManagerClient, plan);

  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'agent-1');
  assert.deepEqual(result.steps.map((s) => [s.key, s.status]), [
    ['preflight', 'ok'],
    ['spawn', 'ok'],
    ['mcp', 'ok'],
    ['rebuild', 'ok'],
    ['probe', 'ok'],
  ]);
  assert.deepEqual(client.calls.map((c) => c.method), [
    'withTeam',
    'agents',
    'spawnAgent',
    'setAgentMcp',
    'restartAgent',
    'probeOne',
  ]);
}

async function testFailSoftPostSpawn() {
  const client = new FakeClient({ mcpFails: true });
  const result = await runOnboarding(client as unknown as ManagerClient, plan);

  assert.equal(result.ok, false);
  assert.equal(result.agentId, 'agent-1');
  assert.equal(result.steps.find((s) => s.key === 'mcp')?.status, 'failed');
  assert.equal(result.steps.find((s) => s.key === 'probe')?.status, 'ok');
  assert.equal(client.calls.some((c) => c.method === 'spawnAgent'), true);
  assert.equal(client.calls.some((c) => c.method === 'restartAgent'), false);
}

await testHappyPath();
await testFailSoftPostSpawn();
console.log('onboard orchestration tests passed');
