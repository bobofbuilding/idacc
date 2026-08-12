import assert from 'node:assert/strict';
import { ManagerClient, NetworkError } from './client.ts';

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'agent_configuration_apply_failed',
    message: 'Claude Code is not signed in for the selected subscription.',
  }), { status: 503, headers: { 'content-type': 'application/json' } });

  const client = new ManagerClient({
    managerUrl: 'http://idacc.test',
    refreshMs: 1_000,
    waitSeconds: 1,
  });
  await assert.rejects(
    () => client.applyAgentConfiguration(
      'agent_1',
      { runtime: 'claude-code-cli', model: 'sonnet' },
      { runtime: 'claude-code-cli', model: 'haiku' },
    ),
    (error: unknown) => {
      assert.ok(error instanceof NetworkError);
      assert.match(error.message, /agent_configuration_apply_failed/);
      assert.match(error.message, /Claude Code is not signed in/);
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('[managerErrorDetail.test] OK');
