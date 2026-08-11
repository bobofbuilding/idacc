import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditValidatedTaskEvidence, ownerlessWaitingCandidates, reconcileOwnerlessWaiting } from '../src/main/work.ts';
import { hasRecordedArtifactEvidence, needsArtifactIntegrityCheck } from '../src/shared/validationIntegrity.ts';
import { ownerQueryKey, taskHasActiveOwnerQuery } from '../src/shared/taskActivity.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/renderer/views/Tasks.tsx'), 'utf8');
const bridge = fs.readFileSync(path.join(here, '../src/main/bridge.ts'), 'utf8');

assert.match(
  source,
  /call<ReconcileReport>\('remote', '\/task reconcile --all --limit 20 --force'\)/,
  'Reconcile must use the manager-owned deterministic recovery command',
);
assert.match(
  source,
  /const holdingTasks = tasks\.filter/,
  'Reconcile must count the complete Holding Pattern rather than stalled doing tasks only',
);
assert.match(
  source,
  /workflowState === 'failed'\) return colOf\(t\.status\) === 'done' \? 'done' : 'holding'/,
  'Terminal failed outcomes must remain auditable in Done instead of appearing as actionable Holding work',
);
assert.match(
  source,
  /automatically routes durable workflow-waiting tasks through bounded team-lead triage/,
  'The Work page must distinguish Manager workflow recovery from the app Holding overlay',
);
assert.match(
  source,
  /const waitingRouted = report\.waiting\?\.routed \?\? 0/,
  'Reconcile must report how many waiting tasks were routed',
);
assert.match(
  source,
  /Reconciling \$\{waitingCount\} waiting/,
  'Reconcile progress must include both waiting columns',
);
assert.match(
  source,
  /reconcileUntrackedWaiting\(report\.waiting\?\.items \?\? \[\]\)/,
  'Reconcile must status-check ownerless waiting rows absent from the Manager report',
);
assert.match(
  bridge,
  /'work:reconcileWaiting': async/,
  'the main-process bridge must independently revalidate waiting candidates before delegation',
);
assert.match(
  source,
  /manager validated · artifact evidence not recorded/,
  'project tasks must not present a bare Manager verdict as repository-integrity proof',
);
assert.match(bridge, /'work:auditTaskEvidence': async/, 'Work must expose a read-only artifact audit action');
assert.match(bridge, /'tasks:activeOwnerQueries': async/, 'the board must obtain live owner-query evidence through the app bridge');
assert.match(
  source,
  /: owned \? <button[\s\S]{0,800}void statusCheck\(t\)[\s\S]{0,200}'check status'/,
  'every owned Doing task must expose a non-destructive status control before the stale threshold',
);
assert.match(
  source,
  /No task or project file will be deleted/,
  'the status control must explicitly distinguish itself from destructive deletion',
);
assert.match(
  source,
  /jumpstartCore\(t, \{\}, true, true\)/,
  'the status control must force an exact-task Manager probe even below the stale threshold',
);
assert.match(source, /title="Delete task permanently"/, 'the destructive X must be labeled unambiguously');
assert.match(
  source,
  /const working = activeTaskQuery/,
  'a live owner and recent timestamp alone must not produce the green working label',
);
assert.match(
  source,
  /\(\?:unknown\|unsupported\).*\(\?:command\|subcommand\).*reconcile.*usage:.*\\\/task/is,
  'Older managers need a bounded compatibility fallback',
);

async function main() {
const overlayComplete = {
  shortId: '#8f254b46',
  title: 'Implement selected-provider binding',
  status: 'todo',
  ownerName: null,
  teamName: 'engineering-team',
  projectId: 'bounties',
  createdAt: 1,
};
const workflowComplete = {
  shortId: '#3dcd8c7d',
  title: 'Design moderation and bilateral ratings',
  status: 'doing',
  ownerName: null,
  teamName: 'engineering-team',
  projectId: 'bounties',
  workflowState: 'blocked',
  createdAt: 2,
};
const triageRequired = {
  shortId: '#38e8f63c',
  title: 'Correct moderation and bilateral ratings implementation',
  status: 'doing',
  ownerName: null,
  teamName: 'engineering-team',
  projectId: 'bounties',
  workflowState: 'triage_required',
  createdAt: 3,
};
const ownedHolding = { ...overlayComplete, shortId: '#owned', ownerName: 'architect' };
const doneHolding = { ...overlayComplete, shortId: '#done', status: 'done' };
const lanes = { '#8f254b46': 'holding', '#owned': 'holding', '#done': 'holding' };

const architectTask = {
  shortId: '#3dcd8c7d',
  name: 'design-moderation-bilateral-ratings',
  title: 'Design moderation and bilateral ratings',
  status: 'doing',
  ownerName: 'architect',
  teamName: 'engineering-team',
  createdAt: 1,
};
assert.equal(taskHasActiveOwnerQuery(architectTask, { count: 0, queries: [] }), false);
assert.equal(taskHasActiveOwnerQuery(architectTask, {
  count: 1,
  queries: [{ status: 'processing', prompt_preview: 'unrelated work for #38e8f63c' }],
}), false, 'an architect query for corrective work must not make the older architecture task look active');
assert.equal(taskHasActiveOwnerQuery(architectTask, {
  count: 1,
  queries: [{ status: 'processing', prompt_preview: 'Status check for exact task #3dcd8c7d' }],
}), true);
assert.equal(ownerQueryKey('engineering-team', 'Architect'), '["engineering-team","architect"]');

assert.deepEqual(
  ownerlessWaitingCandidates([overlayComplete, workflowComplete, triageRequired, ownedHolding, doneHolding], lanes).map((task) => task.shortId),
  ['#8f254b46'],
  'the default companion pass must cover only the overlay-only ownerless gap',
);
assert.deepEqual(
  ownerlessWaitingCandidates(
    [overlayComplete, workflowComplete, triageRequired, ownedHolding, doneHolding],
    lanes,
    ['#8f254b46', '#3dcd8c7d', '#38e8f63c'],
    { includeWorkflowManaged: true },
  ).map((task) => task.shortId),
  ['#8f254b46', '#3dcd8c7d', '#38e8f63c'],
  'Manager-unreported blocked and triage-required rows must receive an evidence-first status check',
);

const commands = [];
const fakeClient = {
  team: 'engineering-team',
  tasksByStatus: async (status) => status === 'todo'
    ? [overlayComplete]
    : status === 'doing' ? [workflowComplete, triageRequired] : [],
  agents: async () => [{ name: 'engineering-lead', status: 'running', metadata: { role: 'team lead' } }],
  activeAgentQueries: async () => ({ count: 0, queries: [] }),
  remote: async (command) => {
    commands.push(command);
    return { ok: true, result: { queryId: 'waiting-audit-1' } };
  },
};
const routed = await reconcileOwnerlessWaiting(
  fakeClient,
  ['#8f254b46', '#3dcd8c7d', '#38e8f63c'],
  lanes,
  [{ id: 'bounties', name: 'Bounties', path: '/projects/bounties' }],
);
assert.equal(routed.considered, 3);
assert.equal(routed.routed, 3);
assert.equal(routed.queryId, 'waiting-audit-1');
assert.match(commands[0] || '', /#8f254b46/);
assert.match(commands[0] || '', /#3dcd8c7d/);
assert.match(commands[0] || '', /#38e8f63c/);
assert.match(commands[0] || '', /exact project root: \/projects\/bounties/);
assert.match(commands[0] || '', /COMM completion report/);
assert.match(commands[0] || '', /file presence alone is not completion evidence/i);

const unsupportedValidation = {
  ...overlayComplete,
  shortId: '#bb6d96fa',
  title: 'Implement bilateral ratings',
  status: 'done',
  workflowState: 'validated',
  validationDetail: { verdict: 'approved', evidence_ids: ['query:validator-1'] },
  outcomeDetail: { result: 'Implementation complete.' },
};
assert.equal(hasRecordedArtifactEvidence(unsupportedValidation), false);
assert.equal(needsArtifactIntegrityCheck(unsupportedValidation), true);
assert.equal(hasRecordedArtifactEvidence({
  ...unsupportedValidation,
  validationDetail: { verdict: 'approved', artifacts: ['src/ratings.ts'], tests: ['ratings.test.ts passed'] },
}), true);

const auditCommands = [];
const audit = await auditValidatedTaskEvidence(
  {
    ...fakeClient,
    tasksByStatus: async (status) => status === 'done' ? [unsupportedValidation] : [],
    dispatch: async (command) => {
      auditCommands.push(command);
      return 'MISSING — no ratings schema or API was found; existing tests do not cover the requested scope.';
    },
  },
  '#bb6d96fa',
  [{ id: 'bounties', name: 'Bounties', path: '/projects/bounties' }],
);
assert.equal(audit.ok, true);
assert.match(audit.reply || '', /^MISSING/);
assert.match(auditCommands[0] || '', /Do not delegate, create or reopen tasks, edit files/);
assert.match(auditCommands[0] || '', /validated lifecycle verdict is a claim, not proof/);
assert.match(auditCommands[0] || '', /Exact project root: \/projects\/bounties/);

console.log('work reconcile smoke passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
