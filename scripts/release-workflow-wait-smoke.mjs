#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, 'scripts', 'lib', 'release-command.sh');
const commit = 'a'.repeat(40);
const fixture = mkdtempSync(join(tmpdir(), 'idacc-release-workflow-wait-'));

function run(mode) {
  return spawnSync('bash', [join(fixture, 'driver.sh'), mode], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fixture}:${dirname(process.execPath)}:${process.env.PATH || ''}`,
      IDACC_RELEASE_HELPER: helper,
      IDACC_RELEASE_TEST_COMMIT: commit,
      IDACC_RELEASE_TEST_COUNTER: join(fixture, `${mode}.counter`),
      IDACC_RELEASE_DISCOVERY_ATTEMPTS: '1',
      IDACC_RELEASE_DISCOVERY_SECONDS: '0',
      IDACC_RELEASE_RUN_POLL_ATTEMPTS: '3',
      IDACC_RELEASE_RUN_POLL_SECONDS: '0',
      MOCK_RELEASE_SCENARIO: mode,
    },
    encoding: 'utf8',
  });
}

try {
  writeFileSync(
    join(fixture, 'gh'),
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const endpoint = args[1] || '';
const scenario = process.env.MOCK_RELEASE_SCENARIO || '';
const commit = process.env.IDACC_RELEASE_TEST_COMMIT;
const counterPath = process.env.IDACC_RELEASE_TEST_COUNTER;
const title = (publish, request) =>
  \`Production release v1.2.3 publish=\${publish} request=\${request}\`;
const record = (overrides = {}) => ({
  id: 101,
  event: 'workflow_dispatch',
  head_sha: commit,
  head_branch: 'v1.2.3',
  display_title: title('true', 'request-123'),
  status: 'queued',
  conclusion: null,
  html_url: 'https://github.example/runs/101',
  ...overrides,
});

if (args[0] !== 'api') process.exit(2);
if (endpoint.includes('/actions/workflows/release.yml/runs?')) {
  let workflowRuns;
  if (scenario === 'duplicate') {
    workflowRuns = [
      record({ id: 101, display_title: title('true', 'request-123') }),
      record({ id: 102, display_title: title('true', 'request-456') }),
    ];
  } else {
    workflowRuns = [
      record(),
      record({ id: 102, head_sha: 'b'.repeat(40) }),
      record({ id: 103, display_title: title('true', 'another-request') }),
      record({ id: 104, display_title: title('false', 'request-123') }),
      record({ id: 105, event: 'push' }),
    ];
  }
  process.stdout.write(JSON.stringify({ workflow_runs: workflowRuns }));
  process.exit(0);
}
if (endpoint.endsWith('/actions/runs/101')) {
  let status = 'completed';
  let conclusion = 'success';
  let headSha = commit;
  if (scenario === 'transition') {
    const previous = existsSync(counterPath)
      ? Number(readFileSync(counterPath, 'utf8'))
      : 0;
    writeFileSync(counterPath, String(previous + 1));
    if (previous === 0) {
      status = 'in_progress';
      conclusion = 'none';
    }
  } else if (scenario === 'failure') {
    conclusion = 'failure';
  } else if (scenario === 'wrong-head') {
    headSha = 'b'.repeat(40);
  }
  process.stdout.write([
    '101',
    status,
    conclusion,
    headSha,
    'v1.2.3',
    'workflow_dispatch',
    title('true', 'request-123'),
    'https://github.example/runs/101',
  ].join('\\t'));
  process.exit(0);
}
process.exit(3);
`,
  );
  chmodSync(join(fixture, 'gh'), 0o755);
  writeFileSync(
    join(fixture, 'driver.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
source "$IDACC_RELEASE_HELPER"

case "$1" in
  transition)
    RECORD="$(release_wait_for_dispatched_workflow_record \
      bobofbuilding/idacc v1.2.3 "$IDACC_RELEASE_TEST_COMMIT" true request-123)"
    test "$RECORD" = $'101\\thttps://github.example/runs/101'
    release_wait_for_workflow_run \
      bobofbuilding/idacc 101 v1.2.3 "$IDACC_RELEASE_TEST_COMMIT" true request-123
    ;;
  duplicate)
    release_active_workflow_record \
      bobofbuilding/idacc v1.2.3 "$IDACC_RELEASE_TEST_COMMIT" true
    ;;
  failure|wrong-head)
    release_wait_for_workflow_run \
      bobofbuilding/idacc 101 v1.2.3 "$IDACC_RELEASE_TEST_COMMIT" true request-123
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(join(fixture, 'driver.sh'), 0o755);

  const transition = run('transition');
  assert.equal(transition.status, 0, transition.stderr);
  assert.match(transition.stdout, /completed successfully/);
  assert.equal(readFileSync(join(fixture, 'transition.counter'), 'utf8'), '2');

  const duplicate = run('duplicate');
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /multiple matching active Production release runs/);

  const failure = run('failure');
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /completed with failure/);

  const wrongHead = run('wrong-head');
  assert.notEqual(wrongHead.status, 0);
  assert.match(wrongHead.stderr, /head SHA is/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log('release workflow exact-run wait smoke: ok');
