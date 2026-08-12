import assert from 'node:assert/strict';
import { buildPlanGenerationPrompt } from '../src/shared/planGeneration.ts';

const prompt = buildPlanGenerationPrompt('Prepare a future testnet deployment reference plan.');

assert.match(prompt, /planning-only/i);
assert.match(prompt, /do not execute/i);
assert.match(prompt, /do not .*create implementation child tasks/i);
assert.match(prompt, /do not .*deploy/i);
assert.match(prompt, /do not .*broadcast/i);
assert.match(prompt, /do not .*test live infrastructure/i);
assert.match(prompt, /--advisory-query/);
assert.match(prompt, /--no-delegation-reason/);
assert.match(prompt, /Never create an artificial completed child task/i);
assert.match(prompt, /Request: Prepare a future testnet deployment reference plan\./);

console.log('plan generation advisory boundary smoke: ok');
