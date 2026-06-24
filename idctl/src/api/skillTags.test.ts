import assert from 'node:assert/strict';
import { heuristicSkillTags, sanitizeSkillTags, SKILL_CATEGORIES } from './client.ts';

function testHeuristicMatches() {
  assert.ok(heuristicSkillTags('xmtp', 'Send and receive encrypted messages to external agents').includes('messaging'));
  assert.ok(heuristicSkillTags('catalog', 'Update your REST-API catalog to describe your role').includes('catalog'));
  assert.ok(heuristicSkillTags('wallet', 'OWS wallet — sign transactions').includes('wallet'));
  // Every heuristic tag is from the controlled vocabulary.
  const vocab = new Set<string>(SKILL_CATEGORIES);
  for (const t of heuristicSkillTags('inter-agent', 'Communicate with other agents in your team')) {
    assert.ok(vocab.has(t), `heuristic tag "${t}" must be in SKILL_CATEGORIES`);
  }
}

function testHeuristicFallbackAndCap() {
  // No keyword hits → 'general'.
  assert.deepEqual(heuristicSkillTags('mystery-thing', ''), ['general']);
  assert.deepEqual(heuristicSkillTags('zzz'), ['general']);
  // Caps at `max` even when many rules match.
  const many = heuristicSkillTags('multi', 'research and code to extract data, test security');
  assert.equal(many.length, 4);
  assert.ok(many.includes('research') && many.includes('coding'));
}

function testSanitizeBasics() {
  const out = sanitizeSkillTags(
    { a: ['Research', 'research', 'CODING'], b: ['x-y'], hallucinated: ['z'] },
    ['a', 'b'],
  );
  assert.deepEqual(out.a, ['research', 'coding'], 'slugged + deduped');
  assert.deepEqual(out.b, ['x-y']);
  assert.ok(!('hallucinated' in out), 'unknown skill names dropped');
}

function testSanitizeGarbageAndCaps() {
  assert.deepEqual(sanitizeSkillTags({ a: 'not-an-array' as unknown as unknown[] }, ['a']), {});
  assert.deepEqual(sanitizeSkillTags({}, ['a']), {});
  assert.deepEqual(sanitizeSkillTags('nope', ['a']), {});
  assert.deepEqual(sanitizeSkillTags({ a: [] }, ['a']), {}, 'empty tag list omits the skill');
  const capped = sanitizeSkillTags({ a: ['t1', 't2', 't3', 't4', 't5'] }, ['a']);
  assert.equal(capped.a.length, 4, 'caps tags per skill');
}

testHeuristicMatches();
testHeuristicFallbackAndCap();
testSanitizeBasics();
testSanitizeGarbageAndCaps();
console.log('skill categorization tests passed');
