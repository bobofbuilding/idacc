'use strict';

const { pathToFileURL } = require('node:url');

const entry = process.argv[2];
if (
  process.env.IDACC_MANAGED_SERVICE !== '1'
  || typeof entry !== 'string'
  || entry.length < 1
  || entry.includes('\0')
) {
  process.exit(1);
}

const entryArguments = process.argv.slice(3);
process.argv = [process.execPath, entry, ...entryArguments];
const initialSigtermListeners = process.listenerCount('SIGTERM');
let imported = false;
let stopRequested = false;
let stopDispatched = false;

function dispatchManagedStop() {
  if (!stopRequested || stopDispatched) return;
  const deadline = Date.now() + 5_000;
  const attempt = () => {
    if (stopDispatched) return;
    if (
      imported
      && process.listenerCount('SIGTERM') > initialSigtermListeners
    ) {
      stopDispatched = true;
      process.emit('SIGTERM', 'SIGTERM');
      return;
    }
    if (Date.now() >= deadline) {
      stopDispatched = true;
      process.exit(1);
      return;
    }
    setTimeout(attempt, 25);
  };
  attempt();
}

function requestManagedStop() {
  if (stopRequested) return;
  stopRequested = true;
  dispatchManagedStop();
}

process.stdin.once('end', requestManagedStop);
process.stdin.once('error', requestManagedStop);
process.stdin.resume();

import(pathToFileURL(entry).href).then(
  () => {
    imported = true;
    dispatchManagedStop();
  },
  (error) => {
    console.error('[idacc-managed-service] entry failed:', error);
    process.exit(1);
  },
);
