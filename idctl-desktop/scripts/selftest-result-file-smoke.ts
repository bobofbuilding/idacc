import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStackSelftestResultFile } from '../src/main/selftestResult.ts';

const scratch = mkdtempSync(join(tmpdir(), 'idacc-selftest-result-'));

try {
  const resultPath = join(scratch, 'stack-result.json');
  const expected = {
    managed: true,
    ready: true,
    authPassed: true,
    services: [{ name: 'manager', healthy: true }, { name: 'brain', healthy: true }],
  };
  assert.equal(writeStackSelftestResultFile(resultPath, scratch, expected), resultPath);
  assert.deepEqual(JSON.parse(readFileSync(resultPath, 'utf8')), expected);
  assert.equal(lstatSync(resultPath).isFile(), true);
  assert.equal(lstatSync(resultPath).isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(resultPath).mode & 0o777, 0o600);
  }

  assert.throws(
    () => writeStackSelftestResultFile(resultPath, scratch, expected),
    /already exists/,
    'a result must never replace existing evidence',
  );
  assert.throws(
    () => writeStackSelftestResultFile('relative-result.json', scratch, expected),
    /absolute file path/,
  );
  assert.throws(
    () => writeStackSelftestResultFile(join(scratch, 'nested', 'result.json'), scratch, expected),
    /directly inside/,
  );

  if (process.platform !== 'win32') {
    const symlinkPath = join(scratch, 'symlink-result.json');
    symlinkSync(resultPath, symlinkPath);
    assert.throws(
      () => writeStackSelftestResultFile(symlinkPath, scratch, expected),
      /already exists/,
      'a caller-supplied symlink must never be followed',
    );

    const permissiveRoot = mkdtempSync(join(tmpdir(), 'idacc-selftest-public-'));
    try {
      chmodSync(permissiveRoot, 0o777);
      assert.throws(
        () => writeStackSelftestResultFile(join(permissiveRoot, 'result.json'), permissiveRoot, expected),
        /must not be accessible to other users/,
      );
    } finally {
      rmSync(permissiveRoot, { recursive: true, force: true });
    }
  }

  assert.throws(
    () => writeStackSelftestResultFile(
      join(scratch, 'oversized.json'),
      scratch,
      { value: 'x'.repeat(1024 * 1024) },
    ),
    /exceeds the 1 MiB safety limit/,
  );
  assert.throws(
    () => writeStackSelftestResultFile(join(scratch, 'undefined.json'), scratch, undefined),
    /must be JSON-serializable/,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('stack self-test result file smoke: ok\n');
