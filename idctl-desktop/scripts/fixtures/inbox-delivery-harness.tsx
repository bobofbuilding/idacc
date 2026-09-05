import { createRoot } from 'react-dom/client';
import { Inbox } from '../../src/renderer/views/Inbox.tsx';
import { setTransport, type FleetStore } from '../../src/renderer/store.ts';
const harness = { calls: [] as string[], fail: true, reviewFail: false, removed: false };
(window as unknown as { inboxHarness: typeof harness }).inboxHarness = harness;
const question = { id: 'delivery-check', question: 'Choose the next step', options: ['Continue'], agent: 'lead', team: 'preview', taskRef: 'task:1', createdAt: Date.now() };
setTransport(async (method) => {
  harness.calls.push(method);
  if (method === 'questions:list') return { ok: true, result: harness.removed ? [] : [question] };
  if (method === 'tasks:deps') return { ok: true, result: {} };
  if (method === 'dispatch' && harness.fail) return { ok: false, error: 'Delivery failed; retry your reply.' };
  if (method === 'tasks:setReview' && harness.reviewFail) return { ok: false, error: 'Review update failed.' };
  if (method === 'questions:remove') harness.removed = true;
  return { ok: true, result: 'acknowledged' };
});
const store = { inbox: [], lastUpdated: 1, refresh() {} } as unknown as FleetStore;
createRoot(document.getElementById('root')!).render(<Inbox store={store} />);
