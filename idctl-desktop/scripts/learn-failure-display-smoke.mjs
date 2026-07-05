import assert from 'node:assert/strict';
import { latestLearnFailureNote } from '../src/shared/learnMaterialDisplay.ts';

assert.equal(
  latestLearnFailureNote({
    status: 'failed',
    processingTag: 'older fallback',
    progress: [
      { status: 'failed', note: ' first failure ' },
      { status: 'processing', note: 'working' },
      { status: 'failed', note: ' snapshot fetch failed:   HTTP 404\n' },
    ],
  }),
  'snapshot fetch failed: HTTP 404',
);

assert.equal(
  latestLearnFailureNote({
    status: 'failed',
    processingTag: ' snapshot fetch failed: HTTP 404 ',
    progress: [{ status: 'processing', note: 'working' }],
  }),
  'snapshot fetch failed: HTTP 404',
);

assert.equal(
  latestLearnFailureNote({
    status: 'ready',
    processingTag: 'not a failure',
    progress: [{ status: 'failed', note: '' }],
  }),
  '',
);

console.log('learn failure display smoke ok');
