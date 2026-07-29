import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
  const unsafeLegacyDirectory = join(legacyPlans, '00-unsafe-directory.md');
  const unsafeLegacyLink = join(legacyPlans, '00-unsafe-link.md');
  mkdirSync(unsafeLegacyDirectory);
  if (process.platform !== 'win32') {
    const outsideLegacyPlan = join(root, 'outside-legacy-plan.md');
    writeFileSync(outsideLegacyPlan, '# Outside legacy plan\n\nMust not be followed.\n');
    symlinkSync(outsideLegacyPlan, unsafeLegacyLink);
  }

  const expectedPlansDir = join(root, 'profile', 'config', 'brain-plans');
  assert.equal(
    existsSync(join(expectedPlansDir, '.legacy-import.json')),
    false,
    'the resilience case must begin before the one-time import marker exists',
  );
  const dir = brainPlansDir();
  assert.equal(dir, expectedPlansDir);
  assert.equal(readFileSync(join(legacyPlans, 'README.md'), 'utf8'), legacyIndex);
  assert.equal(readFileSync(join(legacyPlans, '01-private.md'), 'utf8'), legacyBody);
  assert.equal(getBrainPlan('01-private.md')?.content, legacyBody);
  assert.equal(getBrainPlan('../config.json'), null);
  assert.equal(existsSync(join(dir, '00-unsafe-directory.md')), false);
  assert.equal(existsSync(join(dir, '00-unsafe-link.md')), false);

  const importMarkerPath = join(dir, '.legacy-import.json');
  const importMarkerBeforeRetry = readFileSync(importMarkerPath, 'utf8');
  const importReport = JSON.parse(importMarkerBeforeRetry) as {
    schemaVersion: number;
    source: string | null;
    imported: number;
    importedFiles: string[];
    skipped: Array<{ file: string; reason: string }>;
    sourceError: string | null;
  };
  assert.equal(importReport.schemaVersion, 2);
  assert.equal(importReport.source, legacyPlans);
  assert.equal(importReport.imported, 2);
  assert.deepEqual(importReport.importedFiles, ['01-private.md', 'README.md']);
  assert.deepEqual(
    importReport.skipped,
    [
      { file: '00-unsafe-directory.md', reason: 'unsafe-entry' },
      ...(process.platform === 'win32'
        ? []
        : [{ file: '00-unsafe-link.md', reason: 'unsafe-entry' }]),
    ],
    'unsafe legacy Markdown entries must be recorded deterministically without being followed',
  );
  assert.equal(importReport.sourceError, null);

  // Completing the marker makes the import genuinely one-time. Even if a
  // skipped source is later replaced by a valid regular Markdown file, routine
  // Plans operations retain the report and never retry or mutate that source.
  rmSync(unsafeLegacyDirectory, { recursive: true, force: true });
  writeFileSync(unsafeLegacyDirectory, '# Replaced legacy plan\n\nDo not retry.\n');
  if (process.platform !== 'win32') {
    rmSync(unsafeLegacyLink, { force: true });
    writeFileSync(unsafeLegacyLink, '# Replaced linked plan\n\nDo not retry.\n');
  }
  assert.equal(brainPlansDir(), dir);
  assert.equal(readFileSync(importMarkerPath, 'utf8'), importMarkerBeforeRetry);
  assert.equal(existsSync(join(dir, '00-unsafe-directory.md')), false);
  assert.equal(existsSync(join(dir, '00-unsafe-link.md')), false);
  assert.match(readFileSync(unsafeLegacyDirectory, 'utf8'), /Do not retry/);

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

  const special = createBrainPlan(
    'Review [v2]\nlaunch | privacy',
    'A bracketed, multiline title must remain an operable plan.',
  );
  assert.equal(special.ok, true);
  assert.ok(special.file);
  const specialListed = listBrainPlans().plans.find((plan) => plan.file === special.file);
  assert.equal(specialListed?.title, 'Review [v2] launch | privacy');
  assert.equal(specialListed?.status, '⏳ PENDING');
  assert.match(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    /\[Review &#91;v2&#93; launch &#124; privacy\]\([^)]+\.md\)/,
    'table-breaking title characters must be encoded without changing the UI title',
  );

  // Preserve legacy rows that used literal nested brackets before title
  // encoding was introduced.
  writeFileSync(join(dir, '80-legacy-brackets.md'), '# Review [legacy] plan\n\nRetained legacy plan.\n');
  writeFileSync(
    join(dir, 'README.md'),
    `${readFileSync(join(dir, 'README.md'), 'utf8').trimEnd()}\n`
      + '| 80 | [Review [legacy] plan](80-legacy-brackets.md) | 🔄 PARTIAL | retained | Legacy row. |\n',
  );
  const legacyBracket = listBrainPlans().plans.find((plan) => plan.file === '80-legacy-brackets.md');
  assert.equal(legacyBracket?.title, 'Review [legacy] plan');
  assert.equal(legacyBracket?.status, '🔄 PARTIAL');

  // A status-only mutation must not normalize or reconstruct a retained row.
  // Long legacy titles and literal pipes in the title/notes are profile data,
  // not formatting that IDACC may discard.
  const longLegacyTitle = `${'Long retained title '.repeat(8)}| literal pipe`;
  const losslessFile = '81-lossless-legacy.md';
  writeFileSync(join(dir, losslessFile), `# ${longLegacyTitle}\n\nRetained metadata.\n`);
  const losslessRow = `| 81 | [${longLegacyTitle}](${losslessFile}) | ⏳ PENDING | retained | Preserve A | Preserve B |`;
  writeFileSync(
    join(dir, 'README.md'),
    `${readFileSync(join(dir, 'README.md'), 'utf8').trimEnd()}\n${losslessRow}\n`,
  );
  const losslessListed = listBrainPlans().plans.find((plan) => plan.file === losslessFile);
  assert.equal(losslessListed?.title, longLegacyTitle);
  assert.equal(losslessListed?.notes, 'Preserve A | Preserve B');
  const losslessStatus = setBrainPlanStatus(losslessFile, 'done', undefined, {
    status: losslessListed?.status,
    mtime: losslessListed?.mtime,
  });
  assert.deepEqual(losslessStatus, { ok: true, from: '⏳ PENDING', to: '✅ DONE' });
  const losslessUpdatedRow = readFileSync(join(dir, 'README.md'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.includes(`](${losslessFile})`));
  assert.equal(
    losslessUpdatedRow,
    losslessRow.replace('⏳ PENDING', '✅ DONE'),
    'status writes must preserve every non-status byte in an existing profile row',
  );
  assert.equal(
    listBrainPlans().plans.find((plan) => plan.file === losslessFile)?.title,
    longLegacyTitle,
    'a status write must not truncate a retained legacy title',
  );

  // A status-only update must also preserve Windows CRLF terminators and every
  // other byte in an imported user-owned index.
  const crlfFile = '82-crlf-retained.md';
  writeFileSync(join(dir, crlfFile), '# CRLF retained plan\r\n\r\nRetained metadata.\r\n');
  const crlfRow = `| 82 | [CRLF retained plan](${crlfFile}) | ⏳ PENDING | retained | Preserve CRLF. |`;
  const crlfIndex = `${readFileSync(join(dir, 'README.md'), 'utf8')
    .trimEnd()
    .replace(/\r?\n/g, '\r\n')}\r\n${crlfRow}\r\n`;
  writeFileSync(join(dir, 'README.md'), crlfIndex);
  const crlfListed = listBrainPlans().plans.find((plan) => plan.file === crlfFile);
  const crlfStatus = setBrainPlanStatus(crlfFile, 'done', undefined, {
    status: crlfListed?.status,
    mtime: crlfListed?.mtime,
  });
  assert.deepEqual(crlfStatus, { ok: true, from: '⏳ PENDING', to: '✅ DONE' });
  assert.equal(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    crlfIndex.replace(crlfRow, crlfRow.replace('⏳ PENDING', '✅ DONE')),
    'status writes must preserve CRLF terminators and every non-status index byte',
  );

  // A partial index or an interrupted create must not hide a retained regular
  // Markdown plan. The filesystem merge is deterministic and status changes
  // repair the missing row using the same optimistic mtime expectation.
  const recoveredFile = '77-retained-but-unindexed.md';
  writeFileSync(
    join(dir, recoveredFile),
    '# Plan 77 - Retained [orphan]\n\nThe prior process stopped before updating README.\n',
  );
  mkdirSync(join(dir, '78-directory.md'));
  if (process.platform !== 'win32') {
    symlinkSync('01-private.md', join(dir, '79-symlink.md'));
  }
  const merged = listBrainPlans().plans;
  assert.deepEqual(
    merged.map((plan) => plan.file),
    [...merged.map((plan) => plan.file)].sort(),
    'profile plan ordering must be independent of index completeness and host locale',
  );
  const recovered = merged.find((plan) => plan.file === recoveredFile);
  assert.equal(recovered?.title, 'Retained [orphan]');
  assert.equal(recovered?.status, undefined);
  assert.equal(merged.some((plan) => plan.file === '78-directory.md'), false);
  assert.equal(merged.some((plan) => plan.file === '79-symlink.md'), false);
  assert.equal(getBrainPlan('78-directory.md'), null);
  assert.equal(getBrainPlan('79-symlink.md'), null);
  assert.equal(setBrainPlanStatus('78-directory.md', 'done').ok, false);
  assert.equal(setBrainPlanStatus('79-symlink.md', 'done').ok, false);
  assert.equal(setBrainPlanStatus('README.md', 'done').ok, false);
  utimesSync(join(dir, recoveredFile), new Date(), new Date(Date.now() + 2_000));
  const staleRecoveredStatus = setBrainPlanStatus(recoveredFile, 'done', undefined, {
    status: recovered?.status,
    mtime: recovered?.mtime,
  });
  assert.equal(staleRecoveredStatus.ok, false);
  assert.equal(staleRecoveredStatus.stale, true);
  assert.doesNotMatch(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    /\]\(77-retained-but-unindexed\.md\)/,
    'a stale recovery attempt must not create an index row',
  );
  const refreshedRecovered = listBrainPlans().plans.find((plan) => plan.file === recoveredFile);
  const recoveredStatus = setBrainPlanStatus(recoveredFile, 'done', undefined, {
    status: refreshedRecovered?.status,
    mtime: refreshedRecovered?.mtime,
  });
  assert.deepEqual(recoveredStatus, { ok: true, from: undefined, to: '✅ DONE' });
  assert.equal(listBrainPlans().plans.find((plan) => plan.file === recoveredFile)?.status, '✅ DONE');
  assert.match(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    /\[Retained &#91;orphan&#93;\]\(77-retained-but-unindexed\.md\) \| ✅ DONE \| recovered \|/,
  );

  // Recovered link targets must remain parseable even when a retained filename
  // contains characters that would otherwise break a Markdown table/link.
  const markdownFile = process.platform === 'win32'
    ? '76-retained [v2](final).md'
    : '76-retained|[v2](final).md';
  writeFileSync(
    join(dir, markdownFile),
    '# Plan 76 - Retained | [v2] (final)\n\nRecovered filename coverage.\n',
  );
  const markdownListed = listBrainPlans().plans.find((plan) => plan.file === markdownFile);
  assert.equal(markdownListed?.status, undefined);
  const markdownStatus = setBrainPlanStatus(markdownFile, 'partial', undefined, {
    status: markdownListed?.status,
    mtime: markdownListed?.mtime,
  });
  assert.deepEqual(markdownStatus, { ok: true, from: undefined, to: '🔄 PARTIAL' });
  const markdownRelisted = listBrainPlans().plans.find((plan) => plan.file === markdownFile);
  assert.equal(markdownRelisted?.title, 'Retained | [v2] (final)');
  assert.equal(markdownRelisted?.status, '🔄 PARTIAL');
  const encodedTarget = encodeURIComponent(markdownFile).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  assert.match(
    readFileSync(join(dir, 'README.md'), 'utf8'),
    new RegExp(`\\[Retained &#124; &#91;v2&#93; \\(final\\)\\]\\(${encodedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`),
    'recovery must encode every table field and the complete Markdown link target',
  );

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
