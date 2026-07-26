import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brainPlansDir,
  createBrainPlan,
  getBrainPlan,
  listBrainPlans,
  setBrainPlanStatus,
} from '../src/main/brainplans.ts';

const root = mkdtempSync(join(tmpdir(), 'idacc-brain-plans-'));
const config = join(root, 'profile', 'config', 'config.json');
const legacyProjects = join(root, 'legacy-projects');
const legacyPlans = join(legacyProjects, 'brain', 'plans');
const legacyIndex = `# Legacy plans

| # | Plan | Status | Effort | Notes |
|---:|---|---|---|---|
| 01 | [Keep customer data private](01-private.md) | 🔄 PARTIAL | build | Existing plan. |
`;
const legacyBody = '# Keep customer data private\n\nLegacy content must remain untouched.\n';
const originalCwd = process.cwd();
const originalConfig = process.env.IDCTL_CONFIG;
const originalLegacyRoot = process.env.IDACC_LEGACY_PROJECTS_ROOT;

try {
  process.env.IDCTL_CONFIG = config;
  mkdirSync(join(root, 'profile', 'config'), { recursive: true });
  mkdirSync(legacyPlans, { recursive: true });
  writeFileSync(config, JSON.stringify({ version: 1, projectsRoot: legacyProjects }) + '\n');
  writeFileSync(join(legacyPlans, 'README.md'), legacyIndex);
  writeFileSync(join(legacyPlans, '01-private.md'), legacyBody);

  const dir = brainPlansDir();
  assert.equal(dir, join(root, 'profile', 'config', 'brain-plans'));
  assert.equal(readFileSync(join(legacyPlans, 'README.md'), 'utf8'), legacyIndex);
  assert.equal(readFileSync(join(legacyPlans, '01-private.md'), 'utf8'), legacyBody);
  assert.equal(getBrainPlan('01-private.md')?.content, legacyBody);
  assert.equal(getBrainPlan('../config.json'), null);

  const imported = listBrainPlans();
  assert.equal(imported.plans.length, 1);
  assert.equal(imported.plans[0].status, '🔄 PARTIAL');

  const created = createBrainPlan('Finish consumer packaging', 'Ship the whole stack together.');
  assert.equal(created.ok, true);
  assert.equal(created.persisted, true);
  assert.equal(created.committed, false);
  assert.ok(created.file);
  assert.match(getBrainPlan(created.file!)?.content ?? '', /Ship the whole stack together/);

  const pending = listBrainPlans().plans.find((plan) => plan.file === created.file);
  assert.ok(pending);
  const changed = setBrainPlanStatus(created.file!, 'done', undefined, {
    status: pending!.status,
    mtime: pending!.mtime,
  });
  assert.deepEqual(changed, { ok: true, from: '⏳ PENDING', to: '✅ DONE' });
  assert.equal(listBrainPlans().plans.find((plan) => plan.file === created.file)?.status, '✅ DONE');

  const stale = setBrainPlanStatus(created.file!, 'pending', undefined, { status: '⏳ PENDING' });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);

  // Reopening the profile must not re-import or overwrite profile-owned edits.
  writeFileSync(join(dir, '01-private.md'), '# Profile edit\n');
  assert.equal(brainPlansDir(), dir);
  assert.equal(getBrainPlan('01-private.md')?.content, '# Profile edit\n');
  assert.equal(readFileSync(join(legacyPlans, '01-private.md'), 'utf8'), legacyBody);

  // A clean profile must not discover or import plans merely because a
  // checkout-like directory happens to exist below its current working
  // directory. Consumer imports require a saved projectsRoot or an explicit
  // IDACC_LEGACY_PROJECTS_ROOT override.
  const cleanRoot = join(root, 'clean-profile');
  const unrelatedPlans = join(root, 'unrelated-cwd', 'workspace', 'projects', 'brain', 'plans');
  const cleanConfig = join(cleanRoot, 'config', 'config.json');
  mkdirSync(unrelatedPlans, { recursive: true });
  mkdirSync(join(cleanRoot, 'config'), { recursive: true });
  writeFileSync(join(unrelatedPlans, 'README.md'), legacyIndex);
  writeFileSync(join(unrelatedPlans, '01-private.md'), legacyBody);
  writeFileSync(cleanConfig, JSON.stringify({ version: 1 }) + '\n');
  delete process.env.IDACC_LEGACY_PROJECTS_ROOT;
  process.env.IDCTL_CONFIG = cleanConfig;
  process.chdir(join(root, 'unrelated-cwd'));
  assert.equal(listBrainPlans().plans.length, 0);
  assert.equal(
    readFileSync(join(cleanRoot, 'config', 'brain-plans', '.legacy-import.json'), 'utf8').includes('"source": null'),
    true,
  );
  process.stdout.write('brain plans profile smoke: ok\n');
} finally {
  process.chdir(originalCwd);
  if (originalConfig === undefined) delete process.env.IDCTL_CONFIG;
  else process.env.IDCTL_CONFIG = originalConfig;
  if (originalLegacyRoot === undefined) delete process.env.IDACC_LEGACY_PROJECTS_ROOT;
  else process.env.IDACC_LEGACY_PROJECTS_ROOT = originalLegacyRoot;
  rmSync(root, { recursive: true, force: true });
}
