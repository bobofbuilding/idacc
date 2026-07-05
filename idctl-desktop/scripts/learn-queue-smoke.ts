import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brain, type BrainEntity } from '../../idctl/src/api/brain.ts';
import { getMaterial, listMaterials, processNextMaterial, saveMaterial } from '../src/main/materialstore.ts';

const LEARN_BRAIN_SYNC_SCHEMA_VERSION = 3;
const tempRoot = mkdtempSync(join(tmpdir(), 'idacc-learn-queue-'));
const previousConfig = process.env.IDCTL_CONFIG;
process.env.IDCTL_CONFIG = join(tempRoot, 'idctl', 'config.json');

const entities: BrainEntity[] = [];
const original = {
  entity: brain.entity,
  facts: brain.facts,
  entityEdgesDetailed: brain.entityEdgesDetailed,
  ingestText: brain.ingestText,
  memory: brain.memory,
  timeline: brain.timeline,
};

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  try {
    brain.entity = async (entity: BrainEntity) => {
      entities.push(entity);
      return true;
    };
    brain.facts = async () => true;
    brain.entityEdgesDetailed = async (edges) => ({ ok: true, count: edges.length, expected: edges.length });
    brain.ingestText = async () => true;
    brain.memory = async () => true;
    brain.timeline = async () => true;

    await main();
  } finally {
    brain.entity = original.entity;
    brain.facts = original.facts;
    brain.entityEdgesDetailed = original.entityEdgesDetailed;
    brain.ingestText = original.ingestText;
    brain.memory = original.memory;
    brain.timeline = original.timeline;
    if (previousConfig === undefined) delete process.env.IDCTL_CONFIG;
    else process.env.IDCTL_CONFIG = previousConfig;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function hasCurrentBrainGraphSync(material: NonNullable<ReturnType<typeof getMaterial>>): boolean {
  const sync = material.brainSync;
  if (!sync) return false;
  if (sync.schemaVersion !== LEARN_BRAIN_SYNC_SCHEMA_VERSION || sync.exactEntity !== true) return false;
  if (!sync.entity || !sync.sourceEntity || !sync.facts || !sync.edges) return false;
  const expected = Math.max(0, Number(sync.expectedEdgeCount ?? 0) || 0);
  const actual = Math.max(0, Number(sync.edgeCount ?? 0) || 0);
  return expected === 0 || actual >= expected;
}

function isLearnMaterialComplete(material: NonNullable<ReturnType<typeof getMaterial>>): boolean {
  return material.status === 'ready' && hasCurrentBrainGraphSync(material);
}

async function main(): Promise<void> {
  const sourceDir = join(tempRoot, 'source');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'README.md'), [
    '# Learn Queue Smoke',
    '',
    'This material documents a small operational workflow for managed agents.',
    'It should be extracted, summarized, compared against active goals, synced to Brain, and leave the active queue.',
    '',
    'The workflow describes an intake process where source material is copied into an application-owned area, summarized with bounded text, classified by topic, and compared with current goals. The result should remain review-gated, but normal trustworthy material should complete the processing pass without staying in the queued lane. Follow-up recommendations should be drafts until the operator explicitly accepts them. Completed material should remain available for review and Brain graph inspection while no longer being eligible for the automatic queue runner.',
    '',
    'A healthy Learn queue processor handles one item at a time, recovers stale processing records, and avoids reprocessing material that already reached the recommendation stage with a current Brain sync. It should also preserve source excerpts as untrusted data, keep routing decisions tied to known teams, and avoid creating live tasks directly from Learn rows. This fixture intentionally contains enough plain operational text to avoid the low-text review blocker while still exercising summary, classification, comparison, recommendation, and Brain sync stages.',
  ].join('\n'));

  saveMaterial({
    id: 'queuesmoke',
    title: 'Queue smoke material',
    kind: 'folder',
    source: sourceDir,
    priority: 'normal',
  });

  assert.equal(listMaterials().filter((material) => material.status === 'queued').length, 1);

  const processed = await processNextMaterial({ knownTeams: ['default'], defaultTeam: 'default' });
  assert.equal(processed?.id, 'queuesmoke');

  const material = getMaterial('queuesmoke');
  assert.ok(material, 'processed material should still be readable');
  assert.equal(material.status, 'ready');
  assert.equal(material.stage, 'recommendations');
  assert.equal(material.brainSync?.status, 'ok');
  assert.equal(material.brainSync?.schemaVersion, LEARN_BRAIN_SYNC_SCHEMA_VERSION);
  assert.equal(hasCurrentBrainGraphSync(material), true);
  assert.equal(isLearnMaterialComplete(material), true);
  assert.equal(listMaterials().filter((row) => row.status === 'queued').length, 0);
  assert.equal(listMaterials().filter((row) => row.id === 'queuesmoke' && isLearnMaterialComplete(row)).length, 1);

  const next = await processNextMaterial({ knownTeams: ['default'], defaultTeam: 'default' });
  assert.equal(next, null, 'completed material should not be reprocessed as queued work');

  assert.ok(entities.some((entity) => entity.id === 'learn:queuesmoke'), 'Brain sync should write the Learn material entity');
}
