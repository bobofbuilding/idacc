#!/usr/bin/env node
/**
 * Brain Listener — continuously feeds brain from the id-agents manager event stream.
 *
 * Subscribes to GET /events?since=<seq> on the manager daemon and writes
 * entities, edges, and timeline entries to brain for every relevant event:
 *
 *   agent lifecycle events         → upsert entity (type=agent, status)
 *   task:created / task:done       → upsert entity (type=task) + timeline event
 *   query:delivered / query:failed → timeline event (agent activity)
 *   checkin:due                    → timeline event
 *
 * State (last processed seq) is persisted in the active profile, with a keyed
 * Brain memory retained as a compatibility mirror, so restarts resume safely.
 *
 * Run: node brain-listener.mjs
 * Env:
 *   BRAIN_URL    (default http://127.0.0.1:4200)
 *   MANAGER_URL  (default http://127.0.0.1:4100)
 *   ID_TEAM      (default default)
 */

import { brainGet, brainPost, recordScriptFailure } from './brain-client.mjs';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBrainStateDir } from './config.mjs';
import { ingestLearnedArtifact as ingestLearnedArtifactImpl } from './listener/artifacts.mjs';
import { validateManagerContractEvent as validateManagerContractEventImpl } from './listener/contract.mjs';
import {
  agentLifecycleStatus,
  isAgentLifecycleEvent,
  isCheckinEvent,
  isQueryControlEvent,
  isQueryEvent,
  isTaskAttemptEvent,
  isTaskCompletionEvent,
  isTaskSupervisionEvent,
  isValidatorRecommendationEvent,
} from './listener/events.mjs';
import { agentSourceId, prefixedEntityId, querySourceId, scalarId, taskSourceId } from './listener/provenance.mjs';
import { handleQueryLearning } from './listener/query-events.mjs';
import { handleTaskCompletionLearning } from './listener/task-events.mjs';
import { recordSuccessfulTrajectory as recordSuccessfulTrajectoryImpl } from './listener/trajectories.mjs';
import { canonicalSourceIds } from './source-ids.mjs';
import { startParentDeathWatchdog } from './parent-watchdog.mjs';
import { managerServiceHeaders } from './manager-service-client.mjs';

const BRAIN   = process.env.BRAIN_URL   ?? 'http://127.0.0.1:4200';
const MANAGER = process.env.MANAGER_URL ?? 'http://127.0.0.1:4100';
const TEAM    = process.env.ID_TEAM     ?? 'default';
const AGENT_ID = 'brain-listener';
const CURSOR_FILE = process.env.BRAIN_LISTENER_CURSOR_FILE?.trim()
  || join(defaultBrainStateDir(), 'brain-listener-cursor.json');
const STATUS_FILE = process.env.BRAIN_LISTENER_STATUS_FILE?.trim() || '';
const INSTANCE_NONCE = process.env.BRAIN_LISTENER_INSTANCE_NONCE?.trim() || '';
const BOOTSTRAP_TEAM = 'default';
const MAX_ACTIVE_TEAMS = 512;
const MAX_CURSOR_TEAMS = MAX_ACTIVE_TEAMS + 1;
const MAX_CURSOR_FILE_BYTES = 512 * 1024;
const TEAM_POLL_CONCURRENCY = 8;
const MAX_RECENT_AGENT_IDENTITIES = 4096;
let primaryTeamIdentity = { id: '', name: TEAM };

const HEADERS = { 'X-Id-Team': TEAM, 'Content-Type': 'application/json' };

const LISTENER_DEPS = {
  brainPost,
  timelinePost: (ev, suffix, body, options) => timelinePost(ev, suffix, body, options),
  compact: (value, max) => compact(value, max),
  canonicalSourceIds: (ids) => canonicalSourceIds(ids),
  eventIdempotencyKey: (ev, suffix) => managerEventIdempotencyKey(ev, suffix),
  eventSourceId: (ev, suffix) => eventSourceId(ev, suffix),
  ingestTextUnit: (ev, options) => ingestTextUnit(ev, options),
  postFacts: (facts, idempotencyKey) => postFacts(facts, idempotencyKey),
  validateManagerContractEvent: (ev, options) => validateManagerContractEvent(ev, options),
  recordSuccessfulTrajectory: (ev, options) => recordSuccessfulTrajectory(ev, options),
  recordFeedbackMissing: (ev, options) => recordFeedbackMissing(ev, options),
  ingestLearnedArtifact: (ev, artifact, fallbackTextUnitIds) => ingestLearnedArtifact(ev, artifact, fallbackTextUnitIds),
};

// ─── Brain helpers ────────────────────────────────────────────────────────────

async function brainPostJson(path, body) {
  const r = await brainPost(path, body);
  return r.data;
}

async function retryBrainPost(path, body, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await brainPost(path, body);
    } catch (err) {
      lastError = err;
      await new Promise(resolve => setTimeout(resolve, 250 * (i + 1)));
    }
  }
  throw lastError;
}

// ─── Cursor persistence ───────────────────────────────────────────────────────

function validIdentityPart(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validateTeamRecord(value, label = 'listener cursor team') {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !validIdentityPart(value.id)
    || !validIdentityPart(value.name)
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  return { id: value.id, name: value.name };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readDescriptorBounded(descriptor, maxBytes, label) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const count = readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    chunks.push(buffer.subarray(0, count));
    total += count;
  }
  if (total > maxBytes) throw new Error(`${label} exceeds its size limit`);
  return Buffer.concat(chunks, total).toString('utf8');
}

function readCursorDocument() {
  if (!CURSOR_FILE) return null;
  let pathStats;
  try {
    pathStats = lstatSync(CURSOR_FILE);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (pathStats.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link listener cursor: ${CURSOR_FILE}`);
  }
  let descriptor;
  let serialized;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    descriptor = openSync(CURSOR_FILE, fsConstants.O_RDONLY | noFollow);
    const openedStats = fstatSync(descriptor);
    if (!sameFileIdentity(pathStats, openedStats)) {
      throw new Error('listener cursor file changed while it was being opened');
    }
    if (
      !openedStats.isFile()
      || openedStats.size < 1
      || openedStats.size > MAX_CURSOR_FILE_BYTES
    ) {
      throw new Error('listener cursor file is not a bounded regular file');
    }
    if (process.platform !== 'win32' && (openedStats.mode & 0o077) !== 0) {
      throw new Error('listener cursor file is not private');
    }
    serialized = readDescriptorBounded(descriptor, MAX_CURSOR_FILE_BYTES, 'listener cursor file');
    const afterReadStats = fstatSync(descriptor);
    if (!sameFileSnapshot(openedStats, afterReadStats)) {
      throw new Error('listener cursor file changed while it was being read');
    }
    const finalPathStats = lstatSync(CURSOR_FILE);
    if (finalPathStats.isSymbolicLink() || !sameFileIdentity(openedStats, finalPathStats)) {
      throw new Error('listener cursor file changed while it was being checked');
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (!serialized) {
    throw new Error('listener cursor file is not a bounded regular file');
  }
  const parsed = JSON.parse(serialized);
  if (parsed?.schemaVersion === 1) {
    if (
      !validIdentityPart(parsed.team)
      || !Number.isSafeInteger(parsed.seq)
      || parsed.seq < 0
    ) {
      throw new Error('legacy listener cursor file is invalid');
    }
    return {
      schemaVersion: 1,
      team: parsed.team,
      seq: parsed.seq,
    };
  }
  if (
    parsed?.schemaVersion !== 2
    || !Array.isArray(parsed.teams)
    || parsed.teams.length < 1
    || parsed.teams.length > MAX_CURSOR_TEAMS
  ) {
    throw new Error('listener cursor registry is invalid');
  }
  const primaryTeam = validateTeamRecord(parsed.primaryTeam, 'listener cursor primary team');
  const seenIds = new Set();
  const teams = parsed.teams.map((entry) => {
    const identity = validateTeamRecord(entry);
    if (seenIds.has(identity.id)) throw new Error('listener cursor registry contains duplicate team ids');
    if (!Number.isSafeInteger(entry.seq) || entry.seq < 0) {
      throw new Error('listener cursor registry contains an invalid sequence');
    }
    seenIds.add(identity.id);
    return { ...identity, seq: entry.seq };
  });
  if (!seenIds.has(primaryTeam.id)) {
    throw new Error('listener cursor registry omits its primary team');
  }
  return { schemaVersion: 2, primaryTeam, teams };
}

function writePrivateJson(path, payload, label) {
  if (!path) return;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CURSOR_FILE_BYTES) {
    throw new Error(`refusing oversized ${label}`);
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing symbolic-link ${label}: ${path}`);
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, serialized);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best effort outside POSIX */ }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
  }
}

function cursorRegistryFromDocument(document, activeTeams = []) {
  if (document?.schemaVersion === 2) {
    return {
      schemaVersion: 2,
      primaryTeam: { ...document.primaryTeam },
      teams: document.teams.map((entry) => ({ ...entry })),
    };
  }
  if (document?.schemaVersion === 1) {
    const active = activeTeams.find((team) => team.name === document.team);
    const identity = active ?? {
      id: `legacy-name:${encodeURIComponent(document.team)}`,
      name: document.team,
    };
    return {
      schemaVersion: 2,
      primaryTeam: { ...identity },
      teams: [{ ...identity, seq: document.seq }],
    };
  }
  return null;
}

function sortCursorTeams(registry) {
  registry.teams.sort((left, right) => {
    if (left.id === registry.primaryTeam.id) return -1;
    if (right.id === registry.primaryTeam.id) return 1;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
  return registry;
}

function writeCursorRegistry(registry) {
  if (
    !registry
    || registry.schemaVersion !== 2
    || !Array.isArray(registry.teams)
    || registry.teams.length < 1
    || registry.teams.length > MAX_CURSOR_TEAMS
  ) {
    throw new Error('refusing to persist an invalid listener cursor registry');
  }
  const normalized = sortCursorTeams({
    schemaVersion: 2,
    primaryTeam: { ...registry.primaryTeam },
    teams: registry.teams.map((entry) => ({ id: entry.id, name: entry.name, seq: entry.seq })),
  });
  writePrivateJson(CURSOR_FILE, {
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, 'listener cursor');
}

function reconcileActiveTeams(registry, activeTeams) {
  if (!Array.isArray(activeTeams) || activeTeams.length < 1) {
    throw new Error('Manager returned no teams for listener reconciliation');
  }
  if (activeTeams.length > MAX_ACTIVE_TEAMS) {
    throw new Error(`Manager returned more than ${MAX_ACTIVE_TEAMS} active teams`);
  }
  const activeIds = new Set(activeTeams.map((team) => team.id));
  registry.teams = registry.teams.filter((entry) => (
    entry.id === registry.primaryTeam.id || activeIds.has(entry.id)
  ));
  for (const team of activeTeams) {
    const existing = registry.teams.find((entry) => entry.id === team.id);
    if (existing) {
      if (existing.id !== registry.primaryTeam.id) existing.name = team.name;
    } else {
      registry.teams.push({ ...team, seq: 0 });
    }
  }
  if (registry.teams.length > MAX_CURSOR_TEAMS) {
    throw new Error('listener cursor registry exceeds its bounded team capacity');
  }
  return registry;
}

async function loadLegacyCursor() {
  let response;
  try {
    response = await brainGet(`/memory/${AGENT_ID}/event-cursor`);
  } catch (error) {
    // A new consumer profile has neither a private cursor file nor the legacy
    // Brain mirror. That precise absence is the initial cursor, not a service
    // failure. Authentication, availability, and all other errors still fail
    // closed so the supervisor can surface the real problem.
    if (error?.status === 404) return 0;
    throw error;
  }
  if (!response?.data?.memory) {
    throw new Error('legacy Brain listener cursor response is invalid');
  }
  const cursor = Number(response.data.memory.content);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new Error('legacy Brain listener cursor is invalid');
  }
  return cursor;
}

async function loadCursor(team = TEAM, teamId = '') {
  const document = readCursorDocument();
  if (document?.schemaVersion === 1) {
    return document.team === team ? document.seq : 0;
  }
  if (document?.schemaVersion === 2) {
    return document.teams.find((entry) => (
      teamId ? entry.id === teamId : entry.name === team
    ))?.seq ?? 0;
  }
  return team === TEAM ? loadLegacyCursor() : 0;
}

async function mirrorPrimaryCursor(seq) {
  try {
    await retryBrainPost(`/memory/${AGENT_ID}`, { key: 'event-cursor', content: String(seq), tags: ['cursor'] });
  } catch (error) {
    if (!CURSOR_FILE) throw error;
    console.warn('[brain-listener] Brain cursor mirror failed; profile cursor is durable:', error.message);
  }
}

async function persistTeamCursor(registry, team, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('refusing to persist an invalid listener cursor');
  }
  let entry = registry.teams.find((candidate) => candidate.id === team.id);
  if (!entry) {
    entry = { id: team.id, name: team.name, seq: 0 };
    registry.teams.push(entry);
  }
  entry.name = team.name;
  entry.seq = seq;
  // The private profile file is the supervisor-owned source of truth. Persist it
  // before acknowledging the batch so a clean restart cannot ingest it twice.
  writeCursorRegistry(registry);
  if (team.id === registry.primaryTeam.id) await mirrorPrimaryCursor(seq);
}

async function saveCursor(seq, teamName = primaryTeamIdentity.name, teamId = primaryTeamIdentity.id) {
  const document = readCursorDocument();
  let registry = cursorRegistryFromDocument(document);
  const identity = {
    id: teamId || registry?.teams.find((entry) => entry.name === teamName)?.id || `legacy-name:${encodeURIComponent(teamName)}`,
    name: teamName,
  };
  if (!registry) {
    registry = {
      schemaVersion: 2,
      primaryTeam: { ...identity },
      teams: [{ ...identity, seq: 0 }],
    };
  }
  primaryTeamIdentity = { ...registry.primaryTeam };
  await persistTeamCursor(registry, identity, seq);
}

async function initializeCursorRegistry(activeTeams) {
  if (!Array.isArray(activeTeams) || activeTeams.length < 1) {
    throw new Error('Manager returned no teams for listener initialization');
  }
  const teams = activeTeams.map((team) => validateTeamRecord(team, 'Manager team'));
  const document = readCursorDocument();
  let registry = cursorRegistryFromDocument(document, teams);
  if (!registry) {
    const primary = teams.find((team) => team.name === TEAM)
      ?? teams.find((team) => team.name === BOOTSTRAP_TEAM)
      ?? teams[0];
    const legacySeq = primary.name === TEAM ? await loadLegacyCursor() : 0;
    registry = {
      schemaVersion: 2,
      primaryTeam: { ...primary },
      teams: [{ ...primary, seq: legacySeq }],
    };
  }
  reconcileActiveTeams(registry, teams);
  primaryTeamIdentity = { ...registry.primaryTeam };
  writeCursorRegistry(registry);
  return registry;
}

function writeListenerStatus(registry, activeTeams, completedAt = new Date()) {
  if (!STATUS_FILE) return;
  const cursors = activeTeams.map((team) => {
    const entry = registry.teams.find((candidate) => candidate.id === team.id);
    if (!entry) throw new Error(`listener cursor is missing active team ${team.name}`);
    return { id: team.id, name: team.name, seq: entry.seq };
  });
  const primaryActive = cursors.some((entry) => entry.id === registry.primaryTeam.id);
  writePrivateJson(STATUS_FILE, {
    schemaVersion: 1,
    instanceNonce: INSTANCE_NONCE,
    pid: process.pid,
    primaryTeam: { ...registry.primaryTeam, active: primaryActive },
    teamCount: cursors.length,
    lastSuccessfulPollAt: completedAt.toISOString(),
    cursors,
  }, 'listener status');
}

// ─── Learning helpers ────────────────────────────────────────────────────────

function compact(value, max = 8000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
  return text.replace(/\s+\n/g, '\n').trim().slice(0, max);
}

function eventTeamContext(ev) {
  const name = scalarId(ev?.team) || primaryTeamIdentity.name || TEAM;
  const id = scalarId(ev?.stream_id ?? ev?.streamId ?? ev?.team_id ?? ev?.teamId);
  return { id, name };
}

function scopedAgentName(team, name, teamId = '') {
  return isPrimaryTeam(team, teamId)
    ? name
    : `${encodeURIComponent(teamId || team)}:${encodeURIComponent(name)}`;
}

function eventSourceId(ev, suffix) {
  const scope = scalarId(ev.seq ?? ev.subject ?? Date.now()) || Date.now();
  const { id: streamId, name: team } = eventTeamContext(ev);
  const namespace = streamId
    ? `${streamId}:`
    : (!isPrimaryTeam(team) ? `${team}:` : '');
  return `${namespace}${scope}:${suffix}`;
}

function managerEventIdempotencyKey(ev, suffix) {
  const { id: streamId, name: team } = eventTeamContext(ev);
  const sequence = scalarId(ev?.seq);
  if (!sequence) throw new Error('cannot construct a Manager event key without a sequence');
  const suffixDigest = createHash('sha256').update(String(suffix)).digest('hex').slice(0, 20);
  return `manager-event:${encodeURIComponent(streamId || team)}:${sequence}:${suffixDigest}`;
}

async function timelinePost(ev, suffix, body, options) {
  return brainPost('/timeline', {
    ...body,
    idempotency_key: managerEventIdempotencyKey(ev, suffix),
  }, options);
}

async function validateManagerContractEvent(ev, options = {}) {
  return validateManagerContractEventImpl(LISTENER_DEPS, ev, options);
}
function taskText(ev, status, learnedArtifact = null) {
  const d = ev.data ?? {};
  const taskId = prefixedEntityId('task', ev.subject, `task:${ev.seq ?? Date.now()}`);
  const parts = [
    `Task: ${d.title ?? eventSubjectKey(ev.subject) ?? ''}`,
    `Status: ${status}`,
    `Task ID: ${taskId}`,
    ev.actor ? `Requester/actor: ${ev.actor}` : '',
    d.assignee ? `Assignee: ${d.assignee}` : '',
    d.body ? `Body:\n${d.body}` : '',
    d.prompt ? `Prompt:\n${d.prompt}` : '',
    d.summary ? `Summary:\n${d.summary}` : '',
    d.result ? `Result:\n${compact(d.result, 3000)}` : '',
    d.finalAnswer ? `Final answer:\n${d.finalAnswer}` : '',
    Array.isArray(d.changedFiles) ? `Changed files:\n${d.changedFiles.join('\n')}` : '',
    Array.isArray(d.commands) ? `Commands:\n${d.commands.map(compact).join('\n')}` : '',
    d.errors ? `Errors:\n${compact(d.errors, 2000)}` : '',
  ].filter(Boolean);
  const artifactText = learnedArtifactText(learnedArtifact);
  if (artifactText) parts.push(artifactText);
  return parts.join('\n\n');
}

function learnedArtifactText(artifact) {
  if (!artifact || typeof artifact !== 'object') return '';
  const parts = [];
  if (artifact.summary) {
    parts.push(`Learned artifact summary:\n${compact(artifact.summary, 1200)}`);
  }
  if (Array.isArray(artifact.sources) && artifact.sources.length) {
    const sources = artifact.sources.map((source, index) => [
      `Source ${index + 1}: ${source?.kind ?? 'learned-artifact'}${source?.source_id ? ` (${source.source_id})` : ''}`,
      source?.title ? `Title: ${source.title}` : '',
      source?.content ? compact(source.content, 1200) : '',
    ].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
    if (sources) parts.push(`Learned artifact sources:\n${sources}`);
  }
  if (Array.isArray(artifact.facts) && artifact.facts.length) {
    const facts = artifact.facts.map((fact, index) => {
      const factEntityId = scalarId(fact?.entity_id ?? fact?.entityId);
      return `Fact ${index + 1}: ${factEntityId ?? ''}.${fact?.field ?? ''} = ${compact(fact?.value, 500)}`;
    }).join('\n');
    if (facts) parts.push(`Learned artifact facts:\n${facts}`);
  }
  if (Array.isArray(artifact.skills) && artifact.skills.length) {
    const skills = artifact.skills.map((skill, index) => {
      if (typeof skill === 'string') return `Skill ${index + 1}: ${skill}`;
      return `Skill ${index + 1}: ${skill?.name ?? 'unknown'} — ${compact(skill?.gap ?? skill?.evidence ?? skill?.description ?? '', 500)}`;
    }).join('\n');
    if (skills) parts.push(`Learned artifact skills:\n${skills}`);
  }
  if (Array.isArray(artifact.follow_up_questions) && artifact.follow_up_questions.length) {
    const questions = artifact.follow_up_questions.map((question, index) => `Question ${index + 1}: ${typeof question === 'string' ? question : question?.question ?? ''}`).filter(Boolean).join('\n');
    if (questions) parts.push(`Learned artifact follow-up questions:\n${questions}`);
  }
  const usedIds = Array.isArray(artifact.skill_used_ids) ? artifact.skill_used_ids : Array.isArray(artifact.skillUsedIds) ? artifact.skillUsedIds : [];
  const helpfulness = typeof artifact.skill_helpfulness === 'number' ? artifact.skill_helpfulness : typeof artifact.skillHelpfulness === 'number' ? artifact.skillHelpfulness : null;
  if (usedIds.length || helpfulness != null) {
    parts.push(`Learned artifact skill feedback:\nUsed skill IDs: ${usedIds.join(', ')}\nHelpfulness: ${helpfulness ?? 'n/a'}`);
  }
  return parts.join('\n\n');
}

function queryText(ev, learnedArtifact = null) {
  const d = ev.data ?? {};
  const queryId = prefixedEntityId('query', ev.subject, `query:${ev.seq ?? Date.now()}`);
  const parts = [
    `Query ID: ${queryId}`,
    ev.actor ? `Agent: ${ev.actor}` : '',
    d.prompt ? `Prompt:\n${d.prompt}` : '',
    d.query ? `Query:\n${d.query}` : '',
    d.message ? `Message:\n${d.message}` : '',
    d.result ? `Result:\n${compact(d.result, 3000)}` : '',
    d.response ? `Response:\n${compact(d.response, 3000)}` : '',
    d.error ? `Error:\n${compact(d.error, 2000)}` : '',
  ].filter(Boolean);
  const artifactText = learnedArtifactText(learnedArtifact);
  if (artifactText) parts.push(artifactText);
  return parts.join('\n\n');
}

async function ingestTextUnit(ev, { sourceKind, sourceId, title, content, metadata = {} }) {
  if (!content?.trim()) return null;
  const team = eventTeamContext(ev).name;
  return brainPostJson('/text-units/ingest', {
    source_kind: sourceKind,
    source_id: sourceId,
    title,
    content,
    metadata: { ...metadata, team, event_topic: ev.topic, event_seq: ev.seq },
    process_config: { strategy: 'heuristic', chunk_size: 3000, chunk_overlap: 250 },
  });
}

async function postFacts(facts, idempotencyKey = '') {
  const filtered = facts.filter(f => f.entity_id && f.field && f.value !== undefined && f.source);
  if (!filtered.length) return;
  await brainPost('/facts/bulk', {
    facts: filtered,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
}

function sourceFacts(facts, source) {
  return facts.map((fact) => (fact.source ? fact : { ...fact, source }));
}

function evidenceContext(ev, ingest, extra = {}) {
  return {
    source_text_unit_ids: ingest?.textUnitIds ?? [],
    source_ids: canonicalSourceIds(ingest?.textUnitIds ?? []),
    ...extra,
    event_seq: ev.seq,
  };
}

function stableRuntimeFacts(entityId, data = {}, context = {}, source = 'brain-listener') {
  const normalizedEntityId = scalarId(entityId);
  if (!normalizedEntityId) return [];
  const facts = [];
  for (const field of ['model', 'runtime', 'provider']) {
    if (data?.[field] !== undefined && data?.[field] !== null && data?.[field] !== '') {
      facts.push({ entity_id: normalizedEntityId, field, value: data[field], source, confidence: 0.85, context });
    }
  }
  return facts;
}

function stableTextFacts(entityId, data = {}, context = {}, fields = [], source = 'brain-listener') {
  const normalizedEntityId = scalarId(entityId);
  if (!normalizedEntityId) return [];
  const facts = [];
  for (const field of fields) {
    const value = data?.[field];
    if (value === undefined || value === null || value === '') continue;
    facts.push({
      entity_id: normalizedEntityId,
      field,
      value: typeof value === 'string' ? compact(value, 1000) : value,
      source,
      confidence: 0.7,
      context,
    });
  }
  return facts;
}

function learnedSkillNamesFromData(data = {}) {
  const artifact = data?.learned_artifact ?? data?.learnedArtifact ?? {};
  const eventSkills = data?.learned_skills ?? data?.learnedSkills ?? data?.skills ?? [];
  const skills = [
    ...(Array.isArray(eventSkills) ? eventSkills : []),
    ...(Array.isArray(artifact?.skills) ? artifact.skills : []),
  ];
  return [...new Set(skills.map(skill => {
    if (typeof skill === 'string') return skill.trim();
    return String(skill?.name ?? '').trim();
  }).filter(Boolean))];
}

async function ingestLearnedArtifact(ev, artifact, fallbackTextUnitIds = []) {
  return ingestLearnedArtifactImpl(LISTENER_DEPS, ev, artifact, fallbackTextUnitIds);
}

async function recordFeedbackMissing(ev, {
  taskId = '',
  queryId = '',
  agentId = '',
  queryText = '',
  volunteeredSourceIds = [],
} = {}) {
  const team = eventTeamContext(ev).name;
  if (!Array.isArray(volunteeredSourceIds) || volunteeredSourceIds.length === 0) {
    await timelinePost(ev, 'context-feedback-totally-missing', {
      source: 'idagents',
      type: 'context:feedback-totally-missing',
      subject: taskId || queryId || agentId || '',
      data: {
        event_seq: ev.seq,
        event_topic: ev.topic,
        team,
        task_id: taskId,
        query_id: queryId,
        agent_id: agentId,
        query_text: String(queryText ?? '').slice(0, 1000),
        volunteered_source_ids: [],
        feedback_state: 'totally_missing',
      },
      tags: ['brain', 'context', 'feedback-missing', 'feedback-totally-missing'],
    });
    return;
  }
  await brainPost('/context/feedback-missing', {
    task_id: taskId,
    query_id: queryId,
    agent_id: agentId,
    query_text: queryText,
    volunteered_source_ids: volunteeredSourceIds,
    source: 'idagents',
    metadata: { event_seq: ev.seq, event_topic: ev.topic, team },
    idempotency_key: managerEventIdempotencyKey(ev, 'context-feedback-missing'),
  });
}

async function recordSuccessfulTrajectory(ev, options = {}) {
  return recordSuccessfulTrajectoryImpl(LISTENER_DEPS, ev, options);
}
// ─── Event handlers ───────────────────────────────────────────────────────────

function eventSubjectKey(subject) {
  return scalarId(subject);
}

function controlEntity(topic, subject, data = {}, team = primaryTeamIdentity.name, teamId = primaryTeamIdentity.id) {
  const kind = scalarId(data.subject_kind ?? data.kind ?? '').toLowerCase();
  const nested = data.data && typeof data.data === 'object' ? data.data : {};
  const action = scalarId(data.action ?? nested.action ?? data.path ?? topic);
  if (kind === 'project' || topic.startsWith('project:')) {
    return { id: prefixedEntityId('project', subject), type: 'project', name: scalarId(nested.name ?? data.name ?? subject), payload: nested };
  }
  if (kind === 'agent' || topic.startsWith('config:agent-')) {
    return {
      id: agentEntityId(team, subject, teamId),
      type: 'agent',
      name: agentEntityName(team, subject, teamId),
      status: topic.endsWith('-removed') ? 'removed' : undefined,
      payload: data.change ?? nested,
    };
  }
  if (kind === 'team' || topic.startsWith('config:team-') || topic.startsWith('control:org')) {
    return { id: prefixedEntityId('team', subject), type: 'team', name: subject, status: topic.endsWith('-removed') ? 'removed' : undefined, payload: data.change ?? nested };
  }
  if (topic.startsWith('plan:')) {
    return { id: prefixedEntityId('plan', subject), type: 'plan', name: subject, payload: nested };
  }
  return { id: null, type: null, name: action || subject, payload: nested };
}

async function handleEvent(ev) {
  const { topic, actor, data } = ev;
  const subject = eventSubjectKey(ev.subject);
  const { id: teamId, name: team } = eventTeamContext(ev);

  if (isAgentLifecycleEvent(topic)) {
    const status = agentLifecycleStatus(topic);
    const internalId = scalarId(subject);
    const agentName = await resolveAgentNameForEvent(
      internalId,
      { id: teamId, name: team },
      { hints: [data?.agent] },
    );
    await brainPost('/entities', {
      id:     agentEntityId(team, agentName, teamId),
      type:   'agent',
      name:   agentEntityName(team, agentName, teamId),
      source: 'idagents',
      status,
      tags:   ['agent', team],
      aliases: internalId && internalId !== agentName ? [internalId] : [],
      data:   {
        name: agentName,
        team,
        teamId,
        internalId: internalId && internalId !== agentName ? internalId : undefined,
        runtime: data?.runtime,
        model: data?.model,
        port: data?.port,
      },
      exactId: true,
      mergeAliases: false,
    });
    await timelinePost(ev, 'agent-lifecycle', {
      source: 'idagents',
      type: topic,
      subject: agentName,
      data: { ...data, team, teamId },
      tags: ['agent'],
    });
  }

  else if (topic === 'task:created') {
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    const taskStatus = data?.status ?? (data?.assignee ? 'doing' : 'todo');
    await brainPost('/entities', {
      id:     taskId,
      type:   'task',
      name:   data?.title ?? subject,
      source: 'idagents',
      status: taskStatus,
      tags:   ['task', team],
      data:   { team, teamId, assignee: data?.assignee, from: actor },
      exactId: true,
      mergeAliases: false,
    });
    const projectId = data?.project_id ? prefixedEntityId('project', data.project_id) : null;
    const planId = data?.plan_id ? prefixedEntityId('plan', data.plan_id) : null;
    if (projectId) {
      await brainPost('/entities', {
        id: projectId, type: 'project', name: String(data.project_id), source: 'idagents',
        tags: ['project', team], data: { team, teamId }, exactId: true, mergeAliases: false,
      });
    }
    if (planId) {
      await brainPost('/entities', {
        id: planId, type: 'plan', name: String(data.plan_id), source: 'idagents',
        tags: ['plan', team], data: { team, teamId, project_id: data?.project_id ?? null }, exactId: true, mergeAliases: false,
      });
    }
    if (projectId && planId) await brainPost('/entity-edges', { from: projectId, to: planId, kind: 'contains-plan' });
    if (planId) await brainPost('/entity-edges', { from: planId, to: taskId, kind: 'contains-task' });
    else if (projectId) await brainPost('/entity-edges', { from: projectId, to: taskId, kind: 'contains-task' });
    await timelinePost(ev, 'task-created', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...data, team, teamId, task_id: taskId },
      tags: ['task'],
    });
    const ingest = await ingestTextUnit(ev, {
      sourceKind: 'idagents-task',
      sourceId: eventSourceId(ev, 'created'),
      title: data?.title ?? `Task ${subject}`,
      content: taskText(ev, 'created', data?.learned_artifact ?? data?.learnedArtifact),
      metadata: { task_id: taskId, assignee: data?.assignee, requester: actor },
    });
    await postFacts(sourceFacts([
      { entity_id: taskId, field: 'status', value: taskStatus, confidence: 0.9, context: evidenceContext(ev, ingest) },
      { entity_id: taskId, field: 'assignee', value: data?.assignee ?? null, confidence: 0.8, context: evidenceContext(ev, ingest) },
      { entity_id: taskId, field: 'requester', value: actor ?? null, confidence: 0.8, context: evidenceContext(ev, ingest) },
      ...(data?.project_id ? [{ entity_id: taskId, field: 'project_id', value: data.project_id, confidence: 0.95, context: evidenceContext(ev, ingest) }] : []),
      ...(data?.plan_id ? [{ entity_id: taskId, field: 'plan_id', value: data.plan_id, confidence: 0.95, context: evidenceContext(ev, ingest) }] : []),
      ...stableRuntimeFacts(taskId, data, evidenceContext(ev, ingest), source),
      ...stableTextFacts(taskId, data, evidenceContext(ev, ingest), ['title', 'body'], source),
    ], source), managerEventIdempotencyKey(ev, 'facts:task-created'));
  }

  else if (topic === 'task:claimed') {
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    const brainContext = data?.brain_context ?? data?.brainContext ?? {};
    const cited = brainContext?.cited ?? {};
    const timelineEventId = brainContext?.timelineEventId ?? brainContext?.timeline_event_id ?? null;
    const canonicalSourceIds = cited?.canonical_source_ids ?? cited?.canonicalSourceIds ?? [];
    await validateManagerContractEvent(ev, {
      subject: taskId,
      items: [{ type: 'task_envelope', payload: data }],
    });
    await brainPost('/entities', {
      id: taskId, type: 'task', name: subject, source: 'idagents',
      status: 'doing', tags: ['task', team], data: { team, teamId, assignee: actor },
      exactId: true, mergeAliases: false,
    });
    if (actor) {
      const actorName = await resolveAgentNameForEvent(
        actor,
        { id: teamId, name: team },
        { refreshUnknown: true },
      );
      await brainPost('/entity-edges', { from: agentEntityId(team, actorName, teamId), to: taskId, kind: 'assigned' });
    }
    await timelinePost(ev, 'task-claimed', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...data, team, teamId, task_id: taskId },
      tags: ['task', 'claim'],
    });
    await postFacts(sourceFacts([
      { entity_id: taskId, field: 'status', value: 'claimed', confidence: 0.9, context: { event_seq: ev.seq } },
      { entity_id: taskId, field: 'claimed_by', value: actor ?? null, confidence: 0.85, context: { event_seq: ev.seq } },
      ...(canonicalSourceIds.length ? [{
        entity_id: taskId,
        field: 'brain_context_source_ids',
        value: canonicalSourceIds,
        confidence: 0.9,
        context: { event_seq: ev.seq, brain_context_timeline_event_id: timelineEventId },
      }] : []),
      ...(timelineEventId ? [{
        entity_id: taskId,
        field: 'brain_context_timeline_event_id',
        value: timelineEventId,
        confidence: 0.9,
        context: { event_seq: ev.seq, brain_context_source_ids: canonicalSourceIds },
      }] : []),
    ], source), managerEventIdempotencyKey(ev, 'facts:task-claimed'));
  }

  else if (isTaskCompletionEvent(topic)) {
    const status = topic === 'task:removed' ? 'removed' : 'done';
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    await brainPost('/entities', {
      id: taskId, type: 'task', name: subject, source: 'idagents',
      status, tags: ['task', team], data: { ...data, team, teamId },
      exactId: true, mergeAliases: false,
    });
    await timelinePost(ev, 'task-completed', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...data, team, teamId, task_id: taskId },
      tags: ['task'],
    });
    const ingest = await ingestTextUnit(ev, {
      sourceKind: 'idagents-task',
      sourceId: eventSourceId(ev, status),
      title: data?.title ?? `Task ${subject} ${status}`,
      content: taskText(ev, status, data?.learned_artifact ?? data?.learnedArtifact),
      metadata: { task_id: taskId, agent_id: actor, status },
    });
    await postFacts(sourceFacts([
      { entity_id: taskId, field: 'status', value: status, confidence: 0.95, context: evidenceContext(ev, ingest) },
      { entity_id: taskId, field: 'assignee', value: data?.assignee ?? actor ?? null, confidence: 0.8, context: evidenceContext(ev, ingest) },
      { entity_id: taskId, field: 'completed_by', value: actor ?? data?.assignee ?? null, confidence: 0.75, context: evidenceContext(ev, ingest) },
      ...stableRuntimeFacts(taskId, data, evidenceContext(ev, ingest), source),
      ...stableTextFacts(taskId, data, evidenceContext(ev, ingest), ['title', 'summary', 'result', 'finalAnswer'], source),
      ...(learnedSkillNamesFromData(data).length ? [{
        entity_id: taskId,
        field: 'learned_skill_names',
        value: learnedSkillNamesFromData(data),
        confidence: 0.75,
        context: evidenceContext(ev, ingest),
      }] : []),
    ], source), managerEventIdempotencyKey(ev, 'facts:task-completion'));
    const completionAgentName = actor
      ? await resolveAgentNameForEvent(
        actor,
        { id: teamId, name: team },
        { refreshUnknown: true },
      )
      : null;
    const completionAgent = completionAgentName
      ? scopedAgentName(team, completionAgentName, teamId)
      : actor;
    await handleTaskCompletionLearning(LISTENER_DEPS, ev, {
      actor: completionAgent,
      subject,
      data,
      ingest,
    });
  }

  else if (isTaskSupervisionEvent(topic)) {
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    await brainPost('/entities', {
      id: taskId,
      type: 'task',
      name: data?.title_preview ?? data?.title ?? data?.task_name ?? subject,
      source: 'idagents',
      tags: ['task', team, 'supervision'],
      data: { ...data, team, teamId },
      exactId: true,
      mergeAliases: false,
    });
    await timelinePost(ev, 'task-supervision', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...data, team, teamId, task_id: taskId },
      tags: ['task', 'supervision', topic === 'task:triaged' ? 'triaged' : 'refreshed'],
    });
    await postFacts([{
      entity_id: taskId,
      field: 'last_supervision_event',
      value: topic,
      source,
      confidence: 0.9,
      context: { event_seq: ev.seq, reason: data?.reason ?? null },
    }], managerEventIdempotencyKey(ev, 'facts:task-supervision'));
  }

  else if (isTaskAttemptEvent(topic)) {
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    const attempt = {
      task_name: compact(data?.task_name ?? data?.title ?? subject, 280),
      task_uuid: scalarId(data?.task_uuid ?? subject),
      query_id: scalarId(data?.query_id),
      action: scalarId(data?.action),
      approach_key: compact(data?.approach_key ?? '', 500),
      note: compact(data?.note ?? '', 500),
      changed_approach: data?.changed_approach === true,
      repeated: data?.repeated === true,
    };
    await brainPost('/entities', {
      id: taskId,
      type: 'task',
      name: attempt.task_name || subject,
      source: 'idagents',
      tags: ['task', team, 'attempt'],
      data: { ...attempt, team, teamId },
      exactId: true,
      mergeAliases: false,
    });
    await timelinePost(ev, 'task-attempt-approach', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...attempt, team, teamId, task_id: taskId },
      tags: ['task', 'attempt', attempt.repeated ? 'repeated' : 'approach'],
    });
    await postFacts([{
      entity_id: taskId,
      field: 'last_attempt_approach',
      value: attempt,
      source,
      confidence: 0.9,
      context: { event_seq: ev.seq, query_id: attempt.query_id },
    }], managerEventIdempotencyKey(ev, 'facts:task-attempt'));
  }

  else if (isValidatorRecommendationEvent(topic)) {
    const taskId = prefixedEntityId('task', subject, `task:${ev.seq}`);
    const source = taskSourceId(taskId);
    const validator = await resolveAgentNameForEvent(
      data?.validator ?? actor,
      { id: teamId, name: team },
      { refreshUnknown: true },
    );
    const recommendation = {
      task_name: compact(data?.task_name ?? data?.title_preview ?? subject, 280),
      task_uuid: scalarId(data?.task_uuid ?? subject),
      validator,
      lead: scalarId(data?.lead),
      trigger: scalarId(data?.trigger),
      title_preview: compact(data?.title_preview ?? '', 280),
      completion_note_preview: compact(data?.completion_note_preview ?? '', 280),
    };
    await brainPost('/entities', {
      id: taskId,
      type: 'task',
      name: recommendation.task_name || subject,
      source: 'idagents',
      tags: ['task', team, 'validation', 'recommendation'],
      data: { ...recommendation, team, teamId },
      exactId: true,
      mergeAliases: false,
    });
    await timelinePost(ev, 'validator-recommendation-loop', {
      source: 'idagents',
      type: topic,
      subject,
      data: { ...recommendation, team, teamId, task_id: taskId },
      tags: ['task', 'validation', 'recommendation'],
    });
    await postFacts([{
      entity_id: taskId,
      field: 'validator_recommendation_loop',
      value: recommendation,
      source,
      confidence: 0.9,
      context: { event_seq: ev.seq },
    }], managerEventIdempotencyKey(ev, 'facts:validator-recommendation'));
  }

  else if (topic === 'control:brain-write:requested' || topic === 'control:brain-write:delivered') {
    // Manager retains relay transport telemetry in its event journal. Mirroring these
    // acknowledgements back into Brain would duplicate every explicit knowledge write.
    return 'ignored';
  }

  else if (/^(?:control|config|project|plan):/.test(topic)) {
    const isAgentConfig = topic.startsWith('config:agent-');
    const resolvedSubject = isAgentConfig
      ? await resolveAgentNameForEvent(
        subject,
        { id: teamId, name: team },
        {
          hints: [data?.agent, data?.name, data?.change?.name],
          refreshUnknown: true,
        },
      )
      : subject;
    const target = controlEntity(topic, resolvedSubject, data, team, teamId);
    const targetPayload = {
      ...target.payload,
      team,
      teamId,
      ...(isAgentConfig ? {
        name: resolvedSubject,
        internalId: resolvedSubject !== subject ? subject : undefined,
      } : {}),
    };
    const source = `manager-event:${ev.seq}`;
    const tags = Array.from(new Set([
      'manager-control',
      topic.split(':')[0],
      ...(Array.isArray(data?.tags) ? data.tags.map(String).slice(0, 12) : []),
    ]));
    await timelinePost(ev, 'manager-control', {
      source: 'idagents-manager',
      type: topic,
      subject: data?.subject ?? target.name ?? subject,
      data: { ...data, team, teamId, event_seq: ev.seq, actor },
      tags,
    });
    if (target.id && target.type) {
      await brainPost('/entities', {
        id: target.id,
        type: target.type,
        name: target.name || target.id,
        source: 'idagents-manager',
        ...(target.status ? { status: target.status } : {}),
        tags: [target.type, team, 'manager-control'],
        ...(isAgentConfig && resolvedSubject !== subject ? { aliases: [subject] } : {}),
        data: targetPayload,
        exactId: true,
        mergeAliases: false,
      });
      const stable = ['status', 'team', 'lead', 'policy', 'runtime', 'model', 'path']
        .filter((field) => targetPayload?.[field] !== undefined)
        .map((field) => ({
          entity_id: target.id,
          field,
          value: targetPayload[field],
          source,
          confidence: 0.95,
          context: { event_seq: ev.seq, topic },
        }));
      stable.push({
        entity_id: target.id,
        field: 'last_manager_change',
        value: scalarId(data?.action ?? data?.path ?? topic),
        source,
        confidence: 0.95,
        context: { event_seq: ev.seq, topic },
      });
      await postFacts(stable, managerEventIdempotencyKey(ev, 'facts:manager-control'));
    }
    if (isAgentConfig && teamId) {
      try {
        await refreshTeamAgentResolver({ id: teamId, name: team });
      } catch (error) {
        console.warn(
          `[brain-listener] could not refresh agent identities after ${topic} for ${team}:`,
          error.message,
        );
      }
    }
  }

  // Heartbeat / checkin lifecycle — gives brain a unified ops activity log
  else if (isCheckinEvent(topic)) {
    const lifecycle = topic.slice('checkin:'.length);
    await timelinePost(ev, 'checkin', {
      source: 'idagents',
      type:   topic,
      subject: actor ?? subject,
      data:   { ...data, team, teamId },
      tags:   ['heartbeat', lifecycle],
    });
  }

  else if (isQueryControlEvent(topic)) {
    const queryId = prefixedEntityId('query', subject ?? data?.query_id ?? ev.seq, `query:${ev.seq}`);
    const queryLabel = queryId.startsWith('query:') ? queryId.slice('query:'.length) : queryId;
    const taskId = prefixedEntityId('task', data?.task_uuid ?? '', '');
    const agentName = await resolveAgentNameForEvent(
      actor,
      { id: teamId, name: team },
      { refreshUnknown: true },
    );
    const controlReply = {
      action: scalarId(data?.action),
      task_uuid: scalarId(data?.task_uuid),
      task_name: compact(data?.task_name ?? '', 280),
    };
    await brainPost('/entities', {
      id: queryId,
      type: 'query',
      name: queryLabel,
      source: 'idagents',
      tags: ['query', team, 'control-reply'],
      data: { ...controlReply, agent: agentName, team, teamId, queryId },
      exactId: true,
      mergeAliases: false,
    });
    await timelinePost(ev, 'query-control-reply-applied', {
      source: 'idagents',
      type: topic,
      subject: queryLabel,
      data: {
        ...controlReply,
        agent: agentName,
        team,
        teamId,
        task_id: taskId,
        queryId,
      },
      tags: ['query', 'control-reply', 'applied'],
    });
    await postFacts([{
      entity_id: queryId,
      field: 'last_control_reply_action',
      value: controlReply.action || 'applied',
      source: querySourceId(queryId),
      confidence: 0.95,
      context: { event_seq: ev.seq, task_id: taskId },
    }], managerEventIdempotencyKey(ev, 'facts:query-control-reply'));
  }

  else if (isQueryEvent(topic)) {
    const queryStatus = topic === 'query:failed'
      ? 'failed'
      : topic === 'query:expired'
        ? 'expired'
        : 'delivered';
    const internalId = scalarId(actor ?? subject);
    const agentName = await resolveAgentNameForEvent(
      internalId,
      { id: teamId, name: team },
      { hints: [data?.agent], refreshUnknown: true },
    );
    const agentId = agentName ? agentEntityId(team, agentName, teamId) : '';
    const learningAgentName = agentName ? scopedAgentName(team, agentName, teamId) : '';
    const queryId = prefixedEntityId('query', subject ?? data?.queryId ?? ev.seq, `query:${ev.seq}`);
    const queryEntityId = queryId;
    const querySource = querySourceId(queryId);
    const queryLabel = queryId.startsWith('query:') ? queryId.slice('query:'.length) : queryId;
    const agentSource = learningAgentName ? agentSourceId(learningAgentName) : querySource;
    await brainPost('/entities', {
      id: queryEntityId,
      type: 'query',
      name: queryLabel,
      source: 'idagents',
      tags: ['query', team],
      data: { agent: agentName, agentId, team, teamId, topic },
      exactId: true,
      mergeAliases: false,
    });
    if (agentName) {
      await brainPost('/entities', {
        id: agentId,
        type: 'agent',
        name: agentEntityName(team, agentName, teamId),
        source: 'idagents',
        tags: ['agent', team],
        aliases: internalId && internalId !== agentName ? [internalId] : [],
        data: {
          name: agentName,
          team,
          teamId,
          internalId: internalId && internalId !== agentName ? internalId : undefined,
          runtime: data?.runtime,
          model: data?.model,
          provider: data?.provider,
        },
        exactId: true,
        mergeAliases: false,
      });
    }
    await timelinePost(ev, 'query', {
      source: 'idagents', type: topic, subject: agentName,
      data: { ...data, agent: actor, agentName, agentId, team, teamId, queryId },
      tags: ['query', queryStatus === 'delivered' ? 'success' : queryStatus],
    });
    const ingest = await ingestTextUnit(ev, {
      sourceKind: 'idagents-query',
      sourceId: eventSourceId(ev, queryStatus),
      title: `Query ${queryLabel}`,
      content: queryText(ev, data?.learned_artifact ?? data?.learnedArtifact),
      metadata: { query_id: queryId, agent_id: agentName, status: queryStatus },
    });
    const facts = [];
    if (agentName) {
      facts.push(
        { entity_id: agentId, field: 'last_query_status', value: queryStatus, source: agentSource, confidence: 0.8, context: evidenceContext(ev, ingest, { query_id: queryId }) },
      );
    }
    if (agentName) facts.push(...stableRuntimeFacts(agentId, data, evidenceContext(ev, ingest), agentSource));
    if (typeof data?.durationMs === 'number' && agentName) facts.push({ entity_id: agentId, field: 'last_query_duration_ms', value: data.durationMs, source: agentSource, confidence: 0.7, context: evidenceContext(ev, ingest) });
    if (agentName && learnedSkillNamesFromData(data).length) {
      facts.push({
        entity_id: agentId,
        field: 'learned_skill_names',
        value: learnedSkillNamesFromData(data),
        source: agentSource,
        confidence: 0.75,
        context: evidenceContext(ev, ingest),
      });
    }
    facts.push(...stableTextFacts(queryEntityId, data, evidenceContext(ev, ingest, { query_id: queryId }), ['prompt', 'query', 'message', 'result', 'response'], querySource));
    await postFacts(
      sourceFacts(facts, querySource),
      managerEventIdempotencyKey(ev, 'facts:query-event'),
    );
    await handleQueryLearning(LISTENER_DEPS, ev, {
      topic,
      subject,
      data,
      agentName: learningAgentName,
      agentId,
      ingest,
    });
  }

  else {
    return 'unsupported';
  }

  return 'handled';
}

// ─── Main polling loop ────────────────────────────────────────────────────────

async function waitForBrain(maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try { const r = await fetch(`${BRAIN}/health`); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function waitForManager(maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const headers = managerServiceHeaders({
        ...HEADERS,
        'X-Id-Team': BOOTSTRAP_TEAM,
      });
      const r = await fetch(`${MANAGER}/teams`, { headers });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

// Map team-scoped internal agent id → human name. The active map is replaced
// only after a complete inventory. A bounded recent map keeps a just-removed
// identity replay-safe until its Manager event is checkpointed, without
// allowing churn to grow process memory without bound.
const idToName = new Map();
const recentIdToName = new Map();

function agentResolverKey(teamId, internalId) {
  return `${teamId}\u0000${internalId}`;
}

function rememberRecentAgentIdentity(key, name) {
  if (!key || !name) return;
  recentIdToName.delete(key);
  recentIdToName.set(key, name);
  while (recentIdToName.size > MAX_RECENT_AGENT_IDENTITIES) {
    recentIdToName.delete(recentIdToName.keys().next().value);
  }
}

function replaceAgentResolverMap(next) {
  for (const [key, name] of idToName) {
    if (!next.has(key)) rememberRecentAgentIdentity(key, name);
  }
  idToName.clear();
  for (const [key, name] of next) {
    idToName.set(key, name);
    recentIdToName.delete(key);
  }
}

function replaceTeamAgentResolverMap(teamId, agents) {
  const prefix = `${teamId}\u0000`;
  const next = new Map(agents.map((agent) => [
    agentResolverKey(teamId, agent.id),
    agent.name,
  ]));
  for (const [key, name] of idToName) {
    if (key.startsWith(prefix) && !next.has(key)) {
      rememberRecentAgentIdentity(key, name);
      idToName.delete(key);
    }
  }
  for (const [key, name] of next) {
    idToName.set(key, name);
    recentIdToName.delete(key);
  }
}

function normalizeManagerAgents(fleet, team) {
  if (!Array.isArray(fleet?.agents)) {
    throw new Error(`Manager /agents response is invalid for ${team.name}`);
  }
  const seenIds = new Set();
  return fleet.agents.map((agent) => {
    const id = String(agent?.id ?? '').trim();
    const name = String(agent?.name ?? '').trim();
    if (!validIdentityPart(id) || !validIdentityPart(name) || seenIds.has(id)) {
      throw new Error(`Manager /agents returned an invalid identity for ${team.name}`);
    }
    seenIds.add(id);
    return { ...agent, id, name };
  });
}

async function managerJson(path, team = BOOTSTRAP_TEAM) {
  const headers = managerServiceHeaders({ ...HEADERS, 'X-Id-Team': team });
  const response = await fetch(`${MANAGER}${path}`, { headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${response.statusText}`);
  return response.json();
}

async function managerTeams() {
  const data = await managerJson('/teams', BOOTSTRAP_TEAM);
  if (!Array.isArray(data?.teams)) throw new Error('Manager /teams response is invalid');
  const seenIds = new Set();
  const teams = [];
  for (const value of data.teams) {
    const team = validateTeamRecord(value, 'Manager team');
    if (seenIds.has(team.id)) throw new Error('Manager /teams returned duplicate team ids');
    seenIds.add(team.id);
    teams.push(team);
  }
  if (!teams.length) throw new Error('Manager /teams returned no usable teams');
  return teams;
}

async function refreshTeamAgentResolver(team) {
  const identity = validateTeamRecord(team, 'Manager team');
  const fleet = await managerJson(
    `/agents?team=${encodeURIComponent(identity.name)}`,
    identity.name,
  );
  const agents = normalizeManagerAgents(fleet, identity);
  replaceTeamAgentResolverMap(identity.id, agents);
  return agents;
}

function isPrimaryTeam(team, teamId = '') {
  if (primaryTeamIdentity.id && teamId) return teamId === primaryTeamIdentity.id;
  return team === primaryTeamIdentity.name;
}

function agentEntityId(team, name, teamId = '') {
  return isPrimaryTeam(team, teamId)
    ? `agent:${encodeURIComponent(name)}`
    : `agent:team:${encodeURIComponent(teamId || team)}:${encodeURIComponent(name)}`;
}

function agentEntityName(team, name, teamId = '') {
  return isPrimaryTeam(team, teamId) ? name : `${team}/${name}`;
}

function agentEntityAliases(team, agent, teamId = '') {
  const aliases = [agent?.id].filter(Boolean);
  if (!isPrimaryTeam(team, teamId)) aliases.push(`${team}:${agent.name}`, `${team}/${agent.name}`);
  return aliases;
}

function agentEntity(team, agent, teamId = '') {
  return {
    id: agentEntityId(team, agent.name, teamId),
    type: 'agent',
    name: agentEntityName(team, agent.name, teamId),
    source: 'idagents',
    exactId: true,
    status: agent.status,
    tags: ['agent', team],
    aliases: agentEntityAliases(team, agent, teamId),
    data: {
      name: agent.name,
      team,
      teamId,
      runtime: agent.runtime,
      model: agent.model,
      port: agent.port,
      pid: agent.pid,
      internalId: agent.id,
    },
  };
}

async function markStaleAgentEntities(currentIds) {
  try {
    const response = await brainGet('/entities?type=agent&source=idagents&limit=1000', { strict: false });
    const entities = response?.data?.entities ?? [];
    let stale = 0;
    for (const entity of entities) {
      const team = entity?.data?.team;
      if (currentIds.has(entity.id)) continue;
      if (entity.status === 'stale') continue;
      await brainPost('/entities', {
        id: entity.id,
        type: 'agent',
        name: entity.name,
        source: 'idagents',
        exactId: true,
        status: 'stale',
        tags: [...new Set([...(entity.tags ?? []), 'agent', team, 'stale'].filter(Boolean))],
        data: { ...(entity.data ?? {}), stale: true, staleReason: 'absent from latest manager all-team snapshot' },
      });
      stale++;
    }
    return stale;
  } catch (error) {
    console.warn('[brain-listener] stale agent retirement failed:', error.message);
    return 0;
  }
}

async function snapshotFleet({ teams: suppliedTeams = null, throwOnError = false } = {}) {
  let teams = [];
  const currentIds = new Set();
  const nextIdToName = new Map();
  let total = 0;
  try {
    teams = suppliedTeams ?? await managerTeams();
    for (const team of teams) {
      const fleet = await managerJson(`/agents?team=${encodeURIComponent(team.name)}`, team.name);
      const agents = normalizeManagerAgents(fleet, team);
      if (!agents.length) continue;
      for (const a of agents) {
        nextIdToName.set(agentResolverKey(team.id, a.id), a.name);
      }
      for (const agent of agents) currentIds.add(agentEntityId(team.name, agent.name, team.id));
      await brainPost('/entities/bulk', {
        entities: agents.map(agent => agentEntity(team.name, agent, team.id)),
      });
      total += agents.length;
    }
    const stale = await markStaleAgentEntities(currentIds);
    if (stale) console.log(`[brain-listener] marked ${stale} stale agent cache rows`);
    // Replace the resolver cache only after every team inventory and Brain
    // projection completed. A partial snapshot keeps the last known-good map,
    // while successful team deletion/recreation cannot leak old mappings.
    replaceAgentResolverMap(nextIdToName);
  } catch (e) {
    console.warn('[brain-listener] fleet snapshot failed:', e.message);
    if (throwOnError) throw e;
  }
  return total;
}

function resolveAgentName(actorOrId, team = primaryTeamIdentity) {
  if (!actorOrId) return null;
  if (team?.id) {
    const key = agentResolverKey(team.id, actorOrId);
    const match = idToName.get(key) ?? recentIdToName.get(key);
    if (match) return match;
  }
  return actorOrId;
}

function looksLikeManagerAgentId(value) {
  return /^(?:agent_|local_|remote_|virtual_|onchain_)/.test(String(value ?? ''))
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value ?? ''));
}

async function resolveAgentNameForEvent(
  actorOrId,
  team = primaryTeamIdentity,
  { hints = [], refreshUnknown = false } = {},
) {
  const internalId = scalarId(actorOrId);
  if (!internalId) return null;
  const cached = resolveAgentName(internalId, team);
  if (cached !== internalId) return cached;
  const hinted = hints
    .map(scalarId)
    .find((value) => value && value !== internalId);
  if (hinted) {
    if (team?.id) {
      const key = agentResolverKey(team.id, internalId);
      rememberRecentAgentIdentity(key, hinted);
    }
    return hinted;
  }
  if (
    !team?.id
    || !validIdentityPart(internalId)
    || (!refreshUnknown && !looksLikeManagerAgentId(internalId))
  ) {
    return internalId;
  }
  try {
    const historicalName = await resolveAgentNameFromBrainInventory(internalId, team);
    if (historicalName) return historicalName;
  } catch (error) {
    console.warn(
      `[brain-listener] could not read the Brain agent inventory for ${team?.name ?? 'unknown team'}:`,
      error.message,
    );
  }
  try {
    await refreshTeamAgentResolver(team);
  } catch (error) {
    console.warn(
      `[brain-listener] could not refresh agent identities for ${team?.name ?? 'unknown team'}:`,
      error.message,
    );
  }
  return resolveAgentName(internalId, team);
}

async function resolveAgentNameFromBrainInventory(internalId, team) {
  const response = await brainGet(
    `/entities?type=agent&q=${encodeURIComponent(internalId)}&limit=100`,
    { strict: false },
  );
  if (!response.ok || !Array.isArray(response.data?.entities)) return null;
  const entity = response.data.entities.find((candidate) => {
    const stored = candidate?.data;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return false;
    const hasInternalId = scalarId(stored.internalId) === internalId
      || (
        Array.isArray(candidate.aliases)
        && candidate.aliases.some((alias) => scalarId(alias?.alias) === internalId)
      );
    if (!hasInternalId) return false;
    if (team?.id && scalarId(stored.teamId)) return scalarId(stored.teamId) === team.id;
    return scalarId(stored.team) === team?.name;
  });
  const qualifiedPrefix = `${team?.name ?? ''}/`;
  const name = scalarId(entity?.data?.name)
    || (
      scalarId(entity?.name).startsWith(qualifiedPrefix)
        ? scalarId(entity?.name).slice(qualifiedPrefix.length)
        : scalarId(entity?.name)
    );
  if (!name || !validIdentityPart(name)) return null;
  rememberRecentAgentIdentity(agentResolverKey(team.id, internalId), name);
  return name;
}

function teamInventorySignature(teams) {
  return teams
    .map((team) => `${team.id}\u0000${team.name}`)
    .sort()
    .join('\u0001');
}

function mergeActiveTeamsIntoRegistry(registry, activeTeams) {
  reconcileActiveTeams(registry, activeTeams);
  writeCursorRegistry(registry);
}

function validateFeedSequence(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Manager event feed ${label} is invalid`);
  }
  return value;
}

async function pollTeamEvents(registry, team) {
  const cursorEntry = registry.teams.find((entry) => entry.id === team.id);
  if (!cursorEntry) throw new Error(`listener cursor is missing team ${team.name}`);
  const headers = managerServiceHeaders({ ...HEADERS, 'X-Id-Team': team.name });
  const response = await fetch(
    `${MANAGER}/events?since=${cursorEntry.seq}&limit=50`,
    { headers, signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) {
    throw new Error(`/events for ${team.name} returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Manager event feed for ${team.name} is not an object`);
  }
  if (payload.stream_id !== team.id) {
    throw new Error(`Manager event stream identity mismatch for ${team.name}`);
  }
  const earliestAvailableSeq = payload.earliest_available_seq === null
    ? null
    : validateFeedSequence(payload.earliest_available_seq, 'earliest_available_seq');
  const latestAvailableSeq = payload.latest_available_seq === null
    ? null
    : validateFeedSequence(payload.latest_available_seq, 'latest_available_seq');
  if (
    (earliestAvailableSeq === null) !== (latestAvailableSeq === null)
    || (
      earliestAvailableSeq !== null
      && latestAvailableSeq !== null
      && earliestAvailableSeq > latestAvailableSeq
    )
  ) {
    throw new Error(`Manager event availability range is invalid for ${team.name}`);
  }
  if (!Array.isArray(payload.events)) {
    throw new Error(`Manager event feed for ${team.name} omits events`);
  }
  if (typeof payload.replay_truncated !== 'boolean') {
    throw new Error(`Manager event feed for ${team.name} omits replay_truncated`);
  }

  if (payload.cursor_reset === true) {
    if (
      payload.cursor_reset_reason !== 'ahead_of_log'
      || payload.events.length !== 0
      || payload.replay_truncated !== false
      || cursorEntry.seq <= (latestAvailableSeq ?? 0)
    ) {
      throw new Error(`Manager event cursor reset contract is invalid for ${team.name}`);
    }
    const resetCursor = validateFeedSequence(payload.next_seq, 'reset next_seq');
    const expectedResetCursor = earliestAvailableSeq === null
      ? 0
      : Math.max(0, earliestAvailableSeq - 1);
    if (resetCursor !== expectedResetCursor) {
      throw new Error(`Manager event cursor reset target is invalid for ${team.name}`);
    }
    console.warn(
      `[brain-listener] resetting ${team.name} cursor ${cursorEntry.seq} → ${resetCursor} `
      + '(Manager event log is behind the profile cursor)',
    );
    await persistTeamCursor(registry, team, resetCursor);
    return { processed: 0, reset: true };
  }
  if (payload.cursor_reset !== false) {
    throw new Error(`Manager event feed for ${team.name} omits cursor_reset`);
  }
  if (
    latestAvailableSeq === null
      ? cursorEntry.seq !== 0
      : cursorEntry.seq > latestAvailableSeq
  ) {
    throw new Error(`Manager failed to reset an ahead cursor for ${team.name}`);
  }
  const expectedReplayTruncated = earliestAvailableSeq !== null
    && cursorEntry.seq < earliestAvailableSeq - 1;
  if (payload.replay_truncated !== expectedReplayTruncated) {
    throw new Error(`Manager event replay_truncated disagrees with availability for ${team.name}`);
  }
  if (payload.events.length > 50) {
    throw new Error(`Manager event feed exceeded the requested page size for ${team.name}`);
  }

  // Validate the complete normal-page envelope before producing any Brain side
  // effects or durable checkpoints. A malformed next_seq or truncated-history
  // declaration must not become accepted merely because individual rows looked
  // usable.
  const validatedEvents = [];
  let validatedNextCursor = cursorEntry.seq;
  for (const rawEvent of payload.events) {
    if (
      !rawEvent
      || typeof rawEvent !== 'object'
      || Array.isArray(rawEvent)
      || rawEvent.team !== team.name
      || !validIdentityPart(rawEvent.topic)
      || !Number.isSafeInteger(rawEvent.occurred_at)
      || rawEvent.occurred_at < 0
      || !rawEvent.data
      || typeof rawEvent.data !== 'object'
      || Array.isArray(rawEvent.data)
    ) {
      throw new Error(`Manager event feed crossed team scope for ${team.name}`);
    }
    const seq = validateFeedSequence(rawEvent.seq, 'event seq');
    if (seq <= validatedNextCursor) {
      throw new Error(`Manager event feed is not strictly increasing for ${team.name}`);
    }
    if (
      earliestAvailableSeq === null
      || latestAvailableSeq === null
      || seq < earliestAvailableSeq
      || seq > latestAvailableSeq
    ) {
      throw new Error(`Manager event seq is outside the available range for ${team.name}`);
    }
    validatedEvents.push({ rawEvent, seq });
    validatedNextCursor = seq;
  }

  const responseCursor = validateFeedSequence(payload.next_seq, 'next_seq');
  if (responseCursor !== validatedNextCursor) {
    throw new Error(`Manager event feed next_seq disagrees with events for ${team.name}`);
  }
  if (latestAvailableSeq === null && responseCursor !== 0) {
    throw new Error(`Manager empty event feed cursor is invalid for ${team.name}`);
  }
  if (
    validatedEvents.length === 0
    && latestAvailableSeq !== null
    && cursorEntry.seq < latestAvailableSeq
  ) {
    throw new Error(`Manager event feed omitted available events for ${team.name}`);
  }
  if (
    expectedReplayTruncated
    && validatedEvents[0]?.seq !== earliestAvailableSeq
  ) {
    throw new Error(`Manager truncated replay did not begin at retained history for ${team.name}`);
  }

  let nextCursor = cursorEntry.seq;
  for (const { rawEvent, seq } of validatedEvents) {
    const disposition = await handleEvent({ ...rawEvent, stream_id: team.id });
    if (disposition === 'unsupported') {
      console.warn(
        `[brain-listener] unsupported Manager event ${rawEvent.topic} `
        + `for ${team.name} at seq=${seq}; checkpointing without a Brain projection`,
      );
    }
    nextCursor = seq;
    await persistTeamCursor(registry, team, nextCursor);
  }
  if (payload.events.length > 0) {
    console.log(`[brain-listener] processed ${payload.events.length} ${team.name} events, cursor=${nextCursor}`);
  }
  if (payload.replay_truncated === true) {
    console.warn(`[brain-listener] ${team.name} replay began after pruned Manager history`);
  }
  return { processed: payload.events.length, reset: false };
}

async function mapWithConcurrency(values, concurrency, fn) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log(`[brain-listener] starting — brain=${BRAIN} manager=${MANAGER} configured-team=${TEAM}`);

  if (!await waitForBrain()) { console.error('[brain-listener] brain not available after 30s — exiting'); process.exit(1); }
  if (!await waitForManager()) { console.error('[brain-listener] manager not available after 30s — exiting'); process.exit(1); }

  let activeTeams = await managerTeams();
  const registry = await initializeCursorRegistry(activeTeams);
  console.log(
    `[brain-listener] primary team=${registry.primaryTeam.name} (${registry.primaryTeam.id}); `
    + `tracking ${activeTeams.length} active teams`,
  );

  // Startup snapshot
  let identityRefreshPending = false;
  try {
    const n = await snapshotFleet({ teams: activeTeams, throwOnError: true });
    if (n) console.log(`[brain-listener] seeded ${n} agents into brain`);
  } catch (error) {
    identityRefreshPending = true;
    console.warn('[brain-listener] startup fleet snapshot will be retried:', error.message);
  }

  // Periodic re-snapshot every hour — catches model/status changes that aren't event-driven
  setInterval(async () => {
    try {
      const m = await snapshotFleet();
      if (m) console.log(`[brain-listener] hourly snapshot: ${m} agents refreshed`);
    } catch (error) {
      console.warn('[brain-listener] hourly fleet snapshot failed:', error.message);
    }
  }, 60 * 60 * 1000).unref();

  let nextTeamRefreshAt = Date.now() + 15_000;
  let inventoryHealthy = true;
  const teamPollFailures = new Map();

  while (true) {
    if (Date.now() >= nextTeamRefreshAt) {
      try {
        const discoveredTeams = await managerTeams();
        const inventoryChanged = teamInventorySignature(discoveredTeams)
          !== teamInventorySignature(activeTeams);
        activeTeams = discoveredTeams;
        mergeActiveTeamsIntoRegistry(registry, activeTeams);
        if (inventoryChanged || identityRefreshPending) {
          identityRefreshPending = true;
          const refreshed = await snapshotFleet({
            teams: activeTeams,
            throwOnError: true,
          });
          identityRefreshPending = false;
          console.log(
            `[brain-listener] active team inventory changed: ${refreshed} agents refreshed`,
          );
        }
        const activeIds = new Set(activeTeams.map((team) => team.id));
        for (const teamId of teamPollFailures.keys()) {
          if (!activeIds.has(teamId)) teamPollFailures.delete(teamId);
        }
        inventoryHealthy = true;
      } catch (error) {
        inventoryHealthy = false;
        console.warn('[brain-listener] team inventory refresh failed:', error.message);
      }
      nextTeamRefreshAt = Date.now() + 15_000;
    }

    const roundStartedAt = Date.now();
    const outcomes = await mapWithConcurrency(
      activeTeams,
      TEAM_POLL_CONCURRENCY,
      async (team) => {
        const failureState = teamPollFailures.get(team.id);
        if (failureState?.nextAttemptAt > roundStartedAt) {
          return { healthy: false, processed: 0 };
        }
        try {
          const result = await pollTeamEvents(registry, team);
          teamPollFailures.delete(team.id);
          return { healthy: true, processed: result.processed };
        } catch (error) {
          const failures = Math.min(6, (failureState?.failures ?? 0) + 1);
          const delayMs = Math.min(30_000, 1000 * (2 ** (failures - 1)));
          teamPollFailures.set(team.id, {
            failures,
            nextAttemptAt: Date.now() + delayMs,
          });
          console.warn(
            `[brain-listener] ${team.name} poll failed; retrying in ${delayMs}ms:`,
            error.message,
          );
          return { healthy: false, processed: 0 };
        }
      },
    );
    const roundHealthy = inventoryHealthy && outcomes.every((outcome) => outcome.healthy);
    const processed = outcomes.reduce((total, outcome) => total + outcome.processed, 0);
    if (roundHealthy) writeListenerStatus(registry, activeTeams);
    if (processed === 0 || !roundHealthy) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function isDirectExecution(
  argvPath,
  modulePath = fileURLToPath(import.meta.url),
  platform = process.platform,
) {
  if (!argvPath) return false;
  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi.resolve(argvPath) === pathApi.resolve(modulePath);
}

if (isDirectExecution(process.argv[1])) {
  let stopping = false;
  let stopParentWatchdog = () => {};
  const shutdown = (reason) => {
    if (stopping) return;
    stopping = true;
    stopParentWatchdog();
    console.log(`[brain-listener] shutting down (${reason})`);
    process.exit(0);
  };
  stopParentWatchdog = startParentDeathWatchdog(() => shutdown('parent-exit'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', () => stopParentWatchdog());
  main().catch(async e => {
    await recordScriptFailure({ script: 'brain-listener', error: e, context: { manager: MANAGER, team: TEAM } });
    console.error('[brain-listener] fatal:', e);
    process.exit(1);
  });
}

export {
  handleEvent,
  initializeCursorRegistry,
  isDirectExecution,
  loadCursor,
  pollTeamEvents,
  saveCursor,
  snapshotFleet,
  writeListenerStatus,
};
