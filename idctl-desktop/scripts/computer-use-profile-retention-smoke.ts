import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'idacc-computer-use-retention-'));
const previousRoot = process.env.IDACC_DATA_DIR;
process.env.IDACC_DATA_DIR = scratch;

async function main(): Promise<void> {
try {
  const {
    audit,
    pruneComputerUseAudit,
    recentAudit,
    resetComputerUseAuditProfileState,
  } = await import('../src/main/computeruse/audit.ts');
  const dir = join(scratch, 'computeruse', 'audit');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let index = 0; index < 91; index += 1) {
    const name = `${20_000_000 + index}.jsonl`;
    const path = join(dir, name);
    writeFileSync(path, '{}\n', { mode: 0o644 });
    utimesSync(path, new Date(now), new Date(now));
  }
  const old = join(dir, '19990101.jsonl');
  writeFileSync(old, '{}\n');
  utimesSync(old, new Date(0), new Date(0));

  assert.equal(pruneComputerUseAudit(now), 2);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length, 90);

  audit({
    ts: now,
    agent: 'default:coder',
    action: 'left_click',
    detail: '10,10',
    decision: 'executed',
  });
  assert.equal(recentAudit().length, 1);
  resetComputerUseAuditProfileState();
  assert.equal(recentAudit().length, 0, 'profile retry must clear the prior audit ring');
  const today = new Date(now);
  const stamp = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, '0')}${String(today.getUTCDate()).padStart(2, '0')}`;
  const active = join(dir, `${stamp}.jsonl`);
  if (process.platform !== 'win32') {
    // Windows privacy is enforced by the profile root ACL; POSIX mode bits
    // are not a meaningful ownership boundary there.
    assert.equal(statSync(active).mode & 0o777, 0o600);
    assert.equal(statSync(join(scratch, 'computeruse')).mode & 0o777, 0o700);
  }
  const brokerSource = readFileSync(
    join(process.cwd(), 'src/main/computeruse/broker.ts'),
    'utf8',
  );
  assert.match(
    brokerSource,
    /function loadAgentTokens\(\): void \{\s*[\s\S]*?agentTokens\.clear\(\);/,
    'loading a profile token store must replace rather than merge the bearer map',
  );
  const stopSource = brokerSource.slice(
    brokerSource.indexOf('export function stopBroker(): Promise<void>'),
  );
  assert.match(stopSource, /agentTokens\.clear\(\)/);
  assert.match(stopSource, /resetComputerUseAuditProfileState\(\)/);
} finally {
  if (previousRoot === undefined) delete process.env.IDACC_DATA_DIR;
  else process.env.IDACC_DATA_DIR = previousRoot;
  try { chmodSync(scratch, 0o700); } catch { /* best effort */ }
  rmSync(scratch, { recursive: true, force: true });
}

console.log('computer use profile retention smoke: ok');
}

void main();
