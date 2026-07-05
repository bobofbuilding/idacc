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

console.log('chat terminal failure guard ok');
