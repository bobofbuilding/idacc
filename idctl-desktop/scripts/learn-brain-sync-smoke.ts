import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brain, type BrainEntity } from '../../idctl/src/api/brain.ts';
import { getMaterial, saveMaterial, syncUnsyncedMaterialsToBrain } from '../src/main/materialstore.ts';
import { syncDomainsForMethod } from '../src/shared/syncDomains.ts';

const tempRoot = mkdtempSync(join(tmpdir(), 'idacc-learn-sync-'));
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

async function main(): Promise<void> {
  saveMaterial({
    id: 'syncsmoke',
    title: 'Sync smoke material',
    kind: 'site',
    source: 'https://example.test/sync-smoke',
    priority: 'normal',
    status: 'ready',
    stage: 'recommendations',
    summary: 'Summary ready for Brain.',
    comparison: 'Comparison ready for Brain.',
    classification: {
      topics: ['sync'],
      routedTeams: ['engineering-team'],
      confidence: 'high',
      reason: 'smoke test',
    },
    activeGoalMatches: [{
      id: 'goal-sync',
      title: 'Sync goal',
      team: 'engineering-team',
      priority: 'general',
      score: 10,
      reason: 'smoke test',
    }],
  });

  const result = await syncUnsyncedMaterialsToBrain({ limit: 1, retryMs: 0 });
  const material = getMaterial('syncsmoke');
  const learnEntities = entities.filter((entity) => entity.id === 'learn:syncsmoke');
  const mirroredEntity = [...learnEntities].reverse().find((entity) => entity.data?.brainSync);

  assert.deepEqual(syncDomainsForMethod('materials:brainSync').sort(), ['brain', 'materials']);
  assert.deepEqual(syncDomainsForMethod('materials:syncBrain').sort(), ['brain', 'materials']);
  assert.equal(result.attempted, 1);
  assert.equal(result.synced, 1);
  assert.equal(material?.brainSync?.status, 'ok');
  assert.ok(mirroredEntity, 'backfill should mirror updated Learn material state to the Brain entity cache');
  assert.equal(mirroredEntity?.data?.packetReady, true);
  assert.deepEqual(mirroredEntity?.data?.brainSync, {
    status: 'ok',
    sourceId: 'learn:syncsmoke',
    at: material?.brainSync?.at,
    schemaVersion: 3,
    exactEntity: true,
    entity: true,
    sourceEntity: true,
    facts: true,
    edges: true,
    edgeCount: 3,
    expectedEdgeCount: 3,
    text: true,
    memory: true,
    timeline: true,
  });
}
