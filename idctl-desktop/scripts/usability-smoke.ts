import assert from 'node:assert/strict';
import { requestedPlanConsolidation, heartbeatIntervals, learningSummary, hasCurrentBrainGraphSync } from '../src/shared/usability.ts';
import { workDestination } from '../src/renderer/navigation.ts';
for (const text of [
  'Plan 72 merge/deployment update: PR 14 merged; 192 tests passed.',
  'Correction: 192 was a test count. Preserve consolidated plan 72 as partial; commit d7c37f94.',
  'Resume canonical IDACC Plan 72 (consolidated Plans 70+71).',
  'Do not combine plans 70 and 71.',
  'Combine plans 70 and 71 after running 192 tests.',
]) assert.equal(requestedPlanConsolidation(text), null, text);
assert.deepEqual(requestedPlanConsolidation('Please combine plans 70 and 71.'), ['70', '71']);
assert.deepEqual(requestedPlanConsolidation('/combine plans #2, #3 + #4'), ['2', '3', '4']);
assert.equal(requestedPlanConsolidation('merge plans 0 and 1'), null);
assert.equal(requestedPlanConsolidation('merge plans 1 and 1'), null);
for (const seconds of [60, 43200, 4500, 123]) assert.equal(heartbeatIntervals(seconds).filter((item) => item.s === seconds).length, 1);
const current = { status: 'ready', brainSync: { status: 'ok', schemaVersion: 3, exactEntity: true, entity: true, sourceEntity: true, facts: true, edges: true, expectedEdgeCount: 2, edgeCount: 2 } };
assert.equal(hasCurrentBrainGraphSync(current), true);
for (const patch of [{schemaVersion: 2}, {status: 'failed'}, {edgeCount: 1}, {sourceEntity: false}]) {
  const material = {...current, brainSync: {...current.brainSync, ...patch}};
  assert.equal(hasCurrentBrainGraphSync(material), false);
  assert.equal(learningSummary([material]).label, '1 need attention');
}
assert.equal(learningSummary(null).label, 'Status unavailable');
assert.equal(learningSummary([current]).label, 'Up to date');
assert.equal(learningSummary([{status:'failed'}]).label, '1 need attention');
assert.deepEqual(workDestination('tasks:plans'), { view: 'tasks', tab: 'plans' });
assert.deepEqual(workDestination('tasks:dream'), { view: 'knowledge', tab: 'dream' });
assert.deepEqual(workDestination('schedule'), { view: 'automations', tab: 'schedule' });
assert.deepEqual(workDestination('automations:loops'), { view: 'automations', tab: 'loops' });
assert.equal(workDestination('tasks:missing'), null);
console.log('usability regression checks passed');
