import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, setUpdateSettings } from '../../idctl/src/settings/store.ts';
import { DEFAULT_UPDATE_REPO } from '../../idctl/src/settings/schema.ts';

const temp = mkdtempSync(join(tmpdir(), 'idacc-update-repo-'));
const config = join(temp, 'config.json');

try {
  writeFileSync(config, JSON.stringify({
    version: 1,
    managers: [],
    providers: [],
    update: {
      autoUpgrade: true,
      updateRepo: 'bobofbuilding/id-agent-control-center',
      checkIntervalHours: 1,
    },
  }));

  assert.equal(loadSettings(config).update?.updateRepo, DEFAULT_UPDATE_REPO);
  assert.equal(setUpdateSettings({}, config).update?.updateRepo, DEFAULT_UPDATE_REPO);
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).update.updateRepo, DEFAULT_UPDATE_REPO);

  assert.equal(
    setUpdateSettings({ updateRepo: 'example/custom-releases' }, config).update?.updateRepo,
    'example/custom-releases',
  );

  console.log('update repo migration smoke: ok');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
