import { call } from '../store.ts';

type DispatchStart = { queryId?: string; inline?: string };
type DispatchPoll = { status?: string; text?: string; error?: string };

/**
 * Run a Work-page request against the team captured when the action began.
 * Using the resumable dispatch routes avoids borrowing a different global team
 * if the user changes the active-team selector while a long request is running.
 */
export async function dispatchWorkToTeam(
  command: string,
  team: string,
  conversationId: string,
  totalTimeoutMs = 15 * 60 * 1000,
): Promise<string> {
  const started = await call<DispatchStart>('dispatch:start', command, conversationId, team);
  if (!started.queryId) return started.inline || '(no reply)';

  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const result = await call<DispatchPoll>('query:poll', started.queryId, 8, team);
    if (result.status === 'delivered') return result.text || '(empty reply)';
    if (result.status === 'failed') throw new Error(result.error || 'agent failed');
    if (result.status === 'expired') throw new Error(result.error || 'query expired');
    if (result.status === 'cancelled') throw new Error(result.error || 'query cancelled');
  }
  throw new Error('timed out waiting for reply');
}
