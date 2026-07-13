#!/usr/bin/env node
import assert from 'node:assert/strict';
import { semverTags, unpublishedFrontierTags } from './lib/release-publication.mjs';

const tags = ['v0.1.20', 'v0.1.636', 'v0.1.637', 'v0.1.637', 'v1.0.0-rc.1', 'notes'];
const releases = [
  { tag_name: 'v0.1.636', draft: false },
  { tag_name: 'v0.1.637', draft: true },
];

assert.deepEqual(semverTags(tags), ['v0.1.20', 'v0.1.636', 'v0.1.637']);
assert.deepEqual(unpublishedFrontierTags(tags, releases), ['v0.1.637']);
assert.deepEqual(unpublishedFrontierTags(tags, releases, { allowTags: ['v0.1.637'] }), []);

console.log('✓ release publication guard smoke test passed');
