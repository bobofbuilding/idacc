#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);

function option(name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '') : fallback;
}

function fail(message) {
  throw new Error(message);
}

function requiredFile(path, label) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) fail(`${label} not found at ${resolved}`);
  return resolved;
}

function q(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Buffer.isBuffer(value)) return { $buffer: value.toString('base64') };
  return value;
}

function rowDigest(row, columns) {
  return digest(JSON.stringify(columns.map((column) => canonicalValue(row[column]))));
}

function encodedId(value) {
  return JSON.stringify({ type: typeof value, value });
}

function decodedId(value) {
  return JSON.parse(value).value;
}

function valuesEqual(left, right, columns) {
  return columns.every((column) => {
    const a = left[column];
    const b = right[column];
    if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
      return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    }
    return Object.is(a, b);
  });
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((column) => String(column.name));
}

function primaryKeyColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all()
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => String(column.name));
}

function commonColumns(source, target, table) {
  const targetSet = new Set(tableColumns(target, table));
  return tableColumns(source, table).filter((column) => targetSet.has(column));
}

function timestampValue(row, candidates) {
  for (const column of candidates) {
    const value = row[column];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NEGATIVE_INFINITY;
}

function prepareInsert(db, table, columns) {
  return db.prepare(
    `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
}

function prepareUpdate(db, table, columns, pkColumns) {
  const mutable = columns.filter((column) => !pkColumns.includes(column));
  return {
    mutable,
    statement: mutable.length ? db.prepare(
      `UPDATE ${q(table)} SET ${mutable.map((column) => `${q(column)} = ?`).join(', ')} WHERE ${pkColumns.map((column) => `${q(column)} IS ?`).join(' AND ')}`,
    ) : null,
  };
}

function prepareLookup(db, table, columns, pkColumns) {
  return db.prepare(
    `SELECT ${columns.map(q).join(', ')} FROM ${q(table)} WHERE ${pkColumns.map((column) => `${q(column)} IS ?`).join(' AND ')}`,
  );
}

function openDatabase(path, readOnly = false) {
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

function transformRow(row, transforms = {}) {
  const result = { ...row };
  for (const [column, transform] of Object.entries(transforms)) {
    if (Object.hasOwn(result, column) && result[column] !== null && result[column] !== undefined) {
      result[column] = transform(result[column]);
    }
  }
  return result;
}

function nextIntegerId(target, table, pk) {
  let next = Number(target.prepare(`SELECT COALESCE(MAX(${q(pk)}), 0) + 1 AS next FROM ${q(table)}`).get().next);
  return () => next++;
}

function uniqueTextId(target, table, pk, original, signature) {
  const stem = `${String(original)}#legacy-${signature.slice(0, 12)}`;
  const lookup = target.prepare(`SELECT 1 FROM ${q(table)} WHERE ${q(pk)} = ?`);
  if (!lookup.get(stem)) return stem;
  let suffix = 2;
  while (lookup.get(`${stem}-${suffix}`)) suffix += 1;
  return `${stem}-${suffix}`;
}

function planRemappedIds(
  source,
  target,
  table,
  pk,
  stats,
  { stableMapping = new Map(), frozen = new Set() } = {},
) {
  const columns = commonColumns(source, target, table);
  const contentColumns = columns.filter((column) => column !== pk);
  const lookup = prepareLookup(target, table, columns, [pk]);
  const select = source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`);
  const targetByContent = new Map();
  for (const row of target.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`).iterate()) {
    targetByContent.set(rowDigest(row, contentColumns), row[pk]);
  }
  const sourceIds = source.prepare(`SELECT ${q(pk)} AS value FROM ${q(table)}`).all().map((row) => row.value);
  const reserved = new Set(sourceIds);
  let maximumSourceId = 0;
  for (const value of sourceIds) {
    if (typeof value === 'number' && value > maximumSourceId) maximumSourceId = value;
  }
  let nextNumber = Math.max(
    Number(target.prepare(`SELECT COALESCE(MAX(${q(pk)}), 0) AS value FROM ${q(table)}`).get().value),
    maximumSourceId,
  ) + 1;
  const mapping = new Map();
  for (const row of select.iterate()) {
    const original = row[pk];
    const stableTarget = stableMapping.get(original);
    if (stableTarget !== undefined && lookup.get(stableTarget)) {
      mapping.set(original, stableTarget);
      frozen.add(encodedId(original));
      continue;
    }
    const current = lookup.get(original);
    if (!current || valuesEqual(row, current, columns)) {
      mapping.set(original, original);
      continue;
    }
    const signature = rowDigest(row, columns);
    const existingEquivalent = targetByContent.get(rowDigest(row, contentColumns));
    if (existingEquivalent !== undefined) {
      mapping.set(original, existingEquivalent);
      continue;
    }
    let replacement;
    if (typeof original === 'number') {
      while (reserved.has(nextNumber)) nextNumber += 1;
      replacement = nextNumber++;
    } else {
      const stem = `${String(original)}#legacy-${signature.slice(0, 12)}`;
      replacement = stem;
      let suffix = 2;
      while (reserved.has(replacement) || target.prepare(`SELECT 1 FROM ${q(table)} WHERE ${q(pk)} = ?`).get(replacement)) {
        replacement = `${stem}-${suffix++}`;
      }
    }
    mapping.set(original, replacement);
    reserved.add(replacement);
    stats[table].collisions += 1;
  }
  return mapping;
}

function expandRemappedIds(
  source,
  target,
  table,
  pk,
  mapping,
  stats,
  transforms = {},
  frozen = new Set(),
) {
  const columns = commonColumns(source, target, table);
  const contentColumns = columns.filter((column) => column !== pk);
  const lookup = prepareLookup(target, table, columns, [pk]);
  const select = source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`);
  const targetByContent = new Map();
  for (const row of target.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`).iterate()) {
    targetByContent.set(rowDigest(row, contentColumns), row[pk]);
  }
  const reserved = new Set(mapping.values());
  let maximumReservedId = 0;
  for (const value of reserved) {
    if (typeof value === 'number' && value > maximumReservedId) maximumReservedId = value;
  }
  let nextNumber = Math.max(
    Number(target.prepare(`SELECT COALESCE(MAX(${q(pk)}), 0) AS value FROM ${q(table)}`).get().value),
    maximumReservedId,
  ) + 1;
  let changed = false;
  for (const raw of select.iterate()) {
    if (frozen.has(encodedId(raw[pk]))) continue;
    const row = transformRow(raw, transforms);
    const currentMappedId = mapping.get(raw[pk]) ?? raw[pk];
    const current = lookup.get(currentMappedId);
    if (current && valuesEqual(row, current, contentColumns)) continue;
    const existingEquivalent = targetByContent.get(rowDigest(row, contentColumns));
    if (existingEquivalent !== undefined) {
      if (currentMappedId !== existingEquivalent) {
        mapping.set(raw[pk], existingEquivalent);
        changed = true;
      }
      continue;
    }
    if (!current) continue;
    const signature = rowDigest(row, columns);
    let replacement;
    if (typeof raw[pk] === 'number') {
      while (reserved.has(nextNumber)) nextNumber += 1;
      replacement = nextNumber++;
    } else {
      const stem = `${String(raw[pk])}#legacy-${signature.slice(0, 12)}`;
      replacement = stem;
      let suffix = 2;
      while (reserved.has(replacement) || target.prepare(`SELECT 1 FROM ${q(table)} WHERE ${q(pk)} = ?`).get(replacement)) {
        replacement = `${stem}-${suffix++}`;
      }
    }
    mapping.set(raw[pk], replacement);
    reserved.add(replacement);
    stats[table].collisions += 1;
    changed = true;
  }
  return changed;
}

function insertRemappedTable(
  source,
  target,
  table,
  pk,
  mapping,
  stats,
  transforms = {},
  frozen = new Set(),
) {
  const columns = commonColumns(source, target, table);
  const lookup = prepareLookup(target, table, columns, [pk]);
  const insert = prepareInsert(target, table, columns);
  const select = source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`);
  for (const raw of select.iterate()) {
    const row = transformRow(raw, transforms);
    row[pk] = mapping.get(raw[pk]);
    const current = lookup.get(row[pk]);
    if (current && valuesEqual(row, current, columns)) {
      stats[table].matched += 1;
      continue;
    }
    if (current && frozen.has(encodedId(raw[pk]))) {
      stats[table].retained += 1;
      continue;
    }
    try {
      insert.run(...columns.map((column) => row[column]));
    } catch (error) {
      throw new Error(
        `${table} insert failed for ${pk}=${JSON.stringify(row[pk])} (legacy ${JSON.stringify(raw[pk])}): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    stats[table].inserted += 1;
  }
}

const NEWER_COLUMNS = [
  'updated_at', 'lifecycle_updated_at', 'completed', 'completed_at', 'resolved_at',
  'refreshed_at', 'observed_at_ms', 'last_decayed_at', 'created_at', 'timestamp',
];

function mergeKeyedTable(source, target, table, stats, transforms = {}, newerColumns = NEWER_COLUMNS) {
  const columns = commonColumns(source, target, table);
  const pkColumns = primaryKeyColumns(target, table);
  if (!pkColumns.length) fail(`${table} has no primary key`);
  const lookup = prepareLookup(target, table, columns, pkColumns);
  const insert = prepareInsert(target, table, columns);
  const update = prepareUpdate(target, table, columns, pkColumns);
  const select = source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`);
  for (const raw of select.iterate()) {
    const row = transformRow(raw, transforms);
    const key = pkColumns.map((column) => row[column]);
    const current = lookup.get(...key);
    if (!current) {
      insert.run(...columns.map((column) => row[column]));
      stats[table].inserted += 1;
      continue;
    }
    if (valuesEqual(row, current, columns)) {
      stats[table].matched += 1;
      continue;
    }
    if (update.statement && timestampValue(row, newerColumns) > timestampValue(current, newerColumns)) {
      update.statement.run(
        ...update.mutable.map((column) => row[column]),
        ...pkColumns.map((column) => row[column]),
      );
      stats[table].updated += 1;
    } else {
      stats[table].retained += 1;
    }
  }
}

function mergeWithAlternateIdentity(
  source,
  target,
  table,
  stats,
  {
    pk = 'id',
    alternateKeys = [],
    transforms = {},
    newerColumns = NEWER_COLUMNS,
    immutableColumns = [],
    preplannedIdentityMap,
    frozenIdentityKeys = new Set(),
  } = {},
) {
  const columns = commonColumns(source, target, table);
  const select = source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`);
  const byPrimary = prepareLookup(target, table, columns, [pk]);
  const alternateLookups = alternateKeys.map((keys) => ({
    keys,
    statement: prepareLookup(target, table, columns, keys),
  }));
  const insert = prepareInsert(target, table, columns);
  const updateColumns = columns.filter((column) => column !== pk && !immutableColumns.includes(column));
  const update = target.prepare(
    `UPDATE ${q(table)} SET ${updateColumns.map((column) => `${q(column)} = ?`).join(', ')} WHERE ${q(pk)} IS ?`,
  );
  const identityMap = new Map();
  for (const raw of select.iterate()) {
    const row = transformRow(raw, transforms);
    let current = preplannedIdentityMap?.has(raw[pk])
      ? byPrimary.get(preplannedIdentityMap.get(raw[pk]))
      : undefined;
    if (!current) {
      for (const candidate of alternateLookups) {
        if (candidate.keys.some((column) => row[column] === null || row[column] === undefined || row[column] === '')) continue;
        current = candidate.statement.get(...candidate.keys.map((column) => row[column]));
        if (current) break;
      }
    }
    current ??= byPrimary.get(preplannedIdentityMap?.get(raw[pk]) ?? row[pk]);
    if (!current) {
      insert.run(...columns.map((column) => row[column]));
      identityMap.set(raw[pk], row[pk]);
      stats[table].inserted += 1;
      continue;
    }
    identityMap.set(raw[pk], current[pk]);
    const comparisonColumns = columns.filter((column) => column !== pk);
    if (valuesEqual(row, current, comparisonColumns)) {
      stats[table].matched += 1;
      continue;
    }
    if (frozenIdentityKeys.has(encodedId(raw[pk]))) {
      stats[table].retained += 1;
      continue;
    }
    if (timestampValue(row, newerColumns) > timestampValue(current, newerColumns)) {
      update.run(
        ...updateColumns.map((column) => row[column]),
        current[pk],
      );
      stats[table].updated += 1;
    } else {
      stats[table].retained += 1;
    }
  }
  return identityMap;
}

function planAlternateIdentityMap(
  source,
  target,
  table,
  {
    pk = 'id', alternateKeys = [], transforms = {}, stableMapping = new Map(), frozen = new Set(),
  } = {},
) {
  const columns = commonColumns(source, target, table);
  const byPrimary = prepareLookup(target, table, columns, [pk]);
  const alternateLookups = alternateKeys.map((keys) => ({
    keys,
    statement: prepareLookup(target, table, columns, keys),
  }));
  const mapping = new Map();
  for (const raw of source.prepare(`SELECT ${columns.map(q).join(', ')} FROM ${q(table)}`).iterate()) {
    const row = transformRow(raw, transforms);
    const stableTarget = stableMapping.get(raw[pk]);
    let current = stableTarget !== undefined ? byPrimary.get(stableTarget) : undefined;
    if (current) {
      frozen.add(encodedId(raw[pk]));
    } else {
      for (const candidate of alternateLookups) {
        if (candidate.keys.some((column) => row[column] === null || row[column] === undefined || row[column] === '')) continue;
        current = candidate.statement.get(...candidate.keys.map((column) => row[column]));
        if (current) break;
      }
    }
    current ??= byPrimary.get(row[pk]);
    mapping.set(raw[pk], current?.[pk] ?? row[pk]);
  }
  return mapping;
}

function tableStats(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, {
    before: Number(db.prepare(`SELECT COUNT(*) AS count FROM ${q(table)}`).get().count),
    after: 0,
    inserted: 0,
    updated: 0,
    matched: 0,
    retained: 0,
    collisions: 0,
  }]));
}

function finishStats(db, stats) {
  for (const [table, value] of Object.entries(stats)) {
    value.after = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${q(table)}`).get().count);
  }
}

function mapped(mapping, value) {
  return mapping?.get(value) ?? value;
}

function ensureLegacyMappingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idacc_legacy_id_map (
      table_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      PRIMARY KEY (table_name, source_id)
    )
  `);
}

function storedLegacyMappings(db) {
  const result = {};
  for (const row of db.prepare('SELECT table_name, source_id, target_id FROM idacc_legacy_id_map').iterate()) {
    result[row.table_name] ??= new Map();
    result[row.table_name].set(decodedId(row.source_id), decodedId(row.target_id));
  }
  return result;
}

function receiptLegacyMappings(receipt) {
  const result = {};
  for (const [table, entries] of Object.entries(receipt?.collisionMaps ?? {})) {
    result[table] = new Map(entries.map(({ from, to }) => [from, to]));
  }
  return result;
}

function stableMappingsFor(source, table, pk, stored, receipt) {
  const result = new Map();
  const receiptTable = receipt[table] ?? new Map();
  for (const row of source.prepare(`SELECT ${q(pk)} AS value FROM ${q(table)}`).iterate()) {
    result.set(row.value, receiptTable.get(row.value) ?? row.value);
  }
  for (const [from, to] of stored[table] ?? []) result.set(from, to);
  return result;
}

function preferNewestSemanticMapping(source, target, table, pk, mapping, keys, orderBy) {
  const lookup = target.prepare(
    `SELECT ${q(pk)} AS value FROM ${q(table)} WHERE ${keys.map((key) => `${q(key)} IS ?`).join(' AND ')} ORDER BY ${q(orderBy)} DESC, ${q(pk)} DESC LIMIT 1`,
  );
  for (const row of source.prepare(`SELECT ${[pk, ...keys].map(q).join(', ')} FROM ${q(table)}`).iterate()) {
    if (keys.some((key) => row[key] === null || row[key] === undefined || row[key] === '')) continue;
    const current = lookup.get(...keys.map((key) => row[key]));
    if (current) mapping.set(row[pk], current.value);
  }
  return mapping;
}

function persistLegacyMappings(db, maps) {
  const write = db.prepare(`
    INSERT INTO idacc_legacy_id_map (table_name, source_id, target_id)
    VALUES (?, ?, ?)
    ON CONFLICT(table_name, source_id) DO UPDATE SET target_id = excluded.target_id
  `);
  for (const [table, mapping] of Object.entries(maps)) {
    for (const [from, to] of mapping) write.run(table, encodedId(from), encodedId(to));
  }
}

function mergeManager(sourcePath, targetPath) {
  const source = openDatabase(sourcePath, true);
  const target = openDatabase(targetPath);
  const tables = target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => String(row.name));
  const stats = tableStats(target, tables);
  const eventMap = planRemappedIds(source, target, 'event_log', 'seq', stats);
  const newsMap = planRemappedIds(source, target, 'news_items', 'id', stats);
  target.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    const teamMap = mergeWithAlternateIdentity(source, target, 'teams', stats, {
      alternateKeys: [['name']],
    });
    expandRemappedIds(source, target, 'event_log', 'seq', eventMap, stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    expandRemappedIds(source, target, 'news_items', 'id', newsMap, stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    mergeKeyedTable(source, target, 'agents', stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    const taskMap = mergeWithAlternateIdentity(source, target, 'tasks', stats, {
      alternateKeys: [['uuid'], ['team_id', 'name']],
      transforms: { team_id: (value) => mapped(teamMap, value) },
      immutableColumns: ['uuid', 'team_id', 'name'],
    });
    mergeKeyedTable(source, target, 'queries', stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    for (const table of ['schedule_definitions', 'schedule_runs', 'schedule_targets', 'control_state', 'runtime_lane_cooldowns', 'wallets']) {
      mergeKeyedTable(source, target, table, stats);
    }
    mergeKeyedTable(source, target, 'task_event_links', stats, {
      task_id: (value) => mapped(taskMap, value),
    });
    insertRemappedTable(source, target, 'event_log', 'seq', eventMap, stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    insertRemappedTable(source, target, 'news_items', 'id', newsMap, stats, {
      team_id: (value) => mapped(teamMap, value),
    });
    for (const table of ['checkins', 'subscriptions']) {
      mergeKeyedTable(source, target, table, stats, {
        last_event_seq: (value) => mapped(eventMap, value),
        linked_task_id: (value) => mapped(taskMap, value),
        team_id: (value) => mapped(teamMap, value),
      });
    }
    mergeKeyedTable(source, target, 'webhook_delivery_attempts', stats, {
      event_seq: (value) => mapped(eventMap, value),
    });
    mergeKeyedTable(source, target, 'id_agents_migration_markers', stats);
    target.exec('COMMIT');
  } catch (error) {
    target.exec('ROLLBACK');
    throw error;
  } finally {
    finishStats(target, stats);
    source.close();
    target.close();
  }
  return stats;
}

const BRAIN_ID_TABLES = [
  ['timeline', 'id'],
  ['controllers', 'controller_id'],
  ['entities', 'id'],
  ['facts', 'id'],
  ['agent_memories', 'id'],
  ['approvals', 'id'],
  ['communities', 'id'],
  ['community_reports', 'id'],
  ['context_packages', 'id'],
  ['context_volunteers', 'id'],
  ['eval_queries', 'id'],
  ['eval_fixtures', 'id'],
  ['learning_tasks', 'id'],
  ['learning_rollback_records', 'id'],
  ['memory_events', 'id'],
  ['skill_nodes', 'skill_id'],
];

function mergeBrain(sourcePath, targetPath, seedReceipt = null) {
  const source = openDatabase(sourcePath, true);
  const target = openDatabase(targetPath);
  ensureLegacyMappingTable(target);
  const storedMappings = storedLegacyMappings(target);
  const receiptMappings = receiptLegacyMappings(seedReceipt);
  const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  const targetTables = target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => String(row.name));
  const managedTables = targetTables.filter((table) => (
    !table.startsWith('skill_fts') && table !== 'idacc_legacy_id_map'
  ));
  const stats = tableStats(target, managedTables);
  const maps = {};
  const frozenMaps = {};
  for (const [table, pk] of BRAIN_ID_TABLES) {
    frozenMaps[table] = new Set();
    let stableMapping = stableMappingsFor(source, table, pk, storedMappings, receiptMappings);
    if (table === 'communities') {
      stableMapping = preferNewestSemanticMapping(
        source,
        target,
        table,
        pk,
        stableMapping,
        ['title'],
        'updated_at',
      );
    } else if (table === 'community_reports') {
      stableMapping = preferNewestSemanticMapping(
        source,
        target,
        table,
        pk,
        stableMapping,
        ['title', 'prompt_version'],
        'created_at',
      );
    }
    maps[table] = planRemappedIds(source, target, table, pk, stats, {
      stableMapping,
      frozen: frozenMaps[table],
    });
  }
  frozenMaps.text_units = new Set();
  maps.text_units = planAlternateIdentityMap(source, target, 'text_units', {
    alternateKeys: [['source_kind', 'source_id']],
    stableMapping: stableMappingsFor(source, 'text_units', 'id', storedMappings, receiptMappings),
    frozen: frozenMaps.text_units,
  });
  const transforms = {
    controllers: {},
    entities: {},
    text_units: { parent_text_unit_id: (value) => mapped(maps.text_units, value) },
    facts: {
      entity_id: (value) => mapped(maps.entities, value),
      supersedes: (value) => mapped(maps.facts, value),
    },
    agent_memories: {
      supersedes: (value) => mapped(maps.agent_memories, value),
      superseded_by: (value) => mapped(maps.agent_memories, value),
    },
    approvals: {},
    communities: {},
    community_reports: { community_id: (value) => mapped(maps.communities, value) },
    context_packages: { timeline_event_id: (value) => mapped(maps.timeline, value) },
    context_volunteers: {
      timeline_event_id: (value) => mapped(maps.timeline, value),
      context_package_id: (value) => mapped(maps.context_packages, value),
    },
    eval_queries: { context_package_id: (value) => mapped(maps.context_packages, value) },
    eval_fixtures: { eval_query_id: (value) => mapped(maps.eval_queries, value) },
    learning_tasks: { approval_id: (value) => mapped(maps.approvals, value) },
    learning_rollback_records: { approval_id: (value) => mapped(maps.approvals, value) },
    memory_events: {},
    skill_nodes: {
      duplicate_of: (value) => mapped(maps.skill_nodes, value),
      canonical_id: (value) => mapped(maps.skill_nodes, value),
    },
    timeline: {},
  };
  // A row that was byte-identical at the original numeric key may still need
  // a new key when one of its referenced legacy rows was remapped. Iterate to
  // a fixed point so self-referential parent/supersession chains remain intact.
  for (let pass = 0; pass < BRAIN_ID_TABLES.length + 2; pass += 1) {
    let changed = false;
    for (const [table, pk] of BRAIN_ID_TABLES) {
      changed = expandRemappedIds(
        source,
        target,
        table,
        pk,
        maps[table],
        stats,
        transforms[table],
        frozenMaps[table],
      ) || changed;
    }
    if (!changed) break;
    if (pass === BRAIN_ID_TABLES.length + 1) fail('Brain collision mapping did not converge');
  }
  frozenMaps.entity_edges = new Set();
  maps.entity_edges = planAlternateIdentityMap(source, target, 'entity_edges', {
    alternateKeys: [['from_id', 'to_id', 'kind']],
    transforms: {
      from_id: (value) => mapped(maps.entities, value),
      to_id: (value) => mapped(maps.entities, value),
    },
    stableMapping: stableMappingsFor(source, 'entity_edges', 'id', storedMappings, receiptMappings),
    frozen: frozenMaps.entity_edges,
  });
  target.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
  try {
    mergeWithAlternateIdentity(source, target, 'text_units', stats, {
      alternateKeys: [['source_kind', 'source_id']],
      transforms: { parent_text_unit_id: (value) => mapped(maps.text_units, value) },
      immutableColumns: ['source_kind', 'source_id'],
      preplannedIdentityMap: maps.text_units,
      frozenIdentityKeys: frozenMaps.text_units,
    });
    for (const [table, pk] of BRAIN_ID_TABLES) {
      insertRemappedTable(
        source,
        target,
        table,
        pk,
        maps[table],
        stats,
        transforms[table],
        frozenMaps[table],
      );
    }
    mergeWithAlternateIdentity(source, target, 'entity_edges', stats, {
      alternateKeys: [['from_id', 'to_id', 'kind']],
      transforms: {
        from_id: (value) => mapped(maps.entities, value),
        to_id: (value) => mapped(maps.entities, value),
      },
      immutableColumns: ['from_id', 'to_id', 'kind'],
      preplannedIdentityMap: maps.entity_edges,
      frozenIdentityKeys: frozenMaps.entity_edges,
    });
    const alternateTables = [
      ['controller_agent_links', ['controller_id', 'agent_id', 'role'], {
        controller_id: (value) => mapped(maps.controllers, value),
      }],
      ['entity_aliases', ['entity_id', 'normalized'], {
        entity_id: (value) => mapped(maps.entities, value),
      }],
      ['instruction_scope_snapshots', ['day', 'memory_id', 'scope_key'], {
        memory_id: (value) => mapped(maps.agent_memories, value),
      }],
      ['instruction_scope_stats', ['memory_id', 'scope_key'], {
        memory_id: (value) => mapped(maps.agent_memories, value),
      }],
      ['quality_metric_snapshots', ['day', 'source'], {}],
      ['skill_edges', ['from_id', 'to_id', 'kind'], {
        from_id: (value) => mapped(maps.skill_nodes, value),
        to_id: (value) => mapped(maps.skill_nodes, value),
      }],
      ['skill_node_merges', ['old_id'], {
        old_id: (value) => mapped(maps.skill_nodes, value),
        canonical_id: (value) => mapped(maps.skill_nodes, value),
      }],
      ['source_embedding_vec_refs', ['canonical_source_id'], {}],
      ['source_precision_snapshots', ['day', 'canonical_source_id'], {}],
    ];
    for (const [table, identity, rowTransforms] of alternateTables) {
      mergeWithAlternateIdentity(source, target, table, stats, {
        alternateKeys: [identity],
        transforms: rowTransforms,
        immutableColumns: identity,
      });
    }
    mergeKeyedTable(source, target, 'entity_edge_confidence_backfills', stats, {
      edge_id: (value) => mapped(maps.entity_edges, value),
    });
    mergeKeyedTable(source, target, 'entity_text_units', stats, {
      entity_id: (value) => mapped(maps.entities, value),
      text_unit_id: (value) => mapped(maps.text_units, value),
    });
    mergeKeyedTable(source, target, 'fact_text_units', stats, {
      fact_id: (value) => mapped(maps.facts, value),
      text_unit_id: (value) => mapped(maps.text_units, value),
    });
    for (const table of [
      'memory_edge_decay_state',
      'memory_edge_reinforce_baseline',
      'source_embeddings',
      'vector_replay_gate_state',
    ]) {
      mergeKeyedTable(source, target, table, stats);
    }
    if (sourceTables.has('idempotency_receipts')) {
      mergeKeyedTable(source, target, 'idempotency_receipts', stats);
    }
    persistLegacyMappings(target, maps);
    target.exec('DELETE FROM skill_fts');
    const ftsRows = target.prepare('SELECT skill_id, name, description, tags FROM skill_nodes').all();
    const ftsInsert = target.prepare('INSERT INTO skill_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)');
    for (const row of ftsRows) ftsInsert.run(row.skill_id, row.name, row.description, row.tags);
    target.exec('COMMIT');
    const foreignKeyFailures = target.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length) {
      fail(`Brain foreign-key audit found ${foreignKeyFailures.length} violation(s)`);
    }
  } catch (error) {
    try { target.exec('ROLLBACK'); } catch { /* transaction may already be committed */ }
    throw error;
  } finally {
    finishStats(target, stats);
    source.close();
    target.close();
  }
  return { stats, maps };
}

function compactStats(stats) {
  return Object.fromEntries(Object.entries(stats).map(([table, value]) => [table, value]));
}

const profile = resolve(option('--profile'));
if (!option('--profile')) fail('--profile is required');
const legacyManager = requiredFile(option('--legacy-manager'), 'legacy Manager database');
const legacyBrain = requiredFile(option('--legacy-brain'), 'legacy Brain database');
const managerTarget = requiredFile(option('--manager-target', resolve(profile, 'manager', 'id-agents.db')), 'profile Manager database');
const brainTarget = requiredFile(option('--brain-target', resolve(profile, 'brain', 'brain.db')), 'profile Brain database');
const receiptPath = resolve(option('--receipt', resolve(profile, 'migration-receipts', `legacy-convergence-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}.json`)));
const seedReceiptPath = option('--seed-receipt');
const seedReceipt = seedReceiptPath
  ? JSON.parse(readFileSync(requiredFile(seedReceiptPath, 'seed convergence receipt'), 'utf8'))
  : null;

const startedAt = new Date().toISOString();
const manager = mergeManager(legacyManager, managerTarget);
const brain = mergeBrain(legacyBrain, brainTarget, seedReceipt);
const receipt = {
  schemaVersion: 1,
  operation: 'legacy-profile-convergence',
  startedAt,
  completedAt: new Date().toISOString(),
  sources: {
    manager: { path: legacyManager },
    brain: { path: legacyBrain },
    ...(seedReceiptPath ? { seedReceipt: { path: resolve(seedReceiptPath) } } : {}),
  },
  targets: {
    profile,
    manager: managerTarget,
    brain: brainTarget,
  },
  manager: compactStats(manager),
  brain: compactStats(brain.stats),
  collisionMaps: Object.fromEntries(Object.entries(brain.maps).map(([table, mapping]) => [
    table,
    [...mapping.entries()].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to })),
  ])),
};
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: true,
  receipt: receiptPath,
  managerInserted: Object.values(manager).reduce((sum, value) => sum + value.inserted, 0),
  brainInserted: Object.values(brain.stats).reduce((sum, value) => sum + value.inserted, 0),
  brainCollisions: Object.values(brain.stats).reduce((sum, value) => sum + value.collisions, 0),
}, null, 2));
