import assert from 'node:assert/strict';
import { displayAppVersion } from '../src/shared/versionDisplay.ts';

assert.equal(displayAppVersion('0.1.696-review.62'), '0.1.696');
assert.equal(displayAppVersion(' 0.1.697-review.63 '), '0.1.697');
assert.equal(displayAppVersion('0.1.698-review.64+build.1'), '0.1.698');
assert.equal(displayAppVersion('0.1.698'), '0.1.698');
assert.equal(displayAppVersion('0.1.698-beta.1'), '0.1.698-beta.1');

console.log('version display smoke passed');
