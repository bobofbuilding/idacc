import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { DB_PATH, ensureBrainDbDir } from './config.mjs';
import { classifyEntityEdgeFreshness, entityEdgeFreshnessThresholds } from './edge-semantics.mjs';
import { promptVersion } from './prompt-config.mjs';
import { backfillEvalSourceIds } from './source-ids.mjs';

// ─── Database setup ───────────────────────────────────────────────────────────

ensureBrainDbDir(DB_PATH);
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode=WAL;`);

export const VECTOR_DIMENSIONS = Math.max(1, Math.floor(Number(process.env.BRAIN_VECTOR_DIMENSIONS ?? 64)) || 64);

let sqliteVecAvailable = false;
let sqliteVecError = '';
try {
  const extensionPath = process.env.BRAIN_SQLITE_VEC_EXTENSION ?? '';
  if (extensionPath) {
    db.enableLoadExtension(true);
    db.loadExtension(extensionPath);
    db.enableLoadExtension(false);
    sqliteVecAvailable = true;
  }
} catch (err) {
  sqliteVecAvailable = false;
  sqliteVecError = String(err?.message ?? err);
  try { db.enableLoadExtension(false); } catch {}
}

const SKILL_EDGE_KINDS = [
  'related',
  'composes',
  'requires',
  'same-domain',
  'supports-task',
  'validates-source',
  'requires-skill',
  'source-of',
  'supersedes',
];
const SKILL_EDGE_KIND_SET = new Set(SKILL_EDGE_KINDS);
const PRIORITY_SKILL_EDGE_WEIGHTS = {
  'requires-skill': 3.25,
  'supports-task': 3,
  'validates-source': 2.75,
  'source-of': 2.5,
  supersedes: 2.25,
  requires: 1.75,
  composes: 1.5,
  related: 1,
};
const RECOMMEND_DOMAIN_RECALL = 0.25;
const RECOMMEND_DOMAIN_ONLY_PENALTY = -1;
const RECOMMEND_OUTCOME_WEIGHT = 2;

// Catalog verdicts that keep reviewed-but-not-cleared candidates out of
// default recommendations and block execution in the safety report.
const BLOCKED_INSTALL_TAGS = ['do-not-install'];

function isBlockedNode(tags) {
  const list = Array.isArray(tags) ? tags : [];
  return BLOCKED_INSTALL_TAGS.some(tag => list.includes(tag));
}

const SCHEMA_VERSION = 3;

function getUserVersion() {
  const row = db.prepare(`PRAGMA user_version`).get();
  return Number(row?.user_version ?? 0);
}

function setUserVersion(version) {
  db.exec(`PRAGMA user_version = ${Number(version)}`);
}

function addColumnIfMissing(sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (/duplicate column name/i.test(String(err?.message ?? err))) return;
    throw err;
  }
}

function skillEdgeKindCheckSql() {
  return SKILL_EDGE_KINDS.map(kind => `'${kind}'`).join(',');
}

function skillEdgesCreateSql(tableName = 'skill_edges') {
  return `
    CREATE TABLE ${tableName} (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES skill_nodes(skill_id),
      to_id   INTEGER NOT NULL REFERENCES skill_nodes(skill_id),
      kind    TEXT    NOT NULL CHECK(kind IN (${skillEdgeKindCheckSql()})),
      weight  REAL    NOT NULL DEFAULT 1.0,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(from_id, to_id, kind)
    )
  `;
}

function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function migrateSkillEdgeKindVocabulary() {
  if (!tableExists('skill_edges')) return;
  const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_edges'`).get()?.sql ?? '';
  if (SKILL_EDGE_KINDS.every(kind => schema.includes(`'${kind}'`))) return;
  const hasEvidenceCount = /\bevidence_count\b/i.test(schema);
  const hasUpdatedAt = /\bupdated_at\b/i.test(schema);
  db.exec(`DROP TABLE IF EXISTS skill_edges_v3`);
  db.exec(`BEGIN`);
  try {
    db.exec(skillEdgesCreateSql('skill_edges_v3'));
    db.exec(`
      INSERT INTO skill_edges_v3 (id, from_id, to_id, kind, weight, evidence_count, updated_at)
      SELECT id, from_id, to_id, kind, weight,
        ${hasEvidenceCount ? `COALESCE(NULLIF(evidence_count, 0), 1)` : '1'},
        ${hasUpdatedAt ? `COALESCE(NULLIF(updated_at, 0), unixepoch())` : 'unixepoch()'}
      FROM skill_edges
    `);
    db.exec(`DROP TABLE skill_edges`);
    db.exec(`ALTER TABLE skill_edges_v3 RENAME TO skill_edges`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_from ON skill_edges(from_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_to ON skill_edges(to_id)`);
    db.exec(`COMMIT`);
  } catch (err) {
    try { db.exec(`ROLLBACK`); } catch {}
    try { db.exec(`DROP TABLE IF EXISTS skill_edges_v3`); } catch {}
    throw err;
  }
}

function runMigrations() {
  const current = getUserVersion();
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    // Migration 1: preserve existing additive schema drift and start versioning.
    for (const col of [
      `ALTER TABLE skill_nodes ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agent_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
      `ALTER TABLE agent_memories ADD COLUMN expires_at INTEGER`,
    ]) {
      try { db.exec(col); } catch { /* table/column already exists or is created below */ }
    }
    setUserVersion(1);
  }

  if (current < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_metric_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        day          TEXT    NOT NULL,
        measured_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        source       TEXT    NOT NULL DEFAULT 'brain-quality-metrics',
        "values"     TEXT    NOT NULL DEFAULT '{}',
        brain_totals TEXT    NOT NULL DEFAULT '{}',
        sample_size  INTEGER NOT NULL DEFAULT 0,
        window_days  INTEGER NOT NULL DEFAULT 7,
        pass_count   INTEGER NOT NULL DEFAULT 0,
        total_count  INTEGER NOT NULL DEFAULT 0,
        all_pass     INTEGER NOT NULL DEFAULT 0,
        UNIQUE(day, source)
      );
      CREATE INDEX IF NOT EXISTS idx_quality_metric_snapshots_day ON quality_metric_snapshots(day DESC);
    `);
    setUserVersion(2);
  }

  if (current < 3) {
    migrateSkillEdgeKindVocabulary();
    setUserVersion(3);
  }
}

runMigrations();

db.exec(`
  CREATE TABLE IF NOT EXISTS skill_nodes (
    skill_id     INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    domain       TEXT    NOT NULL DEFAULT 'knowledge',
    tags         TEXT    NOT NULL DEFAULT '[]',
    compute_cost INTEGER NOT NULL DEFAULT 0,
    chainable    INTEGER NOT NULL DEFAULT 1,
    use_count    INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_domain    ON skill_nodes(domain);
  CREATE INDEX IF NOT EXISTS idx_nodes_use_count ON skill_nodes(use_count DESC);

  CREATE TABLE IF NOT EXISTS skill_edges (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES skill_nodes(skill_id),
    to_id   INTEGER NOT NULL REFERENCES skill_nodes(skill_id),
    kind    TEXT    NOT NULL CHECK(kind IN ('related','composes','requires','same-domain','supports-task','validates-source','requires-skill','source-of','supersedes')),
    weight  REAL    NOT NULL DEFAULT 1.0,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(from_id, to_id, kind)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_from ON skill_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to   ON skill_edges(to_id);

  CREATE TABLE IF NOT EXISTS agent_memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT    NOT NULL,
    mem_key    TEXT,
    content    TEXT    NOT NULL,
    tags       TEXT    NOT NULL DEFAULT '[]',
    visibility TEXT    NOT NULL DEFAULT 'private',
    status     TEXT    NOT NULL DEFAULT 'active',
    durable_metadata TEXT NOT NULL DEFAULT '{}',
    source_ids TEXT    NOT NULL DEFAULT '[]',
    confidence REAL,
    project    TEXT    NOT NULL DEFAULT '',
    task_id    TEXT    NOT NULL DEFAULT '',
    session_id TEXT    NOT NULL DEFAULT '',
    user_id    TEXT    NOT NULL DEFAULT '',
    turn_id    TEXT    NOT NULL DEFAULT '',
    supersedes INTEGER,
    superseded_by INTEGER,
    expires_at INTEGER,
    last_volunteered_at INTEGER,
    last_used_at INTEGER,
    ignored_count INTEGER NOT NULL DEFAULT 0,
    volunteered_count INTEGER NOT NULL DEFAULT 0,
    used_count INTEGER NOT NULL DEFAULT 0,
    harmful_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_memories_agent      ON agent_memories(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memories_visibility ON agent_memories(visibility);
  CREATE INDEX IF NOT EXISTS idx_memories_expires    ON agent_memories(expires_at) WHERE expires_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS controllers (
    controller_id  TEXT    PRIMARY KEY,
    type           TEXT    NOT NULL CHECK(type IN ('wallet','org','safe','human','service')),
    label          TEXT    NOT NULL DEFAULT '',
    name           TEXT    NOT NULL DEFAULT '',
    primary_wallet TEXT    NOT NULL DEFAULT '',
    metadata       TEXT    NOT NULL DEFAULT '{}',
    status         TEXT    NOT NULL DEFAULT 'active',
    created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_controllers_type ON controllers(type, status);
  CREATE INDEX IF NOT EXISTS idx_controllers_wallet ON controllers(primary_wallet);

  CREATE TABLE IF NOT EXISTS controller_agent_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    controller_id   TEXT    NOT NULL REFERENCES controllers(controller_id),
    agent_id        TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'owner',
    authority_level TEXT    NOT NULL DEFAULT 'operator',
    metadata        TEXT    NOT NULL DEFAULT '{}',
    status          TEXT    NOT NULL DEFAULT 'active',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(controller_id, agent_id, role)
  );
  CREATE INDEX IF NOT EXISTS idx_controller_agent_links_controller ON controller_agent_links(controller_id, status);
  CREATE INDEX IF NOT EXISTS idx_controller_agent_links_agent ON controller_agent_links(agent_id, status);

  CREATE TABLE IF NOT EXISTS vector_replay_gate_state (
    config_version TEXT     PRIMARY KEY,
    config_json    TEXT     NOT NULL DEFAULT '{}',
    rollout_allowed INTEGER NOT NULL DEFAULT 0,
    guard          TEXT     NOT NULL DEFAULT 'unknown',
    comparison_mode TEXT    NOT NULL DEFAULT 'union',
    summary_json   TEXT     NOT NULL DEFAULT '{}',
    updated_at     INTEGER  NOT NULL DEFAULT (unixepoch())
  );
`);

// FTS5 for full-text search — graceful fallback if unavailable
let ftsAvailable = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
      name, description, tags,
      tokenize='porter ascii'
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS skill_nodes_ai AFTER INSERT ON skill_nodes BEGIN
      INSERT INTO skill_fts(rowid, name, description, tags)
      VALUES (new.skill_id, new.name, new.description, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS skill_nodes_au AFTER UPDATE ON skill_nodes BEGIN
      DELETE FROM skill_fts WHERE rowid = old.skill_id;
      INSERT INTO skill_fts(rowid, name, description, tags)
      VALUES (new.skill_id, new.name, new.description, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS skill_nodes_ad AFTER DELETE ON skill_nodes BEGIN
      DELETE FROM skill_fts WHERE rowid = old.skill_id;
    END;
  `);
  db.exec(`DELETE FROM skill_fts`);
  const rows = db.prepare(`SELECT skill_id, name, description, tags FROM skill_nodes`).all();
  const ins = db.prepare(`INSERT INTO skill_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.skill_id, r.name, r.description, r.tags);
  ftsAvailable = true;
} catch {
  // FTS5 not compiled in — LIKE fallback used
}

// Universal knowledge graph — entities (agents, tasks, contracts, projects, concepts)
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id          TEXT    PRIMARY KEY,
    type        TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    source      TEXT    NOT NULL DEFAULT 'manual',
    data        TEXT    NOT NULL DEFAULT '{}',
    tags        TEXT    NOT NULL DEFAULT '[]',
    status      TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_entities_type   ON entities(type);
  CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source);

  CREATE TABLE IF NOT EXISTS entity_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT    NOT NULL,
    alias       TEXT    NOT NULL,
    normalized  TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'alias',
    source      TEXT    NOT NULL DEFAULT 'manual',
    status      TEXT    NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(entity_id, normalized)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_entity ON entity_aliases(entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized ON entity_aliases(normalized, status);

  CREATE TABLE IF NOT EXISTS entity_edges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    TEXT    NOT NULL,
    to_id      TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    weight     REAL    NOT NULL DEFAULT 1.0,
    confidence REAL    NOT NULL DEFAULT 0.5,
    provenance TEXT    NOT NULL DEFAULT '{"method":"asserted","source":"manual"}',
    prompt_version TEXT NOT NULL DEFAULT 'edge-description.v1',
    UNIQUE(from_id, to_id, kind)
  );

  CREATE INDEX IF NOT EXISTS idx_entity_edges_from ON entity_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_entity_edges_to   ON entity_edges(to_id);

  CREATE TABLE IF NOT EXISTS timeline (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    source     TEXT    NOT NULL,
    type       TEXT    NOT NULL,
    subject    TEXT    NOT NULL DEFAULT '',
    data       TEXT    NOT NULL DEFAULT '{}',
    tags       TEXT    NOT NULL DEFAULT '[]',
    idempotency_key TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_timeline_source  ON timeline(source);
  CREATE INDEX IF NOT EXISTS idx_timeline_type    ON timeline(type);
  CREATE INDEX IF NOT EXISTS idx_timeline_created ON timeline(created_at DESC);

  CREATE TABLE IF NOT EXISTS idempotency_receipts (
    scope           TEXT    NOT NULL,
    idempotency_key TEXT    NOT NULL,
    content_hash    TEXT    NOT NULL,
    result          TEXT    NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(scope, idempotency_key)
  );

  -- Durable facts with provenance (Plan 22, Phase 0): writers post atomic facts
  -- instead of clobbering entities.data, and each new write supersedes the
  -- prior active values for the same entity + field so the active surface stays
  -- single-valued while preserving the historical rows.
  CREATE TABLE IF NOT EXISTS facts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT    NOT NULL,
    field       TEXT    NOT NULL,
    value       TEXT    NOT NULL,            -- JSON-encoded
    source      TEXT    NOT NULL,
    confidence  REAL    NOT NULL DEFAULT 0.6,
    observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    supersedes  INTEGER,                     -- fact.id this replaced
    status      TEXT    NOT NULL DEFAULT 'active',  -- active | superseded | disputed
    volunteered_count INTEGER NOT NULL DEFAULT 0,
    used_count  INTEGER NOT NULL DEFAULT 0,
    last_volunteered_at INTEGER,
    last_used_at INTEGER,
    context     TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id, field);
  CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);

  CREATE TABLE IF NOT EXISTS text_units (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind         TEXT    NOT NULL,
    source_id           TEXT    NOT NULL,
    parent_text_unit_id INTEGER,
    title               TEXT    NOT NULL DEFAULT '',
    content             TEXT    NOT NULL,
    source_metadata     TEXT    NOT NULL DEFAULT '{}',
    process_config      TEXT    NOT NULL DEFAULT '{}',
    metadata            TEXT    NOT NULL DEFAULT '{}',
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(source_kind, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_text_units_source ON text_units(source_kind, source_id);
  CREATE INDEX IF NOT EXISTS idx_text_units_parent ON text_units(parent_text_unit_id);

  CREATE TABLE IF NOT EXISTS entity_text_units (
    entity_id    TEXT    NOT NULL,
    text_unit_id INTEGER NOT NULL,
    relation     TEXT    NOT NULL DEFAULT 'mentions',
    confidence   REAL    NOT NULL DEFAULT 0.7,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(entity_id, text_unit_id, relation)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_text_units_entity ON entity_text_units(entity_id);
  CREATE INDEX IF NOT EXISTS idx_entity_text_units_text   ON entity_text_units(text_unit_id);

  CREATE TABLE IF NOT EXISTS fact_text_units (
    fact_id      INTEGER NOT NULL,
    text_unit_id INTEGER NOT NULL,
    relation     TEXT    NOT NULL DEFAULT 'evidence',
    confidence   REAL    NOT NULL DEFAULT 0.7,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(fact_id, text_unit_id, relation)
  );
  CREATE INDEX IF NOT EXISTS idx_fact_text_units_fact ON fact_text_units(fact_id);
  CREATE INDEX IF NOT EXISTS idx_fact_text_units_text ON fact_text_units(text_unit_id);

  CREATE TABLE IF NOT EXISTS communities (
    id          TEXT    PRIMARY KEY,
    title       TEXT    NOT NULL,
    entity_ids  TEXT    NOT NULL DEFAULT '[]',
    metadata    TEXT    NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS community_reports (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id          TEXT    NOT NULL,
    title                 TEXT    NOT NULL,
    summary               TEXT    NOT NULL,
    findings              TEXT    NOT NULL DEFAULT '[]',
    source_text_unit_ids  TEXT    NOT NULL DEFAULT '[]',
    fact_ids              TEXT    NOT NULL DEFAULT '[]',
    prompt_version        TEXT    NOT NULL DEFAULT 'deterministic-v1',
    rank                  REAL    NOT NULL DEFAULT 0,
    confidence            REAL    NOT NULL DEFAULT 0.6,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_community_reports_community ON community_reports(community_id);
  CREATE INDEX IF NOT EXISTS idx_community_reports_prompt ON community_reports(prompt_version, rank DESC, confidence DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    subject     TEXT    NOT NULL DEFAULT '',
    payload     TEXT    NOT NULL DEFAULT '{}',
    risk_level  TEXT    NOT NULL DEFAULT 'medium',
    requested_by TEXT   NOT NULL DEFAULT 'brain',
    status      TEXT    NOT NULL DEFAULT 'pending',
    resolution  TEXT    NOT NULL DEFAULT '{}',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS eval_queries (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    query_text         TEXT    NOT NULL,
    agent_id           TEXT    NOT NULL DEFAULT '',
    task_id            TEXT    NOT NULL DEFAULT '',
    route              TEXT    NOT NULL,
    returned_entity_ids TEXT   NOT NULL DEFAULT '[]',
    returned_text_unit_ids TEXT NOT NULL DEFAULT '[]',
    returned_fact_ids  TEXT    NOT NULL DEFAULT '[]',
    accepted_ids       TEXT    NOT NULL DEFAULT '[]',
    route_ids          TEXT    NOT NULL DEFAULT '[]',
    required_source_ids TEXT    NOT NULL DEFAULT '[]',
    required_acceptance_ids TEXT NOT NULL DEFAULT '[]',
    used_ids           TEXT    NOT NULL DEFAULT '[]',
    artifact_hash      TEXT,
    route_ack_state    TEXT    NOT NULL DEFAULT '{}',
    latency_ms         INTEGER,
    metadata           TEXT    NOT NULL DEFAULT '{}',
    idempotency_key    TEXT,
    idempotency_hash   TEXT,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_eval_queries_route ON eval_queries(route, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_eval_queries_agent ON eval_queries(agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS eval_fixtures (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    eval_query_id        INTEGER,
    query_text           TEXT    NOT NULL,
    route                TEXT    NOT NULL DEFAULT '',
    agent_id             TEXT    NOT NULL DEFAULT '',
    task_id              TEXT    NOT NULL DEFAULT '',
    required_source_ids  TEXT    NOT NULL DEFAULT '[]',
    required_strings     TEXT    NOT NULL DEFAULT '[]',
    metadata             TEXT    NOT NULL DEFAULT '{}',
    promoted_by          TEXT    NOT NULL DEFAULT 'brain',
    status               TEXT    NOT NULL DEFAULT 'active',
    stale_reason         TEXT    NOT NULL DEFAULT '',
    stale_at             INTEGER,
    retired_at           INTEGER,
    failure_count        INTEGER NOT NULL DEFAULT 0,
    last_replayed_at     INTEGER,
    last_failed_at       INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_eval_fixtures_route ON eval_fixtures(route, created_at DESC);

  CREATE TABLE IF NOT EXISTS context_volunteers (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id              TEXT    NOT NULL DEFAULT '',
    agent_id             TEXT    NOT NULL DEFAULT '',
    query_text           TEXT    NOT NULL DEFAULT '',
    entity_ids           TEXT    NOT NULL DEFAULT '[]',
    fact_ids             TEXT    NOT NULL DEFAULT '[]',
    text_unit_ids        TEXT    NOT NULL DEFAULT '[]',
    canonical_source_ids TEXT    NOT NULL DEFAULT '[]',
    source_origins       TEXT    NOT NULL DEFAULT '{}',
    timeline_event_id    INTEGER,
    used_source_ids      TEXT    NOT NULL DEFAULT '[]',
    used_at              INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_context_volunteers_task ON context_volunteers(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_context_volunteers_agent ON context_volunteers(agent_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS context_packages (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id              TEXT    NOT NULL DEFAULT '',
    agent_id             TEXT    NOT NULL DEFAULT '',
    query_text           TEXT    NOT NULL DEFAULT '',
    summary              TEXT    NOT NULL DEFAULT '',
    original_source_ids  TEXT    NOT NULL DEFAULT '[]',
    included_source_ids  TEXT    NOT NULL DEFAULT '[]',
    omitted_source_ids   TEXT    NOT NULL DEFAULT '[]',
    retrievable_source_ids TEXT  NOT NULL DEFAULT '[]',
    source_origins       TEXT    NOT NULL DEFAULT '{}',
    character_estimate   INTEGER NOT NULL DEFAULT 0,
    token_estimate       INTEGER NOT NULL DEFAULT 0,
    budget               TEXT    NOT NULL DEFAULT '{}',
    timeline_event_id    INTEGER,
    expires_at           INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_context_packages_task ON context_packages(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_context_packages_expires ON context_packages(expires_at) WHERE expires_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS source_precision_snapshots (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    day                  TEXT    NOT NULL,
    canonical_source_id  TEXT    NOT NULL,
    source_kind          TEXT    NOT NULL,
    volunteered          INTEGER NOT NULL DEFAULT 0,
    used                 INTEGER NOT NULL DEFAULT 0,
    weighted_volunteered REAL    NOT NULL DEFAULT 0,
    weighted_used        REAL    NOT NULL DEFAULT 0,
    precision            REAL,
    weighted_precision   REAL,
    threshold_state      TEXT    NOT NULL DEFAULT 'neutral',
    score                REAL    NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(day, canonical_source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_source_precision_snapshots_day ON source_precision_snapshots(day);

  CREATE TABLE IF NOT EXISTS instruction_scope_stats (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id            INTEGER NOT NULL,
    source_id            TEXT    NOT NULL,
    scope_key            TEXT    NOT NULL,
    scope_label          TEXT    NOT NULL DEFAULT 'global',
    project              TEXT    NOT NULL DEFAULT '',
    session_id           TEXT    NOT NULL DEFAULT '',
    user_id              TEXT    NOT NULL DEFAULT '',
    agent_id             TEXT    NOT NULL DEFAULT '',
    memory_scope_match   INTEGER NOT NULL DEFAULT 0,
    used_count           INTEGER NOT NULL DEFAULT 0,
    ignored_count        INTEGER NOT NULL DEFAULT 0,
    harmful_count        INTEGER NOT NULL DEFAULT 0,
    feedback_count       INTEGER NOT NULL DEFAULT 0,
    first_seen           INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen            INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(memory_id, scope_key)
  );
  CREATE INDEX IF NOT EXISTS idx_instruction_scope_stats_memory ON instruction_scope_stats(memory_id);
  CREATE INDEX IF NOT EXISTS idx_instruction_scope_stats_scope ON instruction_scope_stats(scope_key);

  CREATE TABLE IF NOT EXISTS instruction_scope_snapshots (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    day                  TEXT    NOT NULL,
    memory_id            INTEGER NOT NULL,
    source_id            TEXT    NOT NULL,
    scope_key            TEXT    NOT NULL,
    scope_label          TEXT    NOT NULL DEFAULT 'global',
    project              TEXT    NOT NULL DEFAULT '',
    session_id           TEXT    NOT NULL DEFAULT '',
    user_id              TEXT    NOT NULL DEFAULT '',
    agent_id             TEXT    NOT NULL DEFAULT '',
    memory_scope_match   INTEGER NOT NULL DEFAULT 0,
    used_count           INTEGER NOT NULL DEFAULT 0,
    ignored_count        INTEGER NOT NULL DEFAULT 0,
    harmful_count        INTEGER NOT NULL DEFAULT 0,
    feedback_count       INTEGER NOT NULL DEFAULT 0,
    precision            REAL,
    threshold_state      TEXT    NOT NULL DEFAULT 'neutral',
    created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(day, memory_id, scope_key)
  );
  CREATE INDEX IF NOT EXISTS idx_instruction_scope_snapshots_day ON instruction_scope_snapshots(day);
  CREATE INDEX IF NOT EXISTS idx_instruction_scope_snapshots_scope ON instruction_scope_snapshots(scope_key, day);

  CREATE TABLE IF NOT EXISTS source_embeddings (
    canonical_source_id TEXT PRIMARY KEY,
    source_kind         TEXT    NOT NULL,
    provider            TEXT    NOT NULL DEFAULT 'manual',
    model               TEXT    NOT NULL DEFAULT '',
    content_hash        TEXT    NOT NULL DEFAULT '',
    embedding_json      TEXT    NOT NULL DEFAULT '[]',
    text_preview        TEXT    NOT NULL DEFAULT '',
    metadata            TEXT    NOT NULL DEFAULT '{}',
    refreshed_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_source_embeddings_kind ON source_embeddings(source_kind, refreshed_at DESC);

  CREATE TABLE IF NOT EXISTS source_embedding_vec_refs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_source_id TEXT    NOT NULL UNIQUE,
    source_kind         TEXT    NOT NULL,
    refreshed_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_source_embedding_vec_refs_source ON source_embedding_vec_refs(canonical_source_id);

  CREATE TABLE IF NOT EXISTS learning_tasks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                TEXT    NOT NULL,
    subject             TEXT    NOT NULL DEFAULT '',
    approval_id         INTEGER,
    assignee            TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL DEFAULT 'queued',
    priority            INTEGER NOT NULL DEFAULT 0,
    evidence_ids        TEXT    NOT NULL DEFAULT '{}',
    payload             TEXT    NOT NULL DEFAULT '{}',
    result              TEXT    NOT NULL DEFAULT '{}',
    idempotency_key     TEXT,
    idempotency_hash    TEXT,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at        INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_learning_tasks_status ON learning_tasks(status, priority DESC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_learning_tasks_assignee ON learning_tasks(assignee, status, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_learning_tasks_approval ON learning_tasks(approval_id);

  CREATE TABLE IF NOT EXISTS learning_rollback_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id         INTEGER,
    kind                TEXT    NOT NULL,
    subject             TEXT    NOT NULL DEFAULT '',
    inverse_action      TEXT    NOT NULL,
    before_state        TEXT    NOT NULL DEFAULT '{}',
    after_state         TEXT    NOT NULL DEFAULT '{}',
    metadata            TEXT    NOT NULL DEFAULT '{}',
    created_by          TEXT    NOT NULL DEFAULT 'brain',
    created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
    applied_at          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_learning_rollback_approval ON learning_rollback_records(approval_id);
  CREATE INDEX IF NOT EXISTS idx_learning_rollback_kind ON learning_rollback_records(kind, created_at DESC);
`);

if (sqliteVecAvailable) {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS source_embedding_vec USING vec0(
        embedding float[${VECTOR_DIMENSIONS}],
        canonical_source_id text,
        source_kind text,
        refreshed_at integer
      );
    `);
  } catch (err) {
    sqliteVecAvailable = false;
    sqliteVecError = String(err?.message ?? err);
  }
}

for (const col of [
  `ALTER TABLE agent_memories ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_memories ADD COLUMN last_volunteered_at INTEGER`,
  `ALTER TABLE agent_memories ADD COLUMN last_used_at INTEGER`,
  `ALTER TABLE agent_memories ADD COLUMN ignored_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_memories ADD COLUMN volunteered_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_memories ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_memories ADD COLUMN harmful_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE agent_memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE agent_memories ADD COLUMN durable_metadata TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE agent_memories ADD COLUMN project TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE agent_memories ADD COLUMN task_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE agent_memories ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE agent_memories ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE agent_memories ADD COLUMN turn_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE agent_memories ADD COLUMN supersedes INTEGER`,
  `ALTER TABLE agent_memories ADD COLUMN superseded_by INTEGER`,
  `ALTER TABLE agent_memories ADD COLUMN source_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE agent_memories ADD COLUMN confidence REAL`,
  `ALTER TABLE facts ADD COLUMN volunteered_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE facts ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE facts ADD COLUMN last_volunteered_at INTEGER`,
  `ALTER TABLE facts ADD COLUMN last_used_at INTEGER`,
  `ALTER TABLE timeline ADD COLUMN idempotency_key TEXT`,
  `ALTER TABLE eval_queries ADD COLUMN volunteered_source_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN skill_used_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN skill_helpfulness REAL`,
  `ALTER TABLE eval_queries ADD COLUMN context_package_id INTEGER`,
  `ALTER TABLE eval_queries ADD COLUMN route_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN required_source_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN required_acceptance_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN used_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE eval_queries ADD COLUMN artifact_hash TEXT`,
  `ALTER TABLE eval_queries ADD COLUMN route_ack_state TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE eval_queries ADD COLUMN idempotency_key TEXT`,
  `ALTER TABLE eval_queries ADD COLUMN idempotency_hash TEXT`,
  `ALTER TABLE learning_tasks ADD COLUMN idempotency_key TEXT`,
  `ALTER TABLE learning_tasks ADD COLUMN idempotency_hash TEXT`,
  `ALTER TABLE eval_fixtures ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE eval_fixtures ADD COLUMN stale_reason TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE eval_fixtures ADD COLUMN stale_at INTEGER`,
  `ALTER TABLE eval_fixtures ADD COLUMN retired_at INTEGER`,
  `ALTER TABLE eval_fixtures ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE eval_fixtures ADD COLUMN last_replayed_at INTEGER`,
  `ALTER TABLE eval_fixtures ADD COLUMN last_failed_at INTEGER`,
  `ALTER TABLE context_volunteers ADD COLUMN source_origins TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE context_volunteers ADD COLUMN context_package_id INTEGER`,
]) {
  addColumnIfMissing(col);
}
db.exec(`UPDATE context_volunteers SET source_origins='{}' WHERE source_origins IS NULL OR trim(source_origins)=''`);
db.exec(`UPDATE agent_memories SET updated_at=COALESCE(NULLIF(updated_at, 0), created_at, unixepoch()) WHERE updated_at=0 OR updated_at IS NULL`);
db.exec(`UPDATE agent_memories SET source_ids=COALESCE(NULLIF(json_extract(durable_metadata,'$.source_ids'),'null'),'[]'), confidence=json_extract(durable_metadata,'$.confidence') WHERE source_ids='[]' AND durable_metadata!='{}'`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_fixtures_status ON eval_fixtures(status, created_at DESC)`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_idempotency
  ON timeline(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_queries_idempotency
  ON eval_queries(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_learning_tasks_idempotency
  ON learning_tasks(idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
`);
try { backfillEvalSourceIds(db); } catch { /* older local databases may not have eval tables yet */ }

for (const col of [
  `ALTER TABLE skill_edges ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE skill_edges ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE entity_edges ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE entity_edges ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE entity_edges ADD COLUMN text_unit_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE entity_edges ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE entity_edges ADD COLUMN prompt_version TEXT NOT NULL DEFAULT 'edge-description.v1'`,
  `ALTER TABLE entity_edges ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5`,
  `ALTER TABLE entity_edges ADD COLUMN provenance TEXT NOT NULL DEFAULT '{"method":"asserted","source":"manual"}'`,
  `ALTER TABLE text_units ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE entity_text_units ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE fact_text_units ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE text_units ADD COLUMN source_metadata TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE text_units ADD COLUMN process_config TEXT NOT NULL DEFAULT '{}'`,
]) {
  addColumnIfMissing(col);
}

// Keep the legacy orphan rows readable for maintenance/remediation, but stop
// every new direct-SQL insert or entity retarget from increasing the debt. The
// application preflight below provides stable HTTP errors; these triggers are
// the last-line guard for internal/legacy writers that bypass that helper.
db.exec(`
  CREATE TRIGGER IF NOT EXISTS facts_entity_guard_insert
  BEFORE INSERT ON facts
  WHEN NOT EXISTS (SELECT 1 FROM entities WHERE id = NEW.entity_id)
  BEGIN
    SELECT RAISE(ABORT, 'facts.entity_not_found');
  END;

  CREATE TRIGGER IF NOT EXISTS facts_entity_guard_update
  BEFORE UPDATE OF entity_id ON facts
  WHEN NOT EXISTS (SELECT 1 FROM entities WHERE id = NEW.entity_id)
  BEGIN
    SELECT RAISE(ABORT, 'facts.entity_not_found');
  END;
`);

db.exec(`UPDATE skill_edges SET evidence_count=1 WHERE evidence_count=0 OR evidence_count IS NULL`);
db.exec(`UPDATE skill_edges SET updated_at=unixepoch() WHERE updated_at=0 OR updated_at IS NULL`);
db.exec(`UPDATE entity_edges SET updated_at=unixepoch() WHERE updated_at=0 OR updated_at IS NULL`);
db.exec(`UPDATE entity_edges SET confidence=0.5 WHERE confidence IS NULL OR confidence < 0 OR confidence > 1`);
db.exec(`UPDATE entity_edges SET provenance='{"method":"asserted","source":"manual"}' WHERE provenance IS NULL OR trim(provenance)=''`);
db.exec(`UPDATE text_units SET updated_at=COALESCE(NULLIF(updated_at, 0), created_at, unixepoch()) WHERE updated_at=0 OR updated_at IS NULL`);
db.exec(`UPDATE entity_text_units SET updated_at=COALESCE(NULLIF(updated_at, 0), created_at, unixepoch()) WHERE updated_at=0 OR updated_at IS NULL`);
db.exec(`UPDATE fact_text_units SET updated_at=COALESCE(NULLIF(updated_at, 0), created_at, unixepoch()) WHERE updated_at=0 OR updated_at IS NULL`);

/**
 * Append a fact with the Plan-22 hybrid merge policy:
 *  - exact dup (same entity+field+source+value, active) → reaffirm (bump observed_at)
 *  - new value for the same entity+field → insert a fresh row and supersede all
 *    prior active rows for that field
 */
// G9: pull text-unit provenance ids out of a fact's context (several aliases used
// by writers across the codebase).
function factContextTextUnitIds(context = {}) {
  const ctx = context ?? {};
  const raw = [
    ...(Array.isArray(ctx.source_text_unit_ids) ? ctx.source_text_unit_ids : []),
    ...(Array.isArray(ctx.sourceTextUnitIds) ? ctx.sourceTextUnitIds : []),
    ...(Array.isArray(ctx.text_unit_ids) ? ctx.text_unit_ids : []),
    ...(Array.isArray(ctx.textUnitIds) ? ctx.textUnitIds : []),
  ];
  return [...new Set(raw.map(Number).filter(Number.isInteger))];
}

function factSourceNodeId(source) {
  const text = String(source ?? '').trim();
  if (!text) return null;
  return text.includes(':') ? text : `source:${text}`;
}

function normalizedScalarId(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    return text && !text.includes('[object Object]') ? text : '';
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function normalizeFactEntityId(value) {
  const scalar = normalizedScalarId(value);
  if (scalar) return scalar;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['entity_id', 'entityId', 'id', 'uuid', 'name', 'query_id', 'queryId', 'task_id', 'taskId', 'short_id', 'shortId']) {
    const found = normalizedScalarId(value[key]);
    if (found) return found;
  }
  return '';
}

function factEntityExists(entityId) {
  const normalized = normalizeFactEntityId(entityId);
  if (!normalized) return false;
  return Boolean(db.prepare(`SELECT 1 FROM entities WHERE id=? LIMIT 1`).get(normalized));
}

function factEntityWriteTarget(entityId) {
  const normalized = normalizeFactEntityId(entityId);
  if (!normalized) {
    throw Object.assign(new Error('fact entity not found'), {
      status: 404,
      code: 'fact_entity_not_found',
      entityId: normalized,
    });
  }
  const entity = db.prepare(`SELECT id, status, data FROM entities WHERE id=? LIMIT 1`).get(normalized);
  if (!entity) {
    throw Object.assign(new Error(`fact entity not found: ${normalized}`), {
      status: 404,
      code: 'fact_entity_not_found',
      entityId: normalized,
    });
  }
  const status = String(entity.status ?? 'active').trim().toLowerCase() || 'active';
  const data = parseJson(entity.data, {});
  if (status === 'merged') {
    throw Object.assign(new Error(`fact entity is merged: ${normalized}`), {
      status: 409,
      code: 'fact_entity_merged',
      entityId: normalized,
      entityStatus: status,
      canonicalEntityId: String(data.merged_into ?? data.mergedInto ?? '').trim() || null,
    });
  }
  if (['deleted', 'archived', 'retired', 'removed'].includes(status)) {
    throw Object.assign(new Error(`fact entity is unavailable: ${normalized}`), {
      status: 409,
      code: 'fact_entity_unavailable',
      entityId: normalized,
      entityStatus: status,
    });
  }
  return entity;
}

function factStatusProjection({ entityId = '' } = {}) {
  const normalizedEntityId = String(entityId ?? '').trim();
  const where = normalizedEntityId ? 'WHERE entity_id=?' : '';
  const params = normalizedEntityId ? [normalizedEntityId] : [];
  const rows = db.prepare(`
    SELECT COALESCE(status, 'active') AS status, COUNT(*) AS count
    FROM facts
    ${where}
    GROUP BY COALESCE(status, 'active')
  `).all(...params);
  const byStatus = { active: 0, superseded: 0, disputed: 0 };
  let other = 0;
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] += count;
    else other += count;
  }
  const orphanWhere = normalizedEntityId ? 'AND f.entity_id=?' : '';
  const orphanRows = db.prepare(`
    SELECT COALESCE(f.status, 'active') AS status, COUNT(*) AS count
    FROM facts f
    LEFT JOIN entities e ON e.id=f.entity_id
    WHERE e.id IS NULL ${orphanWhere}
    GROUP BY COALESCE(f.status, 'active')
  `).all(...params);
  const orphanByStatus = { active: 0, superseded: 0, disputed: 0 };
  let orphanOther = 0;
  for (const row of orphanRows) {
    const count = Number(row.count ?? 0);
    if (Object.hasOwn(orphanByStatus, row.status)) orphanByStatus[row.status] += count;
    else orphanOther += count;
  }
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0) + other;
  const orphanTotal = Object.values(orphanByStatus).reduce((sum, count) => sum + count, 0) + orphanOther;
  return {
    total,
    facts_total: total,
    active: byStatus.active,
    superseded: byStatus.superseded,
    disputed: byStatus.disputed,
    other,
    by_status: byStatus,
    serving_active_facts: byStatus.active - orphanByStatus.active,
    orphan_facts: orphanTotal,
    orphan_by_status: orphanByStatus,
    orphan_other: orphanOther,
    ...(normalizedEntityId ? { entity_id: normalizedEntityId } : {}),
  };
}

function auditFactEntityIntegrity({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const statusProjection = factStatusProjection();
  const orphanCount = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM facts f
    LEFT JOIN entities e ON e.id=f.entity_id
    WHERE e.id IS NULL
  `).get()?.count ?? 0);
  const orphanFacts = db.prepare(`
    SELECT f.id AS fact_id, f.entity_id, f.status, f.observed_at
    FROM facts f
    LEFT JOIN entities e ON e.id=f.entity_id
    WHERE e.id IS NULL
    ORDER BY f.id ASC
    LIMIT ?
  `).all(safeLimit);
  const orphanByStatus = statusProjection.orphan_by_status;
  const orphanOther = Number(statusProjection.orphan_other ?? 0);
  const activeOrphans = Number(orphanByStatus.active ?? 0);
  const status = orphanCount === 0 ? 'ok' : activeOrphans > 0 ? 'error' : 'warn';
  const sample = orphanFacts;
  return {
    schema: 'brain.fact-entity-integrity.v1',
    checked_at: Math.floor(Date.now() / 1000),
    status,
    ok: orphanCount === 0,
    invariant_ok: orphanCount === 0,
    total_facts: statusProjection.total,
    orphan_count: orphanCount,
    orphan_by_status: { ...orphanByStatus, other: orphanOther },
    orphan_facts: orphanFacts,
    truncated: orphanCount > orphanFacts.length,
    limit: safeLimit,
    sample,
    sample_truncated: orphanCount > sample.length,
    status_projection: statusProjection,
  };
}

function recordFactProvenanceEdges({ factId, previousFactId = null, previousFactIds = [], source, sourceTuIds = [], taskId = '' }) {
  const id = Number(factId);
  if (!Number.isInteger(id)) return;
  const factNodeId = `fact:${id}`;
  const promptVersion = 'deterministic-fact-provenance.v1';
  const sourceNodeId = factSourceNodeId(source);
  if (sourceNodeId) {
    upsertEntityEdge({
      from: sourceNodeId,
      to: factNodeId,
      kind: 'source-of',
      weight: 0.9,
      description: `Source ${sourceNodeId} is the source of fact ${id}.`,
      textUnitIds: sourceTuIds,
      evidenceCount: Math.max(1, sourceTuIds.length),
      promptVersion,
    });
  }
  for (const textUnitId of sourceTuIds) {
    upsertEntityEdge({
      from: `text:${textUnitId}`,
      to: factNodeId,
      kind: 'validates-source',
      weight: 0.95,
      description: `Text unit ${textUnitId} provides validating source evidence for fact ${id}.`,
      textUnitIds: [textUnitId],
      evidenceCount: 1,
      promptVersion,
    });
  }
  const task = String(taskId ?? '').trim();
  if (task) {
    upsertEntityEdge({
      from: factNodeId,
      to: task.startsWith('task:') ? task : `task:${task}`,
      kind: 'supports-task',
      weight: 0.85,
      description: `Fact ${id} was captured with task scope ${task}.`,
      textUnitIds: sourceTuIds,
      evidenceCount: Math.max(1, sourceTuIds.length),
      promptVersion,
    });
  }
  const priorFactIds = [...new Set([
    previousFactId,
    ...(Array.isArray(previousFactIds) ? previousFactIds : []),
  ]
    .map(Number)
    .filter(prev => Number.isInteger(prev) && prev > 0 && prev !== id))];
  for (const prev of priorFactIds) {
    upsertEntityEdge({
      from: factNodeId,
      to: `fact:${prev}`,
      kind: 'supersedes',
      weight: 1,
      description: `Fact ${id} supersedes prior active fact ${prev}.`,
      textUnitIds: sourceTuIds,
      evidenceCount: Math.max(1, sourceTuIds.length),
      promptVersion,
    });
  }
}

function upsertFact(b) {
  const entityId = normalizeFactEntityId(b.entity_id);
  const field = String(b.field ?? '').trim();
  const source = String(b.source ?? '').trim();
  if (!entityId || !field || b.value === undefined || !source) {
    throw Object.assign(new Error('entity_id, field, value, source required'), { status: 400 });
  }
  factEntityWriteTarget(entityId);
  const value = JSON.stringify(b.value ?? null);
  const conf  = typeof b.confidence === 'number' ? b.confidence : 0.6;
  const ctx   = JSON.stringify(b.context ?? {});
  const sourceTuIds = factContextTextUnitIds(b.context); // G9
  const activeRows = db.prepare(
    `SELECT id, source, value, observed_at, confidence
     FROM facts
     WHERE entity_id=? AND field=? AND status='active'
     ORDER BY observed_at DESC, id DESC`
  ).all(entityId, field);
  const exactRows = activeRows.filter((row) => row.source === source && row.value === value);
  const taskId = b.context?.task_id ?? b.context?.taskId ?? '';
  if (exactRows.length > 0) {
    const primary = exactRows[0];
    const supersededRows = activeRows.filter((row) => row.id !== primary.id);
    if (supersededRows.length > 0) {
      const supersedeStmt = db.prepare(`UPDATE facts SET status='superseded' WHERE id=?`);
      for (const row of supersededRows) supersedeStmt.run(row.id);
    }
    db.prepare(`UPDATE facts SET observed_at=unixepoch(), confidence=MAX(confidence,?) WHERE id=?`).run(conf, primary.id);
    if (sourceTuIds.length) linkFactToTextUnits(primary.id, sourceTuIds, { relation: 'provenance', confidence: 0.85 });
    recordFactProvenanceEdges({
      factId: primary.id,
      previousFactIds: supersededRows.map((row) => row.id),
      source,
      sourceTuIds,
      taskId,
    });
    rollupEntityFactsData(entityId);
    return {
      id: primary.id,
      action: 'reaffirmed',
      contradiction: false,
      superseded: supersededRows.map((row) => row.id),
      conflictingSources: [...new Set(supersededRows.map((row) => row.source))],
    };
  }

  const previousFactId = activeRows[0]?.id ?? null;
  const ins = db.prepare(
    `INSERT INTO facts (entity_id,field,value,source,confidence,context,supersedes) VALUES (?,?,?,?,?,?,?)`
  ).run(entityId, field, value, source, conf, ctx, previousFactId);
  if (activeRows.length > 0) {
    const supersedeStmt = db.prepare(`UPDATE facts SET status='superseded' WHERE id=?`);
    for (const row of activeRows) supersedeStmt.run(row.id);
  }
  const factId = Number(ins.lastInsertRowid);
  if (sourceTuIds.length) linkFactToTextUnits(factId, sourceTuIds, { relation: 'provenance', confidence: 0.85 });
  recordFactProvenanceEdges({
    factId,
    previousFactId,
    previousFactIds: activeRows.map((row) => row.id),
    source,
    sourceTuIds,
    taskId,
  });
  rollupEntityFactsData(entityId);
  return {
    id: factId,
    action: activeRows.length > 0 ? (activeRows.some((row) => row.source === source) ? 'superseded-own' : 'superseded-active') : 'added',
    supersedes: previousFactId,
    superseded: activeRows.map((row) => row.id),
    contradiction: false,
    conflictingSources: [...new Set(activeRows.map((row) => row.source))],
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function slugifyControllerPart(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeWalletAddress(value) {
  const address = String(value ?? '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? address.toLowerCase() : address;
}

function normalizeControllerType(value = 'wallet') {
  const type = String(value || 'wallet').toLowerCase();
  if (!['wallet', 'org', 'safe', 'human', 'service'].includes(type)) {
    throw Object.assign(new Error('invalid controller type'), { status: 400 });
  }
  return type;
}

function controllerScopeUserId(controllerId) {
  const id = String(controllerId ?? '').trim();
  if (!id) return '';
  return id.startsWith('controller:') ? id : `controller:${id}`;
}

function deriveControllerId(input = {}) {
  const explicit = String(input.controller_id ?? input.controllerId ?? '').trim();
  if (explicit) return controllerScopeUserId(explicit);
  const type = normalizeControllerType(input.type);
  const wallet = normalizeWalletAddress(input.primary_wallet ?? input.primaryWallet ?? input.wallet ?? input.address ?? '');
  if ((type === 'wallet' || type === 'safe') && wallet) {
    const chainId = Number(input.chain_id ?? input.chainId ?? input.eip155_chain_id ?? input.eip155ChainId ?? 1) || 1;
    return `controller:eip155:${chainId}:${wallet}`;
  }
  const name = slugifyControllerPart(input.slug ?? input.org ?? input.name ?? input.label);
  if (!name) throw Object.assign(new Error('controller_id or stable wallet/org/name required'), { status: 400 });
  return `controller:${type}:${name}`;
}

function rowToController(row, links = []) {
  if (!row) return null;
  return {
    controller_id: row.controller_id,
    controllerId: row.controller_id,
    scope_user_id: controllerScopeUserId(row.controller_id),
    type: row.type,
    label: row.label,
    name: row.name,
    primary_wallet: row.primary_wallet,
    primaryWallet: row.primary_wallet,
    metadata: parseJson(row.metadata, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    agent_links: links.map(rowToControllerAgentLink),
    agentLinks: links.map(rowToControllerAgentLink),
  };
}

function rowToControllerAgentLink(row) {
  return {
    id: Number(row.id),
    controller_id: row.controller_id,
    controllerId: row.controller_id,
    agent_id: row.agent_id,
    agentId: row.agent_id,
    role: row.role,
    authority_level: row.authority_level,
    authorityLevel: row.authority_level,
    metadata: parseJson(row.metadata, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function controllerLinks(controllerId) {
  return db.prepare(`
    SELECT * FROM controller_agent_links
    WHERE controller_id=?
    ORDER BY status='active' DESC, updated_at DESC, agent_id, role
  `).all(controllerId);
}

function getController(controllerId) {
  const id = controllerScopeUserId(controllerId);
  const row = db.prepare(`SELECT * FROM controllers WHERE controller_id=?`).get(id);
  return rowToController(row, row ? controllerLinks(id) : []);
}

function listControllers({ type = '', q = '', agentId = '', status = 'active', limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  let join = '';
  if (agentId) {
    join = `JOIN controller_agent_links l ON l.controller_id=c.controller_id AND l.agent_id=?`;
    params.push(agentId);
  }
  if (type) { clauses.push('c.type=?'); params.push(normalizeControllerType(type)); }
  if (status) { clauses.push('c.status=?'); params.push(status); }
  if (q) {
    clauses.push(`(c.controller_id LIKE ? OR c.label LIKE ? OR c.name LIKE ? OR c.primary_wallet LIKE ? OR c.metadata LIKE ?)`);
    params.push(...Array(5).fill(`%${q}%`));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT DISTINCT c.*
    FROM controllers c
    ${join}
    ${where}
    ORDER BY c.updated_at DESC, c.label, c.controller_id
    LIMIT ?
  `).all(...params, Math.min(Math.max(Number(limit) || 50, 1), 200));
  return rows.map(row => rowToController(row, controllerLinks(row.controller_id)));
}

function upsertController(input = {}) {
  const type = normalizeControllerType(input.type);
  const controllerId = deriveControllerId({ ...input, type });
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const label = String(input.label ?? input.name ?? input.ens ?? input.ensName ?? controllerId).slice(0, 240);
  const name = String(input.name ?? input.ens ?? input.ensName ?? '').slice(0, 240);
  const primaryWallet = normalizeWalletAddress(input.primary_wallet ?? input.primaryWallet ?? input.wallet ?? input.address ?? '');
  const status = String(input.status ?? 'active').slice(0, 80) || 'active';
  const before = db.prepare(`SELECT controller_id FROM controllers WHERE controller_id=?`).get(controllerId);
  db.prepare(`
    INSERT INTO controllers (controller_id, type, label, name, primary_wallet, metadata, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(controller_id) DO UPDATE SET
      type=excluded.type,
      label=excluded.label,
      name=excluded.name,
      primary_wallet=excluded.primary_wallet,
      metadata=excluded.metadata,
      status=excluded.status,
      updated_at=unixepoch()
  `).run(controllerId, type, label, name, primaryWallet, JSON.stringify(metadata), status);
  return { ...getController(controllerId), action: before ? 'updated' : 'created' };
}

function linkControllerAgent(input = {}) {
  const controllerId = controllerScopeUserId(input.controller_id ?? input.controllerId);
  if (!controllerId) throw Object.assign(new Error('controller_id required'), { status: 400 });
  if (!db.prepare(`SELECT 1 FROM controllers WHERE controller_id=?`).get(controllerId)) {
    throw Object.assign(new Error('controller not found'), { status: 404 });
  }
  const agentId = String(input.agent_id ?? input.agentId ?? '').trim();
  if (!agentId) throw Object.assign(new Error('agent_id required'), { status: 400 });
  const role = String(input.role ?? 'owner').slice(0, 80) || 'owner';
  const authorityLevel = String(input.authority_level ?? input.authorityLevel ?? 'operator').slice(0, 80) || 'operator';
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const status = String(input.status ?? 'active').slice(0, 80) || 'active';
  db.prepare(`
    INSERT INTO controller_agent_links (controller_id, agent_id, role, authority_level, metadata, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(controller_id, agent_id, role) DO UPDATE SET
      authority_level=excluded.authority_level,
      metadata=excluded.metadata,
      status=excluded.status,
      updated_at=unixepoch()
  `).run(controllerId, agentId, role, authorityLevel, JSON.stringify(metadata), status);
  const row = db.prepare(`
    SELECT * FROM controller_agent_links
    WHERE controller_id=? AND agent_id=? AND role=?
  `).get(controllerId, agentId, role);
  return rowToControllerAgentLink(row);
}

const FACT_ROLLUP_KEY = '__fact_rollup';

function activeFactsForEntity(entityId) {
  return db.prepare(
    `SELECT * FROM facts WHERE entity_id=? AND status='active' ORDER BY field, confidence DESC, observed_at DESC, id DESC`
  ).all(entityId);
}

function buildFactRollup(rows = []) {
  const grouped = {};
  for (const row of rows) {
    const claim = {
      id: Number(row.id),
      value: parseJson(row.value, null),
      source: row.source,
      confidence: row.confidence,
      observed_at: row.observed_at,
      context: parseJson(row.context, {}),
    };
    (grouped[row.field] ??= []).push(claim);
  }
  const rollup = {};
  for (const [field, claims] of Object.entries(grouped)) {
    const uniqueValues = new Set(claims.map((claim) => JSON.stringify(claim.value)));
    if (uniqueValues.size === 1) {
      const [primary] = claims;
      rollup[field] = {
        value: primary.value,
        source: primary.source,
        confidence: primary.confidence,
        observed_at: primary.observed_at,
        context: primary.context,
        claim_count: claims.length,
      };
      continue;
    }
    rollup[field] = {
      contradictory: true,
      claim_count: claims.length,
      claims,
    };
  }
  return rollup;
}

function mergeEntityDataWithFactRollup(data, rollup) {
  const next = { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) };
  delete next[FACT_ROLLUP_KEY];
  if (Object.keys(rollup).length > 0) next[FACT_ROLLUP_KEY] = rollup;
  return next;
}

function preserveFactRollup(data, existingData) {
  const current = existingData && typeof existingData === 'object' && !Array.isArray(existingData)
    ? { ...existingData }
    : {};
  delete current[FACT_ROLLUP_KEY];
  const incoming = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
    : {};
  const next = { ...current, ...incoming };
  delete next[FACT_ROLLUP_KEY];
  if (existingData && Object.hasOwn(existingData, FACT_ROLLUP_KEY)) {
    next[FACT_ROLLUP_KEY] = existingData[FACT_ROLLUP_KEY];
  }
  return next;
}

function rollupEntityFactsData(entityId) {
  const row = db.prepare(`SELECT data FROM entities WHERE id=?`).get(entityId);
  if (!row) return null;
  const currentData = parseJson(row.data, {});
  const nextData = mergeEntityDataWithFactRollup(currentData, buildFactRollup(activeFactsForEntity(entityId)));
  if (JSON.stringify(nextData) !== JSON.stringify(currentData)) {
    db.prepare(`UPDATE entities SET data=?, updated_at=unixepoch() WHERE id=?`)
      .run(JSON.stringify(nextData), entityId);
  }
  return nextData;
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validateTextUnit({ content, metadata = {} }) {
  const text = normalizeWhitespace(content);
  if (!text) throw Object.assign(new Error('text unit content required'), { status: 400 });
  const maxChars = Number(metadata.maxChars ?? process.env.BRAIN_TEXT_UNIT_MAX_CHARS ?? 24_000);
  if (text.length > maxChars) throw Object.assign(new Error('text unit content too large'), { status: 400 });
  const minChars = Number(metadata.minChars ?? process.env.BRAIN_TEXT_UNIT_MIN_CHARS ?? 40);
  if (text.length < minChars && metadata.allowSmall !== true) {
    throw Object.assign(new Error('text unit content too fragmented'), { status: 400 });
  }
  return text;
}

function validateTextUnitSource({ sourceKind, sourceId, parentTextUnitId = null }) {
  const kind = normalizeWhitespace(sourceKind);
  const id = normalizeWhitespace(sourceId);
  if (!kind) throw Object.assign(new Error('text unit source_kind required'), { status: 400 });
  if (!id) throw Object.assign(new Error('text unit source_id required'), { status: 400 });
  if (parentTextUnitId != null) {
    const parentId = Number(parentTextUnitId);
    if (!Number.isInteger(parentId) || parentId <= 0) {
      throw Object.assign(new Error('parent_text_unit_id must be a positive integer'), { status: 400 });
    }
    const parent = db.prepare(`SELECT id FROM text_units WHERE id=?`).get(parentId);
    if (!parent) throw Object.assign(new Error('parent_text_unit_id not found'), { status: 400 });
  }
  return { sourceKind: kind, sourceId: id };
}

function normalizeProcessConfig(config = {}) {
  const strategy = String(config.strategy ?? 'auto').toLowerCase();
  const allowed = new Set(['auto', 'heading', 'heuristic', 'recursive']);
  if (!allowed.has(strategy)) throw Object.assign(new Error('invalid chunk strategy'), { status: 400 });
  return {
    strategy,
    chunk_size: Math.max(500, Number(config.chunk_size ?? config.chunkSize ?? 3_000) || 3_000),
    chunk_overlap: Math.max(0, Number(config.chunk_overlap ?? config.chunkOverlap ?? 250) || 0),
    token_limit: Math.max(0, Number(config.token_limit ?? config.tokenLimit ?? 0) || 0),
    parser: String(config.parser ?? 'plain-text'),
    prompt_version: String(config.prompt_version ?? config.promptVersion ?? 'none'),
    extraction_config: config.extraction_config ?? config.extractionConfig ?? {},
    allow_small: config.allow_small === true || config.allowSmall === true,
  };
}

function upsertTextUnit({ sourceKind, sourceId, title = '', content, metadata = {}, parentTextUnitId = null, sourceMetadata = {}, processConfig = {} }) {
  const source = validateTextUnitSource({ sourceKind, sourceId, parentTextUnitId });
  const normalizedProcess = normalizeProcessConfig(processConfig);
  const clean = validateTextUnit({
    content,
    metadata: {
      ...metadata,
      allowSmall: metadata.allowSmall === true || normalizedProcess.allow_small === true || normalizedProcess.allowSmall === true,
    },
  });
  const result = db.prepare(`
    INSERT INTO text_units (source_kind, source_id, parent_text_unit_id, title, content, source_metadata, process_config, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(source_kind, source_id) DO UPDATE SET
      parent_text_unit_id=excluded.parent_text_unit_id,
      title=excluded.title,
      content=excluded.content,
      source_metadata=excluded.source_metadata,
      process_config=excluded.process_config,
      metadata=excluded.metadata,
      updated_at=unixepoch()
  `).run(
    source.sourceKind,
    source.sourceId,
    parentTextUnitId,
    title ?? '',
    clean,
    JSON.stringify(sourceMetadata ?? {}),
    JSON.stringify(normalizedProcess),
    JSON.stringify(metadata ?? {}),
  );
  const row = db.prepare(`SELECT id FROM text_units WHERE source_kind=? AND source_id=?`).get(source.sourceKind, source.sourceId);
  return { id: Number(row?.id ?? result.lastInsertRowid), content: clean };
}

// Rough GPT-style token heuristic for budgeting (no tokenizer dependency).
const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  const str = String(text ?? '');
  if (!str) return 0;
  const words = str.match(/\S+/g)?.length ?? 0;
  return Math.max(Math.ceil(str.length / CHARS_PER_TOKEN), Math.ceil(words * 1.3));
}

// G5: strip non-prose noise before chunking/embedding — long base64 / data: URIs /
// hex blobs and control characters. Normal prose passes through untouched.
function sanitizeIngestText(text) {
  let str = String(text ?? '');
  str = str.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, ' [binary data omitted] ');
  str = str.replace(/[A-Za-z0-9+/]{300,}={0,2}/g, ' [base64 blob omitted] ');
  str = str.replace(/(?:[0-9a-fA-F]{2}[\s:]?){200,}/g, ' [hex blob omitted] ');
  str = str.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, ' ');
  return str;
}

// G2: when a token_limit is set, the effective char budget is the smaller of the
// requested char size and the token budget expressed in chars.
function effectiveChunkChars(size, tokenLimit) {
  if (!tokenLimit || tokenLimit <= 0) return size;
  return Math.max(200, Math.min(size, tokenLimit * CHARS_PER_TOKEN));
}

// Heuristic sliding window with sentence/word boundary snapping (long-standing
// behaviour). Char-based; respects `size`.
function heuristicSplit(clean, size, overlap) {
  if (clean.length <= size) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const boundary = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf('. ', end), clean.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(size * 0.55)) end = boundary + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks.filter(Boolean);
}

// G3: recursive separator splitter — split on the coarsest separator, recurse into
// oversized pieces with finer separators, then greedily re-pack adjacent pieces up
// to `size` with overlap. Distinct from the sliding window: it preserves paragraph
// and sentence structure instead of cutting at fixed offsets.
function recursiveSplit(clean, size, overlap, seps = ['\n\n', '\n', '. ', ' ', '']) {
  if (clean.length <= size) return [clean];
  const [sep, ...rest] = seps;
  let pieces;
  if (sep === '') {
    pieces = [];
    for (let i = 0; i < clean.length; i += size) pieces.push(clean.slice(i, i + size));
  } else {
    pieces = clean.split(sep);
  }
  const expanded = [];
  for (const piece of pieces) {
    const withSep = sep ? piece + sep : piece;
    if (withSep.length > size && rest.length) expanded.push(...recursiveSplit(piece, size, overlap, rest));
    else if (withSep.trim()) expanded.push(withSep);
  }
  const packed = [];
  let buf = '';
  for (const piece of expanded) {
    if (!buf) { buf = piece; continue; }
    if ((buf + piece).length <= size) { buf += piece; continue; }
    packed.push(buf.trim());
    const tail = overlap > 0 ? buf.slice(Math.max(0, buf.length - overlap)) : '';
    buf = tail + piece;
  }
  if (buf.trim()) packed.push(buf.trim());
  return packed.filter(Boolean);
}

// G4: merge chunks below the min size into a neighbour so ingest never emits a
// swarm of tiny fragments (over-fragmentation guard).
function mergeSmallChunks(chunks, size, minChars) {
  if (chunks.length <= 1 || minChars <= 0) return chunks;
  const merged = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev != null && (chunk.length < minChars || prev.length < minChars)
      && (prev.length + chunk.length) <= Math.floor(size * 1.5)) {
      merged[merged.length - 1] = `${prev}\n${chunk}`.trim();
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

// G2: enforce a hard token ceiling on any chunk that still exceeds it after
// structural splitting.
function enforceTokenLimit(chunks, tokenLimit, size, overlap) {
  if (!tokenLimit || tokenLimit <= 0) return chunks;
  const out = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) <= tokenLimit) out.push(chunk);
    else out.push(...heuristicSplit(chunk, effectiveChunkChars(size, tokenLimit), overlap));
  }
  return out;
}

// G3: 'auto' picks a concrete strategy from the content shape.
function chooseAutoStrategy(clean) {
  if (/(^|\n)#{1,6}\s+\S/.test(clean)) return 'heading';
  if ((clean.match(/\n\s*\n/g)?.length ?? 0) >= 2) return 'recursive';
  return 'heuristic';
}

function chunkText(content, {
  strategy = 'auto',
  chunkSize = 3_000,
  chunkOverlap = 250,
  tokenLimit = 0,
  allowSmall = false,
} = {}) {
  const clean = sanitizeIngestText(validateTextUnit({
    content,
    metadata: { maxChars: Number(process.env.BRAIN_INGEST_MAX_CHARS ?? 200_000), allowSmall },
  }));
  const baseSize = Math.max(500, Number(chunkSize) || 3_000);
  const size = effectiveChunkChars(baseSize, tokenLimit);
  const overlap = Math.max(0, Math.min(Number(chunkOverlap) || 0, Math.floor(size / 3)));
  const resolved = strategy === 'auto' ? chooseAutoStrategy(clean) : strategy;

  let chunks;
  if (resolved === 'heading') {
    const sections = clean.split(/\n(?=#{1,6}\s+)/).map(normalizeWhitespace).filter(Boolean);
    chunks = sections.length > 1
      ? sections.flatMap(section => recursiveSplit(section, size, overlap))
      : recursiveSplit(clean, size, overlap);
  } else if (resolved === 'recursive') {
    chunks = recursiveSplit(clean, size, overlap);
  } else {
    chunks = heuristicSplit(clean, size, overlap);
  }

  chunks = chunks.map(chunk => chunk.trim()).filter(Boolean);
  chunks = mergeSmallChunks(chunks, size, Math.max(0, Number(process.env.BRAIN_TEXT_UNIT_MERGE_MIN_CHARS ?? 200)));
  chunks = enforceTokenLimit(chunks, tokenLimit, baseSize, overlap);
  chunks = chunks.map(chunk => chunk.trim()).filter(Boolean);
  if (!chunks.length) return [clean];

  const maxChunks = Number(process.env.BRAIN_TEXT_UNIT_MAX_CHUNKS ?? 500);
  if (chunks.length > maxChunks) throw Object.assign(new Error('text unit output too fragmented'), { status: 400 });
  return chunks;
}

function upsertTextUnitsFromSource({ sourceKind, sourceId, title = '', content, metadata = {}, parentTextUnitId = null, processConfig = {} }) {
  validateTextUnitSource({ sourceKind, sourceId, parentTextUnitId });
  content = sanitizeIngestText(content); // G5: strip base64/binary noise at ingest
  const normalizedProcess = normalizeProcessConfig(processConfig);
  const strategy = normalizedProcess.strategy;
  // G1: provenance every text unit carries — which parser/prompt/extraction/strategy produced it.
  const provenance = {
    parser: normalizedProcess.parser,
    prompt_version: normalizedProcess.prompt_version,
    extraction_config: normalizedProcess.extraction_config,
    strategy: normalizedProcess.strategy,
  };
  const chunks = chunkText(content, {
    strategy,
    chunkSize: normalizedProcess.chunk_size,
    chunkOverlap: normalizedProcess.chunk_overlap,
    tokenLimit: normalizedProcess.token_limit,
    allowSmall: normalizedProcess.allow_small === true || metadata.allowSmall === true,
  });

  // The parent text unit is validated against the per-unit char cap. Large
  // sources are split into the `chunks` children above, so clamp the parent's
  // stored content to fit the cap instead of letting validateTextUnit throw and
  // abort the whole ingest (e.g. a repo digest with a big README). Full content
  // is preserved in the child chunks.
  const parentMaxChars = Number(metadata.maxChars ?? process.env.BRAIN_TEXT_UNIT_MAX_CHARS ?? 24_000);
  const normalizedContent = normalizeWhitespace(content);
  const parentTruncated = normalizedContent.length > parentMaxChars;
  const parentContent = parentTruncated
    ? `${normalizedContent.slice(0, Math.max(0, parentMaxChars - 200))}\n\n[…truncated; full content preserved across ${chunks.length} child text units]`
    : content;

  const parent = upsertTextUnit({
    sourceKind,
    sourceId,
    parentTextUnitId,
    title,
    content: parentContent,
    sourceMetadata: {
      kind: sourceKind,
      id: String(sourceId),
      title: title ?? '',
      ingested_at: Math.floor(Date.now() / 1000),
      ...provenance,
    },
    processConfig: { ...normalizedProcess, chunks: chunks.length },
    metadata: {
      ...metadata,
      source_ref: { kind: sourceKind, id: String(sourceId) },
      process_config: { ...normalizedProcess, chunks: chunks.length },
      role: 'parent',
      ...(parentTruncated ? { parent_truncated: true, source_chars: normalizedContent.length } : {}),
    },
  });

  if (chunks.length === 1 && chunks[0] === parent.content) {
    const links = linkTextUnitToEntities(parent.id);
    const factLinks = linkFactsForTextUnit(parent.id); // G9
    return { parentId: parent.id, textUnitIds: [parent.id], chunks: 1, entityLinks: links, factLinks };
  }

  const ids = [parent.id];
  let entityLinks = linkTextUnitToEntities(parent.id);
  let factLinks = linkFactsForTextUnit(parent.id); // G9
  chunks.forEach((chunk, i) => {
    const unit = upsertTextUnit({
      sourceKind,
      sourceId: `${sourceId}#chunk-${i + 1}`,
      parentTextUnitId: parent.id,
      title: title ? `${title} (${i + 1})` : `chunk ${i + 1}`,
      content: chunk,
      sourceMetadata: {
        kind: sourceKind,
        id: String(sourceId),
        parent_text_unit_id: parent.id,
        chunk_index: i,
        ...provenance,
      },
      processConfig: normalizedProcess,
      metadata: {
        ...metadata,
        source_ref: { kind: sourceKind, id: String(sourceId) },
        parent_ref: { text_unit_id: parent.id, source_id: String(sourceId) },
        process_config: normalizedProcess,
        role: 'child',
        chunk_index: i,
        total_chunks: chunks.length,
      },
    });
    ids.push(unit.id);
    entityLinks += linkTextUnitToEntities(unit.id);
    factLinks += linkFactsForTextUnit(unit.id); // G9
  });
  return { parentId: parent.id, textUnitIds: ids, chunks: ids.length, entityLinks, factLinks };
}

function linkTextUnitToEntities(textUnitId) {
  const unit = db.prepare(`SELECT content FROM text_units WHERE id=?`).get(textUnitId);
  if (!unit) return 0;
  const haystack = unit.content.toLowerCase();
  const entities = db.prepare(`
    SELECT e.id, e.name, COALESCE(json_group_array(a.alias), '[]') AS aliases
    FROM entities e
    LEFT JOIN entity_aliases a ON a.entity_id=e.id AND a.status='active'
    GROUP BY e.id
    ORDER BY length(e.name) DESC
    LIMIT 2000
  `).all();
  let count = 0;
  const stmt = db.prepare(`
    INSERT INTO entity_text_units (entity_id, text_unit_id, relation, confidence, updated_at)
    VALUES (?, ?, 'mentions', ?, unixepoch())
    ON CONFLICT(entity_id, text_unit_id, relation) DO UPDATE SET
      confidence=MAX(entity_text_units.confidence, excluded.confidence),
      updated_at=unixepoch()
  `);
  for (const entity of entities) {
    const names = [entity.name, ...parseJson(entity.aliases, [])]
      .map(value => String(value ?? '').toLowerCase().trim())
      .filter(value => value.length >= 3);
    const matchedAlias = names.some(name => haystack.includes(name));
    if (matchedAlias || haystack.includes(String(entity.id).toLowerCase())) {
      const r = stmt.run(entity.id, textUnitId, haystack.includes(String(entity.id).toLowerCase()) ? 0.9 : 0.7);
      count += r.changes;
    }
  }
  return count;
}

// G9: explicit text_unit↔fact evidence linkage. Used by ingest/cycle when a fact's
// provenance (context.source_text_unit_ids) is known. Idempotent; keeps the highest
// confidence per (fact, text_unit, relation).
function linkFactToTextUnits(factId, textUnitIds = [], { relation = 'evidence', confidence = 0.7 } = {}) {
  const fid = Number(factId);
  if (!Number.isInteger(fid)) return 0;
  const ids = [...new Set((Array.isArray(textUnitIds) ? textUnitIds : [textUnitIds]).map(Number).filter(Number.isInteger))];
  if (!ids.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO fact_text_units (fact_id, text_unit_id, relation, confidence, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(fact_id, text_unit_id, relation) DO UPDATE SET
      confidence=MAX(fact_text_units.confidence, excluded.confidence),
      updated_at=unixepoch()
  `);
  let count = 0;
  for (const tuId of ids) {
    const exists = db.prepare(`SELECT 1 FROM text_units WHERE id=?`).get(tuId);
    if (!exists) continue;
    count += stmt.run(fid, tuId, String(relation || 'evidence'), Math.max(0, Math.min(1, Number(confidence) || 0.7))).changes;
  }
  return count;
}

// G9: auto-link a text unit to facts it grounds. A fact of an entity already linked
// to this text unit is treated as evidence when its field/value text appears in the
// unit content. Content-grounded so links stay precise (no blanket entity fan-out).
function linkFactsForTextUnit(textUnitId) {
  const tuId = Number(textUnitId);
  if (!Number.isInteger(tuId)) return 0;
  const unit = db.prepare(`SELECT content FROM text_units WHERE id=?`).get(tuId);
  if (!unit) return 0;
  const haystack = String(unit.content ?? '').toLowerCase();
  if (!haystack) return 0;
  const entityIds = db.prepare(`SELECT DISTINCT entity_id FROM entity_text_units WHERE text_unit_id=?`).all(tuId).map(r => r.entity_id);
  if (!entityIds.length) return 0;
  const ph = entityIds.map(() => '?').join(',');
  const facts = db.prepare(`
    SELECT id, field, value FROM facts
    WHERE status='active' AND entity_id IN (${ph})
    LIMIT 2000
  `).all(...entityIds);
  let count = 0;
  for (const fact of facts) {
    const valueText = String(parseJson(fact.value, fact.value) ?? '').toLowerCase().trim();
    const fieldText = String(fact.field ?? '').toLowerCase().trim();
    const grounded = (valueText.length >= 3 && haystack.includes(valueText))
      || (fieldText.length >= 3 && haystack.includes(fieldText));
    if (grounded) count += linkFactToTextUnits(fact.id, [tuId], { relation: 'evidence', confidence: 0.7 });
  }
  return count;
}

function promptVersionForEdge() {
  return promptVersion('edgeDescription');
}

function normalizedTextUnitIds(value = []) {
  const raw = Array.isArray(value) ? value : parseJson(value, []);
  return [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
}

const ENTITY_EDGE_CONFIDENCE_DEFAULT = 0.5;
const ENTITY_EDGE_PROVENANCE_METHODS = new Set(['asserted', 'extracted', 'inferred']);
const ENTITY_EDGE_PROVENANCE_SOURCES = new Set(['manual', 'text_unit', 'system', 'import']);

function entityEdgeValidationError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizedEntityEdgeConfidence(value, { fallback = ENTITY_EDGE_CONFIDENCE_DEFAULT } = {}) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw entityEdgeValidationError('confidence must be a finite number between 0 and 1');
  }
  return value;
}

function defaultEntityEdgeProvenance(textUnitIds = []) {
  return normalizedTextUnitIds(textUnitIds).length
    ? { method: 'extracted', source: 'text_unit' }
    : { method: 'asserted', source: 'manual' };
}

function normalizeEntityEdgeProvenance(value, { textUnitIds = [] } = {}) {
  const fallback = defaultEntityEdgeProvenance(textUnitIds);
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw entityEdgeValidationError('provenance must be an object with method and source');
  }
  const method = String(value.method ?? fallback.method).trim().toLowerCase();
  const source = String(value.source ?? fallback.source).trim().toLowerCase();
  if (!ENTITY_EDGE_PROVENANCE_METHODS.has(method)) {
    throw entityEdgeValidationError(`provenance.method must be one of ${[...ENTITY_EDGE_PROVENANCE_METHODS].join(', ')}`);
  }
  if (!ENTITY_EDGE_PROVENANCE_SOURCES.has(source)) {
    throw entityEdgeValidationError(`provenance.source must be one of ${[...ENTITY_EDGE_PROVENANCE_SOURCES].join(', ')}`);
  }
  return { method, source };
}

function validateEntityEdgeSemantics({ confidence, provenance, textUnitIds = [] } = {}) {
  const hasExplicitConfidence = confidence !== undefined;
  const hasExplicitProvenance = provenance !== undefined;
  return {
    hasExplicitConfidence,
    hasExplicitProvenance,
    confidence: hasExplicitConfidence ? normalizedEntityEdgeConfidence(confidence) : undefined,
    provenance: hasExplicitProvenance ? normalizeEntityEdgeProvenance(provenance, { textUnitIds }) : undefined,
  };
}

function upsertEntityEdge({ from, to, kind, weight = 1.0, description = '', textUnitIds = [], evidenceCount = null, promptVersion = promptVersionForEdge(), confidence, provenance } = {}) {
  const existing = db.prepare(`SELECT text_unit_ids, evidence_count FROM entity_edges WHERE from_id=? AND to_id=? AND kind=?`).get(from, to, kind);
  const mergedIds = [...new Set([...normalizedTextUnitIds(existing?.text_unit_ids), ...normalizedTextUnitIds(textUnitIds)])];
  const existingEvidenceCount = Number(existing?.evidence_count ?? 0) || 0;
  const explicitEvidenceCount = Number(evidenceCount ?? 0) || 0;
  const mergedEvidenceCount = Math.max(existingEvidenceCount, explicitEvidenceCount, mergedIds.length);
  const semantics = validateEntityEdgeSemantics({ confidence, provenance, textUnitIds: mergedIds });
  const normalizedConfidence = semantics.hasExplicitConfidence
    ? semantics.confidence
    : normalizedEntityEdgeConfidence(undefined);
  const normalizedProvenance = semantics.hasExplicitProvenance
    ? semantics.provenance
    : normalizeEntityEdgeProvenance(undefined, { textUnitIds: mergedIds });
  db.prepare(`
    INSERT INTO entity_edges (from_id, to_id, kind, weight, confidence, provenance, description, evidence_count, text_unit_ids, prompt_version, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
      weight=MAX(entity_edges.weight, excluded.weight),
      confidence=CASE WHEN ? THEN excluded.confidence ELSE entity_edges.confidence END,
      provenance=CASE WHEN ? THEN excluded.provenance ELSE entity_edges.provenance END,
      description=CASE WHEN excluded.description != '' THEN excluded.description ELSE entity_edges.description END,
      evidence_count=excluded.evidence_count,
      text_unit_ids=excluded.text_unit_ids,
      prompt_version=excluded.prompt_version,
      updated_at=unixepoch()
  `).run(
    from,
    to,
    kind,
    weight,
    normalizedConfidence,
    JSON.stringify(normalizedProvenance),
    description,
    mergedEvidenceCount,
    JSON.stringify(mergedIds),
    promptVersion,
    semantics.hasExplicitConfidence ? 1 : 0,
    semantics.hasExplicitProvenance ? 1 : 0,
  );
}

function normalizeAlias(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function aliasValuesForEntityInput(entity = {}) {
  return [
    entity.name,
    ...(Array.isArray(entity.aliases) ? entity.aliases : []),
    ...(Array.isArray(entity.data?.aliases) ? entity.data.aliases : []),
  ].filter(value => String(value ?? '').trim());
}

function entityAliasRows(entityId) {
  return db.prepare(`
    SELECT alias, normalized, kind, source, status, created_at, updated_at
    FROM entity_aliases
    WHERE entity_id=?
    ORDER BY kind='canonical' DESC, updated_at DESC, alias
  `).all(entityId);
}

function rowToEntity(row) {
  return {
    ...row,
    data: parseJson(row.data, {}),
    tags: parseJson(row.tags, []),
    aliases: entityAliasRows(row.id),
  };
}

function resolveEntityAlias({ name, aliases = [], type = '' } = {}) {
  const normalizedValues = [...new Set(aliasValuesForEntityInput({ name, aliases })
    .map(normalizeAlias)
    .filter(Boolean))];
  if (!normalizedValues.length) return null;
  const typeClause = type ? `AND e.type=?` : '';
  const stmt = db.prepare(`
    SELECT e.*
    FROM entity_aliases a
    JOIN entities e ON e.id=a.entity_id
    WHERE a.normalized=? AND a.status='active' ${typeClause}
    ORDER BY a.kind='canonical' DESC, a.updated_at DESC
    LIMIT 1
  `);
  for (const normalized of normalizedValues) {
    const row = type ? stmt.get(normalized, type) : stmt.get(normalized);
    if (row) return row;
  }
  return null;
}

function recordEntityAliases({ entityId, name, aliases = [], source = 'manual' }) {
  const values = aliasValuesForEntityInput({ name, aliases });
  const stmt = db.prepare(`
    INSERT INTO entity_aliases (entity_id, alias, normalized, kind, source, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', unixepoch())
    ON CONFLICT(entity_id, normalized) DO UPDATE SET
      alias=excluded.alias,
      kind=CASE WHEN entity_aliases.kind='canonical' THEN entity_aliases.kind ELSE excluded.kind END,
      source=excluded.source,
      status='active',
      updated_at=unixepoch()
  `);
  let count = 0;
  for (const value of values) {
    const alias = String(value ?? '').trim();
    const normalized = normalizeAlias(alias);
    if (!normalized) continue;
    stmt.run(entityId, alias, normalized, alias === name ? 'canonical' : 'alias', source);
    count++;
  }
  return count;
}

function upsertEntity(entity = {}) {
  if (!entity.id || !entity.type || !entity.name) {
    throw Object.assign(new Error('id, type, name required'), { status: 400 });
  }
  const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  const exactIdOnly = entity.exactId === true || entity.mergeAliases === false;
  const exactExisting = db.prepare(`SELECT * FROM entities WHERE id=?`).get(entity.id);
  const existing = exactExisting ?? (exactIdOnly ? null : resolveEntityAlias({ name: entity.name, aliases, type: entity.type }));
  const entityId = existing?.id ?? entity.id;
  const currentById = db.prepare(`SELECT data, type FROM entities WHERE id=?`).get(entityId);
  const nextData = preserveFactRollup(entity.data ?? {}, parseJson(currentById?.data, {}));
  const action = existing && existing.id !== entity.id ? 'merged-alias' : (existing ? 'updated' : 'created');
  // Schema/type changes are governed (Plan 22): the create path freezes `type`
  // on conflict, so re-ingesting an existing entity with a different type does
  // NOT mutate it — instead we queue a reviewable, reversible `entity.type`
  // approval for the curator. (De-duped against an open proposal.)
  if (action === 'updated' && entity.type && currentById?.type && currentById.type !== entity.type) {
    const typeSubject = `entity:${entityId}`;
    const pendingType = db.prepare(`SELECT id FROM approvals WHERE kind='entity.type' AND subject=? AND status='pending' LIMIT 1`).get(typeSubject);
    if (!pendingType) {
      db.prepare(`INSERT INTO approvals (kind, subject, payload, risk_level, requested_by)
        VALUES ('entity.type', ?, ?, 'high', ?)`)
        .run(typeSubject, JSON.stringify({
          entity_id: entityId,
          current_type: currentById.type,
          proposed_type: entity.type,
          reason: 'type change proposed on ingest',
          source: entity.source ?? 'manual',
        }), entity.source ?? 'manual');
    }
  }
  db.prepare(`INSERT INTO entities (id,type,name,description,source,data,tags,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, description=excluded.description,
      source=excluded.source, data=excluded.data, tags=excluded.tags,
      status=COALESCE(excluded.status, entities.status), updated_at=unixepoch()`)
    .run(entityId, entity.type, entity.name, entity.description ?? '', entity.source ?? 'manual',
         JSON.stringify(nextData), JSON.stringify(entity.tags ?? []), entity.status ?? null);
  const aliasCount = recordEntityAliases({
    entityId,
    name: entity.name,
    aliases: [...aliases, ...(entityId !== entity.id ? [entity.id] : [])],
    source: entity.source ?? 'manual',
  });
  return { id: entityId, action, aliasCount, mergedFrom: entityId !== entity.id ? entity.id : null };
}

function sqliteVecStatus() {
  const embeddingRows = countRows(`SELECT COUNT(*) AS c FROM source_embeddings`);
  const nativeVectorRows = sqliteVecAvailable ? countRows(`SELECT COUNT(*) AS c FROM source_embedding_vec_refs`) : 0;
  const retrievalFlagEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.BRAIN_VECTOR_RETRIEVAL ?? '').toLowerCase());
  const embedPhaseEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.BRAIN_EMBED_PHASE ?? '').toLowerCase());
  const state = sqliteVecAvailable
    ? 'native_available'
    : process.env.BRAIN_SQLITE_VEC_EXTENSION
      ? 'native_unavailable'
      : 'native_not_configured';
  const degraded = !sqliteVecAvailable;
  return {
    available: sqliteVecAvailable,
    dimensions: VECTOR_DIMENSIONS,
    extension: process.env.BRAIN_SQLITE_VEC_EXTENSION ? 'configured' : 'not_configured',
    error: sqliteVecError || null,
    retrievalFeatureEnabled: retrievalFlagEnabled,
    embedPhaseEnabled,
    embeddingRows,
    nativeVectorRows,
    state,
    degraded,
    fallback: degraded ? 'fts5_keyword_and_embedding_json_scan' : null,
    degradation: degraded ? {
      kind: 'vector_capability_degraded',
      severity: retrievalFlagEnabled || embedPhaseEnabled ? 'warn' : 'info',
      reason: state,
      message: sqliteVecError
        ? `sqlite-vec unavailable: ${sqliteVecError}`
        : 'sqlite-vec native ANN is not configured; Brain is using FTS5 and JSON embedding fallback.',
      action: process.env.BRAIN_SQLITE_VEC_EXTENSION
        ? 'verify extension load path and node:sqlite loadExtension support'
        : 'set BRAIN_SQLITE_VEC_EXTENSION to enable native ANN after eval replay gates pass',
    } : null,
  };
}

function upsertSourceEmbeddingVector({ canonicalSourceId, sourceKind, embedding, refreshedAt = null } = {}) {
  if (!sqliteVecAvailable) return { indexed: false, reason: 'sqlite_vec_unavailable' };
  if (!canonicalSourceId || !Array.isArray(embedding)) return { indexed: false, reason: 'invalid_embedding' };
  if (embedding.length !== VECTOR_DIMENSIONS) return { indexed: false, reason: 'dimension_mismatch', dimensions: embedding.length, expected: VECTOR_DIMENSIONS };
  const vector = embedding.map(Number);
  if (vector.some(value => !Number.isFinite(value))) return { indexed: false, reason: 'invalid_embedding_value' };
  const ref = db.prepare(`
    INSERT INTO source_embedding_vec_refs (canonical_source_id, source_kind, refreshed_at)
    VALUES (?, ?, COALESCE(?, unixepoch()))
    ON CONFLICT(canonical_source_id) DO UPDATE SET
      source_kind=excluded.source_kind,
      refreshed_at=excluded.refreshed_at
    RETURNING id
  `).get(canonicalSourceId, sourceKind ?? '', refreshedAt);
  const rowid = Number(ref?.id);
  if (!Number.isInteger(rowid)) return { indexed: false, reason: 'missing_rowid' };
  db.prepare(`DELETE FROM source_embedding_vec WHERE rowid=?`).run(rowid);
  db.prepare(`
    INSERT INTO source_embedding_vec (rowid, embedding, canonical_source_id, source_kind, refreshed_at)
    VALUES (?, ?, ?, ?, COALESCE(?, unixepoch()))
  `).run(rowid, JSON.stringify(vector), canonicalSourceId, sourceKind ?? '', refreshedAt);
  return { indexed: true, rowid };
}

function vectorCandidatesForEmbedding(embedding, { limit = 5, maxAgeDays = 30 } = {}) {
  if (!sqliteVecAvailable || !Array.isArray(embedding) || embedding.length !== VECTOR_DIMENSIONS) return [];
  const vector = embedding.map(Number);
  if (vector.some(value => !Number.isFinite(value))) return [];
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(Number(maxAgeDays) || 30, 1) * 86400;
  try {
    return db.prepare(`
      SELECT canonical_source_id, source_kind, refreshed_at, distance
      FROM source_embedding_vec
      WHERE embedding MATCH ? AND k = ? AND refreshed_at >= ?
      ORDER BY distance
    `).all(JSON.stringify(vector), Math.max(Number(limit) || 5, 1), cutoff)
      .map(row => ({
        canonical_source_id: row.canonical_source_id,
        source_kind: row.source_kind,
        refreshed_at: row.refreshed_at,
        distance: row.distance,
        score: Math.round((1 / (1 + Number(row.distance))) * 1000) / 1000,
        score_kind: 'sqlite_vec_l2',
      }));
  } catch {
    return [];
  }
}

function vectorReplayGateThresholds(env = process.env) {
  const parsedMaxPrecisionRegression = Number(env.BRAIN_VECTOR_GATE_MAX_VOLUNTEERED_PRECISION_REGRESSION ?? 0);
  return {
    minSamples: Number(env.BRAIN_VECTOR_GATE_MIN_SAMPLES ?? 10),
    minRecallLift: Number(env.BRAIN_VECTOR_GATE_MIN_RECALL_LIFT ?? 0),
    minCoverageLift: Number(env.BRAIN_VECTOR_GATE_MIN_SOURCE_COVERAGE_LIFT ?? 0),
    maxP95Ms: Number(env.BRAIN_VECTOR_GATE_MAX_P95_MS ?? 250),
    maxLatencyRegression: Number(env.BRAIN_VECTOR_GATE_MAX_LATENCY_REGRESSION ?? 0.15),
    maxVolunteeredPrecisionRegression: Number.isFinite(parsedMaxPrecisionRegression)
      ? Math.max(0, parsedMaxPrecisionRegression)
      : 0,
  };
}

function vectorReplayGateConfig(env = process.env) {
  return {
    version: 'vector-replay-gate.v1',
    ...vectorReplayGateThresholds(env),
  };
}

function vectorReplayGateConfigVersion(config = vectorReplayGateConfig()) {
  return `vector-replay-gate:${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16)}`;
}

function persistVectorReplayGateVerdict(database = db, summary = {}, env = process.env) {
  const config = vectorReplayGateConfig(env);
  const configVersion = vectorReplayGateConfigVersion(config);
  const rolloutAllowed = summary?.rolloutAllowed === true || summary?.rolloutAllowed === 1;
  const comparisonMode = String(summary?.comparisonMode ?? summary?.comparison_mode ?? 'union');
  const storedSummary = {
    ...summary,
    config_version: configVersion,
    gate_config: config,
    rolloutAllowed,
    comparisonMode,
  };
  database.prepare(`
    INSERT INTO vector_replay_gate_state
      (config_version, config_json, rollout_allowed, guard, comparison_mode, summary_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(config_version) DO UPDATE SET
      config_json=excluded.config_json,
      rollout_allowed=excluded.rollout_allowed,
      guard=excluded.guard,
      comparison_mode=excluded.comparison_mode,
      summary_json=excluded.summary_json,
      updated_at=unixepoch()
  `).run(
    configVersion,
    JSON.stringify(config),
    rolloutAllowed ? 1 : 0,
    String(summary?.guard ?? 'unknown'),
    comparisonMode,
    JSON.stringify(storedSummary),
  );
  return {
    configVersion,
    config,
    rolloutAllowed,
    guard: String(summary?.guard ?? 'unknown'),
    comparisonMode,
    summary: storedSummary,
  };
}

function latestVectorReplayGateVerdict(database = db, env = process.env) {
  const config = vectorReplayGateConfig(env);
  const configVersion = vectorReplayGateConfigVersion(config);
  const row = database.prepare(`
    SELECT config_version, config_json, rollout_allowed, guard, comparison_mode, summary_json, updated_at
    FROM vector_replay_gate_state
    WHERE config_version=?
  `).get(configVersion);
  if (!row) return null;
  return {
    configVersion: row.config_version,
    config: parseJson(row.config_json, config),
    rolloutAllowed: Number(row.rollout_allowed) === 1,
    guard: String(row.guard ?? 'unknown'),
    comparisonMode: String(row.comparison_mode ?? 'union'),
    summary: parseJson(row.summary_json, {}),
    updatedAt: Number(row.updated_at) || null,
  };
}

function inferEdgesFromTextUnits({ limit = 500 } = {}) {
  const units = db.prepare(`
    SELECT tu.id, tu.content
    FROM text_units tu
    ORDER BY tu.updated_at DESC
    LIMIT ?
  `).all(limit);
  let edges = 0;
  for (const unit of units) {
    const linked = db.prepare(`SELECT entity_id FROM entity_text_units WHERE text_unit_id=?`).all(unit.id).map(r => r.entity_id);
    const linkedSet = new Set(linked);
    const evidenceFacts = db.prepare(`
      SELECT f.id, f.entity_id, f.field
      FROM fact_text_units ftu
      JOIN facts f ON f.id=ftu.fact_id
      WHERE ftu.text_unit_id=? AND f.status='active'
      ORDER BY f.confidence DESC, f.observed_at DESC
      LIMIT 100
    `).all(unit.id);
    for (const fact of evidenceFacts) linkedSet.add(fact.entity_id);
    const allLinked = [...linkedSet].sort();
    for (let i = 0; i < linked.length; i++) {
      for (let j = i + 1; j < linked.length; j++) {
        upsertEntityEdge({
          from: linked[i],
          to: linked[j],
          kind: 'co-mentioned',
          weight: 0.4,
          description: 'Co-mentioned in source text',
          textUnitIds: [unit.id],
        });
        upsertEntityEdge({
          from: linked[j],
          to: linked[i],
          kind: 'co-mentioned',
          weight: 0.4,
          description: 'Co-mentioned in source text',
          textUnitIds: [unit.id],
        });
        edges += 2;
      }
    }
    for (const fact of evidenceFacts) {
      for (const entityId of allLinked) {
        if (entityId === fact.entity_id) continue;
        upsertEntityEdge({
          from: fact.entity_id,
          to: entityId,
          kind: 'fact-context',
          weight: 0.6,
          description: `Fact ${fact.id} (${fact.field}) grounded with related entity in source text`,
          textUnitIds: [unit.id],
        });
        upsertEntityEdge({
          from: entityId,
          to: fact.entity_id,
          kind: 'fact-context',
          weight: 0.6,
          description: `Related entity grounded with fact ${fact.id} (${fact.field}) in source text`,
          textUnitIds: [unit.id],
        });
        edges += 2;
      }
    }
  }
  return { edges };
}

// G12: in-process, library-free modularity refinement. Weighted label propagation
// splits a large connected component into tighter sub-communities. Deterministic:
// nodes processed in sorted order; ties broken by smallest label. (NOT Leiden/
// Louvain/graphology — a self-contained LPA per Plan 25 non-goals.)
function refineByLabelPropagation(nodes, weightedAdj, { passes = 6 } = {}) {
  const label = new Map(nodes.map(n => [n, n]));
  const order = [...nodes].sort();
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const node of order) {
      const weights = new Map();
      for (const [nbr, w] of (weightedAdj.get(node) ?? new Map())) {
        const lbl = label.get(nbr);
        weights.set(lbl, (weights.get(lbl) ?? 0) + w);
      }
      if (!weights.size) continue;
      let best = label.get(node);
      let bestW = -Infinity;
      for (const [lbl, w] of [...weights.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        if (w > bestW) { bestW = w; best = lbl; }
      }
      if (best !== label.get(node)) { label.set(node, best); changed = true; }
    }
    if (!changed) break;
  }
  const groups = new Map();
  for (const node of nodes) {
    const lbl = label.get(node);
    if (!groups.has(lbl)) groups.set(lbl, []);
    groups.get(lbl).push(node);
  }
  return [...groups.values()].map(g => g.sort());
}

// Weighted modularity Q of a partition over a weighted undirected graph.
function weightedModularity(groups, weightedAdj) {
  let twoM = 0;
  const deg = new Map();
  for (const [u, nbrs] of weightedAdj) {
    let d = 0;
    for (const [, w] of nbrs) d += w;
    deg.set(u, d);
    twoM += d;
  }
  if (twoM === 0) return 0;
  const groupOf = new Map();
  groups.forEach((g, i) => g.forEach(n => groupOf.set(n, i)));
  let q = 0;
  for (const [u, nbrs] of weightedAdj) {
    for (const [v, w] of nbrs) {
      if (groupOf.get(u) === groupOf.get(v)) q += w - (deg.get(u) * deg.get(v)) / twoM;
    }
  }
  return Math.round((q / twoM) * 1000) / 1000;
}

function buildDeterministicCommunities() {
  const entities = db.prepare(`SELECT id, name, type, updated_at FROM entities`).all();
  const ids = new Set(entities.map(e => e.id));
  const typeById = new Map(entities.map(e => [e.id, e.type]));
  const adj = new Map(entities.map(e => [e.id, new Set()]));           // connectivity (BFS)
  const weightedAdj = new Map(entities.map(e => [e.id, new Map()]));   // weights (LPA + modularity)
  const edgeRows = db.prepare(`SELECT from_id, to_id, kind, weight, evidence_count, text_unit_ids, updated_at FROM entity_edges WHERE weight >= 0.3`).all();
  const edgeKindWeight = { 'alias-of': 0.25, 'co-mentioned': 0.7, mentions: 0.6, uses: 0.8, requires: 0.8 };
  const now = Math.floor(Date.now() / 1000);
  const activityWindow = Number(process.env.BRAIN_COMMUNITY_ACTIVITY_WINDOW_SECONDS ?? 30 * 86400);
  const splitThreshold = Math.max(3, Number(process.env.BRAIN_COMMUNITY_SPLIT_THRESHOLD ?? 6));
  // G12: edge weight blends edge_kind, evidence, recency AND entity-type affinity.
  const scoreEdge = (edge) => {
    const kindBoost = edgeKindWeight[edge.kind] ?? 0.5;
    const evidenceBoost = Math.min(0.3, Number(edge.evidence_count ?? 0) * 0.05);
    const recencyBoost = edge.updated_at && now - Number(edge.updated_at) <= activityWindow ? 0.1 : 0;
    const typeAffinity = typeById.get(edge.from_id) && typeById.get(edge.from_id) === typeById.get(edge.to_id) ? 0.1 : 0;
    return (Number(edge.weight ?? 0) * kindBoost) + evidenceBoost + recencyBoost + typeAffinity;
  };
  for (const edge of edgeRows) {
    if (!ids.has(edge.from_id) || !ids.has(edge.to_id) || edge.from_id === edge.to_id) continue;
    const score = scoreEdge(edge);
    if (score < 0.25) continue;
    adj.get(edge.from_id).add(edge.to_id);
    adj.get(edge.to_id).add(edge.from_id);
    weightedAdj.get(edge.from_id).set(edge.to_id, Math.max(weightedAdj.get(edge.from_id).get(edge.to_id) ?? 0, score));
    weightedAdj.get(edge.to_id).set(edge.from_id, Math.max(weightedAdj.get(edge.to_id).get(edge.from_id) ?? 0, score));
  }

  const seen = new Set();
  const liveCommunityIds = new Set();
  let count = 0;
  let reports = 0;
  let reportsSkippedMissingSources = 0;
  let splitComponents = 0;
  const communityReportPromptVersion = promptVersion('communityReport');
  const generatedReports = [];

  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    const queue = [entity.id];
    const component = [];
    seen.add(entity.id);
    while (queue.length) {
      const id = queue.shift();
      component.push(id);
      for (const next of adj.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    if (component.length < 2) continue;

    // G12: split large components into modularity-tighter sub-communities.
    let subgroups = [component];
    let modularity = 0;
    if (component.length >= splitThreshold) {
      const refined = refineByLabelPropagation(component, weightedAdj);
      if (refined.length > 1) {
        modularity = weightedModularity(refined, weightedAdj);
        subgroups = refined;
        splitComponents++;
      }
    }

    for (const group of subgroups) {
      if (group.length < 2) continue;
      const sorted = [...group].sort();
      const members = entities.filter(e => sorted.includes(e.id));
      const title = members.slice(0, 3).map(e => e.name).join(', ');
      const cid = `community:${sorted.join('|')}`;
      liveCommunityIds.add(cid);
      const typeCounts = members.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {});
      const ph = sorted.map(() => '?').join(',');
      const textUnitIds = db.prepare(`
        SELECT DISTINCT text_unit_id FROM entity_text_units
        WHERE entity_id IN (${ph})
        ORDER BY text_unit_id DESC LIMIT 25
      `).all(...sorted).map(r => r.text_unit_id);
      const factIds = db.prepare(`
        SELECT id FROM facts
        WHERE entity_id IN (${ph}) AND status='active'
        ORDER BY observed_at DESC LIMIT 25
      `).all(...sorted).map(r => r.id);

      // G13: compute rank + confidence from real evidence, not fixed constants.
      const membersWithEvidence = db.prepare(`
        SELECT COUNT(*) c FROM (
          SELECT entity_id FROM entity_text_units WHERE entity_id IN (${ph})
          UNION
          SELECT entity_id FROM facts WHERE entity_id IN (${ph}) AND status='active'
        )
      `).get(...sorted, ...sorted).c;
      const coverage = members.length ? membersWithEvidence / members.length : 0;
      const evidenceVolume = textUnitIds.length + factIds.length;
      const recencyFactor = members.some(m => m.updated_at && now - Number(m.updated_at) <= activityWindow) ? 0.5 : 0;
      const rank = Math.round((members.length + Math.min(8, evidenceVolume * 0.2) + recencyFactor) * 100) / 100;
      const confidence = Math.round(Math.max(0.3, Math.min(0.95, 0.35 + 0.45 * coverage + 0.1 * Math.min(1, evidenceVolume / 10))) * 1000) / 1000;

      db.prepare(`
        INSERT INTO communities (id, title, entity_ids, metadata, updated_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, entity_ids=excluded.entity_ids, metadata=excluded.metadata, updated_at=unixepoch()
      `).run(cid, title, JSON.stringify(sorted), JSON.stringify({
        method: 'deterministic-lpa-modularity-v3',
        size: sorted.length,
        type_counts: typeCounts,
        modularity,
        coverage: Math.round(coverage * 1000) / 1000,
        edge_policy: { min_weight: 0.3, min_edge_score: 0.25, split_threshold: splitThreshold, weighted_by: ['edge_kind', 'entity_type', 'recent_activity', 'evidence_count'] },
      }));

      const findings = [
        { rank: 1, finding: `${sorted.length} entities form a modularity-tight community (coverage ${Math.round(coverage * 100)}%).`, confidence: Math.round(Math.min(0.95, 0.5 + 0.4 * coverage) * 1000) / 1000 },
        { rank: 2, finding: `${textUnitIds.length} source text units and ${factIds.length} active facts are available for audit.`, confidence: Math.round(Math.min(0.9, 0.4 + 0.05 * evidenceVolume) * 1000) / 1000 },
      ];
      if (!textUnitIds.length && !factIds.length) {
        reportsSkippedMissingSources++;
        count++;
        continue;
      }
      db.prepare(`DELETE FROM community_reports WHERE community_id=? AND prompt_version=?`).run(cid, communityReportPromptVersion);
      db.prepare(`
        INSERT INTO community_reports
          (community_id, title, summary, findings, source_text_unit_ids, fact_ids, prompt_version, rank, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cid,
        title,
        `Deterministic community of ${members.map(e => e.name).slice(0, 8).join(', ')} (${Math.round(coverage * 100)}% evidence coverage, ${evidenceVolume} evidence items).`,
        JSON.stringify(findings),
        JSON.stringify(textUnitIds),
        JSON.stringify(factIds),
        communityReportPromptVersion,
        rank,
        confidence,
      );
      generatedReports.push({
        community_id: cid,
        title,
        source_text_unit_ids: textUnitIds,
        fact_ids: factIds,
        rank,
        confidence,
      });
      count++;
      reports++;
    }
  }

  if (reports || reportsSkippedMissingSources) {
    db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`).run(
      'brain-index',
      'brain:community-reports-generated',
      'community-reports',
      JSON.stringify({
        prompt_version: communityReportPromptVersion,
        generated: reports,
        skipped_missing_sources: reportsSkippedMissingSources,
        reports: generatedReports.slice(0, 50),
      }),
      JSON.stringify(['brain', 'community-report', communityReportPromptVersion]),
    );
  }

  // G14: stale-community cleanup. Membership changes mint a new community id; drop
  // any community no longer live this run, plus reports orphaned by the removal.
  let stale = 0;
  let orphanReports = 0;
  if (liveCommunityIds.size) {
    const keep = [...liveCommunityIds];
    const kp = keep.map(() => '?').join(',');
    stale = db.prepare(`DELETE FROM communities WHERE id NOT IN (${kp})`).run(...keep).changes;
  } else {
    stale = db.prepare(`DELETE FROM communities`).run().changes;
  }
  orphanReports = db.prepare(`DELETE FROM community_reports WHERE community_id NOT IN (SELECT id FROM communities)`).run().changes;

  return {
    communities: count,
    communityReports: reports,
    communityReportsSkippedMissingSources: reportsSkippedMissingSources,
    splitComponents,
    staleCommunitiesRemoved: stale,
    orphanReportsRemoved: orphanReports,
  };
}

// Purge expired memories on startup
db.prepare(`DELETE FROM agent_memories WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()`).run();

// Back-fill same-domain edges for all existing node pairs (idempotent)
{
  const domains = db.prepare(`SELECT DISTINCT domain FROM skill_nodes`).all().map(r => r.domain);
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO skill_edges (from_id, to_id, kind, weight, evidence_count, updated_at)
    VALUES (?, ?, 'same-domain', 0.5, 1, unixepoch())
  `);
  for (const domain of domains) {
    const ids = db.prepare(`SELECT skill_id FROM skill_nodes WHERE domain = ?`).all(domain).map(r => r.skill_id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i !== j) insertEdge.run(ids[i], ids[j]);
      }
    }
  }
}

// ─── Prepared statements ──────────────────────────────────────────────────────

const STMT = {
  upsertNode: db.prepare(`
    INSERT INTO skill_nodes (skill_id, name, description, domain, tags, compute_cost, chainable, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(skill_id) DO UPDATE SET
      name=excluded.name, description=excluded.description,
      domain=excluded.domain, tags=excluded.tags,
      compute_cost=excluded.compute_cost, chainable=excluded.chainable,
      updated_at=unixepoch()
  `),
  ftsDelete: ftsAvailable ? db.prepare(`DELETE FROM skill_fts WHERE rowid = ?`) : null,
  ftsInsert: ftsAvailable ? db.prepare(`INSERT INTO skill_fts(rowid, name, description, tags) VALUES (?, ?, ?, ?)`) : null,
  upsertEdge: db.prepare(`
    INSERT INTO skill_edges (from_id, to_id, kind, weight, evidence_count, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
      weight=excluded.weight,
      evidence_count=MAX(skill_edges.evidence_count, excluded.evidence_count),
      updated_at=unixepoch()
  `),
  nodeById:   db.prepare(`SELECT * FROM skill_nodes WHERE skill_id = ?`),
  nodeCount:  db.prepare(`SELECT COUNT(*) AS c FROM skill_nodes`),
  memCount:      db.prepare(`SELECT COUNT(*) AS c FROM agent_memories`),
  edgeCount:     db.prepare(`SELECT COUNT(*) AS c FROM skill_edges`),
  timelineCount: db.prepare(`SELECT COUNT(*) AS c FROM timeline`),
  entityCount:   db.prepare(`SELECT COUNT(*) AS c FROM entities`),
  factCount:     db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE status='active'`),
  incrUse:    db.prepare(`UPDATE skill_nodes SET use_count = use_count + 1 WHERE skill_id = ?`),
  domains:    db.prepare(`SELECT domain, COUNT(*) as count FROM skill_nodes GROUP BY domain ORDER BY count DESC`),
  topNodes:   db.prepare(`SELECT skill_id, name, use_count FROM skill_nodes ORDER BY use_count DESC LIMIT ?`),
  topDegree:  db.prepare(`
    SELECT n.skill_id, n.name, COUNT(e.id) AS degree
    FROM skill_nodes n JOIN skill_edges e ON e.from_id = n.skill_id
    GROUP BY n.skill_id ORDER BY degree DESC LIMIT ?
  `),
  topAgents: db.prepare(`SELECT agent_id, COUNT(*) as count FROM agent_memories GROUP BY agent_id ORDER BY count DESC LIMIT 10`),
  memByKey:  db.prepare(`SELECT * FROM agent_memories WHERE agent_id = ? AND mem_key = ? AND (expires_at IS NULL OR expires_at > unixepoch())`),
};

// ─── Graph ops ────────────────────────────────────────────────────────────────

function isIntegerValue(value) {
  return Number.isInteger(Number(value));
}

function upsertNode({ skillId, name, description = '', domain = 'knowledge', tags = [], computeCost = 0, chainable = true }) {
  const tagsJson = JSON.stringify(tags);
  const id = Number(skillId);
  if (ftsAvailable) {
    try { STMT.ftsDelete.run(id); } catch {}
  }
  STMT.upsertNode.run(id, name, description, domain, tagsJson, computeCost, chainable ? 1 : 0);
  // Mirror into entities table so /entities?type=skill works alongside agents/tasks
  db.prepare(`INSERT INTO entities (id,type,name,description,source,data,tags,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
      source=excluded.source,data=excluded.data,tags=excluded.tags,updated_at=unixepoch()`)
    .run(
      `skill:${id}`, 'skill', name, description, 'skillmesh',
      JSON.stringify({ skillId: id, domain, computeCost, chainable }),
      JSON.stringify(['skill', domain, ...tags]),
      null,
    );
  const textUnits = upsertTextUnitsFromSource({
    sourceKind: 'skill-definition',
    sourceId: `skill:${id}`,
    title: `${name} skill definition`,
    content: [
      `Skill ID: ${id}`,
      `Name: ${name}`,
      `Domain: ${domain}`,
      `Description: ${description}`,
      `Tags: ${(Array.isArray(tags) ? tags : []).join(', ') || '(none)'}`,
      `Compute cost: ${computeCost}`,
      `Chainable: ${chainable ? 'yes' : 'no'}`,
    ].join('\n'),
    metadata: {
      skill_id: id,
      domain,
      tags,
      compute_cost: computeCost,
      chainable,
    },
    processConfig: {
      strategy: 'heading',
      allow_small: true,
      parser: 'json-seed',
      prompt_version: 'skill-node-v1',
      extraction_config: { source: 'upsertNode' },
    },
  });
  if (Number.isInteger(Number(textUnits?.parentId))) {
    upsertEntityEdge({
      from: `text:${Number(textUnits.parentId)}`,
      to: `skill:${id}`,
      kind: 'source-of',
      weight: 0.9,
      description: `Skill definition text unit ${textUnits.parentId} is the source of skill ${id}.`,
      textUnitIds: textUnits.textUnitIds ?? [Number(textUnits.parentId)],
      evidenceCount: Array.isArray(textUnits.textUnitIds) ? textUnits.textUnitIds.length : 1,
      promptVersion: 'deterministic-skill-definition.v1',
    });
  }
  // Auto-wire same-domain edges to existing nodes in the same domain
  const peers = db.prepare(
    `SELECT skill_id FROM skill_nodes WHERE domain = ? AND skill_id != ?`
  ).all(domain, id);
  for (const p of peers) {
    try { STMT.upsertEdge.run(id, p.skill_id, 'same-domain', 0.5, 1); } catch { /* ignore dup */ }
    try { STMT.upsertEdge.run(p.skill_id, id, 'same-domain', 0.5, 1); } catch { /* ignore dup */ }
  }
}

function upsertEdge({ from: f, to: t, kind, weight = 1.0, evidenceCount = 1 }) {
  if (!SKILL_EDGE_KIND_SET.has(kind)) {
    throw Object.assign(new Error(`unsupported skill edge kind: ${kind}`), { status: 400 });
  }
  STMT.upsertEdge.run(Number(f), Number(t), kind, weight, Math.max(0, Number(evidenceCount ?? 1) || 0));
}

function deleteNode(skillId) {
  const id = Number(skillId);
  db.prepare(`DELETE FROM skill_edges WHERE from_id = ? OR to_id = ?`).run(id, id);
  db.prepare(`DELETE FROM skill_nodes WHERE skill_id = ?`).run(id);
  db.prepare(`DELETE FROM entities WHERE id = ?`).run(`skill:${id}`);
}

function rowToNode(r) {
  const tags = JSON.parse(r.tags ?? '[]');
  const blockedTags = BLOCKED_INSTALL_TAGS.filter(tag => tags.includes(tag));
  const suppressed = blockedTags.length > 0;
  return {
    skillId:     r.skill_id,
    name:        r.name,
    description: r.description,
    domain:      r.domain,
    tags,
    computeCost: r.compute_cost,
    chainable:   r.chainable === 1,
    useCount:    r.use_count ?? 0,
    routeEligible: !suppressed,
    suppressed,
    suppressionReason: suppressed ? `tagged: ${blockedTags.join(', ')}` : null,
  };
}

function ftsQuery(q, extraWhere = '', extraParams = [], limit = 20, offset = 0) {
  // Try strict AND match first; if empty fall back to OR (any word matches)
  const terms = String(q ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const safeQ = terms.join(' ');
  if (!safeQ) return [];
  for (const query of [safeQ, safeQ.split(/\s+/).join(' OR ')]) {
    try {
      const rows = db.prepare(`
        SELECT n.* FROM skill_nodes n
        JOIN skill_fts ON skill_fts.rowid = n.skill_id
        WHERE skill_fts MATCH ? ${extraWhere}
        ORDER BY rank LIMIT ? OFFSET ?
      `).all(query, ...extraParams, limit, offset);
      if (rows.length > 0) return rows.map(rowToNode);
    } catch { /* bad query — try next */ }
  }
  return [];
}

function queryNodes({ q, domain, tag, sort, limit = 20, offset = 0 }) {
  // FTS search when query present
  if (q && ftsAvailable) {
    const extraWhere = [domain ? 'AND n.domain = ?' : '', tag ? 'AND n.tags LIKE ?' : ''].filter(Boolean).join(' ');
    const extraParams = [domain, tag ? `%${tag}%` : undefined].filter(v => v !== undefined);
    const rows = ftsQuery(q, extraWhere, extraParams, limit, offset);
    if (rows.length > 0) return rows;
    // Fall through to LIKE if FTS returns nothing
  }

  // LIKE fallback or filter-only
  const conditions = [];
  const params = [];
  if (q)      { conditions.push('(name LIKE ? OR description LIKE ? OR tags LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (domain) { conditions.push('domain = ?');                          params.push(domain); }
  if (tag)    { conditions.push('tags LIKE ?');                         params.push(`%${tag}%`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const order = sort === 'popular' ? 'ORDER BY use_count DESC' : 'ORDER BY skill_id';

  return db.prepare(
    `SELECT * FROM skill_nodes ${where} ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset).map(rowToNode);
}

function getNodeById(id) {
  const r = STMT.nodeById.get(id);
  if (!r) return null;
  const node = rowToNode(r);
  // include neighbor IDs inline
  node.neighbors = db.prepare(
    `SELECT to_id AS skillId, kind, weight FROM skill_edges WHERE from_id = ?`
  ).all(id);
  return node;
}

function getNeighbors(skillId, kinds) {
  if (kinds?.length) {
    const ph = kinds.map(() => '?').join(',');
    return db.prepare(
      `SELECT n.* FROM skill_nodes n JOIN skill_edges e ON e.to_id = n.skill_id
       WHERE e.from_id = ? AND e.kind IN (${ph})`
    ).all(skillId, ...kinds).map(rowToNode);
  }
  return db.prepare(
    `SELECT n.* FROM skill_nodes n JOIN skill_edges e ON e.to_id = n.skill_id WHERE e.from_id = ?`
  ).all(skillId).map(rowToNode);
}

// ─── Path finding (BFS) ───────────────────────────────────────────────────────

function findPath(fromId, toId, maxDepth = 6, includeAllEdges = false) {
  if (fromId === toId) return [fromId];
  // Try related-only first; fall back to all edges if no path found
  for (const kindFilter of [
    `kind IN ('related','composes','requires')`,
    `1=1`,
  ]) {
    if (!includeAllEdges && kindFilter === `1=1`) continue;
    const visited = new Set([fromId]);
    const queue = [[fromId, [fromId]]];
    const adj = db.prepare(`SELECT to_id FROM skill_edges WHERE from_id = ? AND ${kindFilter}`);
    while (queue.length) {
      const [cur, path] = queue.shift();
      if (path.length > maxDepth) continue;
      for (const { to_id } of adj.all(cur)) {
        if (visited.has(to_id)) continue;
        const next = [...path, to_id];
        if (to_id === toId) return next;
        visited.add(to_id);
        queue.push([to_id, next]);
      }
    }
    // If related-only found nothing, try all edges
    if (kindFilter !== `1=1`) continue;
    break;
  }
  // All-edges BFS fallback
  const visited = new Set([fromId]);
  const queue = [[fromId, [fromId]]];
  const adj = db.prepare(`SELECT to_id FROM skill_edges WHERE from_id = ?`);
  while (queue.length) {
    const [cur, path] = queue.shift();
    if (path.length > maxDepth) continue;
    for (const { to_id } of adj.all(cur)) {
      if (visited.has(to_id)) continue;
      const next = [...path, to_id];
      if (to_id === toId) return next;
      visited.add(to_id);
      queue.push([to_id, next]);
    }
  }
  return null;
}

// ─── Skill recommendation ─────────────────────────────────────────────────────

function recommendSkills({ agentId, q, tags = [], domain, limit = 10, candidateDiscovery = false }) {
  // Score candidates: query/tag relevance, same-domain recall, edge-aware neighbor
  // evidence, then popularity/outcome adjustments only for candidates with a
  // relevance signal. Same-domain alone is intentionally down-ranked to avoid
  // clustering every recommendation around the requested domain.
  const scores = new Map();
  const signalKinds = new Map();
  const settleCache = new Map();

  const addScore = (skillId, delta, signal = null) => {
    const id = Number(skillId);
    const value = Number(delta);
    if (!Number.isInteger(id) || !Number.isFinite(value)) return;
    scores.set(id, (scores.get(id) ?? 0) + value);
    if (signal) {
      if (!signalKinds.has(id)) signalKinds.set(id, new Set());
      signalKinds.get(id).add(signal);
    }
  };

  // 1. FTS text match (with OR fallback for multi-word queries)
  if (q && ftsAvailable) {
    const results = ftsQuery(q, '', [], 30, 0);
    for (let i = 0; i < results.length; i++) {
      addScore(results[i].skillId, Math.max(1, 6 - i), 'fts'); // rank-weighted score
    }
  }

  // 2. Tag overlap
  if (tags.length) {
    const all = db.prepare(`SELECT skill_id, tags FROM skill_nodes`).all();
    for (const r of all) {
      const nodeTags = JSON.parse(r.tags ?? '[]');
      const overlap = tags.filter(t => nodeTags.includes(t)).length;
      if (overlap) addScore(r.skill_id, overlap * 2, 'tag');
    }
  }

  // 3. Domain recall. This keeps domain-only searches useful, but the adjustment
  //    below prevents domain from acting like a strong relevance signal.
  if (domain) {
    const inDomain = db.prepare(`SELECT skill_id FROM skill_nodes WHERE domain = ?`).all(domain);
    for (const r of inDomain) addScore(r.skill_id, RECOMMEND_DOMAIN_RECALL, 'domain');
  }

  // 4. Edge-aware neighbor boost from agent's recently used skills. New semantic
  //    edge kinds outrank plain related edges; same-domain edges are deliberately
  //    excluded here because they are handled by domain recall above.
  if (agentId) {
    const usedMem = db.prepare(
      `SELECT mem_key, content FROM agent_memories WHERE agent_id = ? AND mem_key LIKE 'used-skill-%' AND ${LIVE} ORDER BY created_at DESC LIMIT 10`
    ).all(agentId);
    const edgeKinds = Object.keys(PRIORITY_SKILL_EDGE_WEIGHTS);
    const edgeKindPh = edgeKinds.map(() => '?').join(',');
    const edgeStmt = db.prepare(`SELECT to_id, kind, weight FROM skill_edges WHERE from_id = ? AND kind IN (${edgeKindPh})`);
    for (const m of usedMem) {
      const sid = Number(m.mem_key?.replace('used-skill-', ''));
      if (!Number.isInteger(sid)) continue;
      const neighbors = edgeStmt.all(sid, ...edgeKinds);
      for (const n of neighbors) {
        const base = PRIORITY_SKILL_EDGE_WEIGHTS[n.kind] ?? 1;
        const edgeWeight = Number.isFinite(Number(n.weight)) ? Math.max(0.25, Math.min(2, Number(n.weight))) : 1;
        addScore(n.to_id, base * edgeWeight, n.kind === 'related' ? 'related-edge' : 'priority-edge');
      }
    }
  }

  // 5. Domain-only down-rank. The candidate remains available as a weak fallback,
  //    but text, tag, priority-edge, related-edge, or outcome evidence can beat it.
  for (const [skillId, kinds] of signalKinds.entries()) {
    if (kinds.size === 1 && kinds.has('domain')) addScore(skillId, RECOMMEND_DOMAIN_ONLY_PENALTY);
  }

  // 6. Outcome boost from settlement history. Like popularity, this only re-ranks
  //    already-relevant candidates; it never seeds unrelated skills into results.
  if (scores.size) {
    for (const skillId of [...scores.keys()]) {
      const settleRate = getSettleRate(skillId, settleCache);
      if (settleRate !== null) addScore(skillId, settleRate * RECOMMEND_OUTCOME_WEIGHT);
    }
  }

  // 7. Popularity boost (log scale) — re-rank ONLY candidates that already have a
  //    relevance signal (FTS/tag/domain/neighbor). Applying it to every popular
  //    skill turns popularity into an independent recall source, injecting
  //    query-independent popular skills into the results and letting a heavily-used
  //    but irrelevant skill outrank genuine query matches. Popularity should break
  //    ties among relevant candidates, not seed irrelevant ones.
  if (scores.size) {
    const candidateIds = [...scores.keys()];
    const ph = candidateIds.map(() => '?').join(',');
    const usage = db.prepare(
      `SELECT skill_id, use_count FROM skill_nodes WHERE use_count > 0 AND skill_id IN (${ph})`
    ).all(...candidateIds);
    for (const u of usage) addScore(u.skill_id, Math.log(u.use_count + 1) * 0.5);
  }

  if (!scores.size) {
    // No signals — return popular skills in domain/any
    const params = [];
    let where = '1=1';
    if (domain) { where += ' AND domain=?'; params.push(domain); }
    if (!candidateDiscovery) {
      where += ` AND NOT (${BLOCKED_INSTALL_TAGS.map(() => 'tags LIKE ?').join(' OR ')})`;
      for (const tag of BLOCKED_INSTALL_TAGS) params.push(`%"${tag}"%`);
    }
    params.push(limit);
    return db.prepare(
      `SELECT * FROM skill_nodes WHERE ${where} ORDER BY use_count DESC LIMIT ?`
    ).all(...params).map(rowToNode);
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const ids = sorted.map(([id]) => id);
  const ph = ids.map(() => '?').join(',');
  const nodeMap = new Map(
    db.prepare(`SELECT * FROM skill_nodes WHERE skill_id IN (${ph})`).all(...ids).map(r => [r.skill_id, rowToNode(r)])
  );
  const eligible = candidateDiscovery ? sorted : sorted.filter(([id]) => !nodeMap.get(id)?.suppressed);
  return eligible.slice(0, limit)
    .map(([id, score]) => {
      const node = nodeMap.get(id);
      return node ? { ...node, score: Math.round(score * 100) / 100 } : null;
    })
    .filter(Boolean);
}

// ─── Skill chain composer ─────────────────────────────────────────────────────

/** Per-skill settle rate from timeline events. Cached per request. */
function getSettleRate(skillId, cache) {
  if (cache.has(skillId)) return cache.get(skillId);
  const events = db.prepare(
    `SELECT data FROM timeline WHERE source='skillmesh' AND type='skill:executed' AND subject=? ORDER BY created_at DESC LIMIT 20`
  ).all(String(skillId));
  if (events.length === 0) { cache.set(skillId, null); return null; }
  let settled = 0;
  for (const e of events) {
    try { if (JSON.parse(e.data).settled) settled++; } catch {}
  }
  const rate = settled / events.length;
  cache.set(skillId, rate);
  return rate;
}

function composeChain({ goal = '', agentId, maxSteps = 8, maxCost = 500, mustInclude = [], domain } = {}) {
  const settleCache = new Map();
  // 1. Seed candidates via recommend
  const seeds = recommendSkills({ agentId, q: goal, domain, limit: 25 }).map(s => s.skillId);

  // Add mustInclude skills at front
  const pinned = mustInclude.map(Number).filter(id => STMT.nodeById.get(id));
  const candidates = [...new Set([...pinned, ...seeds])];

  if (!candidates.length) return { chain: [], totalCost: 0, valid: true, warnings: ['No matching skills found'] };

  // 2. Greedy BFS chain building
  const chain = [];
  const visited = new Set();
  const visitedNames = new Set(); // deduplicate by name (on-chain may have duplicate names)
  let totalCost = 0;
  const warnings = [];

  // Seed with highest-scored candidate
  const start = candidates[0];
  const startNode = STMT.nodeById.get(start);
  if (startNode) {
    chain.push({ step: 1, ...rowToNode(startNode) });
    visited.add(start);
    visitedNames.add(startNode.name);
    totalCost += startNode.compute_cost;
  }

  // Expand via related neighbors
  while (chain.length < maxSteps) {
    const tip = chain[chain.length - 1];
    if (!tip.chainable && chain.length > 1) break; // non-chainable must be last

    const neighbors = db.prepare(
      `SELECT n.*, e.weight FROM skill_nodes n
       JOIN skill_edges e ON e.to_id = n.skill_id
       WHERE e.from_id = ? AND e.kind = 'related' AND n.skill_id NOT IN (${[...visited].join(',') || 0})`
    ).all(tip.skillId);

    // Score neighbors: candidate match + popularity - cost + settle-rate boost/penalty
    const scored = neighbors
      .filter(n => totalCost + n.compute_cost <= maxCost && !visitedNames.has(n.name))
      .map(n => {
        const settleRate = getSettleRate(n.skill_id, settleCache);
        // settle-rate effect (only when we have data):
        //   >=80% → +5  bonus
        //   <50% → -10 penalty (skip if even worse)
        //   no data → 0 (neutral)
        let settleBonus = 0;
        if (settleRate !== null) {
          if (settleRate >= 0.8) settleBonus = 5;
          else if (settleRate < 0.5) settleBonus = -10;
        }
        return {
          ...n,
          settleRate,
          score: (candidates.includes(n.skill_id) ? 10 : 0)
               + n.use_count * 0.5
               - n.compute_cost * 0.01
               + settleBonus,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) break;
    const next = scored[0];
    chain.push({ step: chain.length + 1, ...rowToNode(next) });
    visited.add(next.skill_id);
    visitedNames.add(next.name);
    totalCost += next.compute_cost;
  }

  // 3. Force mustInclude skills into chain (append at end if missing)
  for (const id of pinned) {
    if (!visited.has(id)) {
      const n = STMT.nodeById.get(id);
      if (n && totalCost + n.compute_cost <= maxCost * 1.2) {
        chain.push({ step: chain.length + 1, ...rowToNode(n) });
        totalCost += n.compute_cost;
      } else {
        warnings.push(`mustInclude skill ${id} could not be added (cost budget or not found)`);
      }
    }
  }

  // 4. Validate chainability — non-chainable can only be last
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].chainable) {
      warnings.push(`Skill ${chain[i].skillId} (${chain[i].name}) is not chainable but appears at step ${i + 1} — moved to end`);
      const [removed] = chain.splice(i, 1);
      chain.push({ ...removed, step: chain.length + 1 });
      // Re-number
      chain.forEach((s, idx) => { s.step = idx + 1; });
      break;
    }
  }

  return {
    chain: chain.map(({ step, skillId, name, description, domain: d, tags, computeCost, chainable, useCount }) =>
      ({ step, skillId, name, description, domain: d, tags, computeCost, chainable, useCount })),
    totalCost,
    valid: warnings.length === 0,
    warnings,
  };
}

// ─── Memory summarization helpers ────────────────────────────────────────────

function getOldUnkeyedMemories(agentId, olderThanDays = 7, keepCount = 20) {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  return db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id=? AND mem_key IS NULL AND created_at < ? AND ${LIVE}
     ORDER BY created_at ASC`
  ).all(agentId, cutoff).slice(0, 200 - keepCount);
}

// ─── Memory ops ───────────────────────────────────────────────────────────────

const LIVE = `(expires_at IS NULL OR expires_at > unixepoch())`;
const ACTIVE_MEMORY = `${LIVE} AND status='active'`;

function memoryScopeFromInput(input = {}) {
  const controllerId = String(input.controller_id ?? input.controllerId ?? '').trim();
  return {
    project: String(input.project ?? '').slice(0, 240),
    taskId: String(input.task_id ?? input.taskId ?? '').slice(0, 240),
    sessionId: String(input.session_id ?? input.sessionId ?? '').slice(0, 240),
    userId: String(input.user_id ?? input.userId ?? (controllerId ? controllerScopeUserId(controllerId) : '')).slice(0, 240),
    turnId: String(input.turn_id ?? input.turnId ?? '').slice(0, 240),
  };
}

function scopedMemoryWhere({ project = '', taskId = '', sessionId = '', userId = '', turnId = '' } = {}) {
  const conds = [];
  const params = [];
  for (const [col, value] of [
    ['project', project],
    ['task_id', taskId],
    ['session_id', sessionId],
    ['user_id', userId],
    ['turn_id', turnId],
  ]) {
    if (!value) continue;
    conds.push(`(${col}=? OR ${col}='')`);
    params.push(value);
  }
  return { clause: conds.length ? ` AND ${conds.join(' AND ')}` : '', params };
}

function memoryOrderSql() {
  return `
    ORDER BY
      CASE WHEN task_id!='' THEN 0 WHEN project!='' THEN 1 WHEN session_id!='' THEN 2 WHEN user_id!='' THEN 3 ELSE 4 END,
      CASE WHEN agent_id='team-instructions'
        THEN (COALESCE(used_count, 0) * 2) - COALESCE(ignored_count, 0) - (COALESCE(harmful_count, 0) * 5)
        ELSE 0
      END DESC,
      ignored_count ASC,
      COALESCE(last_used_at, created_at) DESC
  `;
}

function similarMemoryHints({ agentId, content, key, scope, limit = 5 } = {}) {
  const words = String(content ?? key ?? '')
    .toLowerCase()
    .split(/[^a-z0-9:_-]+/)
    .filter(word => word.length >= 5)
    .slice(0, 5);
  if (!words.length) return [];
  const { clause, params } = scopedMemoryWhere(scope);
  const likes = words.map(() => `(lower(content) LIKE ? OR lower(mem_key) LIKE ?)`).join(' OR ');
  const likeParams = words.flatMap(word => [`%${word}%`, `%${word}%`]);
  return db.prepare(`
    SELECT id, agent_id, mem_key, content, tags, project, task_id, session_id, user_id, turn_id, status, supersedes, superseded_by, created_at
    FROM agent_memories
    WHERE (agent_id=? OR visibility='public')
      AND ${ACTIVE_MEMORY}
      ${clause}
      AND (${likes})
    ${memoryOrderSql()}
    LIMIT ?
  `).all(agentId, ...params, ...likeParams, limit).map(row => ({ ...row, tags: parseJson(row.tags, []) }));
}

function storeMemory(input) {
  const { agentId, key, content, tags = [], shared = false, ttl } = input;
  const tagsJson   = JSON.stringify(tags);
  const visibility = shared ? 'public' : 'private';
  const expiresAt  = ttl ? Math.floor(Date.now() / 1000) + ttl : null;
  const status = String(input.status ?? 'active').trim() || 'active';
  const durableMetadata = input.durable_candidate && typeof input.durable_candidate === 'object' && !Array.isArray(input.durable_candidate)
    ? input.durable_candidate
    : {};
  const durableMetadataJson = JSON.stringify(durableMetadata);
  const sourceIds = Array.isArray(durableMetadata.source_ids) ? durableMetadata.source_ids : [];
  const sourceIdsJson = JSON.stringify(sourceIds);
  const confidence = (durableMetadata.confidence != null && Number.isFinite(Number(durableMetadata.confidence))) ? Number(durableMetadata.confidence) : null;
  const scope = memoryScopeFromInput(input);
  const supersedes = input.supersedes == null ? null : Number(input.supersedes);
  const hints = similarMemoryHints({ agentId, content, key, scope });
  let id = null;

  if (key != null && key !== '') {
    const existing = db.prepare(`SELECT id FROM agent_memories WHERE agent_id = ? AND mem_key = ? AND ${ACTIVE_MEMORY}`).get(agentId, key);
    if (existing) {
      db.prepare(`
        UPDATE agent_memories
        SET content=?, tags=?, visibility=?, status=?, durable_metadata=?, source_ids=?, confidence=?, expires_at=?, project=?, task_id=?, session_id=?, user_id=?, turn_id=?, supersedes=?, updated_at=unixepoch()
        WHERE id=?
      `).run(content, tagsJson, visibility, status, durableMetadataJson, sourceIdsJson, confidence, expiresAt, scope.project, scope.taskId, scope.sessionId, scope.userId, scope.turnId, supersedes, existing.id);
      id = Number(existing.id);
    } else {
      const r = db.prepare(`
        INSERT INTO agent_memories (agent_id, mem_key, content, tags, visibility, status, durable_metadata, source_ids, confidence, expires_at, project, task_id, session_id, user_id, turn_id, supersedes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(agentId, key, content, tagsJson, visibility, status, durableMetadataJson, sourceIdsJson, confidence, expiresAt, scope.project, scope.taskId, scope.sessionId, scope.userId, scope.turnId, supersedes);
      id = Number(r.lastInsertRowid);
    }
  } else {
    const r = db.prepare(`
      INSERT INTO agent_memories (agent_id, mem_key, content, tags, visibility, status, durable_metadata, source_ids, confidence, expires_at, project, task_id, session_id, user_id, turn_id, supersedes)
      VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(agentId, content, tagsJson, visibility, status, durableMetadataJson, sourceIdsJson, confidence, expiresAt, scope.project, scope.taskId, scope.sessionId, scope.userId, scope.turnId, supersedes);
    id = Number(r.lastInsertRowid);
  }
  if (Number.isInteger(supersedes) && id) {
    db.prepare(`UPDATE agent_memories SET status='superseded', superseded_by=? WHERE id=? AND status='active'`).run(id, supersedes);
    upsertEntityEdge({
      from: `memory:${id}`,
      to: `memory:${supersedes}`,
      kind: 'supersedes',
      weight: 1,
      description: `Memory ${id} supersedes prior memory ${supersedes}.`,
      evidenceCount: 1,
      promptVersion: 'deterministic-memory-write.v1',
    });
  }
  if (id) {
    const textUnits = upsertTextUnitsFromSource({
      sourceKind: 'memory',
      sourceId: `memory:${id}`,
      title: key ? `${agentId}:${key}` : `memory:${id}`,
      content,
      metadata: {
        memory_id: id,
        agent_id: agentId,
        mem_key: key ?? null,
        shared,
        visibility,
        status,
        tags,
        project: scope.project,
        task_id: scope.taskId,
        session_id: scope.sessionId,
        user_id: scope.userId,
        turn_id: scope.turnId,
        supersedes,
        durable_candidate: Object.keys(durableMetadata).length ? durableMetadata : null,
      },
      processConfig: {
        strategy: 'auto',
        allow_small: true,
        parser: 'plain-text',
        prompt_version: 'memory-write-v1',
        extraction_config: { source: 'storeMemory' },
      },
    });
    if (Number.isInteger(Number(textUnits?.parentId))) {
      upsertEntityEdge({
        from: `text:${Number(textUnits.parentId)}`,
        to: `memory:${id}`,
        kind: 'source-of',
        weight: 0.9,
        description: `Memory text unit ${textUnits.parentId} is the source of memory ${id}.`,
        textUnitIds: textUnits.textUnitIds ?? [Number(textUnits.parentId)],
        evidenceCount: Array.isArray(textUnits.textUnitIds) ? textUnits.textUnitIds.length : 1,
        promptVersion: 'deterministic-memory-write.v1',
      });
    }
    if (scope.taskId) {
      upsertEntityEdge({
        from: `memory:${id}`,
        to: scope.taskId.startsWith('task:') ? scope.taskId : `task:${scope.taskId}`,
        kind: 'supports-task',
        weight: 0.85,
        description: `Memory ${id} was stored with task scope ${scope.taskId}.`,
        textUnitIds: textUnits?.textUnitIds ?? [],
        evidenceCount: Math.max(1, Array.isArray(textUnits?.textUnitIds) ? textUnits.textUnitIds.length : 0),
        promptVersion: 'deterministic-memory-write.v1',
      });
    }
  }
  return { id, similar: hints.filter(h => h.id !== id) };
}

function getMemories(agentId, { limit = 20, tag, offset = 0, project = '', taskId = '', sessionId = '', userId = '', turnId = '', includeRetired = false } = {}) {
  const scope = scopedMemoryWhere({ project, taskId, sessionId, userId, turnId });
  const live = includeRetired ? LIVE : ACTIVE_MEMORY;
  if (tag) {
    return db.prepare(
      `SELECT * FROM agent_memories WHERE agent_id=? AND tags LIKE ? AND ${live}${scope.clause} ${memoryOrderSql()} LIMIT ? OFFSET ?`
    ).all(agentId, `%${tag}%`, ...scope.params, limit, offset);
  }
  return db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id=? AND ${live}${scope.clause} ${memoryOrderSql()} LIMIT ? OFFSET ?`
  ).all(agentId, ...scope.params, limit, offset);
}

function searchMemories(agentId, q, limit = 10, scopeInput = {}) {
  const like = `%${q}%`;
  const scope = scopedMemoryWhere(scopeInput);
  return db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id=? AND (content LIKE ? OR mem_key LIKE ? OR tags LIKE ?) AND ${ACTIVE_MEMORY}${scope.clause} ${memoryOrderSql()} LIMIT ?`
  ).all(agentId, like, like, like, ...scope.params, limit);
}

function getSharedMemories({ tag, q, limit = 20, project = '', taskId = '', sessionId = '', userId = '', turnId = '', includeRetired = false } = {}) {
  const scope = scopedMemoryWhere({ project, taskId, sessionId, userId, turnId });
  const live = includeRetired ? LIVE : ACTIVE_MEMORY;
  if (q) {
    const like = `%${q}%`;
    return db.prepare(
      `SELECT * FROM agent_memories WHERE visibility='public' AND (content LIKE ? OR mem_key LIKE ? OR tags LIKE ?) AND ${live}${scope.clause} ${memoryOrderSql()} LIMIT ?`
    ).all(like, like, like, ...scope.params, limit);
  }
  if (tag) {
    return db.prepare(
      `SELECT * FROM agent_memories WHERE visibility='public' AND tags LIKE ? AND ${live}${scope.clause} ${memoryOrderSql()} LIMIT ?`
    ).all(`%${tag}%`, ...scope.params, limit);
  }
  return db.prepare(
    `SELECT * FROM agent_memories WHERE visibility='public' AND ${live}${scope.clause} ${memoryOrderSql()} LIMIT ?`
  ).all(...scope.params, limit);
}

function deleteMemory(agentId, key) {
  db.prepare(`DELETE FROM agent_memories WHERE agent_id=? AND mem_key=?`).run(agentId, key);
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function countRows(sql, ...params) {
  try {
    return Number(db.prepare(sql).get(...params)?.c ?? 0);
  } catch {
    return 0;
  }
}

function brainHealthSignals({ cycleMaxAgeSeconds = Number(process.env.BRAIN_HEALTH_CYCLE_MAX_AGE_SECONDS ?? 90000) } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const skillCount = Number(STMT.nodeCount.get().c ?? 0);
  const ftsRows = ftsAvailable ? countRows(`SELECT COUNT(*) AS c FROM skill_fts`) : 0;
  const ftsCoverage = skillCount === 0 ? 1 : ftsRows / skillCount;
  const connectivity = auditBrainConnectivity({ sampleLimit: 8 });

  const entityTotal = countRows(`SELECT COUNT(*) AS c FROM entities WHERE COALESCE(status, 'active')='active'`);
  const duplicateEntityRows = countRows(`
    SELECT COALESCE(SUM(c - 1), 0) AS c
    FROM (
      SELECT lower(trim(name)) AS normalized, COUNT(*) AS c
      FROM entities
      WHERE COALESCE(status, 'active')='active' AND trim(name)!=''
      GROUP BY normalized
      HAVING c > 1
    )
  `);
  const dedupRatio = entityTotal === 0 ? 0 : duplicateEntityRows / entityTotal;

  const factTotal = countRows(`SELECT COUNT(*) AS c FROM facts`);
  const disputedFacts = countRows(`SELECT COUNT(*) AS c FROM facts WHERE status='disputed'`);
  const contradictionRate = factTotal === 0 ? 0 : disputedFacts / factTotal;
  const factStatus = factStatusProjection();
  const factEntityIntegrity = auditFactEntityIntegrity({ limit: 8 });

  const orphanEntities = countRows(`
    SELECT COUNT(*) AS c
    FROM entities e
    WHERE COALESCE(e.status, 'active')='active'
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id=e.id AND f.status='active')
      AND NOT EXISTS (SELECT 1 FROM entity_edges ee WHERE ee.from_id=e.id OR ee.to_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM entity_text_units etu WHERE etu.entity_id=e.id)
  `);
  const memoryTotal = countRows(`SELECT COUNT(*) AS c FROM agent_memories`);
  const staleMemories = countRows(`SELECT COUNT(*) AS c FROM agent_memories WHERE status IN ('retired','superseded')`);
  const orphanStaleDenominator = entityTotal + memoryTotal;
  const orphanStaleRate = orphanStaleDenominator === 0 ? 0 : (orphanEntities + staleMemories) / orphanStaleDenominator;

  const latestCycle = db.prepare(`
    SELECT id, created_at, data FROM timeline
    WHERE source='brain-cycle' AND type='brain:cycle-report'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get();
  const cycleAgeSeconds = latestCycle ? Math.max(0, now - Number(latestCycle.created_at ?? now)) : null;
  const cycleFreshness = latestCycle
    ? Math.max(0, 1 - (cycleAgeSeconds / Math.max(1, Number(cycleMaxAgeSeconds) || 1)))
    : 0;
  const vectorCapability = sqliteVecStatus();
  const vectorCapabilityScore = vectorCapability.available
    ? 100
    : vectorCapability.retrievalFeatureEnabled || vectorCapability.embedPhaseEnabled
      ? 55
      : 75;

  const components = {
    ftsCoverage: {
      score: clampScore(ftsCoverage * 100),
      coverage: Math.round(ftsCoverage * 1000) / 1000,
      indexed: ftsRows,
      total: skillCount,
      available: ftsAvailable,
    },
    dedupRatio: {
      score: clampScore((1 - dedupRatio) * 100),
      ratio: Math.round(dedupRatio * 1000) / 1000,
      duplicates: duplicateEntityRows,
      total: entityTotal,
    },
    contradictionRate: {
      score: clampScore((1 - contradictionRate) * 100),
      rate: Math.round(contradictionRate * 1000) / 1000,
      disputed: disputedFacts,
      total: factTotal,
    },
    factStatus: {
      active: factStatus.active,
      superseded: factStatus.superseded,
      disputed: factStatus.disputed,
      other: factStatus.other,
      total: factStatus.total,
    },
    factEntityIntegrity: {
      score: factEntityIntegrity.ok ? 100 : 0,
      status: factEntityIntegrity.status,
      totalFacts: factEntityIntegrity.total_facts,
      orphanFacts: factEntityIntegrity.orphan_count,
      sample: factEntityIntegrity.orphan_facts,
      sampleTruncated: factEntityIntegrity.truncated,
    },
    orphanStale: {
      score: clampScore((1 - orphanStaleRate) * 100),
      rate: Math.round(orphanStaleRate * 1000) / 1000,
      orphanEntities,
      staleMemories,
      total: orphanStaleDenominator,
    },
    cycleFreshness: {
      score: clampScore(cycleFreshness * 100),
      latestId: latestCycle?.id ?? null,
      ageSeconds: cycleAgeSeconds,
      maxAgeSeconds: Number(cycleMaxAgeSeconds) || 0,
    },
    vectorCapability: {
      score: clampScore(vectorCapabilityScore),
      ...vectorCapability,
    },
    graphConnectivity: {
      score: connectivity.agentTeamEdges.missing === 0 ? 100 : 65,
      status: connectivity.agentTeamEdges.missing === 0 ? 'ok' : 'warn',
      agentTeamEdges: connectivity.agentTeamEdges,
      isolatedEntities: connectivity.isolatedEntities,
      latestRepair: connectivity.latestRepair,
    },
  };

  const weights = {
    ftsCoverage: 0.18,
    dedupRatio: 0.18,
    contradictionRate: 0.18,
    orphanStale: 0.18,
    cycleFreshness: 0.18,
    vectorCapability: 0.1,
  };
  const score = clampScore(Object.entries(weights).reduce((sum, [key, weight]) => sum + components[key].score * weight, 0));
  return {
    generatedAt: new Date().toISOString(),
    score,
    status: score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'critical',
    components,
  };
}

function decodeEntityIdentitySegment(value) {
  try {
    return decodeURIComponent(String(value ?? '')).trim();
  } catch {
    return '';
  }
}

function parseIdaccAgentEntityId(id, data = {}) {
  const rawId = String(id ?? '');
  const dataTeamId = String(data?.teamId ?? '').trim();
  const dataTeam = String(data?.team ?? '').trim();
  const dataAgent = String(data?.name ?? '').trim();
  if (dataTeamId && dataTeam && dataAgent && rawId.startsWith('agent:')) {
    return {
      team: dataTeam,
      teamId: dataTeamId,
      agent: dataAgent,
      teamEntityId: `team:id:${encodeURIComponent(dataTeamId)}`,
    };
  }
  const stableMatch = /^agent:team:([^:]+):(.+)$/.exec(rawId);
  if (stableMatch) {
    const teamId = decodeEntityIdentitySegment(stableMatch[1]);
    const team = dataTeam || teamId;
    const agent = dataAgent || decodeEntityIdentitySegment(stableMatch[2]);
    if (!teamId || !team || !agent) return null;
    return {
      team,
      teamId,
      agent,
      teamEntityId: `team:id:${encodeURIComponent(teamId)}`,
    };
  }
  const match = /^agent:([^:]+):(.+)$/.exec(rawId);
  if (!match) return null;
  const team = match[1].trim();
  const agent = match[2].trim();
  if (!team || !agent) return null;
  return {
    team,
    agent,
    teamEntityId: `team:${team}`,
  };
}

function listIdaccAgentTeamRows() {
  return db.prepare(`
    SELECT id, name, status, source, data, updated_at
    FROM entities
    WHERE type='agent'
      AND (
        id LIKE 'agent:%:%'
        OR (
          source='idagents'
          AND json_extract(data, '$.teamId') IS NOT NULL
          AND trim(json_extract(data, '$.teamId')) != ''
        )
      )
      AND COALESCE(status, 'active') NOT IN ('deleted','archived','retired','removed')
    ORDER BY id
  `).all().map(row => {
    const parsed = parseIdaccAgentEntityId(row.id, parseJson(row.data, {}));
    if (!parsed) return null;
    return { ...row, ...parsed };
  }).filter(Boolean);
}

function memberOfEdgeSet() {
  return new Set(db.prepare(`
    SELECT from_id, to_id
    FROM entity_edges
    WHERE kind='member-of'
      AND from_id LIKE 'agent:%'
      AND to_id LIKE 'team:%'
  `).all().map(row => `${row.from_id}->${row.to_id}`));
}

function latestConnectivityRepairEvent() {
  const row = db.prepare(`
    SELECT id, source, subject, data, created_at
    FROM timeline
    WHERE type='graph:connectivity-repaired'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get();
  return row ? {
    id: row.id,
    source: row.source,
    subject: row.subject,
    data: parseJson(row.data, {}),
    createdAt: row.created_at,
  } : null;
}

function auditBrainConnectivity({ sampleLimit = 20 } = {}) {
  const limit = Math.min(Math.max(Number(sampleLimit) || 20, 1), 200);
  const agentRows = listIdaccAgentTeamRows();
  const edgeSet = memberOfEdgeSet();
  const byTeam = {};
  const missing = [];
  for (const row of agentRows) {
    const bucket = byTeam[row.teamEntityId] ??= {
      team: row.team,
      teamEntityId: row.teamEntityId,
      agents: 0,
      missingMemberOf: 0,
    };
    bucket.agents++;
    const edgeKey = `${row.id}->${row.teamEntityId}`;
    if (!edgeSet.has(edgeKey)) {
      bucket.missingMemberOf++;
      missing.push({
        agentEntityId: row.id,
        agent: row.agent,
        team: row.team,
        teamEntityId: row.teamEntityId,
        status: row.status ?? null,
        source: row.source ?? null,
      });
    }
  }

  const isolatedWhere = `
    FROM entities e
    WHERE COALESCE(e.status, 'active') NOT IN ('deleted','archived','retired','removed')
      AND e.type NOT IN ('probe')
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id=e.id AND f.status='active')
      AND NOT EXISTS (SELECT 1 FROM entity_edges ee WHERE ee.from_id=e.id OR ee.to_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM entity_text_units etu WHERE etu.entity_id=e.id)
  `;
  const isolatedTotal = countRows(`SELECT COUNT(*) AS c ${isolatedWhere}`);
  const isolatedIdaccAgent = `e.type='agent' AND (
    e.id LIKE 'agent:%:%'
    OR (
      e.source='idagents'
      AND json_extract(e.data, '$.teamId') IS NOT NULL
      AND trim(json_extract(e.data, '$.teamId')) != ''
    )
  )`;
  const isolatedAgentNamespace = countRows(`SELECT COUNT(*) AS c ${isolatedWhere} AND (${isolatedIdaccAgent})`);
  const reviewCandidateTotal = countRows(`SELECT COUNT(*) AS c ${isolatedWhere} AND NOT (${isolatedIdaccAgent})`);
  const reviewCandidates = db.prepare(`
    SELECT e.id, e.type, e.name, e.status, e.source, e.updated_at
    ${isolatedWhere}
      AND NOT (${isolatedIdaccAgent})
    ORDER BY e.updated_at DESC, e.id ASC
    LIMIT ?
  `).all(limit);

  const teamEntityCount = countRows(`
    SELECT COUNT(*) AS c
    FROM entities
    WHERE type='team' OR id LIKE 'team:%'
  `);
  const operationalNoEdgeWhere = `
    FROM entities e
    WHERE COALESCE(e.status, 'active') NOT IN ('deleted','archived','retired','removed')
      AND e.type IN ('task','plan')
      AND NOT EXISTS (SELECT 1 FROM entity_edges ee WHERE ee.from_id=e.id OR ee.to_id=e.id)
      AND (
        json_extract(e.data, '$.owner') IS NOT NULL
        OR json_extract(e.data, '$.assignee') IS NOT NULL
        OR json_extract(e.data, '$.agent') IS NOT NULL
        OR json_extract(e.data, '$.team') IS NOT NULL
        OR json_extract(e.data, '$.__fact_rollup.assignee.value') IS NOT NULL
        OR json_extract(e.data, '$.__fact_rollup.completed_by.value') IS NOT NULL
      )
  `;
  const operationalNoEdgeTotal = countRows(`SELECT COUNT(*) AS c ${operationalNoEdgeWhere}`);
  const operationalNoEdgeSample = db.prepare(`
    SELECT e.id, e.type, e.name, e.status, e.source, e.updated_at,
           json_extract(e.data, '$.team') AS team,
           COALESCE(
             json_extract(e.data, '$.owner'),
             json_extract(e.data, '$.assignee'),
             json_extract(e.data, '$.agent'),
             json_extract(e.data, '$.__fact_rollup.assignee.value'),
             json_extract(e.data, '$.__fact_rollup.completed_by.value')
           ) AS owner
    ${operationalNoEdgeWhere}
    ORDER BY e.updated_at DESC, e.id ASC
    LIMIT ?
  `).all(limit);

  return {
    generatedAt: new Date().toISOString(),
    status: missing.length || reviewCandidateTotal || operationalNoEdgeTotal ? 'warn' : 'ok',
    policy: {
      deterministicRepair: 'encoded primary agent ids and stable/legacy secondary agent namespaces -> authoritative team member-of edges, source-backed isolated links, and explicit task/plan provenance links only',
      unsafeActions: ['alias merge', 'identity merge', 'fact resolution', 'skill publish', 'wallet/key/controller change'],
      ambiguousNodes: 'queued for graph.connectivity.review learning tasks by maintenance; not auto-linked',
    },
    agentTeamEdges: {
      totalAgents: agentRows.length,
      teams: Object.values(byTeam).sort((a, b) => b.missingMemberOf - a.missingMemberOf || b.agents - a.agents || a.team.localeCompare(b.team)),
      missing: missing.length,
      missingSample: missing.slice(0, limit),
      connected: Math.max(0, agentRows.length - missing.length),
      teamEntities: teamEntityCount,
    },
    isolatedEntities: {
      total: isolatedTotal,
      idaccAgentNamespace: isolatedAgentNamespace,
      reviewCandidateTotal,
      reviewCandidates,
    },
    operationalProvenance: {
      noEdgeCandidates: operationalNoEdgeTotal,
      sample: operationalNoEdgeSample,
    },
    latestRepair: latestConnectivityRepairEvent(),
  };
}

function connectIdaccAgentTeamGraph({ dryRun = false, source = 'brain-connectivity', sampleLimit = 20 } = {}) {
  const before = auditBrainConnectivity({ sampleLimit });
  const agentRows = listIdaccAgentTeamRows();
  const edgeSet = memberOfEdgeSet();
  const teams = new Map();
  for (const row of agentRows) {
    const bucket = teams.get(row.teamEntityId) ?? {
      team: row.team,
      teamEntityId: row.teamEntityId,
      agents: [],
    };
    bucket.agents.push(row);
    teams.set(row.teamEntityId, bucket);
  }

  const missingRows = agentRows.filter(row => !edgeSet.has(`${row.id}->${row.teamEntityId}`));
  const existingTeams = new Set(db.prepare(`
    SELECT id FROM entities WHERE type='team' OR id LIKE 'team:%'
  `).all().map(row => row.id));

  const result = {
    dryRun: Boolean(dryRun),
    teamsSeen: teams.size,
    teamsCreated: [...teams.values()].filter(team => !existingTeams.has(team.teamEntityId)).length,
    teamsUpdated: [...teams.values()].filter(team => existingTeams.has(team.teamEntityId)).length,
    agentsSeen: agentRows.length,
    agentsConnected: missingRows.length,
    edgesCreated: missingRows.length,
    before,
    policy: before.policy,
  };
  if (dryRun) return { ...result, after: before };

  for (const team of teams.values()) {
    upsertEntity({
      id: team.teamEntityId,
      type: 'team',
      name: team.team,
      description: `IDACC team ${team.team} derived from agent namespace membership.`,
      source,
      data: {
        idacc_team: team.team,
        ...(team.agents[0]?.teamId ? { manager_team_id: team.agents[0].teamId } : {}),
        derived_from: 'agent-entity-namespace',
        agent_count: team.agents.length,
      },
      tags: ['idacc', 'team', 'graph-connectivity'],
      status: 'active',
      exactId: true,
      mergeAliases: false,
    });
  }
  for (const row of missingRows) {
    upsertEntityEdge({
      from: row.id,
      to: row.teamEntityId,
      kind: 'member-of',
      weight: 1,
      description: `IDACC agent ${row.agent} belongs to team ${row.team}.`,
      evidenceCount: 1,
      promptVersion: 'deterministic-idacc-agent-team.v1',
    });
  }

  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run(
      source,
      'graph:connectivity-repaired',
      'idacc-agent-team',
      JSON.stringify({
        teams_seen: result.teamsSeen,
        teams_created: result.teamsCreated,
        teams_updated: result.teamsUpdated,
        agents_seen: result.agentsSeen,
        agents_connected: result.agentsConnected,
        edges_created: result.edgesCreated,
        policy: result.policy,
      }),
      JSON.stringify(['brain', 'graph', 'connectivity', 'idacc']),
    );

  return {
    ...result,
    timelineEventId: Number(event.lastInsertRowid),
    after: auditBrainConnectivity({ sampleLimit }),
  };
}

function tokenizeConnectivityText(...values) {
  const stop = new Set([
    'and',
    'the',
    'for',
    'with',
    'from',
    'into',
    'that',
    'this',
    'node',
    'skill',
    'concept',
    'source',
    'http',
    'https',
    'github',
    'com',
    'repo',
    'repository',
    'reference',
    'brand',
    'standard',
    'guide',
    'style',
    'policy',
    'document',
    'documentation',
    'organization',
    'org',
    'project',
    'ecosystem',
  ]);
  const tokens = new Set();
  for (const value of values) {
    for (const token of String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const normalized = token.endsWith('s') && token.length > 4 ? token.slice(0, -1) : token;
      if (normalized.length < 3 || stop.has(normalized)) continue;
      tokens.add(normalized);
    }
  }
  return tokens;
}

function tokenOverlapScore(a, b) {
  let score = 0;
  const shared = [];
  for (const token of a) {
    if (!b.has(token)) continue;
    score++;
    shared.push(token);
  }
  return { score, shared };
}

function upsertEntityTextUnitLink(entityId, textUnitId, { relation = 'source-evidence', confidence = 0.85 } = {}) {
  const tuId = Number(textUnitId);
  if (!entityId || !Number.isInteger(tuId)) return 0;
  const exists = db.prepare(`SELECT 1 FROM text_units WHERE id=?`).get(tuId);
  if (!exists) return 0;
  return db.prepare(`
    INSERT INTO entity_text_units (entity_id, text_unit_id, relation, confidence, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(entity_id, text_unit_id, relation) DO UPDATE SET
      confidence=MAX(entity_text_units.confidence, excluded.confidence),
      updated_at=unixepoch()
  `).run(entityId, tuId, String(relation || 'source-evidence'), Math.max(0, Math.min(1, Number(confidence) || 0.85))).changes;
}

function sourceBackedConnectivityCandidates({ limit = 200 } = {}) {
  return db.prepare(`
    SELECT e.*
    FROM entities e
    WHERE COALESCE(e.status, 'active') NOT IN ('deleted','archived','retired','removed')
      AND e.type NOT IN ('probe')
      AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id=e.id AND f.status='active')
      AND NOT EXISTS (SELECT 1 FROM entity_edges ee WHERE ee.from_id=e.id OR ee.to_id=e.id)
      AND NOT EXISTS (SELECT 1 FROM entity_text_units etu WHERE etu.entity_id=e.id)
    ORDER BY e.updated_at DESC, e.id ASC
    LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 200, 1), 1000));
}

function bestSourceQualifiedSkillMatch(entity, repository) {
  const entityTags = parseJson(entity.tags, []);
  const entityTokens = tokenizeConnectivityText(entity.name, entity.description, entityTags.join(' '));
  const sourceTokens = tokenizeConnectivityText(
    entity.source,
    repository?.id,
    repository?.name,
  );
  const skills = db.prepare(`
    SELECT e.id, e.name, e.description, e.tags AS entity_tags, sn.tags AS skill_tags
    FROM entities e
    JOIN skill_nodes sn ON e.id='skill:' || sn.skill_id
    WHERE e.type='skill'
    ORDER BY e.id
  `).all();
  let best = null;
  let tied = false;
  for (const skill of skills) {
    const skillTags = parseJson(skill.skill_tags, []);
    const skillTokens = tokenizeConnectivityText(skill.name, skill.description, skill.entity_tags, skillTags.join(' '));
    const sourceOverlap = tokenOverlapScore(sourceTokens, skillTokens);
    const semanticOverlap = tokenOverlapScore(entityTokens, skillTokens);
    if (sourceOverlap.score < 1 || semanticOverlap.score < 2) continue;
    const candidate = {
      ...skill,
      score: semanticOverlap.score,
      sourceScore: sourceOverlap.score,
      sharedTokens: semanticOverlap.shared,
      sharedSourceTokens: sourceOverlap.shared,
    };
    if (
      !best
      || candidate.score > best.score
      || (candidate.score === best.score && candidate.sourceScore > best.sourceScore)
    ) {
      best = candidate;
      tied = false;
    } else if (candidate.score === best.score && candidate.sourceScore === best.sourceScore) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function referenceTargetIds(entity) {
  const data = parseJson(entity.data, {});
  const values = [
    data.reference_for,
    data.referenceFor,
    data.target_entity_id,
    data.targetEntityId,
    data.organization_id,
    data.organizationId,
    data.project_id,
    data.projectId,
  ];
  for (const tag of parseJson(entity.tags, [])) {
    const match = String(tag).match(/^reference-for[:=](.+)$/i);
    if (match) values.push(match[1]);
  }
  return [...new Set(values.map(value => (
    typeof value === 'string'
      ? value.trim()
      : (value && typeof value === 'object' ? String(value.id ?? '').trim() : '')
  )).filter(Boolean))];
}

function bestReferenceTargetMatch(entity) {
  const targets = db.prepare(`
    SELECT id, type, name, description, source, tags
    FROM entities
    WHERE type IN ('org','organization','project')
      AND COALESCE(status, 'active') NOT IN ('deleted','archived','retired','removed','merged')
    ORDER BY id
  `).all();
  const byId = new Map(targets.map(target => [target.id, target]));
  const explicit = referenceTargetIds(entity)
    .map(id => byId.get(id))
    .filter(Boolean);
  if (explicit.length === 1) {
    return { ...explicit[0], explicit: true, score: 1, sharedTokens: [] };
  }
  if (explicit.length > 1) return null;

  const referenceTokens = tokenizeConnectivityText(
    entity.id,
    entity.name,
    entity.description,
    parseJson(entity.tags, []).join(' '),
  );
  let best = null;
  let tied = false;
  for (const target of targets) {
    const targetTokens = tokenizeConnectivityText(
      target.id,
      target.name,
    );
    const overlap = tokenOverlapScore(referenceTokens, targetTokens);
    if (overlap.score < 1) continue;
    const candidate = { ...target, explicit: false, score: overlap.score, sharedTokens: overlap.shared };
    if (!best || candidate.score > best.score) {
      best = candidate;
      tied = false;
    } else if (candidate.score === best.score) {
      tied = true;
    }
  }
  return tied ? null : best;
}

function connectSourceBackedIsolatedEntities({ dryRun = false, source = 'brain-connectivity', limit = 200, sampleLimit = 20 } = {}) {
  const candidates = sourceBackedConnectivityCandidates({ limit });
  const planned = [];
  let entityTextUnitLinks = 0;
  const addEdgePlan = (edge) => planned.push(edge);

  for (const entity of candidates) {
    const tags = parseJson(entity.tags, []);
    const entitySource = String(entity.source ?? '');
    if (entity.type === 'concept' && entitySource.startsWith('github:')) {
      const repo = db.prepare(`
        SELECT id, name FROM entities
        WHERE source=? AND type IN ('repository','repo')
        ORDER BY CASE WHEN id LIKE 'repo:%' THEN 0 ELSE 1 END, id
        LIMIT 1
      `).get(entitySource);
      if (repo) {
        addEdgePlan({
          from: entity.id,
          to: repo.id,
          kind: 'derived-from',
          weight: 0.9,
          description: `${entity.name} is a concept derived from repository source ${repo.name}.`,
          evidenceCount: 1,
          promptVersion: 'deterministic-source-connectivity.v2',
        });
      }
      if (repo) {
        const skill = bestSourceQualifiedSkillMatch(entity, repo);
        if (skill) {
          addEdgePlan({
            from: entity.id,
            to: skill.id,
            kind: 'implemented-by-skill',
            weight: 0.9,
            description: `${entity.name} maps to ${skill.name} by shared repository identity (${skill.sharedSourceTokens.join(', ')}) and content tokens (${skill.sharedTokens.join(', ')}).`,
            evidenceCount: skill.sharedSourceTokens.length + skill.sharedTokens.length,
            promptVersion: 'deterministic-source-connectivity.v2',
          });
          if (!dryRun) {
            const skillId = String(skill.id).replace(/^skill:/, '');
            const textUnit = db.prepare(`SELECT id FROM text_units WHERE source_id=? ORDER BY id LIMIT 1`).get(`skill:${skillId}`);
            entityTextUnitLinks += upsertEntityTextUnitLink(entity.id, textUnit?.id, { relation: 'skill-definition-evidence', confidence: 0.9 });
          }
        }
      }
    }

    if (entity.type === 'reference') {
      const target = bestReferenceTargetMatch(entity);
      if (target) {
        addEdgePlan({
          from: entity.id,
          to: target.id,
          kind: 'reference-for',
          weight: target.explicit ? 0.95 : 0.9,
          description: target.explicit
            ? `${entity.name} explicitly references ${target.name}.`
            : `${entity.name} references ${target.name} by unique shared identity tokens: ${target.sharedTokens.join(', ')}.`,
          evidenceCount: Math.max(1, target.sharedTokens.length),
          promptVersion: 'deterministic-source-connectivity.v2',
        });
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const edge of planned) {
    const key = `${edge.from}->${edge.to}:${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }

  const result = {
    dryRun: Boolean(dryRun),
    candidatesSeen: candidates.length,
    edgesPlanned: deduped.length,
    entityTextUnitLinks,
    planned: deduped.slice(0, Math.min(Math.max(Number(sampleLimit) || 20, 1), 200)),
    policy: {
      deterministicRepair: 'same-source repository links, unique source-qualified skill token matches, and explicit or unique reference-target identity matches only',
      unsafeActions: ['alias merge', 'fact resolution', 'skill publish', 'wallet/key/controller change'],
    },
  };
  if (dryRun) return { ...result, after: auditBrainConnectivity({ sampleLimit }) };

  for (const edge of deduped) upsertEntityEdge(edge);
  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run(
      source,
      'graph:source-connectivity-repaired',
      'source-backed-isolated-entities',
      JSON.stringify({
        candidates_seen: candidates.length,
        edges_created: deduped.length,
        entity_text_unit_links: entityTextUnitLinks,
        policy: result.policy,
      }),
      JSON.stringify(['brain', 'graph', 'connectivity', 'source-backed']),
    );
  return {
    ...result,
    timelineEventId: Number(event.lastInsertRowid),
    after: auditBrainConnectivity({ sampleLimit }),
  };
}

function entityJson(row, field, fallback = null) {
  try {
    const value = JSON.parse(row?.[field] ?? row?.data ?? '{}');
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function compactEntityToken(value) {
  return String(value ?? '').trim();
}

function factRollupValue(data, field) {
  const rollup = data?.__fact_rollup;
  const value = rollup?.[field]?.value;
  return value == null ? '' : String(value).trim();
}

function resolveAgentEntity(agentRef, team = '') {
  const ref = compactEntityToken(agentRef);
  if (!ref) return null;
  const teamName = compactEntityToken(team);
  const candidates = [
    ref,
    ref.startsWith('agent:') ? ref : `agent:${ref}`,
    teamName && !ref.includes(':') ? `agent:${teamName}:${ref}` : '',
  ].filter(Boolean);
  for (const id of candidates) {
    const row = db.prepare(`SELECT id, name, data FROM entities WHERE id=? AND type='agent' LIMIT 1`).get(id);
    if (row) return row;
  }
  const byInternal = db.prepare(`
    SELECT id, name, data
    FROM entities
    WHERE type='agent' AND json_extract(data, '$.internalId')=?
    ORDER BY CASE WHEN status='running' THEN 0 WHEN status='stopped' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `).get(ref);
  if (byInternal) return byInternal;
  const byName = db.prepare(`
    SELECT id, name, data
    FROM entities
    WHERE type='agent'
      AND (name=? OR name=? OR id=?)
    ORDER BY CASE WHEN status='running' THEN 0 WHEN status='stopped' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 1
  `).get(ref, teamName ? `${teamName}/${ref}` : ref, `agent:${ref}`);
  return byName ?? null;
}

function teamForAgentRow(agentRow) {
  const data = entityJson(agentRow, 'data', {});
  const team = compactEntityToken(data?.team);
  if (team) return team;
  const m = /^agent:([^:]+):/.exec(String(agentRow?.id ?? ''));
  return m?.[1] ?? '';
}

function ensureTeamConnectivityEntity(team, source, { dryRun = false } = {}) {
  const name = compactEntityToken(team);
  if (!name) return null;
  const id = `team:${name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'unknown'}`;
  if (dryRun) return id;
  upsertEntity({
    id,
    type: 'team',
    name,
    description: `IDACC team ${name} referenced by task/plan provenance.`,
    source,
    data: { idacc_team: name, derived_from: 'task-plan-provenance' },
    tags: ['idacc', 'team', 'graph-connectivity'],
    status: 'active',
    exactId: true,
    mergeAliases: false,
  });
  return id;
}

function operationalNoEdgeCandidates({ limit = 500 } = {}) {
  return db.prepare(`
    SELECT e.*
    FROM entities e
    WHERE COALESCE(e.status, 'active') NOT IN ('deleted','archived','retired','removed')
      AND e.type IN ('task','plan')
      AND NOT EXISTS (SELECT 1 FROM entity_edges ee WHERE ee.from_id=e.id OR ee.to_id=e.id)
    ORDER BY e.updated_at DESC, e.id ASC
    LIMIT ?
  `).all(Math.min(Math.max(Number(limit) || 500, 1), 2000));
}

function connectOperationalProvenanceEntities({ dryRun = false, source = 'brain-connectivity', limit = 500, sampleLimit = 20 } = {}) {
  const candidates = operationalNoEdgeCandidates({ limit });
  const planned = [];
  const addEdgePlan = (edge) => planned.push(edge);

  for (const entity of candidates) {
    const data = entityJson(entity, 'data', {});
    const team = compactEntityToken(data?.team || factRollupValue(data, 'team'));
    const owner = compactEntityToken(
      data?.owner
      || data?.assignee
      || data?.agent
      || data?.completed_by
      || factRollupValue(data, 'assignee')
      || factRollupValue(data, 'claimed_by')
      || factRollupValue(data, 'completed_by'),
    );
    const agent = resolveAgentEntity(owner, team);
    const agentTeam = agent ? teamForAgentRow(agent) : '';
    const teamId = ensureTeamConnectivityEntity(team || agentTeam, source, { dryRun });

    if (agent) {
      addEdgePlan({
        from: entity.id,
        to: agent.id,
        kind: entity.type === 'task' ? 'assigned' : 'owned-by',
        weight: 0.9,
        description: `${entity.type} ${entity.name} is explicitly associated with agent ${agent.name || agent.id}.`,
        evidenceCount: 1,
        promptVersion: 'deterministic-operational-provenance.v1',
      });
    }
    if (teamId) {
      addEdgePlan({
        from: entity.id,
        to: teamId,
        kind: entity.type === 'task' ? 'routed-to' : 'owned-by',
        weight: 0.85,
        description: `${entity.type} ${entity.name} is explicitly associated with team ${team || agentTeam}.`,
        evidenceCount: 1,
        promptVersion: 'deterministic-operational-provenance.v1',
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const edge of planned) {
    const key = `${edge.from}->${edge.to}:${edge.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }

  const result = {
    dryRun: Boolean(dryRun),
    candidatesSeen: candidates.length,
    edgesPlanned: deduped.length,
    planned: deduped.slice(0, Math.min(Math.max(Number(sampleLimit) || 20, 1), 200)),
    policy: {
      deterministicRepair: 'task/plan owner, assignee, agent, completed_by, and team fields only',
      unsafeActions: ['alias merge', 'identity merge', 'fact resolution', 'skill publish', 'wallet/key/controller change'],
    },
  };
  if (dryRun) return { ...result, after: auditBrainConnectivity({ sampleLimit }) };

  for (const edge of deduped) upsertEntityEdge(edge);
  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run(
      source,
      'graph:operational-provenance-repaired',
      'task-plan-provenance',
      JSON.stringify({
        candidates_seen: candidates.length,
        edges_created: deduped.length,
        policy: result.policy,
      }),
      JSON.stringify(['brain', 'graph', 'connectivity', 'operational-provenance']),
    );
  return {
    ...result,
    timelineEventId: Number(event.lastInsertRowid),
    after: auditBrainConnectivity({ sampleLimit }),
  };
}

// ── Curator governance: reversible entity merge + type change ───────────────
// (Plan 22 "curator agent + hard guardrails": fuzzy merges and type/schema
// changes are reviewed via approvals and must be fully reversible — status
// flips only, never hard deletes. These helpers capture a complete before-state
// snapshot so the matching learning-rollback inverse can restore exactly.)

function curatorReplaceRow(table, row) {
  if (!row || typeof row !== 'object') return;
  const cols = Object.keys(row).filter(key => row[key] !== undefined);
  if (!cols.length) return;
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(col => row[col]));
}

function entityEdgeTargetAfterMerge(edge, loserId, canonicalId) {
  return {
    from: edge.from_id === loserId ? canonicalId : edge.from_id,
    to: edge.to_id === loserId ? canonicalId : edge.to_id,
  };
}

function captureCanonicalEdgeCollisions(loserEdges, loserId, canonicalId) {
  const selectEdge = db.prepare(`SELECT * FROM entity_edges WHERE from_id=? AND to_id=? AND kind=?`);
  return loserEdges
    .map(edge => {
      const target = entityEdgeTargetAfterMerge(edge, loserId, canonicalId);
      if (!target.from || !target.to || target.from === target.to) return null;
      const existing = selectEdge.get(target.from, target.to, edge.kind);
      if (!existing || existing.id === edge.id) return null;
      return { loser_edge_id: edge.id, target, kind: edge.kind, existing };
    })
    .filter(Boolean);
}

function repointEntityEdgesForMerge(loserEdges, loserId, canonicalId) {
  const selectCollision = db.prepare(`SELECT id FROM entity_edges WHERE from_id=? AND to_id=? AND kind=? AND id != ?`);
  const updateEdge = db.prepare(`UPDATE entity_edges SET from_id=?, to_id=?, updated_at=unixepoch() WHERE id=?`);
  const deleteEdge = db.prepare(`DELETE FROM entity_edges WHERE id=?`);
  for (const edge of loserEdges) {
    const target = entityEdgeTargetAfterMerge(edge, loserId, canonicalId);
    if (!target.from || !target.to || target.from === target.to) {
      deleteEdge.run(edge.id);
      continue;
    }
    const collision = selectCollision.get(target.from, target.to, edge.kind, edge.id);
    if (collision) {
      upsertEntityEdge({
        from: target.from,
        to: target.to,
        kind: edge.kind,
        weight: edge.weight,
        description: edge.description,
        textUnitIds: normalizedTextUnitIds(edge.text_unit_ids),
        evidenceCount: edge.evidence_count,
        promptVersion: edge.prompt_version || promptVersionForEdge(),
        confidence: edge.confidence,
        provenance: parseJson(edge.provenance, undefined),
      });
      deleteEdge.run(edge.id);
    } else {
      updateEdge.run(target.from, target.to, edge.id);
    }
  }
}

// Merge `loserId` into `canonicalId`: move facts/text-units/aliases/edges, add a
// reversible alias-of edge, and flip the loser to status='merged'. Returns the
// before/after snapshots used to record (and later reverse) the rollback.
function curatorMergeEntities({ loserId, canonicalId, reason = '', by = 'curator' } = {}) {
  if (!loserId || !canonicalId || loserId === canonicalId) {
    throw Object.assign(new Error('distinct loserId and canonicalId required'), { status: 400 });
  }
  const loser = db.prepare(`SELECT * FROM entities WHERE id=?`).get(loserId);
  const canonical = db.prepare(`SELECT * FROM entities WHERE id=?`).get(canonicalId);
  if (!loser) throw Object.assign(new Error(`loser entity not found: ${loserId}`), { status: 404 });
  if (!canonical) throw Object.assign(new Error(`canonical entity not found: ${canonicalId}`), { status: 404 });
  if (loser.status === 'merged') throw Object.assign(new Error(`entity already merged: ${loserId}`), { status: 409 });

  const beforeState = {
    loser,
    canonical_id: canonicalId,
    loser_id: loserId,
    fact_ids: db.prepare(`SELECT id FROM facts WHERE entity_id=?`).all(loserId).map(r => r.id),
    loser_text_units: db.prepare(`SELECT * FROM entity_text_units WHERE entity_id=?`).all(loserId),
    canonical_text_unit_keys: db.prepare(`SELECT text_unit_id, relation FROM entity_text_units WHERE entity_id=?`).all(canonicalId),
    loser_aliases: db.prepare(`SELECT * FROM entity_aliases WHERE entity_id=?`).all(loserId),
    canonical_alias_norms: db.prepare(`SELECT normalized FROM entity_aliases WHERE entity_id=?`).all(canonicalId).map(r => r.normalized),
    loser_edges: db.prepare(`SELECT * FROM entity_edges WHERE from_id=? OR to_id=?`).all(loserId, loserId),
    alias_edge_preexisting: !!db.prepare(`SELECT 1 FROM entity_edges WHERE from_id=? AND to_id=? AND kind='alias-of'`).get(loserId, canonicalId),
  };
  beforeState.canonical_edge_collisions = captureCanonicalEdgeCollisions(beforeState.loser_edges, loserId, canonicalId);

  db.prepare(`UPDATE facts SET entity_id=? WHERE entity_id=?`).run(canonicalId, loserId);
  db.prepare(`INSERT OR IGNORE INTO entity_text_units (entity_id, text_unit_id, relation, confidence, created_at)
              SELECT ?, text_unit_id, relation, confidence, created_at FROM entity_text_units WHERE entity_id=?`).run(canonicalId, loserId);
  db.prepare(`DELETE FROM entity_text_units WHERE entity_id=?`).run(loserId);
  db.prepare(`INSERT OR IGNORE INTO entity_aliases (entity_id, alias, normalized, kind, source, status, created_at, updated_at)
              SELECT ?, alias, normalized, kind, source, status, created_at, unixepoch() FROM entity_aliases WHERE entity_id=?`).run(canonicalId, loserId);
  db.prepare(`DELETE FROM entity_aliases WHERE entity_id=?`).run(loserId);
  // Repoint the loser's edges in place where possible. If a canonical edge with
  // the same target already exists, merge evidence into that edge instead of
  // leaving the loser edge stranded on a status='merged' entity.
  repointEntityEdgesForMerge(beforeState.loser_edges, loserId, canonicalId);
  upsertEntityEdge({ from: loserId, to: canonicalId, kind: 'alias-of', weight: 1.0, description: `curator alias merge${reason ? ': ' + reason : ''}` });
  db.prepare(`UPDATE entities
              SET status='merged',
                  data=json_set(COALESCE(NULLIF(data, ''), '{}'), '$.merged_into', ?, '$.merged_by', ?, '$.merged_reason', ?),
                  updated_at=unixepoch()
              WHERE id=?`).run(canonicalId, by, reason || 'curator alias merge', loserId);

  return { canonicalId, loserId, beforeState, afterState: { canonical_id: canonicalId, loser_id: loserId, moved_fact_ids: beforeState.fact_ids } };
}

// Reverse curatorMergeEntities from its before-state snapshot.
function curatorUnmergeEntities(beforeState = {}) {
  const loser = beforeState.loser;
  const loserId = beforeState.loser_id ?? loser?.id;
  const canonicalId = beforeState.canonical_id;
  if (!loser || !loserId || !canonicalId) {
    throw Object.assign(new Error('unmerge requires loser + canonical_id in before_state'), { status: 400 });
  }
  curatorReplaceRow('entities', loser);
  const factIds = Array.isArray(beforeState.fact_ids) ? beforeState.fact_ids : [];
  if (factIds.length) {
    const stmt = db.prepare(`UPDATE facts SET entity_id=? WHERE id=?`);
    for (const id of factIds) stmt.run(loserId, Number(id));
  }
  const canonicalTuKeys = new Set((beforeState.canonical_text_unit_keys ?? []).map(k => `${k.text_unit_id}:${k.relation}`));
  for (const tu of beforeState.loser_text_units ?? []) curatorReplaceRow('entity_text_units', tu);
  const delTu = db.prepare(`DELETE FROM entity_text_units WHERE entity_id=? AND text_unit_id=? AND relation=?`);
  for (const tu of beforeState.loser_text_units ?? []) {
    if (!canonicalTuKeys.has(`${tu.text_unit_id}:${tu.relation}`)) delTu.run(canonicalId, tu.text_unit_id, tu.relation);
  }
  const canonicalAliasNorms = new Set(beforeState.canonical_alias_norms ?? []);
  for (const al of beforeState.loser_aliases ?? []) curatorReplaceRow('entity_aliases', al);
  const delAlias = db.prepare(`DELETE FROM entity_aliases WHERE entity_id=? AND normalized=?`);
  for (const al of beforeState.loser_aliases ?? []) {
    if (!canonicalAliasNorms.has(al.normalized)) delAlias.run(canonicalId, al.normalized);
  }
  for (const edge of beforeState.loser_edges ?? []) curatorReplaceRow('entity_edges', edge);
  for (const collision of beforeState.canonical_edge_collisions ?? []) {
    if (collision.existing) curatorReplaceRow('entity_edges', collision.existing);
    else db.prepare(`DELETE FROM entity_edges WHERE from_id=? AND to_id=? AND kind=?`).run(collision.target.from, collision.target.to, collision.kind);
  }
  if (!beforeState.alias_edge_preexisting) {
    db.prepare(`DELETE FROM entity_edges WHERE from_id=? AND to_id=? AND kind='alias-of'`).run(loserId, canonicalId);
  }
  return { loserId, canonicalId, restoredFactIds: factIds };
}

// Change an entity's type (the create path freezes type on conflict, so this is
// the only governed write path for a retype). Returns before/after snapshots.
function curatorChangeEntityType({ entityId, newType } = {}) {
  if (!entityId || !newType) throw Object.assign(new Error('entityId and newType required'), { status: 400 });
  const before = db.prepare(`SELECT id, type FROM entities WHERE id=?`).get(entityId);
  if (!before) throw Object.assign(new Error(`entity not found: ${entityId}`), { status: 404 });
  db.prepare(`UPDATE entities SET type=?, updated_at=unixepoch() WHERE id=?`).run(String(newType), entityId);
  const after = db.prepare(`SELECT id, type FROM entities WHERE id=?`).get(entityId);
  return { before, after };
}

// Reverse curatorChangeEntityType from its before-state snapshot ({entity:{id,type}}).
function curatorRestoreEntityType(beforeState = {}) {
  const entity = beforeState.entity ?? beforeState;
  const id = entity?.id;
  const type = entity?.type;
  if (!id || type === undefined || type === null) throw Object.assign(new Error('entity type before_state required'), { status: 400 });
  db.prepare(`UPDATE entities SET type=?, updated_at=unixepoch() WHERE id=?`).run(String(type), id);
  return id;
}


export {
  db,
  ftsAvailable,
  sqliteVecAvailable,
  STMT,
  LIVE,
  isIntegerValue,
  upsertNode,
  upsertEdge,
  deleteNode,
  rowToNode,
  isBlockedNode,
  rowToEntity,
  queryNodes,
  getNodeById,
  getNeighbors,
  findPath,
  recommendSkills,
  composeChain,
  getOldUnkeyedMemories,
  storeMemory,
  getMemories,
  searchMemories,
  getSharedMemories,
  deleteMemory,
  brainHealthSignals,
  auditBrainConnectivity,
  connectIdaccAgentTeamGraph,
  connectSourceBackedIsolatedEntities,
  connectOperationalProvenanceEntities,
  controllerScopeUserId,
  rowToController,
  getController,
  listControllers,
  upsertController,
  linkControllerAgent,
  normalizeAlias,
  normalizeFactEntityId,
  factEntityExists,
  factEntityWriteTarget,
  factStatusProjection,
  auditFactEntityIntegrity,
  resolveEntityAlias,
  upsertEntity,
  sqliteVecStatus,
  upsertSourceEmbeddingVector,
  vectorCandidatesForEmbedding,
  vectorReplayGateThresholds,
  vectorReplayGateConfig,
  vectorReplayGateConfigVersion,
  persistVectorReplayGateVerdict,
  latestVectorReplayGateVerdict,
  upsertFact,
  upsertTextUnit,
  upsertTextUnitsFromSource,
  chunkText,
  estimateTokens,
  sanitizeIngestText,
  linkTextUnitToEntities,
  linkFactToTextUnits,
  linkFactsForTextUnit,
  upsertEntityEdge,
  validateEntityEdgeSemantics,
  entityEdgeFreshnessThresholds,
  classifyEntityEdgeFreshness,
  inferEdgesFromTextUnits,
  buildDeterministicCommunities,
  rollupEntityFactsData,
  curatorMergeEntities,
  curatorUnmergeEntities,
  curatorChangeEntityType,
  curatorRestoreEntityType,
};
