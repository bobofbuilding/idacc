import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const chat = await readFile(new URL('../src/renderer/views/Chat.tsx', import.meta.url), 'utf8');

assert.ok(
  /function terminalQueryText\(q: QueryPoll[\s\S]*q\.error \|\| q\.text/.test(chat),
  'terminal query messages should prefer manager error/text details over a bare status',
);
assert.ok(
  chat.includes('text: `${terminalQueryText(q)} Checking for a final reply…`'),
  'interim terminal confirmation message should preserve the actionable failure detail',
);
assert.ok(
  chat.includes('text: terminalQueryText(confirmed)'),
  'confirmed terminal failures should use the same detail-preserving formatter',
);
assert.equal(
  chat.includes("call<string>('chat:genReason'"),
  false,
  'behind-the-scenes summaries must come from exact activity traces, not a model paraphrase that can invent actions',
);
assert.ok(
  chat.includes('Work-plan integrity rule:'),
  'agent prompts must forbid unsupported Work-plan mutation claims',
);
assert.ok(
  chat.includes("call<PlanConsolidationResult>('brain:consolidatePlans'"),
  'explicit chat requests to merge numbered plans must use the guarded IDACC core action',
);

console.log('chat terminal failure guard ok');
