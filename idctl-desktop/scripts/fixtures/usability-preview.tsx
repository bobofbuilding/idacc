/** Isolated UI preview. No Manager connection and no accepted mutations. */
import { createRoot } from 'react-dom/client';
import { App, AppErrorBoundary } from '../../src/renderer/App.tsx';
import { setTransport } from '../../src/renderer/store.ts';
import '../../src/renderer/styles.css';
const agent = { id: 'sample-lead', name: 'lead', team: 'sample-team', status: 'online', runtime: 'sample' };
const fixtures: Record<string, unknown> = {
  info: { managerUrl: 'Preview only', team: 'sample-team', coordinator: 'lead' },
  'app:runtimeStatus': { phase: 'running' }, 'app:version': '0.1.723-preview',
  'update:status': { current: '0.1.723-preview', available: false, checking: false, staged: false },
  agents: [agent], teams: [{ name: 'sample-team', coordinator: 'lead' }],
  'agents:allTeams': [{ team: 'sample-team', agents: [agent] }],
  'onboarding:status': { phase: 'ready', ready: true, currentReady: true, needsOnboarding: false, state: { mode: 'complete' }, assignments: [], subscriptions: [], services: [], issues: [], notices: [], gates: {} },
  'org:hierarchy': { primary: { agent: 'lead', team: 'sample-team' }, secondaries: [], coordinators: { 'sample-team': 'lead' }, teams: ['sample-team'] },
  inboxPending: [{ query_id: 'sample-question', from: 'lead', message: 'Which outcome should we prioritize this week?' }],
  'questions:list': [{ id: 'sample-blocker', agent: 'lead', team: 'sample-team', question: 'The task needs a project folder.', options: ['I will choose a folder'], taskTitle: 'Prepare weekly report', createdAt: Date.now() }],
  'tasks:deps': {}, 'chats:unreadCount': 0, 'brain:plans': { dir: null, plans: [] },
  'projects:list': [{ id: 'sample', name: 'Weekly report', status: 'active', description: 'Summarize the team’s completed work.', team: 'sample-team', lead: 'lead', path: '/preview/report' }],
};
for (const name of ['tasks', 'tasks:allTeams', 'goals:list', 'plans:list', 'materials:list', 'schedules', 'schedules:allTeams', 'checkins', 'chats:list', 'providers:list', 'dreams:list']) fixtures[name] = [];
setTransport(async (method) => Object.hasOwn(fixtures, method)
  ? { ok: true, result: fixtures[method] }
  : { ok: false, error: `Preview: ${method} is unavailable; no action was performed.` });
createRoot(document.getElementById('root')!).render(<AppErrorBoundary><App /></AppErrorBoundary>);
