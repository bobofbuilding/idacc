// ─── Request router ───────────────────────────────────────────────────────────

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_AGENTS_HTML, DASHBOARD_HEALTH_HTML, DASHBOARD_HTML, DASHBOARD_LEARNING_HTML, DASHBOARD_SKILLS_HTML } from './dashboard/dashboards.mjs';
import {
  STMT,
  LIVE,
  db,
  ftsAvailable,
  isIntegerValue,
  upsertNode,
  upsertEdge,
  deleteNode,
  rowToNode,
  isBlockedNode,
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
  controllerScopeUserId,
  getController,
  listControllers,
  upsertController,
  linkControllerAgent,
  normalizeAlias,
  normalizeFactEntityId,
  factEntityWriteTarget,
  factStatusProjection,
  auditFactEntityIntegrity,
  rowToEntity,
  upsertEntity,
  sqliteVecStatus,
  vectorCandidatesForEmbedding,
  vectorReplayGateThresholds,
  brainHealthSignals,
  auditBrainConnectivity,
  connectIdaccAgentTeamGraph,
  connectSourceBackedIsolatedEntities,
  connectOperationalProvenanceEntities,
  upsertFact,
  upsertTextUnitsFromSource,
  linkTextUnitToEntities,
  linkFactToTextUnits,
  linkFactsForTextUnit,
  upsertEntityEdge,
  validateEntityEdgeSemantics,
  inferEdgesFromTextUnits,
  buildDeterministicCommunities,
  rollupEntityFactsData,
  curatorMergeEntities,
  curatorChangeEntityType,
} from './db.mjs';
import { applyCorsAndSecurityGuard, err, fail, readBody, send } from './http.mjs';
import { managerServiceHeaders } from './manager-service-client.mjs';
import {
  createLearningTask as policyCreateLearningTask,
  mineCorrectionPatterns,
  parseLearningTask,
  recordLearningRollback as policyRecordLearningRollback,
} from './learning-policy.mjs';
import {
  KNOWN_ENTITY_EDGE_KINDS,
  KNOWN_SKILL_EDGE_KINDS,
  canonicalSourceIds as canonicalSourceIdsForResolver,
  graphEdgeIssues,
  parseEdgeReviewSubject,
  sourceKindFromCanonical,
  sourceRow,
  validateSourceIds,
} from './sources.mjs';
import { canonicalSourceId, normalizeSourceIds } from './source-ids.mjs';
import { normalizeRouteAckState, normalizeRouteIds, normalizeStringList, stableEvalArtifactHash } from './eval-artifact-hash.mjs';
import { handleLearningRoutes } from './routes/learning.mjs';
import { handleApprovalQueueRoutes } from './routes/approvals.mjs';
import { buildSkillProposalReport, handleSkillRoutes } from './routes/skills.mjs';
import { handleManagerContractRoutes } from './routes/manager-contract.mjs';
import { handleRepoRoutes } from './routes/repos.mjs';
import { handleMetricsRoutes } from './routes/metrics.mjs';
import { handleMemoryRoutes } from './routes/memory.mjs';
import { handleControllerRoutes } from './routes/controllers.mjs';
import { handleContextRoutes } from './routes/context.mjs';
import { handleCoreRoutes } from './routes/core.mjs';
import { evalReplaySnapshotStamp, handleEvalRoutes } from './routes/eval.mjs';
import { handleInstructionRoutes } from './routes/instructions.mjs';
import { handleQueryRoutes } from './routes/query.mjs';
import { promptVersion } from './prompt-config.mjs';
import { handleSourceRoutes } from './routes/sources.mjs';
import { handleTimelineRoutes } from './routes/timeline.mjs';
import { handleGraphAppRoutes } from './routes/graph-app.mjs';
import {
  idempotencyErrorBody,
  insertIdempotentTimeline,
  normalizeIdempotencyKey,
  readIdempotencyReceipt,
  writeIdempotencyReceipt,
} from './idempotency.mjs';
import { learningTaskQueueSummary as buildLearningTaskQueueSummary } from './routes/metrics-report-builder.mjs';
import { phaseAttribution as buildPhaseAttribution } from './context/service.mjs';
import { CANONICAL_SOURCE_ORIGINS, addSourceOrigin, mergeSourceOrigins, normalizeSourceOrigins } from './source-origins.mjs';
import {
  buildNextRecommendations,
  summarizePhaseImprovementOutcomes,
  trajectoryReflectionSummary,
} from './cycle/next-recommendations.mjs';
import { curatorPolicy } from './cycle/curator.mjs';
import { maintenancePolicy } from './cycle/maintenance-flow.mjs';
import { checkFactEntityIntegrity } from './maintenance.mjs';

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

const ROUTES = [
  { method: 'GET', pattern: '/health', critical: true, owner: 'core' },
  { method: 'GET', pattern: '/routes', critical: true, owner: 'core' },
  { method: 'GET', pattern: '/dashboard', owner: 'dashboard' },
  { method: 'GET', pattern: '/dashboard/health', owner: 'dashboard' },
  { method: 'GET', pattern: '/dashboard/skills', owner: 'dashboard' },
  { method: 'GET', pattern: '/dashboard/learning', owner: 'dashboard' },
  { method: 'GET', pattern: '/dashboard/agents', owner: 'dashboard' },
  { method: 'GET', pattern: '/dashboard/graph', owner: 'dashboard' },
  { method: 'GET', pattern: '/graph/app', owner: 'dashboard' },
  { method: 'GET', pattern: '/graph/app/vendor/3d-force-graph.min.js', owner: 'dashboard' },
  { method: 'GET', pattern: '/graph/app/data', owner: 'dashboard' },
  { method: 'GET', pattern: '/fleet-report', owner: 'fleet' },
  { method: 'GET', pattern: '/graph/stats', owner: 'graph' },
  { method: 'GET', pattern: '/graph/quality', owner: 'graph' },
  { method: 'GET', pattern: '/graph/nodes', owner: 'graph' },
  { method: 'GET', pattern: '/graph/nodes/:id', owner: 'graph' },
  { method: 'GET', pattern: '/graph/nodes/:id/safety-report', owner: 'graph' },
  { method: 'GET', pattern: '/providers/reputation', owner: 'graph' },
  { method: 'POST', pattern: '/graph/nodes', owner: 'graph' },
  { method: 'POST', pattern: '/graph/nodes/bulk', owner: 'graph' },
  { method: 'POST', pattern: '/graph/nodes/:id/use', owner: 'graph' },
  { method: 'DELETE', pattern: '/graph/nodes/:id', owner: 'graph' },
  { method: 'GET', pattern: '/graph/nodes/:id/neighbors', owner: 'graph' },
  { method: 'POST', pattern: '/graph/edges', owner: 'graph' },
  { method: 'POST', pattern: '/graph/edges/bulk', owner: 'graph' },
  { method: 'POST', pattern: '/graph/sync', owner: 'graph' },
  { method: 'GET', pattern: '/graph/connectivity', owner: 'graph' },
  { method: 'POST', pattern: '/graph/connectivity/repair', owner: 'graph' },
  { method: 'GET', pattern: '/graph/path', owner: 'graph' },
  { method: 'POST', pattern: '/graph/recommend', owner: 'graph' },
  { method: 'POST', pattern: '/graph/compose', owner: 'graph' },
  { method: 'GET', pattern: '/graph/domains', owner: 'graph' },
  { method: 'GET', pattern: '/graph/nodes/:id/stats', owner: 'graph' },
  { method: 'GET', pattern: '/skills/index', owner: 'skills' },
  { method: 'GET', pattern: '/memory/shared', owner: 'memory' },
  { method: 'GET', pattern: '/memory/:agentId', owner: 'memory' },
  { method: 'GET', pattern: '/memory/:agentId/search', owner: 'memory' },
  { method: 'GET', pattern: '/memory/:agentId/:key', owner: 'memory' },
  { method: 'POST', pattern: '/memory/validate', owner: 'memory' },
  { method: 'POST', pattern: '/memory/:agentId', owner: 'memory' },
  { method: 'DELETE', pattern: '/memory/:agentId/:key', owner: 'memory' },
  { method: 'POST', pattern: '/memory/:agentId/summarize', owner: 'memory' },
  { method: 'DELETE', pattern: '/memory/:agentId/_old', owner: 'memory' },
  { method: 'GET', pattern: '/controllers', owner: 'identity' },
  { method: 'POST', pattern: '/controllers', owner: 'identity' },
  { method: 'GET', pattern: '/controllers/:id', owner: 'identity' },
  { method: 'POST', pattern: '/controllers/:id/agent-links', owner: 'identity' },
  { method: 'GET', pattern: '/entities', owner: 'graph' },
  { method: 'GET', pattern: '/entities/:id', owner: 'graph' },
  { method: 'GET', pattern: '/communities', owner: 'query' },
  { method: 'GET', pattern: '/community-reports', owner: 'query' },
  { method: 'POST', pattern: '/entities', owner: 'graph' },
  { method: 'POST', pattern: '/entities/bulk', owner: 'graph' },
  { method: 'GET', pattern: '/entities/:id/facts', owner: 'graph' },
  { method: 'GET', pattern: '/facts/export', owner: 'graph' },
  { method: 'GET', pattern: '/facts/integrity', owner: 'graph' },
  { method: 'POST', pattern: '/entity-edges', owner: 'graph' },
  { method: 'POST', pattern: '/entity-edges/bulk', owner: 'graph' },
  { method: 'POST', pattern: '/facts', owner: 'graph' },
  { method: 'POST', pattern: '/facts/bulk', owner: 'graph' },
  { method: 'GET', pattern: '/timeline', owner: 'timeline' },
  { method: 'POST', pattern: '/timeline', owner: 'timeline' },
  { method: 'POST', pattern: '/text-units/ingest', owner: 'context' },
  { method: 'POST', pattern: '/text-units/produce', owner: 'context' },
  { method: 'GET', pattern: '/text-units', owner: 'context' },
  { method: 'GET', pattern: '/text-units/:id', owner: 'context' },
  { method: 'POST', pattern: '/brain/index', owner: 'query' },
  { method: 'POST', pattern: '/query/fts', owner: 'query' },
  { method: 'POST', pattern: '/query/local', owner: 'query' },
  { method: 'POST', pattern: '/query/global', owner: 'query' },
  { method: 'POST', pattern: '/query/drift', owner: 'query' },
  { method: 'POST', pattern: '/query/questions', owner: 'query' },
  { method: 'POST', pattern: '/context/volunteer', critical: true, owner: 'context' },
  { method: 'POST', pattern: '/context/package', critical: true, owner: 'context' },
  { method: 'GET', pattern: '/context/packages/:id', critical: true, owner: 'context' },
  { method: 'POST', pattern: '/context/packages/:id/expand', critical: true, owner: 'context' },
  { method: 'POST', pattern: '/context/feedback-missing', critical: true, owner: 'context' },
  { method: 'POST', pattern: '/instructions/feedback', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/manager/learning-contract/validate', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/sources/validate', critical: true, owner: 'context' },
  { method: 'GET', pattern: '/sources/:id', owner: 'context' },
  { method: 'GET', pattern: '/repos', owner: 'context' },
  { method: 'POST', pattern: '/repos/digest', critical: true, owner: 'context' },
  { method: 'POST', pattern: '/eval/capture', critical: true, owner: 'eval' },
  { method: 'POST', pattern: '/eval/replay', critical: true, owner: 'eval' },
  { method: 'POST', pattern: '/eval/fixtures/promote', critical: true, owner: 'eval' },
  { method: 'GET', pattern: '/skill-proposals/report', owner: 'skills' },
  { method: 'POST', pattern: '/skill-proposals/repair-tasks', owner: 'skills' },
  { method: 'GET', pattern: '/metrics/learning', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/approvals', owner: 'approvals' },
  { method: 'GET', pattern: '/approvals', owner: 'approvals' },
  { method: 'GET', pattern: '/approvals/:id', owner: 'approvals' },
  { method: 'POST', pattern: '/approvals/:id/resolve', owner: 'approvals' },
  { method: 'POST', pattern: '/approvals/:id/apply', critical: true, owner: 'approvals' },
  { method: 'POST', pattern: '/proposals', owner: 'approvals' },
  { method: 'GET', pattern: '/proposals', owner: 'approvals' },
  { method: 'GET', pattern: '/proposals/:id', owner: 'approvals' },
  { method: 'POST', pattern: '/proposals/:id/resolve', owner: 'approvals' },
  { method: 'POST', pattern: '/proposals/:id/apply', critical: true, owner: 'approvals' },
  { method: 'GET', pattern: '/learning-tasks', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/learning-tasks', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/learning-tasks/claim', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/learning-tasks/recover', critical: true, owner: 'learning' },
  { method: 'PATCH', pattern: '/learning-tasks/:id', owner: 'learning' },
  { method: 'POST', pattern: '/brain/gap-detector/run', owner: 'learning' },
  { method: 'GET', pattern: '/learning-rollbacks', critical: true, owner: 'learning' },
  { method: 'POST', pattern: '/learning-rollbacks/:id/apply', critical: true, owner: 'learning' },
  { method: 'GET', pattern: '/brain/learning-history', owner: 'learning' },
  { method: 'POST', pattern: '/brain/source-precision-snapshot', owner: 'learning' },
  { method: 'POST', pattern: '/brain/instruction-scope-snapshot', owner: 'learning' },
  { method: 'GET', pattern: '/brain/learning-report', critical: true, owner: 'learning' },
  { method: 'GET', pattern: '/brain/health', critical: true, owner: 'learning' },
  { method: 'GET', pattern: '/brain/health-view', critical: true, owner: 'learning' },
];

const ROUTE_INVENTORY = ROUTES.map(route => `${route.method} ${route.pattern}`).sort();
const ROUTE_REGISTRY = ROUTES
  .map(route => ({ ...route, route: `${route.method} ${route.pattern}` }))
  .sort((a, b) => a.route.localeCompare(b.route));

const CRITICAL_LEARNING_ROUTES = ROUTE_REGISTRY
  .filter(route => route.critical)
  .map(route => route.route)
  .sort();

function idAgentsRoot() {
  return process.env.ID_AGENTS_ROOT || path.resolve(ROUTES_DIR, '..', '..', '..');
}

function idaccSkillsDir() {
  return process.env.IDACC_SKILLS_DIR
    || process.env.ID_AGENTS_SKILLS_DIR
    || path.resolve(idAgentsRoot(), 'skills');
}

function stripYamlScalar(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function normalizeSkillTags(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const raw = stripYamlScalar(value);
  if (!raw) return [];
  const unwrapped = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return unwrapped.split(',').map(v => stripYamlScalar(v)).filter(Boolean);
}

function parseSkillFrontmatter(raw) {
  const lines = String(raw ?? '').split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') return {};
  const frontmatter = {};
  let section = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (line === '---' || line === '...') break;
    const nested = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && section) {
      const container = frontmatter[section] && typeof frontmatter[section] === 'object' ? frontmatter[section] : {};
      container[nested[1]] = stripYamlScalar(nested[2]);
      frontmatter[section] = container;
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) continue;
    const [, key, value] = top;
    if (!value.trim()) {
      section = key;
      frontmatter[key] = {};
    } else {
      section = null;
      frontmatter[key] = stripYamlScalar(value);
    }
  }
  return frontmatter;
}

function scanIdaccSkillCatalog() {
  const skillsDir = idaccSkillsDir();
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => {
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return null;
        const raw = fs.readFileSync(skillFile, 'utf8');
        const fm = parseSkillFrontmatter(raw);
        const metadata = fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata) ? fm.metadata : {};
        const tags = normalizeSkillTags(metadata.tags ?? fm.tags);
        return {
          name: String(fm.name || entry.name),
          skillId: entry.name,
          description: fm.description ? String(fm.description) : null,
          tags,
          license: fm.license ? String(fm.license) : null,
          domain: String(metadata.category || fm.category || tags.find(tag => !['plugin', 'skill-catalog'].includes(tag)) || 'idacc-library'),
          source: metadata.source ? String(metadata.source) : 'idacc-library',
          hasSkillMd: true,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { skillsDir, entries, error: null };
  } catch (err) {
    return { skillsDir, entries: [], error: err?.message || String(err) };
  }
}

function normalizeSearchText(value) {
  return String(value ?? '').toLowerCase();
}

function localCatalogMatches(node, { q, domain, tag }) {
  if (domain && normalizeSearchText(node.domain) !== normalizeSearchText(domain)) return false;
  if (tag && !(node.tags || []).some(t => normalizeSearchText(t) === normalizeSearchText(tag))) return false;
  if (!q) return true;
  const haystack = [
    node.skillId,
    node.name,
    node.description,
    node.domain,
    ...(node.tags || []),
  ].join(' ').toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function mergeIdaccCatalogWithGraph(idaccEntries, graphCatalogNodes, { q, domain, tag, sort, limit, offset }) {
  const graphByName = new Map();
  const graphBySkillId = new Map();
  for (const graphNode of graphCatalogNodes) {
    graphByName.set(normalizeSearchText(graphNode.name), graphNode);
    graphBySkillId.set(String(graphNode.skillId), graphNode);
  }
  const catalogNodes = idaccEntries.map((entry, index) => {
    const graphNode = graphBySkillId.get(String(entry.skillId)) || graphByName.get(normalizeSearchText(entry.name));
    return {
      skillId: graphNode?.skillId ?? entry.skillId,
      name: entry.name,
      description: entry.description || graphNode?.description || '',
      domain: entry.domain || graphNode?.domain || 'idacc-library',
      tags: [...new Set([...(entry.tags || []), ...(graphNode?.tags || []), 'skill-catalog'])],
      computeCost: graphNode?.computeCost ?? null,
      chainable: graphNode?.chainable ?? false,
      useCount: graphNode?.useCount ?? 0,
      source: 'idacc-library',
      localSkillId: entry.skillId,
      license: entry.license,
      hasSkillMd: entry.hasSkillMd,
      catalogRank: index,
      graphSkillId: graphNode?.skillId ?? null,
      graphSynced: Boolean(graphNode),
    };
  });
  const filtered = catalogNodes
    .filter(node => localCatalogMatches(node, { q, domain, tag }))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      return Number(b.useCount ?? 0) - Number(a.useCount ?? 0) || a.name.localeCompare(b.name);
    });
  const localNames = new Set(idaccEntries.map(entry => normalizeSearchText(entry.name)));
  const localIds = new Set(idaccEntries.map(entry => String(entry.skillId)));
  const graphOnlyNodes = graphCatalogNodes.filter(graphNode => !localNames.has(normalizeSearchText(graphNode.name)) && !localIds.has(String(graphNode.skillId)));
  return {
    catalogNodes,
    nodes: filtered.slice(offset, offset + limit),
    total: filtered.length,
    graphOnlyNodes,
  };
}

export function routeInventoryReport(expected = CRITICAL_LEARNING_ROUTES) {
  const routes = new Set(ROUTE_INVENTORY);
  const missing = expected.filter(route => !routes.has(route));
  return {
    routes: ROUTE_INVENTORY,
    registry: ROUTE_REGISTRY,
    count: ROUTE_INVENTORY.length,
    criticalLearningRoutes: CRITICAL_LEARNING_ROUTES,
    expected,
    missing,
    skew: missing.length > 0,
  };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => { out[key] = stableClone(value[key]); });
    return out;
  }
  return value ?? null;
}

function approvalSnapshotStamp(row) {
  if (!row) return '';
  return JSON.stringify(stableClone({
    id: row.id,
    status: row.status,
    kind: row.kind,
    subject: row.subject,
    riskLevel: row.risk_level ?? null,
    requestedBy: row.requested_by ?? null,
    createdAt: row.created_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    payload: parseJson(row.payload, {}),
    resolution: parseJson(row.resolution, {}),
  }));
}

function managerUrl() {
  return (process.env.MANAGER_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
}

function defaultManagerTeam() {
  return process.env.ID_TEAM ?? process.env.IDCTL_TEAM ?? 'default';
}

function configuredFleetTeams() {
  return String(process.env.BRAIN_FLEET_TEAMS ?? '')
    .split(',')
    .map(team => team.trim())
    .filter(Boolean);
}

function strictConfiguredFleetTeams() {
  return /^(1|true|yes)$/i.test(String(process.env.BRAIN_FLEET_TEAMS_STRICT ?? ''));
}

function isLiveAgentStatus(status) {
  // Match the id-agents manager lifecycle contract: running totals count only
  // rows whose lifecycle status is exactly "running". Health labels such as
  // "online" or "ok" stay visible in byStatus, but they are not process proof.
  return String(status ?? '').toLowerCase() === 'running';
}

const SENSITIVE_METADATA_KEY_RE = /private_?key|creator_?key|secret|api_?key|auth|bearer|password|seed|mnemonic|credential|(^|[_-])token($|[_-])|access_?token|refresh_?token|session_?token/i;
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

const GAS_ETH_PATHS = [
  'gasEth',
  'gas_spend_eth',
  'gasSpendEth',
  'gasCostEth',
  'gas_cost_eth',
  'totalGasEth',
  'txFeeEth',
  'tx_fee_eth',
  'transactionFeeEth',
  'transaction_fee_eth',
  'feeEth',
  'nativeFeeEth',
  'native_fee_eth',
  'receipt.gasEth',
  'receipt.gasSpendEth',
  'receipt.txFeeEth',
  'transaction.gasEth',
  'transaction.gasSpendEth',
];
const GAS_WEI_PATHS = [
  'gasWei',
  'gas_spend_wei',
  'gasSpendWei',
  'gasCostWei',
  'gas_cost_wei',
  'actualGasCost',
  'actual_gas_cost',
  'totalGasWei',
  'txFeeWei',
  'tx_fee_wei',
  'transactionFeeWei',
  'transaction_fee_wei',
  'feeWei',
  'gas_fee_wei',
  'nativeFeeWei',
  'native_fee_wei',
  'receipt.gasWei',
  'receipt.gasSpendWei',
  'receipt.gasUsedWei',
  'receipt.txFeeWei',
  'receipt.effectiveGasCost',
  'receipt.effective_gas_cost',
  'transaction.gasWei',
  'transaction.gasSpendWei',
];
const GAS_USED_PATHS = ['gasUsed', 'gas_used', 'receipt.gasUsed', 'receipt.gas_used', 'transaction.gasUsed', 'transaction.gas_used'];
const GAS_PRICE_PATHS = [
  'effectiveGasPrice',
  'effective_gas_price',
  'gasPrice',
  'gas_price',
  'receipt.effectiveGasPrice',
  'receipt.effective_gas_price',
  'receipt.gasPrice',
  'receipt.gas_price',
  'transaction.effectiveGasPrice',
  'transaction.gasPrice',
  'transaction.gas_price',
];
const GAS_EVENT_TYPE_RE = /(gas|tx|transaction|receipt|onchain|escrow|wallet)/i;
const GAS_EVENT_SOURCE_RE = /^(idacc-onchain|onchain|skillmesh|wallet|evm|ethereum|x402|escrow|compute-escrow)$/i;

function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') return parseJson(value, {});
  return {};
}

function compactString(value, max = 200) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function compactNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizedEthAddress(value) {
  const text = compactString(value, 80);
  return ETH_ADDRESS_RE.test(text) ? text.toLowerCase() : '';
}

function valueAtPath(value, path) {
  return String(path).split('.').reduce((current, part) => (
    current && typeof current === 'object' ? current[part] : undefined
  ), value);
}

function firstPathValue(value, paths) {
  for (const path of paths) {
    const found = valueAtPath(value, path);
    if (found !== undefined && found !== null && found !== '') return { path, value: found };
  }
  return { path: '', value: undefined };
}

function parseIntegerBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.max(0, Math.trunc(value)));
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
    if (/^\d+$/.test(text)) return BigInt(text);
  } catch {
    return null;
  }
  return null;
}

function parseEthToWei(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return BigInt(Math.round(value * 1e18));
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/e/i.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e18)) : null;
  }
  const match = text.match(/^(\d+)(?:\.(\d{1,18})\d*)?$/);
  if (!match) return null;
  const whole = BigInt(match[1] || '0') * WEI_PER_ETH;
  const frac = BigInt((match[2] || '').padEnd(18, '0') || '0');
  return whole + frac;
}

function weiToEthString(wei) {
  const safeWei = typeof wei === 'bigint' && wei > 0n ? wei : 0n;
  const whole = safeWei / WEI_PER_ETH;
  const frac = (safeWei % WEI_PER_ETH).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function weiToEthNumber(wei) {
  if (typeof wei !== 'bigint' || wei <= 0n) return 0;
  return Number(wei) / 1e18;
}

function safeNameList(value, limit = 24) {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.keys(value)
      : [];
  const names = rows
    .map(item => {
      if (typeof item === 'string' || typeof item === 'number') return compactString(item, 100);
      if (item && typeof item === 'object') {
        return compactString(item.name ?? item.id ?? item.skill ?? item.path ?? item.label, 100);
      }
      return '';
    })
    .filter(Boolean);
  return [...new Set(names)].slice(0, limit);
}

function collectSensitiveMetadataKeys(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return [];
  const keys = [];
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_METADATA_KEY_RE.test(key)) keys.push(key);
    if (child && typeof child === 'object') {
      keys.push(...collectSensitiveMetadataKeys(child, depth + 1));
    }
  }
  return [...new Set(keys)];
}

function fleetAgentPublicMetadata(agent, data) {
  return {
    ...objectValue(data?.metadata),
    ...objectValue(agent?.metadata),
  };
}

function publicAgentIdentity(agent, data, metadata) {
  return {
    alias: compactString(agent?.alias ?? metadata.alias ?? data.alias),
    displayId: compactString(agent?.displayId ?? agent?.name ?? data.displayId ?? data.name),
    domain: compactString(agent?.domain ?? metadata.idchain_domain ?? data.domain),
    tokenId: compactString(agent?.tokenId ?? agent?.token_id ?? data.tokenId ?? data.token_id),
  };
}

function publicWalletSummary(agent, data, metadata) {
  return {
    owsWallet: compactString(agent?.ows_wallet ?? data?.ows_wallet ?? metadata.ows_wallet),
    owsAddress: compactString(agent?.ows_address ?? data?.ows_address ?? metadata.ows_address),
    controllerAddress: compactString(metadata.agent_account ?? metadata.wallet_address ?? metadata.walletAddress),
    walletOptIn: metadata.wallet === true ? true : metadata.wallet === false ? false : null,
  };
}

function publicControllerWalletSummary(agent, data, metadata) {
  const providers = metadata.providers && typeof metadata.providers === 'object' ? metadata.providers : {};
  const skillmeshProvider = providers.skillmesh && typeof providers.skillmesh === 'object' ? providers.skillmesh : {};
  const candidates = [
    { source: 'agent.ows_address', value: agent?.ows_address },
    { source: 'data.ows_address', value: data?.ows_address },
    { source: 'metadata.ows_address', value: metadata.ows_address },
    { source: 'metadata.provider_wallet_address', value: metadata.provider_wallet_address },
    { source: 'metadata.providerWalletAddress', value: metadata.providerWalletAddress },
    { source: 'metadata.providers.skillmesh.address', value: skillmeshProvider.address },
    { source: 'metadata.providers.skillmesh.wallet_address', value: skillmeshProvider.wallet_address },
    { source: 'metadata.providers.skillmesh.walletAddress', value: skillmeshProvider.walletAddress },
    { source: 'metadata.skillmesh_address', value: metadata.skillmesh_address },
    { source: 'agent.ows_wallet', value: agent?.ows_wallet },
    { source: 'data.ows_wallet', value: data?.ows_wallet },
    { source: 'metadata.ows_wallet', value: metadata.ows_wallet },
  ];
  const match = candidates
    .map(candidate => ({ ...candidate, address: normalizedEthAddress(candidate.value) }))
    .find(candidate => candidate.address);
  return {
    address: match?.address ?? '',
    source: match?.source ?? 'missing',
    hasControllerWallet: Boolean(match?.address),
    precedence: 'ows_address -> optional provider wallet address -> address-shaped ows_wallet',
    alignedWith: 'IDACC Identity & Keys controllerWalletFromAgent',
  };
}

function publicSkillmeshSummary(metadata) {
  const address = compactString(metadata.skillmesh_address);
  const keyIndex = compactNumber(metadata.skillmesh_key_index);
  return {
    provider: 'skillmesh',
    optional: true,
    address,
    keyIndex,
    keyPath: compactString(metadata.skillmesh_key_path),
    appUrl: compactString(process.env.SKILLMESH_APP_URL),
    keyMaterial: address || keyIndex !== null ? 'redacted' : 'not-reported',
    secretPolicy: 'private keys, creator keys, auth tokens, API keys, bearer tokens, seeds, and raw metadata are never exposed by this read-only dashboard contract',
  };
}

function publicCapabilitySummary(metadata, data) {
  const skills = safeNameList(metadata.skills ?? data.skills);
  const plugins = safeNameList(metadata.plugins ?? data.plugins);
  const mcpServers = safeNameList(metadata.mcpServers ?? data.mcpServers);
  return {
    skills,
    skillCount: skills.length,
    plugins,
    pluginCount: plugins.length,
    mcpServers,
    mcpServerCount: mcpServers.length,
  };
}

function publicCredentialRedaction(metadata) {
  const sensitiveKeys = collectSensitiveMetadataKeys(metadata);
  return {
    rawMetadataExposed: false,
    secretFieldsRedacted: true,
    sensitiveKeyCount: sensitiveKeys.length,
    policy: 'Brain dashboards expose public identity, capability counts, and redacted key presence only; raw manager metadata is withheld.',
  };
}

function normalizeFleetAgent(agent, team, source) {
  const data = agent?.data && typeof agent.data === 'object' ? agent.data : {};
  const metadata = fleetAgentPublicMetadata(agent, data);
  const identity = publicAgentIdentity(agent, data, metadata);
  const skillmesh = publicSkillmeshSummary(metadata);
  const wallet = publicWalletSummary(agent, data, metadata);
  const controllerWallet = publicControllerWalletSummary(agent, data, metadata);
  const capabilities = publicCapabilitySummary(metadata, data);
  return {
    id: agent?.id ?? data.internalId ?? `${team || data.team || 'unknown'}:${agent?.name ?? 'agent'}`,
    name: agent?.name ?? data.name ?? 'agent',
    status: agent?.status ?? data.status ?? 'unknown',
    team: agent?.team ?? team ?? data.team ?? 'unknown',
    runtime: agent?.runtime ?? data.runtime ?? '',
    model: agent?.model ?? data.model ?? '',
    port: agent?.port ?? data.port ?? null,
    pid: agent?.pid ?? data.pid ?? null,
    source,
    identity,
    skillmesh,
    wallet,
    controllerWallet,
    capabilities,
    credentialRedaction: publicCredentialRedaction(metadata),
  };
}

function summarizeFleetIdentity(agents) {
  const uniqueSkills = new Set();
  let advertisedSkillsTotal = 0;
  for (const agent of agents) {
    for (const skill of agent.capabilities?.skills ?? []) uniqueSkills.add(skill);
    advertisedSkillsTotal += agent.capabilities?.skillCount ?? 0;
  }
  return {
    provider: 'skillmesh',
    optional: true,
    readOnly: true,
    source: 'IDACC manager public/redacted agent contract when live, Brain entity cache only when manager polling is unavailable',
    providerBoundary: 'This optional provider metadata is evidence only, not IDACC core state',
    secretPolicy: 'private keys, creator keys, auth tokens, API keys, bearer tokens, seeds, raw MCP env, and raw manager metadata are not exposed',
    agentsWithSkillmeshAddress: agents.filter(agent => agent.skillmesh?.address).length,
    agentsWithSkillmeshKeyIndex: agents.filter(agent => agent.skillmesh?.keyIndex !== null && agent.skillmesh?.keyIndex !== undefined).length,
    agentsWithOwsWallet: agents.filter(agent => agent.wallet?.owsWallet).length,
    agentsWithOwsAddress: agents.filter(agent => agent.wallet?.owsAddress).length,
    agentsWithControllerWallet: agents.filter(agent => agent.controllerWallet?.address).length,
    agentsWithTokenId: agents.filter(agent => agent.identity?.tokenId).length,
    agentsWithDomain: agents.filter(agent => agent.identity?.domain).length,
    advertisedSkillsTotal,
    uniqueAdvertisedSkills: uniqueSkills.size,
    uniqueAdvertisedSkillsSample: [...uniqueSkills].sort().slice(0, 12),
    redactedSensitiveMetadataAgents: agents.filter(agent => (agent.credentialRedaction?.sensitiveKeyCount ?? 0) > 0).length,
  };
}

function gasWeiFromEventData(data) {
  const eth = firstPathValue(data, GAS_ETH_PATHS);
  const ethWei = parseEthToWei(eth.value);
  if (ethWei !== null) return { wei: ethWei, basis: eth.path, unit: 'eth' };

  const wei = firstPathValue(data, GAS_WEI_PATHS);
  const directWei = parseIntegerBigInt(wei.value);
  if (directWei !== null) return { wei: directWei, basis: wei.path, unit: 'wei' };

  const gasUsed = firstPathValue(data, GAS_USED_PATHS);
  const gasPrice = firstPathValue(data, GAS_PRICE_PATHS);
  const usedWei = parseIntegerBigInt(gasUsed.value);
  const priceWei = parseIntegerBigInt(gasPrice.value);
  if (usedWei !== null && priceWei !== null) {
    return { wei: usedWei * priceWei, basis: `${gasUsed.path}*${gasPrice.path}`, unit: 'wei-product' };
  }
  return null;
}

function eventGasCandidate(row, data) {
  if (GAS_EVENT_SOURCE_RE.test(String(row.source ?? ''))) return true;
  if (GAS_EVENT_TYPE_RE.test(String(row.type ?? ''))) return true;
  return Boolean(gasWeiFromEventData(data));
}

function agentStrongKeys(agent) {
  return [
    agent.id,
    agent.team && agent.name ? `${agent.team}:${agent.name}` : '',
    agent.team && agent.name ? `${agent.team}/${agent.name}` : '',
    agent.identity?.displayId,
    agent.identity?.alias,
  ].map(value => compactString(value).toLowerCase()).filter(Boolean);
}

function agentWeakKeys(agent) {
  return [agent.name].map(value => compactString(value).toLowerCase()).filter(Boolean);
}

function buildAgentGasIndex(agents) {
  const strong = new Map();
  const weak = new Map();
  const wallets = new Map();
  for (const agent of agents) {
    for (const key of agentStrongKeys(agent)) {
      if (!strong.has(key)) strong.set(key, agent);
    }
    for (const key of agentWeakKeys(agent)) {
      if (!weak.has(key)) weak.set(key, []);
      weak.get(key).push(agent);
    }
    for (const wallet of [
      agent.controllerWallet?.address,
      agent.wallet?.owsAddress,
      agent.skillmesh?.address,
    ]) {
      const address = normalizedEthAddress(wallet);
      if (address && !wallets.has(address)) wallets.set(address, agent);
    }
  }
  return { strong, weak, wallets };
}

function eventAgentCandidates(row, data) {
  const team = compactString(data?.team ?? data?.teamName ?? data?.team_id ?? data?.id_team);
  const names = [
    data?.agent,
    data?.agentName,
    data?.agent_name,
    data?.actor,
    data?.operator,
    data?.ownerAgent,
  ].map(compactString).filter(Boolean);
  const scoped = team
    ? names.flatMap(name => [`${team}:${name}`, `${team}/${name}`])
    : [];
  return [
    ...scoped,
    data?.agent_id,
    data?.agentId,
    data?.id,
    row.subject,
    ...names,
  ].map(value => compactString(value).toLowerCase()).filter(Boolean);
}

function eventWalletCandidates(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 3) return [];
  const out = [];
  const walletKeyRe = /^(from|sender|payer|wallet|wallet_address|walletAddress|controller|controller_wallet|controllerWallet|agent_wallet|agentWallet|account|safe|smartAccount|smart_account|owner|ows_address|skillmesh_address)$/i;
  for (const [key, value] of Object.entries(data)) {
    if (walletKeyRe.test(key)) {
      const address = normalizedEthAddress(value);
      if (address) out.push(address);
    }
    if (value && typeof value === 'object') out.push(...eventWalletCandidates(value, depth + 1));
  }
  return [...new Set(out)];
}

function resolveGasAgent(row, data, index) {
  for (const key of eventAgentCandidates(row, data)) {
    const direct = index.strong.get(key);
    if (direct) return { agent: direct, by: 'agent-key', key };
  }
  for (const address of eventWalletCandidates(data)) {
    const byWallet = index.wallets.get(address);
    if (byWallet) return { agent: byWallet, by: 'controller-wallet', key: address };
  }
  for (const key of eventAgentCandidates(row, data)) {
    const matches = index.weak.get(key) ?? [];
    if (matches.length === 1) return { agent: matches[0], by: 'agent-name', key };
  }
  return null;
}

function emptyGasSpend() {
  return {
    totalWei: '0',
    last24hWei: '0',
    totalEth: '0',
    last24hEth: '0',
    totalEthNumber: 0,
    last24hEthNumber: 0,
    samples: 0,
    last24hSamples: 0,
    sources: [],
    attribution: [],
  };
}

function gasSpendPayload(stat) {
  if (!stat) return emptyGasSpend();
  return {
    totalWei: stat.totalWei.toString(),
    last24hWei: stat.last24hWei.toString(),
    totalEth: weiToEthString(stat.totalWei),
    last24hEth: weiToEthString(stat.last24hWei),
    totalEthNumber: weiToEthNumber(stat.totalWei),
    last24hEthNumber: weiToEthNumber(stat.last24hWei),
    samples: stat.samples,
    last24hSamples: stat.last24hSamples,
    sources: [...stat.sources].sort(),
    attribution: [...stat.attribution].sort(),
  };
}

function buildFleetGasSpend(agents, since24h) {
  const index = buildAgentGasIndex(agents);
  const statsByAgentId = new Map();
  const total = { totalWei: 0n, last24hWei: 0n, samples: 0, last24hSamples: 0, sources: new Set(), attribution: new Set() };
  let matchedEvents = 0;
  let unassignedEvents = 0;

  const rows = db.prepare(`
    SELECT created_at, source, type, subject, data
    FROM timeline
    WHERE source IN ('idacc-onchain','onchain','skillmesh','wallet','evm','ethereum','x402','escrow','compute-escrow')
       OR type LIKE '%gas%'
       OR type LIKE '%tx%'
       OR type LIKE '%transaction%'
       OR type LIKE '%receipt%'
       OR type LIKE '%onchain%'
       OR data LIKE '%gas%'
       OR data LIKE '%txHash%'
       OR data LIKE '%tx_hash%'
       OR data LIKE '%transactionHash%'
       OR data LIKE '%transaction_hash%'
    ORDER BY created_at ASC, id ASC
  `).all();

  for (const row of rows) {
    const data = parseJson(row.data, {});
    if (!eventGasCandidate(row, data)) continue;
    const gas = gasWeiFromEventData(data);
    if (!gas || gas.wei <= 0n) continue;
    const resolved = resolveGasAgent(row, data, index);
    if (!resolved) {
      unassignedEvents++;
      continue;
    }
    const agentId = resolved.agent.id;
    if (!statsByAgentId.has(agentId)) {
      statsByAgentId.set(agentId, { totalWei: 0n, last24hWei: 0n, samples: 0, last24hSamples: 0, sources: new Set(), attribution: new Set() });
    }
    const stat = statsByAgentId.get(agentId);
    stat.totalWei += gas.wei;
    stat.samples++;
    stat.sources.add(`${row.source}:${row.type}`);
    stat.attribution.add(`${resolved.by}:${resolved.key}`);
    total.totalWei += gas.wei;
    total.samples++;
    total.sources.add(`${row.source}:${row.type}`);
    total.attribution.add(resolved.by);
    if (Number(row.created_at ?? 0) >= since24h) {
      stat.last24hWei += gas.wei;
      stat.last24hSamples++;
      total.last24hWei += gas.wei;
      total.last24hSamples++;
    }
    matchedEvents++;
  }

  return {
    byAgentId: statsByAgentId,
    summary: {
      ...gasSpendPayload(total),
      readOnly: true,
      matchedEvents,
      unassignedEvents,
      source: 'Brain timeline gas/onchain transaction events matched to IDACC Identity & Keys controller wallet precedence',
      matching: 'agent id/team/name first, controller wallet second, unique bare agent name last',
      unit: 'ETH',
    },
  };
}

function fleetTimelineSummary(since) {
  const countRows = db.prepare(`
    SELECT type, COUNT(*) AS c
    FROM timeline
    WHERE created_at > ?
      AND type IN ('query:delivered', 'query:failed', 'skill:executed', 'watchdog:alert', 'agent:cost')
    GROUP BY type
  `).all(since);
  const counts = Object.fromEntries(countRows.map(row => [row.type, Number(row.c ?? 0)]));

  const costByAgent = {};
  const costRows = db.prepare(`
    SELECT subject, data
    FROM timeline
    WHERE created_at > ? AND type='agent:cost'
    ORDER BY created_at ASC, id ASC
  `).all(since);
  for (const row of costRows) {
    const data = parseJson(row.data, {});
    const agent = row.subject;
    if (!costByAgent[agent]) costByAgent[agent] = { count: 0, totalUsd: 0 };
    costByAgent[agent].count++;
    costByAgent[agent].totalUsd += Number(data.costUsd ?? 0) || 0;
  }

  let settled = 0;
  const skillRows = db.prepare(`
    SELECT data
    FROM timeline
    WHERE created_at > ? AND type='skill:executed'
  `).all(since);
  for (const row of skillRows) {
    const data = parseJson(row.data, {});
    if (data.settled) settled++;
  }

  const watchdogRows = db.prepare(`
    SELECT subject, data
    FROM timeline
    WHERE created_at > ? AND type='watchdog:alert'
    ORDER BY created_at ASC, id ASC
  `).all(since);
  const watchdogAlerts = watchdogRows.map(row => {
    const data = parseJson(row.data, {});
    return { subject: row.subject, failures: data.failures ?? [] };
  });

  return {
    queriesDelivered: counts['query:delivered'] ?? 0,
    queriesFailed: counts['query:failed'] ?? 0,
    costByAgent,
    execStats: {
      total: counts['skill:executed'] ?? 0,
      settled,
    },
    watchdogAlerts,
    parsedRows: costRows.length + skillRows.length + watchdogRows.length,
  };
}

function aggregateFleet(agents, source, meta = {}) {
  const byStatus = {};
  const byModel = {};
  const byRuntime = {};
  const byTeam = {};
  let running = 0;
  for (const agent of agents) {
    const status = String(agent.status || 'unknown');
    const model = String(agent.model || 'unknown');
    const runtime = String(agent.runtime || 'unknown');
    const team = String(agent.team || 'unknown');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byModel[model] = (byModel[model] ?? 0) + 1;
    byRuntime[runtime] = (byRuntime[runtime] ?? 0) + 1;
    if (!byTeam[team]) byTeam[team] = { total: 0, running: 0, byStatus: {} };
    byTeam[team].total++;
    byTeam[team].byStatus[status] = (byTeam[team].byStatus[status] ?? 0) + 1;
    if (isLiveAgentStatus(status)) {
      running++;
      byTeam[team].running++;
    }
  }
  return {
    source,
    total: agents.length,
    running,
    byStatus,
    byModel,
    byRuntime,
    byTeam,
    agents,
    ...meta,
  };
}

function fleetAuthority(source) {
  if (source === 'live-manager') {
    return {
      authority: 'live',
      authoritative: true,
      statusAuthorityLabel: 'Live manager current-state snapshot',
      activeLabel: 'agents active',
    };
  }
  if (source === 'live-manager-partial') {
    return {
      authority: 'partial',
      authoritative: false,
      statusAuthorityLabel: 'Partial manager snapshot; missing teams are not inferred from cache',
      activeLabel: 'known agents active (partial manager snapshot)',
    };
  }
  return {
    authority: 'cache',
    authoritative: false,
    statusAuthorityLabel: 'Brain cache fallback; cached agent statuses are not live current-state proof',
    activeLabel: 'cached agent records (not live status)',
  };
}

function cachedBrainAgents() {
  return db.prepare(`SELECT * FROM entities WHERE type='agent' AND COALESCE(status, '') != 'stale'`).all()
    .map(row => {
      const data = parseJson(row.data, {});
      const tags = parseJson(row.tags, []);
      const team = data.team || (Array.isArray(tags) ? tags.find(tag => tag && tag !== 'agent') : undefined);
      return normalizeFleetAgent({ ...row, data }, team, 'brain-cache');
    });
}

async function fetchManagerJson(path, team) {
  const headers = managerServiceHeaders({ 'Content-Type': 'application/json' });
  if (team) headers['X-Id-Team'] = team;
  const response = await fetch(`${managerUrl()}${path}`, {
    headers,
    signal: AbortSignal.timeout(Number(process.env.BRAIN_MANAGER_TIMEOUT_MS ?? 2500)),
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${response.statusText}`);
  return response.json();
}

async function liveManagerFleet() {
  const warnings = [];
  const errors = [];
  const configuredTeams = configuredFleetTeams();
  const strictTeams = strictConfiguredFleetTeams();
  let teams = configuredTeams;
  let teamSource = configuredTeams.length ? 'env:BRAIN_FLEET_TEAMS' : 'manager:/teams';
  let teamInventoryPartial = false;

  try {
    const data = await fetchManagerJson('/teams');
    const managerTeams = (data.teams ?? [])
      .map(team => String(team.name ?? '').trim())
      .filter(name => name && name.toLowerCase() !== 'all');
    if (managerTeams.length) {
      if (configuredTeams.length && strictTeams) {
        const missing = managerTeams.filter(team => !configuredTeams.includes(team));
        if (missing.length) warnings.push(`manager lists additional teams not polled because BRAIN_FLEET_TEAMS_STRICT=true: ${missing.join(', ')}`);
        teamSource = 'env:BRAIN_FLEET_TEAMS:strict';
      } else {
        if (configuredTeams.length) {
          const missing = managerTeams.filter(team => !configuredTeams.includes(team));
          const extra = configuredTeams.filter(team => !managerTeams.includes(team));
          if (missing.length) warnings.push(`BRAIN_FLEET_TEAMS was missing manager teams (${missing.join(', ')}); polling manager /teams list instead`);
          if (extra.length) warnings.push(`BRAIN_FLEET_TEAMS included teams absent from manager /teams: ${extra.join(', ')}`);
        }
        teams = managerTeams;
        teamSource = configuredTeams.length ? 'manager:/teams (overrode BRAIN_FLEET_TEAMS)' : 'manager:/teams';
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ scope: 'teams', message });
    teamInventoryPartial = true;
    if (!teams.length) {
      teamSource = 'fallback:ID_TEAM';
      warnings.push(`could not list manager teams; using ${defaultManagerTeam()} only`);
      teams = [defaultManagerTeam()];
    } else {
      warnings.push(`could not list manager teams; using configured BRAIN_FLEET_TEAMS (${teams.join(', ')})`);
    }
  }

  const groups = await Promise.all(teams.map(async team => {
    try {
      const data = await fetchManagerJson(`/agents?team=${encodeURIComponent(team)}`, team);
      const agents = (data.agents ?? []).map(agent => normalizeFleetAgent(agent, team, 'live-manager'));
      return { ok: true, team, agents };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, team, agents: [], error: message };
    }
  }));

  const failed = groups.filter(group => !group.ok);
  for (const group of failed) errors.push({ scope: `agents:${group.team}`, message: group.error });
  if (failed.length) warnings.push(`${failed.length}/${groups.length} manager team snapshots failed`);

  const successful = groups.filter(group => group.ok);
  const agents = successful.flatMap(group => group.agents);
  const ok = teams.length === 0 || successful.length > 0;
  return {
    ok,
    source: ok ? (teamInventoryPartial || failed.length ? 'live-manager-partial' : 'live-manager') : 'brain-cache',
    managerUrl: managerUrl(),
    teamSource,
    teams,
    groups,
    agents,
    warnings,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

function extractFixtureStrings(...values) {
  const text = values
    .map(value => typeof value === 'string' ? value : JSON.stringify(value ?? ''))
    .join('\n');
  const patterns = [
    /(?:^|\s)(\/(?:[A-Za-z0-9._-]+\/?){2,})/g,
    /\b(?:[A-Za-z]:\\[^\s"'`]+|\.{1,2}\/[^\s"'`]+)\b/g,
    /\bhttps?:\/\/[^\s"'`<>]+/g,
    /\b0x[a-fA-F0-9]{40}\b/g,
    /\b[A-Z][A-Za-z0-9_]*(?:Error|Exception)\b/g,
    /`([^`\n]{3,120})`/g,
    /\b(?:node|npm|pnpm|yarn|git|gh|curl|sqlite3|launchctl)\s+[^\n.;]{2,120}/g,
    /\b(?:[a-z]+:){1,3}[A-Za-z0-9._:-]{3,120}\b/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = String(match[1] ?? match[0] ?? '').trim().replace(/[),.;]+$/, '');
      if (raw.length >= 3 && raw.length <= 160) found.push(raw);
    }
  }
  return [...new Set(found)].slice(0, 12);
}

const GRAPH_SYNC_SKILL_EDGE_FIELDS = [
  ['related', 'related'],
  ['composes', 'composes'],
  ['requires', 'requires'],
  ['supportsTask', 'supports-task'],
  ['supportsTasks', 'supports-task'],
  ['supports_task', 'supports-task'],
  ['supports_tasks', 'supports-task'],
  ['validatesSource', 'validates-source'],
  ['validatesSources', 'validates-source'],
  ['validates_source', 'validates-source'],
  ['validates_sources', 'validates-source'],
  ['requiresSkill', 'requires-skill'],
  ['requiresSkills', 'requires-skill'],
  ['requires_skill', 'requires-skill'],
  ['requires_skills', 'requires-skill'],
  ['sourceOf', 'source-of'],
  ['source_of', 'source-of'],
  ['supersedes', 'supersedes'],
];

function appendGraphSyncNodeEdges(node, edges) {
  for (const [field, kind] of GRAPH_SYNC_SKILL_EDGE_FIELDS) {
    const value = node?.[field];
    const items = Array.isArray(value) ? value : (value == null ? [] : [value]);
    for (const item of items) {
      const to = (item && typeof item === 'object')
        ? (item.to ?? item.skillId ?? item.skill_id ?? item.id)
        : item;
      if (!isIntegerValue(to)) continue;
      const edge = { from: node.skillId, to, kind };
      if (item && typeof item === 'object' && item.weight !== undefined) edge.weight = item.weight;
      edges.push(edge);
    }
  }
}

function ok(data = {}, meta = {}) {
  return { ok: true, data, meta, profile: 'local' };
}

function operatorOk(data = {}, meta = {}) {
  return { ok: true, data, meta, profile: 'local', ...data };
}

function operatorError(type, message, hint = '', extras = {}, risk = {}) {
  return {
    ok: false,
    error: {
      type,
      message,
      hint,
      risk: {
        level: risk.level ?? 'medium',
        action: risk.action ?? 'approval.apply',
        ...risk,
      },
    },
    profile: 'local',
    ...extras,
  };
}

function factWriteErrorResponse(res, error, entityId) {
  const id = String(error?.entityId ?? entityId ?? '').trim();
  const conflict = error?.code === 'fact_entity_merged' || error?.code === 'fact_entity_unavailable';
  const type = conflict ? 'brain.conflict' : 'brain.not_found';
  const body = err(type, error?.message ?? 'fact entity not found', {
    hint: conflict
      ? error?.code === 'fact_entity_merged'
        ? 'retry with the explicit canonical entity id after reviewing the guarded alias merge'
        : 'select an active entity before writing facts'
      : 'create or select the canonical entity before writing facts',
    retry_command: id ? `GET /entities/${encodeURIComponent(id)}` : 'GET /entities',
    risk: { level: 'low', action: conflict ? 'resolve-entity' : 'inspect-entity', destructive: false },
  });
  body.code = error?.code ?? 'fact_entity_not_found';
  body.entity_id = id || null;
  if (error?.entityStatus) body.entity_status = error.entityStatus;
  if (error?.canonicalEntityId) body.canonical_entity_id = error.canonicalEntityId;
  return send(res, error?.status ?? (conflict ? 409 : 404), body);
}

function factWriteErrorDetail(error, entityId) {
  return {
    type: error?.code === 'fact_entity_merged' || error?.code === 'fact_entity_unavailable' ? 'brain.conflict' : 'brain.not_found',
    message: error?.message ?? 'fact entity not found',
    retryable: false,
    entity_id: String(error?.entityId ?? entityId ?? '').trim() || null,
    ...(error?.entityStatus ? { entity_status: error.entityStatus } : {}),
    ...(error?.canonicalEntityId ? { canonical_entity_id: error.canonicalEntityId } : {}),
  };
}

function normalizeVectorExecutionGate(payload = {}) {
  const candidate = payload?.execution?.requires?.vector_capability
    ?? payload?.execution?.requires?.vectorCapability
    ?? payload?.governance?.execution?.requires?.vector_capability
    ?? payload?.governance?.execution?.requires?.vectorCapability
    ?? payload?.governance?.vector_capability
    ?? payload?.governance?.vectorCapability
    ?? null;
  if (!candidate) return { required: false, allowFallback: true, mode: 'optional', source: null };
  if (candidate === true) return { required: true, allowFallback: false, mode: 'native', source: 'boolean' };
  if (typeof candidate === 'string') {
    if (candidate === 'fallback_ok') return { required: true, allowFallback: true, mode: 'fallback_ok', source: 'string' };
    return { required: true, allowFallback: false, mode: candidate, source: 'string' };
  }
  if (typeof candidate === 'object') {
    return {
      required: candidate.required !== false,
      allowFallback: Boolean(candidate.allow_fallback ?? candidate.allowFallback ?? candidate.on_unavailable === 'fallback'),
      mode: candidate.mode ?? 'native',
      source: 'object',
    };
  }
  return { required: false, allowFallback: true, mode: 'optional', source: null };
}

function buildOperatorEnvelope({ approvalId, approvalKind, path, payload, vectorCapability, applied = false } = {}) {
  return {
    schema_version: 'operator-envelope.v1',
    action: 'approval.apply',
    route: path,
    approval_id: approvalId,
    approval_kind: approvalKind,
    decision_trace_id: payload?.governance?.decision_trace_id ?? payload?.governance?.audit?.decision_trace_id ?? null,
    prompt_version: payload?.process_config?.prompt_version ?? payload?.metadata?.prompt_version ?? payload?.prompt_version ?? null,
    applied,
    vector_capability: vectorCapability,
  };
}

const AUTHORIZATION_APPROVAL_KINDS = {
  'skill.execution.dangerous': {
    eventType: 'approval:dangerous-skill-authorized',
    confirmationRequired: false,
    description: 'dangerous skill execution',
  },
  'memory.retire': {
    eventType: 'approval:memory-retire-authorized',
    confirmationRequired: true,
    description: 'memory retirement',
  },
  'operator.action.destructive': {
    eventType: 'approval:destructive-operator-action-authorized',
    confirmationRequired: true,
    description: 'destructive operator action',
  },
  'provider.call.high_cost': {
    eventType: 'approval:high-cost-provider-call-authorized',
    confirmationRequired: false,
    description: 'high-cost provider call',
  },
};

const EDGE_REPAIR_TABLES = {
  entity_edges: {
    kindSet: new Set(KNOWN_ENTITY_EDGE_KINDS),
    updatableFields: new Set(['from_id', 'to_id', 'kind', 'weight', 'description', 'evidence_count', 'text_unit_ids', 'prompt_version']),
  },
  skill_edges: {
    kindSet: new Set(KNOWN_SKILL_EDGE_KINDS),
    updatableFields: new Set(['from_id', 'to_id', 'kind', 'weight', 'evidence_count']),
  },
};

function normalizeEdgeTextUnitIds(value) {
  const raw = Array.isArray(value) ? value : parseJson(value, []);
  return [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter(Number.isInteger))];
}

function edgeRepairFieldMap(table, existingRow, fields = {}) {
  const config = EDGE_REPAIR_TABLES[table];
  if (!config) return null;
  const allowed = config.updatableFields;
  const next = { ...existingRow };
  if (allowed.has('from_id') && Object.hasOwn(fields, 'from_id')) next.from_id = table === 'skill_edges' ? Number(fields.from_id) : String(fields.from_id ?? '').trim();
  if (allowed.has('to_id') && Object.hasOwn(fields, 'to_id')) next.to_id = table === 'skill_edges' ? Number(fields.to_id) : String(fields.to_id ?? '').trim();
  if (allowed.has('kind') && Object.hasOwn(fields, 'kind')) next.kind = String(fields.kind ?? '').trim();
  if (allowed.has('weight') && Object.hasOwn(fields, 'weight')) next.weight = Math.max(0, Number(fields.weight ?? existingRow.weight) || 0);
  if (allowed.has('evidence_count') && Object.hasOwn(fields, 'evidence_count')) next.evidence_count = Math.max(0, Number(fields.evidence_count ?? existingRow.evidence_count) || 0);
  if (table === 'entity_edges') {
    if (Object.hasOwn(fields, 'description')) next.description = String(fields.description ?? '');
    if (Object.hasOwn(fields, 'prompt_version')) next.prompt_version = String(fields.prompt_version ?? '');
    if (Object.hasOwn(fields, 'text_unit_ids')) next.text_unit_ids = JSON.stringify(normalizeEdgeTextUnitIds(fields.text_unit_ids));
  }
  next.updated_at = Math.floor(Date.now() / 1000);
  return next;
}

function blockingEdgeIssues(report = {}) {
  return (report.issues ?? []).filter(code => code === 'invalid_kind' || code === 'orphaned_from' || code === 'orphaned_to' || code === 'low_evidence' || code === 'stale');
}

function memoryIdsFromSourceIds(sourceIds = []) {
  return normalizeSourceIds(sourceIds).canonical
    .filter((id) => id.startsWith('memory:'))
    .map((id) => Number(id.slice('memory:'.length)))
    .filter(Number.isInteger);
}

function factIdsFromSourceIds(sourceIds = []) {
  return normalizeSourceIds(sourceIds).canonical
    .filter((id) => id.startsWith('fact:'))
    .map((id) => Number(id.slice('fact:'.length)))
    .filter(Number.isInteger);
}

function memoryIdsFromInstructionIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((value) => {
      if (value === undefined || value === null || value === '') return null;
      const text = String(value);
      if (text.startsWith('memory:')) return Number(text.slice('memory:'.length));
      if (/^\d+$/.test(text)) return Number(text);
      return null;
    })
    .filter(Number.isInteger))];
}

function markMemoriesVolunteered(sourceIds = []) {
  const ids = memoryIdsFromSourceIds(sourceIds);
  if (!ids.length) return;
  const stmt = db.prepare(`UPDATE agent_memories SET last_volunteered_at=unixepoch(), volunteered_count=volunteered_count+1 WHERE id=?`);
  for (const id of ids) stmt.run(id);
}

function markMemoriesUsed({ volunteeredSourceIds = [], acceptedSourceIds = [] } = {}) {
  const volunteered = new Set(memoryIdsFromSourceIds(volunteeredSourceIds));
  if (!volunteered.size) return;
  const accepted = new Set(memoryIdsFromSourceIds(acceptedSourceIds));
  const usedStmt = db.prepare(`UPDATE agent_memories SET last_used_at=unixepoch(), ignored_count=0, used_count=used_count+1 WHERE id=?`);
  const ignoredStmt = db.prepare(`UPDATE agent_memories SET ignored_count=ignored_count+1 WHERE id=?`);
  for (const id of volunteered) {
    if (accepted.has(id)) usedStmt.run(id);
    else ignoredStmt.run(id);
  }
}

function markFactsUsed({ volunteeredSourceIds = [], acceptedSourceIds = [] } = {}) {
  const volunteered = new Set(factIdsFromSourceIds(volunteeredSourceIds));
  const accepted = new Set(factIdsFromSourceIds(acceptedSourceIds));
  if (!volunteered.size && !accepted.size) return;
  const volunteeredStmt = db.prepare(`
    UPDATE facts
    SET last_volunteered_at=unixepoch(), volunteered_count=volunteered_count+1
    WHERE id=?
  `);
  const usedStmt = db.prepare(`
    UPDATE facts
    SET last_used_at=unixepoch(), used_count=used_count+1
    WHERE id=?
  `);
  for (const id of volunteered) volunteeredStmt.run(id);
  for (const id of accepted) usedStmt.run(id);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function maxNullable(...values) {
  const nums = values.map(numberOrNull).filter((value) => value != null);
  return nums.length ? Math.max(...nums) : null;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function memoryAcceptedUseSampleStats(memoryIds = []) {
  const uniqueIds = [...new Set((Array.isArray(memoryIds) ? memoryIds : [])
    .map((value) => Number(value))
    .filter(Number.isInteger))];
  const stats = new Map();
  if (!uniqueIds.length) return stats;

  const clauses = uniqueIds.map(() => `volunteered_source_ids LIKE ?`);
  const rows = db.prepare(`
    SELECT accepted_ids, volunteered_source_ids, created_at
    FROM eval_queries
    WHERE volunteered_source_ids != '[]'
      AND (${clauses.join(' OR ')})
    ORDER BY created_at DESC
  `).all(...uniqueIds.map((id) => `%\"memory:${id}\"%`));

  const ensure = (id) => {
    if (!stats.has(id)) {
      stats.set(id, {
        sampled: false,
        volunteered_count: 0,
        used_count: 0,
        ignored_count: 0,
        last_used_at: null,
      });
    }
    return stats.get(id);
  };

  const wanted = new Set(uniqueIds);
  for (const row of rows) {
    const accepted = new Set(normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical);
    const volunteered = normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical;
    for (const sourceId of volunteered) {
      if (!sourceId.startsWith('memory:')) continue;
      const memoryId = Number(sourceId.slice('memory:'.length));
      if (!wanted.has(memoryId)) continue;
      const stat = ensure(memoryId);
      stat.sampled = true;
      stat.volunteered_count++;
      if (accepted.has(sourceId)) {
        stat.used_count++;
        stat.last_used_at = maxNullable(stat.last_used_at, row.created_at);
      } else {
        stat.ignored_count++;
      }
    }
  }
  return stats;
}

function memoryAcceptedUseAccounting(memory = null, sampleStat = null) {
  const persistedVolunteered = numberOrNull(memory?.volunteered_count);
  const persistedUsed = numberOrNull(memory?.used_count);
  const persistedIgnored = numberOrNull(memory?.ignored_count);
  const persistedLastUsed = numberOrNull(memory?.last_used_at);
  const persistedLastVolunteered = numberOrNull(memory?.last_volunteered_at);
  const persistedObserved = (
    (persistedVolunteered ?? 0) > 0
    || (persistedUsed ?? 0) > 0
    || (persistedIgnored ?? 0) > 0
    || persistedLastUsed != null
    || persistedLastVolunteered != null
  );
  const sampledObserved = Boolean(sampleStat?.sampled);

  if (!persistedObserved && !sampledObserved) {
    return {
      accounting_state: 'unknown',
      stats_source: 'unknown',
      instrumentation_needed: true,
      accepted_count: null,
      used_count: null,
      volunteered_count: null,
      ignored_count: null,
      last_used_at: null,
      retrieval_relevance: null,
      reuse_count: null,
      reused: null,
      fields_missing: [
        'accepted_count_or_used_count',
        'volunteered_count',
        'ignored_count',
        'last_used_at',
      ],
    };
  }

  const volunteeredCount = Math.max(persistedVolunteered ?? 0, sampleStat?.volunteered_count ?? 0);
  const usedCount = Math.max(persistedUsed ?? 0, sampleStat?.used_count ?? 0);
  const ignoredCount = Math.max(persistedIgnored ?? 0, sampleStat?.ignored_count ?? 0);
  const lastUsedAt = maxNullable(persistedLastUsed, sampleStat?.last_used_at);
  const derivedSupersedesPersisted = sampledObserved && (
    !persistedObserved
    || (sampleStat?.volunteered_count ?? 0) > (persistedVolunteered ?? 0)
    || (sampleStat?.used_count ?? 0) > (persistedUsed ?? 0)
    || (sampleStat?.ignored_count ?? 0) > (persistedIgnored ?? 0)
    || (sampleStat?.last_used_at ?? 0) > (persistedLastUsed ?? 0)
  );
  const statsSource = derivedSupersedesPersisted
    ? 'derived_from_samples'
    : persistedObserved
      ? 'persisted'
      : 'derived_from_samples';

  return {
    accounting_state: 'known',
    stats_source: statsSource,
    instrumentation_needed: false,
    accepted_count: usedCount,
    used_count: usedCount,
    volunteered_count: volunteeredCount,
    ignored_count: ignoredCount,
    last_used_at: lastUsedAt,
    retrieval_relevance: volunteeredCount > 0 ? round3(usedCount / volunteeredCount) : null,
    reuse_count: usedCount,
    reused: usedCount > 1,
    fields_missing: [],
  };
}

function factReuseSampleStats(factIds = []) {
  const uniqueIds = [...new Set((Array.isArray(factIds) ? factIds : [])
    .map((value) => Number(value))
    .filter(Number.isInteger))];
  const stats = new Map();
  if (!uniqueIds.length) return stats;

  const clauses = uniqueIds.flatMap(() => [`volunteered_source_ids LIKE ?`, `accepted_ids LIKE ?`]);
  const rows = db.prepare(`
    SELECT accepted_ids, volunteered_source_ids, created_at
    FROM eval_queries
    WHERE ${clauses.map((clause) => `(${clause})`).join(' OR ')}
    ORDER BY created_at DESC
  `).all(...uniqueIds.flatMap((id) => [`%\"fact:${id}\"%`, `%\"fact:${id}\"%`]));

  const ensure = (id) => {
    if (!stats.has(id)) {
      stats.set(id, {
        sampled: false,
        volunteered_count: 0,
        used_count: 0,
        last_used_at: null,
      });
    }
    return stats.get(id);
  };

  const wanted = new Set(uniqueIds);
  for (const row of rows) {
    const accepted = new Set(normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical);
    const volunteered = normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical;
    const seen = new Set([...accepted, ...volunteered]);
    for (const sourceId of seen) {
      if (!sourceId.startsWith('fact:')) continue;
      const factId = Number(sourceId.slice('fact:'.length));
      if (!wanted.has(factId)) continue;
      const stat = ensure(factId);
      stat.sampled = true;
      if (volunteered.includes(sourceId)) stat.volunteered_count++;
      if (accepted.has(sourceId)) {
        stat.used_count++;
        stat.last_used_at = maxNullable(stat.last_used_at, row.created_at);
      }
    }
  }
  return stats;
}

function factReuseAccounting(fact = null, sampleStat = null) {
  const persistedVolunteered = numberOrNull(fact?.volunteered_count);
  const persistedUsed = numberOrNull(fact?.used_count);
  const persistedLastUsed = numberOrNull(fact?.last_used_at);
  const persistedLastVolunteered = numberOrNull(fact?.last_volunteered_at);
  const persistedObserved = (
    (persistedVolunteered ?? 0) > 0
    || (persistedUsed ?? 0) > 0
    || persistedLastUsed != null
    || persistedLastVolunteered != null
  );
  const sampledObserved = Boolean(sampleStat?.sampled);

  if (!persistedObserved && !sampledObserved) {
    return {
      metric_state: 'unknown',
      stats_source: 'unknown',
      instrumentation_needed: true,
      volunteered_count: null,
      used_count: null,
      reuse_count: null,
      last_used_at: null,
      precision: null,
      retrieval_relevance: null,
      reused: null,
      fields_missing: [
        'volunteered_count',
        'used_count',
        'last_used_at',
      ],
    };
  }

  const volunteeredCount = Math.max(persistedVolunteered ?? 0, sampleStat?.volunteered_count ?? 0);
  const usedCount = Math.max(persistedUsed ?? 0, sampleStat?.used_count ?? 0);
  const lastUsedAt = maxNullable(persistedLastUsed, sampleStat?.last_used_at);
  const derivedSupersedesPersisted = sampledObserved && (
    !persistedObserved
    || (sampleStat?.volunteered_count ?? 0) > (persistedVolunteered ?? 0)
    || (sampleStat?.used_count ?? 0) > (persistedUsed ?? 0)
    || (sampleStat?.last_used_at ?? 0) > (persistedLastUsed ?? 0)
  );
  const statsSource = derivedSupersedesPersisted
    ? 'derived_from_samples'
    : persistedObserved
      ? 'persisted'
      : 'derived_from_samples';
  const precision = volunteeredCount > 0 ? round3(usedCount / volunteeredCount) : null;

  return {
    metric_state: 'known',
    stats_source: statsSource,
    instrumentation_needed: false,
    volunteered_count: volunteeredCount,
    used_count: usedCount,
    reuse_count: usedCount,
    last_used_at: lastUsedAt,
    precision,
    retrieval_relevance: precision,
    reused: usedCount > 1,
    fields_missing: [],
  };
}

function decorateMemoryRowsWithAcceptedUseAccounting(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const sampleStats = memoryAcceptedUseSampleStats(list.map((row) => row?.id));
  return list.map((row) => ({
    ...row,
    accepted_use_accounting: memoryAcceptedUseAccounting(row, sampleStats.get(Number(row.id)) ?? null),
  }));
}

function decorateMemoryRowWithAcceptedUseAccounting(row = null) {
  if (!row) return row;
  return decorateMemoryRowsWithAcceptedUseAccounting([row])[0];
}

function decorateFactRowsWithReuseAccounting(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const sampleStats = factReuseSampleStats(list.map((row) => row?.id));
  return list.map((row) => ({
    ...row,
    fact_reuse_accounting: factReuseAccounting(row, sampleStats.get(Number(row.id)) ?? null),
  }));
}

function normalizeInstructionFeedback(body = {}) {
  const rows = [];
  const add = (ids, outcome) => {
    for (const id of memoryIdsFromInstructionIds(ids)) rows.push({ id, outcome });
  };
  add(body.used_instruction_ids ?? body.usedInstructionIds ?? body.used_source_ids ?? body.usedSourceIds ?? [], 'used');
  add(body.ignored_instruction_ids ?? body.ignoredInstructionIds ?? body.ignored_source_ids ?? body.ignoredSourceIds ?? [], 'ignored');
  add(body.harmful_instruction_ids ?? body.harmfulInstructionIds ?? body.harmful_source_ids ?? body.harmfulSourceIds ?? [], 'harmful');
  for (const item of Array.isArray(body.feedback) ? body.feedback : []) {
    const ids = item.memory_id != null ? [`memory:${item.memory_id}`] : (item.source_id != null ? [item.source_id] : []);
    const outcome = String(item.outcome ?? '').toLowerCase();
    if (['used', 'ignored', 'harmful'].includes(outcome)) add(ids, outcome);
  }
  if (!rows.length && Array.isArray(body.instruction_ids ?? body.instructionIds)) {
    add(body.instruction_ids ?? body.instructionIds, 'ignored');
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row.outcome);
  return [...byId.entries()].map(([id, outcome]) => ({ id, outcome }));
}

function recordInstructionFeedback(body = {}) {
  const feedback = normalizeInstructionFeedback(body);
  if (!feedback.length) return { recorded: [], missing: [] };
  const now = Math.floor(Date.now() / 1000);
  const feedbackScope = {
    project: String(body.project ?? '').slice(0, 240),
    task_id: String(body.task_id ?? body.taskId ?? '').slice(0, 240),
    session_id: String(body.session_id ?? body.sessionId ?? '').slice(0, 240),
    user_id: String(body.user_id ?? body.userId ?? '').slice(0, 240),
    turn_id: String(body.turn_id ?? body.turnId ?? '').slice(0, 240),
    agent_id: String(body.agent_id ?? body.agentId ?? '').slice(0, 240),
  };
  const usedStmt = db.prepare(`
    UPDATE agent_memories
    SET last_used_at=unixepoch(), ignored_count=0, used_count=used_count+1
    WHERE id=? AND agent_id='team-instructions'
  `);
  const ignoredStmt = db.prepare(`
    UPDATE agent_memories
    SET ignored_count=ignored_count+1
    WHERE id=? AND agent_id='team-instructions'
  `);
  const harmfulStmt = db.prepare(`
    UPDATE agent_memories
    SET ignored_count=ignored_count+1, harmful_count=harmful_count+1
    WHERE id=? AND agent_id='team-instructions'
  `);
  const recorded = [];
  const missing = [];
  for (const item of feedback) {
    const memory = db.prepare(`SELECT id, mem_key, content, project, task_id, session_id, user_id, turn_id, ignored_count, used_count, harmful_count FROM agent_memories WHERE id=? AND agent_id='team-instructions'`).get(item.id);
    if (!memory) {
      missing.push(`memory:${item.id}`);
      continue;
    }
    if (item.outcome === 'used') usedStmt.run(item.id);
    else if (item.outcome === 'harmful') harmfulStmt.run(item.id);
    else ignoredStmt.run(item.id);
    const updated = db.prepare(`SELECT id, mem_key, project, task_id, session_id, user_id, turn_id, ignored_count, used_count, harmful_count FROM agent_memories WHERE id=?`).get(item.id);
    recorded.push({
      source_id: `memory:${item.id}`,
      memory_id: item.id,
      outcome: item.outcome,
      scope: feedbackScope,
      before: memory,
      after: updated,
    });
  }
  recordInstructionScopeStats(recorded, { now });
  db.prepare(`
    INSERT INTO timeline (source, type, subject, data, tags)
    VALUES (?, 'instruction:feedback', ?, ?, ?)
  `).run(
    body.source ?? 'brain-instructions',
    body.task_id ?? body.taskId ?? body.query_id ?? body.queryId ?? body.agent_id ?? body.agentId ?? '',
    JSON.stringify({
      task_id: body.task_id ?? body.taskId ?? '',
      query_id: body.query_id ?? body.queryId ?? '',
      agent_id: body.agent_id ?? body.agentId ?? '',
      project: body.project ?? '',
      session_id: body.session_id ?? body.sessionId ?? '',
      user_id: body.user_id ?? body.userId ?? '',
      turn_id: body.turn_id ?? body.turnId ?? '',
      scope: feedbackScope,
      recorded: recorded.map(({ source_id, memory_id, outcome, scope, before, after }) => ({
        source_id,
        memory_id,
        outcome,
        scope,
        memory_scope: {
          project: before.project ?? '',
          task_id: before.task_id ?? '',
          session_id: before.session_id ?? '',
          user_id: before.user_id ?? '',
          turn_id: before.turn_id ?? '',
        },
        counters: after,
      })),
      missing,
      metadata: body.metadata ?? {},
      recorded_at: now,
    }),
    JSON.stringify(['brain', 'instruction-feedback']),
  );
  return { recorded, missing };
}

function normalizeInstructionScope(raw = {}) {
  return {
    project: String(raw.project ?? '').slice(0, 240),
    task_id: String(raw.task_id ?? raw.taskId ?? '').slice(0, 240),
    session_id: String(raw.session_id ?? raw.sessionId ?? '').slice(0, 240),
    user_id: String(raw.user_id ?? raw.userId ?? '').slice(0, 240),
    turn_id: String(raw.turn_id ?? raw.turnId ?? '').slice(0, 240),
    agent_id: String(raw.agent_id ?? raw.agentId ?? '').slice(0, 240),
  };
}

function instructionScopeKey(scope = {}) {
  const s = normalizeInstructionScope(scope);
  return [
    `project:${s.project}`,
    `session:${s.session_id}`,
    `user:${s.user_id}`,
    `agent:${s.agent_id}`,
  ].join('|');
}

function instructionScopeLabel(scope = {}) {
  const s = normalizeInstructionScope(scope);
  const parts = [
    s.project ? `project=${s.project}` : '',
    s.task_id ? `task=${s.task_id}` : '',
    s.session_id ? `session=${s.session_id}` : '',
    s.user_id ? `user=${s.user_id}` : '',
    s.turn_id ? `turn=${s.turn_id}` : '',
    s.agent_id ? `agent=${s.agent_id}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'global';
}

function mergeInstructionScopes(...scopes) {
  const merged = normalizeInstructionScope({});
  for (const scope of scopes) {
    const current = normalizeInstructionScope(scope ?? {});
    for (const [key, value] of Object.entries(current)) {
      if (value) merged[key] = value;
    }
  }
  return merged;
}

function scopeMatchesMemory(scope = {}, memory = {}) {
  const s = normalizeInstructionScope(scope);
  for (const [field, memField] of [
    ['project', 'project'],
    ['task_id', 'task_id'],
    ['session_id', 'session_id'],
    ['user_id', 'user_id'],
    ['turn_id', 'turn_id'],
  ]) {
    const memoryValue = String(memory[memField] ?? '');
    if (memoryValue && s[field] !== memoryValue) return false;
  }
  return true;
}

function recordInstructionScopeStats(recorded = [], { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!recorded.length) return;
  const stmt = db.prepare(`
    INSERT INTO instruction_scope_stats (
      memory_id, source_id, scope_key, scope_label, project, session_id, user_id,
      agent_id, memory_scope_match, used_count, ignored_count, harmful_count,
      feedback_count, first_seen, last_seen, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(memory_id, scope_key) DO UPDATE SET
      scope_label=excluded.scope_label,
      project=excluded.project,
      session_id=excluded.session_id,
      user_id=excluded.user_id,
      agent_id=excluded.agent_id,
      memory_scope_match=excluded.memory_scope_match,
      used_count=instruction_scope_stats.used_count + excluded.used_count,
      ignored_count=instruction_scope_stats.ignored_count + excluded.ignored_count,
      harmful_count=instruction_scope_stats.harmful_count + excluded.harmful_count,
      feedback_count=instruction_scope_stats.feedback_count + excluded.feedback_count,
      last_seen=MAX(instruction_scope_stats.last_seen, excluded.last_seen),
      updated_at=unixepoch()
  `);
  for (const item of recorded) {
    const scope = mergeInstructionScopes({
      project: item.before?.project ?? '',
      task_id: item.before?.task_id ?? '',
      session_id: item.before?.session_id ?? '',
      user_id: item.before?.user_id ?? '',
      turn_id: item.before?.turn_id ?? '',
    }, item.scope);
    const reusableScope = { ...scope, task_id: '', turn_id: '' };
    const used = item.outcome === 'used' ? 1 : 0;
    const harmful = item.outcome === 'harmful' ? 1 : 0;
    const ignored = item.outcome === 'used' ? 0 : 1;
    stmt.run(
      item.memory_id,
      item.source_id,
      instructionScopeKey(reusableScope),
      instructionScopeLabel(reusableScope),
      reusableScope.project,
      reusableScope.session_id,
      reusableScope.user_id,
      reusableScope.agent_id,
      scopeMatchesMemory(scope, item.before) ? 1 : 0,
      used,
      ignored,
      harmful,
      1,
      now,
      now,
    );
  }
}

function persistedInstructionScopePrecision({ limit = 50 } = {}) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT s.*, m.mem_key, m.content, m.status
      FROM instruction_scope_stats s
      LEFT JOIN agent_memories m ON m.id=s.memory_id
      ORDER BY s.harmful_count DESC, s.ignored_count DESC, s.used_count ASC, s.last_seen DESC
      LIMIT ?
    `).all(limit);
  } catch {
    return [];
  }
  return rows.map(row => ({
    memory_id: row.memory_id,
    source_id: row.source_id,
    key: row.mem_key ?? '',
    project: row.project,
    task_id: '',
    session_id: row.session_id,
    user_id: row.user_id,
    turn_id: '',
    agent_id: row.agent_id,
    scope_key: row.scope_key,
    scope_label: row.scope_label,
    memory_scope_match: Boolean(row.memory_scope_match),
    used_count: Number(row.used_count ?? 0),
    ignored_count: Number(row.ignored_count ?? 0),
    harmful_count: Number(row.harmful_count ?? 0),
    feedback_count: Number(row.feedback_count ?? 0),
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    precision: Number(row.feedback_count ?? 0) ? Math.round((Number(row.used_count ?? 0) / Number(row.feedback_count ?? 0)) * 1000) / 1000 : null,
    stats_source: 'persisted',
  }));
}

function instructionScopeThresholdState(scope = {}) {
  if (Number(scope.harmful_count ?? 0) > 0) return 'harmful';
  if (Number(scope.feedback_count ?? 0) < 2) return 'neutral';
  if (Number(scope.used_count ?? 0) === 0) return 'noisy';
  if ((scope.precision ?? 0) >= 0.6) return 'useful';
  return 'neutral';
}

function latestInstructionScopeSnapshots({ limit = 50 } = {}) {
  const day = db.prepare(`SELECT day FROM instruction_scope_snapshots ORDER BY day DESC LIMIT 1`).get()?.day ?? null;
  if (!day) return { day: null, rows: [], counts: {}, degrading: [], improving: [] };
  const rows = db.prepare(`
    SELECT * FROM instruction_scope_snapshots
    WHERE day=?
    ORDER BY harmful_count DESC, ignored_count DESC, used_count ASC, created_at DESC
    LIMIT ?
  `).all(day, limit).map(row => ({
    ...row,
    memory_scope_match: Boolean(row.memory_scope_match),
  }));
  const counts = rows.reduce((acc, row) => {
    acc[row.threshold_state] = (acc[row.threshold_state] ?? 0) + 1;
    return acc;
  }, {});
  const previousDay = db.prepare(`
    SELECT day FROM instruction_scope_snapshots
    WHERE day < ?
    ORDER BY day DESC
    LIMIT 1
  `).get(day)?.day ?? null;
  const previous = previousDay
    ? new Map(db.prepare(`SELECT memory_id, scope_key, threshold_state, precision FROM instruction_scope_snapshots WHERE day=?`).all(previousDay)
      .map(row => [`${row.memory_id}|${row.scope_key}`, row]))
    : new Map();
  const rank = { harmful: 3, noisy: 2, neutral: 1, useful: 0 };
  const changed = rows.map(row => {
    const prev = previous.get(`${row.memory_id}|${row.scope_key}`);
    if (!prev || prev.threshold_state === row.threshold_state) return null;
    const delta = (rank[row.threshold_state] ?? 1) - (rank[prev.threshold_state] ?? 1);
    return { ...row, previous_state: prev.threshold_state, previous_precision: prev.precision, direction: delta > 0 ? 'degrading' : 'improving' };
  }).filter(Boolean);
  return {
    day,
    rows,
    counts,
    degrading: changed.filter(row => row.direction === 'degrading'),
    improving: changed.filter(row => row.direction === 'improving'),
  };
}

function writeInstructionScopeSnapshot({ day = new Date().toISOString().slice(0, 10), source = 'brain-cycle' } = {}) {
  const scopes = persistedInstructionScopePrecision({ limit: 5000 });
  const previousDay = db.prepare(`
    SELECT day FROM instruction_scope_snapshots
    WHERE day < ?
    ORDER BY day DESC
    LIMIT 1
  `).get(day)?.day ?? null;
  const previous = previousDay
    ? new Map(db.prepare(`SELECT memory_id, scope_key, threshold_state, precision FROM instruction_scope_snapshots WHERE day=?`).all(previousDay)
      .map(row => [`${row.memory_id}|${row.scope_key}`, row]))
    : new Map();
  const changed = [];
  const stmt = db.prepare(`
    INSERT INTO instruction_scope_snapshots (
      day, memory_id, source_id, scope_key, scope_label, project, session_id,
      user_id, agent_id, memory_scope_match, used_count, ignored_count,
      harmful_count, feedback_count, precision, threshold_state
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, memory_id, scope_key) DO UPDATE SET
      source_id=excluded.source_id,
      scope_label=excluded.scope_label,
      project=excluded.project,
      session_id=excluded.session_id,
      user_id=excluded.user_id,
      agent_id=excluded.agent_id,
      memory_scope_match=excluded.memory_scope_match,
      used_count=excluded.used_count,
      ignored_count=excluded.ignored_count,
      harmful_count=excluded.harmful_count,
      feedback_count=excluded.feedback_count,
      precision=excluded.precision,
      threshold_state=excluded.threshold_state
  `);
  for (const scope of scopes) {
    const state = instructionScopeThresholdState(scope);
    stmt.run(
      day,
      scope.memory_id,
      scope.source_id,
      scope.scope_key,
      scope.scope_label,
      scope.project,
      scope.session_id,
      scope.user_id,
      scope.agent_id,
      scope.memory_scope_match ? 1 : 0,
      scope.used_count,
      scope.ignored_count,
      scope.harmful_count,
      scope.feedback_count,
      scope.precision,
      state,
    );
    const prev = previous.get(`${scope.memory_id}|${scope.scope_key}`);
    if (prev && prev.threshold_state !== state) {
      changed.push({
        memory_id: scope.memory_id,
        source_id: scope.source_id,
        scope_key: scope.scope_key,
        scope_label: scope.scope_label,
        previous_state: prev.threshold_state,
        threshold_state: state,
        previous_precision: prev.precision,
        precision: scope.precision,
      });
    }
  }
  if (changed.length) {
    db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
      .run(source, 'instruction-scope:threshold-changed', day, JSON.stringify({ day, changed: changed.slice(0, 50), count: changed.length }), JSON.stringify(['brain', 'instruction', 'scope', 'snapshot']));
  }
  const counts = db.prepare(`
    SELECT threshold_state, COUNT(*) AS c
    FROM instruction_scope_snapshots
    WHERE day=?
    GROUP BY threshold_state
  `).all(day).reduce((acc, row) => {
    acc[row.threshold_state] = row.c;
    return acc;
  }, {});
  return { day, scopes: scopes.length, counts, changed };
}

function instructionScopePrecision({ rows = [], limit = 50 } = {}) {
  const memoryRows = db.prepare(`
    SELECT id, mem_key, content, project, task_id, session_id, user_id, turn_id, status
    FROM agent_memories
    WHERE agent_id='team-instructions'
  `).all();
  const memories = new Map(memoryRows.map(row => [Number(row.id), row]));
  const buckets = new Map();
  for (const event of rows) {
    const data = event.data ?? {};
    const eventScope = normalizeInstructionScope(data.scope ?? data);
    for (const item of Array.isArray(data.recorded) ? data.recorded : []) {
      const memoryId = Number(item.memory_id ?? String(item.source_id ?? '').replace(/^memory:/, ''));
      if (!Number.isInteger(memoryId)) continue;
      const memory = memories.get(memoryId);
      const scope = mergeInstructionScopes(item.memory_scope, eventScope, item.scope);
      const key = `${memoryId}|${instructionScopeKey(scope)}`;
      const bucket = buckets.get(key) ?? {
        memory_id: memoryId,
        source_id: `memory:${memoryId}`,
        key: memory?.mem_key ?? '',
        project: scope.project,
        task_id: '',
        session_id: scope.session_id,
        user_id: scope.user_id,
        turn_id: '',
        agent_id: scope.agent_id,
        scope_label: instructionScopeLabel({ ...scope, task_id: '', turn_id: '' }),
        memory_scope_match: memory ? scopeMatchesMemory(scope, memory) : false,
        used_count: 0,
        ignored_count: 0,
        harmful_count: 0,
        feedback_count: 0,
        last_seen: 0,
      };
      bucket.feedback_count++;
      if (item.outcome === 'used') bucket.used_count++;
      else if (item.outcome === 'harmful') {
        bucket.ignored_count++;
        bucket.harmful_count++;
      } else bucket.ignored_count++;
      bucket.last_seen = Math.max(bucket.last_seen, Number(event.created_at ?? 0));
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()].map(row => ({
    ...row,
    precision: row.feedback_count ? Math.round((row.used_count / row.feedback_count) * 1000) / 1000 : null,
    stats_source: 'timeline',
  })).sort((a, b) =>
    b.harmful_count - a.harmful_count ||
    b.ignored_count - a.ignored_count ||
    a.used_count - b.used_count ||
    b.last_seen - a.last_seen
  ).slice(0, limit);
}

function createLearningTask({
  kind,
  subject = '',
  approvalId = null,
  assignee = '',
  status = 'queued',
  priority = 0,
  evidenceIds = {},
  payload = {},
  result = {},
} = {}) {
  return policyCreateLearningTask(db, { kind, subject, approvalId, assignee, status, priority, evidenceIds, payload, result });
}

function recordLearningRollback({
  approvalId = null,
  kind,
  subject = '',
  inverseAction,
  beforeState = {},
  afterState = {},
  metadata = {},
  createdBy = 'brain',
} = {}) {
  return policyRecordLearningRollback(db, { approvalId, kind, subject, inverseAction, beforeState, afterState, metadata, createdBy });
}

function memoryRetireCandidates({ limit = 25 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return db.prepare(`
    SELECT * FROM agent_memories
    WHERE visibility='public'
      AND agent_id!='team-instructions'
      AND ${LIVE}
      AND last_volunteered_at IS NOT NULL
      AND ignored_count >= 3
    ORDER BY ignored_count DESC, COALESCE(last_used_at, 0) ASC, last_volunteered_at ASC
    LIMIT ?
  `).all(limit).map((row) => {
    const ageDays = Math.round(((now - Number(row.created_at ?? now)) / 86400) * 10) / 10;
    const lastUsedAgeDays = row.last_used_at == null ? null : Math.round(((now - Number(row.last_used_at)) / 86400) * 10) / 10;
    const score = Math.round((Number(row.ignored_count ?? 0) + (lastUsedAgeDays == null ? 2 : Math.min(lastUsedAgeDays / 30, 2)) + Math.min(ageDays / 90, 1)) * 1000) / 1000;
    return {
      id: row.id,
      source_id: `memory:${row.id}`,
      agent_id: row.agent_id,
      key: row.mem_key,
      content: row.content,
      tags: parseJson(row.tags, []),
      ignored_count: row.ignored_count,
      created_at: row.created_at,
      last_volunteered_at: row.last_volunteered_at,
      last_used_at: row.last_used_at,
      ageDays,
      lastUsedAgeDays,
      score,
      suggestedReason: row.last_used_at == null
        ? `Volunteered ${row.ignored_count} times and never accepted.`
        : `Volunteered ${row.ignored_count} ignored times since last accepted use.`,
    };
  });
}

function instructionLifecycleCandidates({ scopePrecision = [], limit = 25 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM agent_memories
    WHERE agent_id='team-instructions'
      AND visibility='public'
      AND ${LIVE}
      AND status='active'
      AND (harmful_count > 0 OR ignored_count >= 3)
    ORDER BY harmful_count DESC, ignored_count DESC, COALESCE(last_used_at, 0) ASC, created_at ASC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => {
    const harmful = Number(row.harmful_count ?? 0);
    const ignored = Number(row.ignored_count ?? 0);
    const localRows = scopePrecision.filter(scope => scope.memory_id === row.id && scope.memory_scope_match);
    const worstLocal = localRows.find(scope => scope.harmful_count > 0)
      ?? localRows.find(scope => scope.ignored_count >= 3 && scope.used_count === 0)
      ?? null;
    if (harmful === 0 && !worstLocal) return null;
    const action = harmful > 0 || (worstLocal?.harmful_count ?? 0) > 0 ? 'team.instruction.retire' : 'team.instruction.supersede';
    return {
      id: row.id,
      source_id: `memory:${row.id}`,
      key: row.mem_key,
      content: row.content,
      tags: parseJson(row.tags, []),
      project: row.project,
      task_id: row.task_id,
      session_id: row.session_id,
      user_id: row.user_id,
      ignored_count: ignored,
      volunteered_count: Number(row.volunteered_count ?? 0),
      used_count: Number(row.used_count ?? 0),
      harmful_count: harmful,
      scope: worstLocal ? {
        project: worstLocal.project,
        task_id: worstLocal.task_id,
        session_id: worstLocal.session_id,
        user_id: worstLocal.user_id,
        turn_id: worstLocal.turn_id,
        agent_id: worstLocal.agent_id,
        label: worstLocal.scope_label,
        ignored_count: worstLocal.ignored_count,
        used_count: worstLocal.used_count,
        harmful_count: worstLocal.harmful_count,
        precision: worstLocal.precision,
      } : null,
      last_volunteered_at: row.last_volunteered_at,
      last_used_at: row.last_used_at,
      suggestedAction: action,
      suggestedReason: (worstLocal?.harmful_count ?? harmful) > 0
        ? `Instruction was marked harmful ${harmful} time${harmful === 1 ? '' : 's'}.`
        : worstLocal
          ? `Instruction was ignored ${worstLocal.ignored_count} times without accepted use in ${worstLocal.scope_label}.`
          : `Instruction was ignored ${ignored} times without accepted use.`,
    };
  }).filter(Boolean);
}

function evalFixturePromotionCandidates({ limit = 25 } = {}) {
  const maxLatencyMs = Number(process.env.BRAIN_FIXTURE_PROMOTE_MAX_LATENCY_MS ?? 5000);
  return db.prepare(`
    SELECT q.*
    FROM eval_queries q
    LEFT JOIN eval_fixtures f ON f.eval_query_id=q.id
    WHERE f.id IS NULL
      AND q.accepted_ids != '[]'
      AND (q.returned_entity_ids != '[]' OR q.returned_text_unit_ids != '[]' OR q.returned_fact_ids != '[]')
      AND (q.latency_ms IS NULL OR q.latency_ms <= ?)
    ORDER BY q.created_at DESC
    LIMIT ?
  `).all(maxLatencyMs, limit).map((row) => {
    const accepted = normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical;
    const returned = [
      ...parseJson(row.returned_entity_ids, []).map(id => canonicalSourceId('entity', id)),
      ...parseJson(row.returned_text_unit_ids, []).map(id => canonicalSourceId('text', id)),
      ...parseJson(row.returned_fact_ids, []).map(id => canonicalSourceId('fact', id)),
    ].filter(Boolean);
    const returnedSet = new Set(returned);
    const requiredSourceIds = accepted.filter(id => returnedSet.has(id));
    const metadata = parseJson(row.metadata, {});
    const localPayloadText = JSON.stringify(buildLocalContext({ q: row.query_text, limit: 10 }));
    const requiredStrings = extractFixtureStrings(row.query_text, metadata)
      .filter(str => !requiredSourceIds.includes(str) && localPayloadText.includes(str));
    return {
      eval_query_id: row.id,
      query_text: row.query_text,
      route: row.route,
      agent_id: row.agent_id,
      task_id: row.task_id,
      latency_ms: row.latency_ms,
      accepted_source_ids: accepted,
      returned_source_ids: returned,
      required_source_ids: requiredSourceIds,
      required_strings: requiredStrings,
      score: Math.round(((requiredSourceIds.length * 2) + requiredStrings.length + (row.latency_ms == null ? 0.5 : Math.max(0, 1 - (row.latency_ms / Math.max(maxLatencyMs, 1))))) * 1000) / 1000,
      suggestedReason: `Eval row accepted ${accepted.length} cited source${accepted.length === 1 ? '' : 's'} with returned-source coverage.`,
      metadata,
    };
  }).filter(candidate => candidate.required_source_ids.length || candidate.required_strings.length);
}

function sourcePrecisionStats({ days = 90 } = {}) {
  const safeDays = Math.max(Number(days) || 90, 1);
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const now = Math.floor(Date.now() / 1000);
  const bySource = new Map();
  const byEntity = new Map();
  const ensure = (map, id) => {
    if (!map.has(id)) {
      map.set(id, {
        source_id: id,
        kind: sourceKindFromCanonical(id),
        volunteered: 0,
        used: 0,
        weightedVolunteered: 0,
        weightedUsed: 0,
        lastVolunteeredAt: null,
        lastUsedAt: null,
      });
    }
    return map.get(id);
  };
  const addStat = (map, id, patch = {}) => {
    const stat = ensure(map, id);
    stat.volunteered += Number(patch.volunteered ?? 0);
    stat.used += Number(patch.used ?? 0);
    stat.weightedVolunteered += Number(patch.weightedVolunteered ?? patch.weighted_volunteered ?? 0);
    stat.weightedUsed += Number(patch.weightedUsed ?? patch.weighted_used ?? 0);
    if (patch.lastVolunteeredAt != null || patch.last_volunteered_at != null) {
      stat.lastVolunteeredAt = Math.max(stat.lastVolunteeredAt ?? 0, Number(patch.lastVolunteeredAt ?? patch.last_volunteered_at ?? 0));
    }
    if (patch.lastUsedAt != null || patch.last_used_at != null) {
      stat.lastUsedAt = Math.max(stat.lastUsedAt ?? 0, Number(patch.lastUsedAt ?? patch.last_used_at ?? 0));
    }
    return stat;
  };

  let deltaSince = since;
  const useSnapshot = safeDays > Number(process.env.BRAIN_PRECISION_DIRECT_DAYS ?? 14);
  if (useSnapshot) {
    const snapshot = db.prepare(`
      SELECT day, MAX(created_at) AS created_at
      FROM source_precision_snapshots
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day DESC
      LIMIT 1
    `).get(since);
    if (snapshot?.day) {
      const snapshotRows = db.prepare(`
        SELECT canonical_source_id, source_kind, volunteered, used, weighted_volunteered, weighted_used, precision, weighted_precision, score
        FROM source_precision_snapshots
        WHERE day=?
      `).all(snapshot.day);
      for (const row of snapshotRows) {
        addStat(bySource, row.canonical_source_id, row);
        if (String(row.canonical_source_id).startsWith('entity:')) {
          addStat(byEntity, String(row.canonical_source_id).slice('entity:'.length), row);
        }
      }
      deltaSince = Math.max(Number(snapshot.created_at ?? since), since);
    }
  }

  const rows = db.prepare(`
    SELECT accepted_ids, volunteered_source_ids, created_at
    FROM eval_queries
    WHERE created_at > ?
      AND volunteered_source_ids != '[]'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(deltaSince, Number(process.env.BRAIN_PRECISION_DELTA_LIMIT ?? 5000));

  for (const row of rows) {
    const accepted = new Set(normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical);
    const volunteered = normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical;
    if (!volunteered.length) continue;
    const ageDays = Math.max((now - Number(row.created_at ?? now)) / 86400, 0);
    const weight = Math.exp(-ageDays / 30);
    for (const id of volunteered) {
      const stat = addStat(bySource, id, { volunteered: 1, weightedVolunteered: weight, lastVolunteeredAt: Number(row.created_at ?? 0) });
      if (accepted.has(id)) {
        addStat(bySource, id, { used: 1, weightedUsed: weight, lastUsedAt: Number(row.created_at ?? 0) });
      }
      if (id.startsWith('entity:')) {
        const entId = id.slice('entity:'.length);
        addStat(byEntity, entId, { volunteered: 1, weightedVolunteered: weight, lastVolunteeredAt: Number(row.created_at ?? 0) });
        if (accepted.has(id)) {
          addStat(byEntity, entId, { used: 1, weightedUsed: weight, lastUsedAt: Number(row.created_at ?? 0) });
        }
      }
    }
  }

  const finalize = (stat) => {
    const precision = stat.volunteered ? stat.used / stat.volunteered : null;
    const weightedPrecision = stat.weightedVolunteered ? stat.weightedUsed / stat.weightedVolunteered : null;
    return {
      ...stat,
      precision: precision == null ? null : Math.round(precision * 1000) / 1000,
      weightedPrecision: weightedPrecision == null ? null : Math.round(weightedPrecision * 1000) / 1000,
      score: weightedPrecision == null
        ? 0
        : Math.round(((weightedPrecision * 2) - (stat.used === 0 && stat.volunteered >= 3 ? 1 : 0)) * 1000) / 1000,
    };
  };

  return {
    bySource: new Map([...bySource].map(([id, stat]) => [id, finalize(stat)])),
    byEntity: new Map([...byEntity].map(([id, stat]) => [id, finalize(stat)])),
  };
}

function thresholdState(stat) {
  if (!stat || stat.volunteered < 3) return 'neutral';
  if ((stat.weightedPrecision ?? stat.precision ?? 0) >= 0.6) return 'useful';
  if (stat.used === 0) return 'noisy';
  return 'neutral';
}

function writeSourcePrecisionSnapshot({ day = new Date().toISOString().slice(0, 10), days = 90, source = 'brain-cycle' } = {}) {
  const existingCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM source_precision_snapshots
    WHERE day=?
  `).get(day)?.c ?? 0);
  const precision = sourcePrecisionStats({ days });
  const previousDay = db.prepare(`
    SELECT day FROM source_precision_snapshots
    WHERE day < ?
    ORDER BY day DESC
    LIMIT 1
  `).get(day)?.day ?? null;
  if (existingCount > 0) {
    return {
      day,
      previousDay,
      written: existingCount,
      changed: [],
      skipped: 'day_exists',
    };
  }
  const previousRows = previousDay
    ? db.prepare(`SELECT canonical_source_id, threshold_state, weighted_precision, volunteered, used FROM source_precision_snapshots WHERE day=?`).all(previousDay)
    : [];
  const previous = new Map(previousRows.map(r => [r.canonical_source_id, r]));
  const changed = [];
  const stmt = db.prepare(`
    INSERT INTO source_precision_snapshots
      (day, canonical_source_id, source_kind, volunteered, used, weighted_volunteered, weighted_used, precision, weighted_precision, threshold_state, score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const stat of precision.bySource.values()) {
    const state = thresholdState(stat);
    stmt.run(
      day,
      stat.source_id,
      stat.kind,
      stat.volunteered,
      stat.used,
      Math.round((stat.weightedVolunteered ?? 0) * 1000) / 1000,
      Math.round((stat.weightedUsed ?? 0) * 1000) / 1000,
      stat.precision,
      stat.weightedPrecision,
      state,
      stat.score,
    );
    const prev = previous.get(stat.source_id);
    if (prev && prev.threshold_state !== state) {
      changed.push({
        source_id: stat.source_id,
        from: prev.threshold_state,
        to: state,
        precision: stat.precision,
        weightedPrecision: stat.weightedPrecision,
        volunteered: stat.volunteered,
        used: stat.used,
      });
    }
  }
  for (const change of changed) {
    db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
      .run(source, 'context:source-threshold-changed', change.source_id, JSON.stringify({ day, previous_day: previousDay, ...change }), JSON.stringify(['brain', 'context', 'precision']));
  }
  return {
    day,
    previousDay,
    written: precision.bySource.size,
    changed,
  };
}

function writeQualityMetricSnapshot({
  day,
  source = 'brain-quality-metrics',
  values = {},
  brain_totals = {},
  sample_size = 0,
  window_days = 7,
  pass_count = 0,
  total_count = 0,
  all_pass = false,
} = {}) {
  const d = day ?? new Date().toISOString().slice(0, 10);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO quality_metric_snapshots
      (day, measured_at, source, "values", brain_totals, sample_size, window_days, pass_count, total_count, all_pass)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day, source) DO UPDATE SET
      measured_at  = excluded.measured_at,
      "values"     = excluded."values",
      brain_totals = excluded.brain_totals,
      sample_size  = excluded.sample_size,
      window_days  = excluded.window_days,
      pass_count   = excluded.pass_count,
      total_count  = excluded.total_count,
      all_pass     = excluded.all_pass
  `).run(d, now, source, JSON.stringify(values), JSON.stringify(brain_totals), sample_size, window_days, pass_count, total_count, all_pass ? 1 : 0);
  return { day: d, source, all_pass, pass_count, total_count };
}

function readQualityMetricTrend({ days = 30, source = 'brain-quality-metrics' } = {}) {
  const since = new Date();
  since.setDate(since.getDate() - Number(days));
  const sinceDay = since.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT * FROM quality_metric_snapshots
    WHERE day >= ? AND source = ?
    ORDER BY day ASC
  `).all(sinceDay, source);
  return rows.map(r => ({
    day: r.day,
    measured_at: r.measured_at,
    source: r.source,
    values: (() => { try { return JSON.parse(r.values); } catch { return {}; } })(),
    brain_totals: (() => { try { return JSON.parse(r.brain_totals); } catch { return {}; } })(),
    sample_size: r.sample_size,
    window_days: r.window_days,
    pass_count: r.pass_count,
    total_count: r.total_count,
    all_pass: Boolean(r.all_pass),
  }));
}

function bundleCanonicalSourceIds(bundle) {
  return [...new Set([
    ...(bundle.entityIds ?? []).map((id) => canonicalSourceId('entity', id)),
    ...(bundle.factIds ?? []).map((id) => canonicalSourceId('fact', id)),
    ...(bundle.textUnitIds ?? []).map((id) => canonicalSourceId('text', id)),
    ...(bundle.memoryIds ?? []).map((id) => `memory:${id}`),
  ].filter(Boolean))];
}

function scoreVolunteerBundle(bundle, precision, index = 0) {
  const ids = bundleCanonicalSourceIds(bundle);
  const stats = ids.map(id => precision.bySource.get(id)).filter(Boolean);
  const precisionScore = stats.length
    ? stats.reduce((sum, stat) => sum + stat.score, 0) / stats.length
    : 0;
  const usefulHits = stats.filter(stat => stat.volunteered >= 2 && stat.precision >= 0.5).length;
  const noisyHits = stats.filter(stat => stat.volunteered >= 3 && stat.used === 0).length;
  return Math.round(((1 / (index + 1)) + precisionScore + usefulHits * 0.25 - noisyHits * 0.75) * 1000) / 1000;
}

function repoHintsForContext(text = '') {
  const lower = String(text ?? '').toLowerCase();
  if (!lower.trim()) return [];
  const rows = db.prepare(`
    SELECT id, name, description, data
    FROM entities
    WHERE type='repo' AND status='active'
    ORDER BY updated_at DESC
    LIMIT 200
  `).all();
  const hints = [];
  for (const row of rows) {
    const data = parseJson(row.data, {});
    const values = [
      row.id,
      row.name,
      row.description,
      data.path,
      data.remote,
      ...(data.changed_files?.files ?? []),
      ...(data.changed_files?.manifests ?? []),
      ...(data.selected_files ?? []).map(file => file.path),
    ].map(value => String(value ?? '').toLowerCase()).filter(Boolean);
    const matched = values.filter(value => lower.includes(value) || lower.includes(value.split('/').pop()));
    if (matched.length) hints.push({ repo_id: row.id, name: row.name, matched: [...new Set(matched)].slice(0, 8) });
  }
  return hints;
}

function sourceRepoIds(record = {}) {
  const ids = [];
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? record.metadata
    : parseJson(record.metadata, {});
  for (const value of [
    metadata.repo_id,
    metadata.repoId,
    record.source_kind === 'repo' ? record.source_id : '',
    record.source_kind === 'repo-file' || record.source_kind === 'repo-diff' ? String(record.source_id ?? '').split(':').slice(0, 2).join(':') : '',
  ]) {
    if (value) ids.push(String(value));
  }
  return [...new Set(ids)];
}

function matchedAliasesForEntity(entityId, query = '') {
  const clean = String(query ?? '').trim().toLowerCase();
  const normalized = normalizeAlias(query);
  if (!entityId || (!clean && !normalized)) return [];
  return db.prepare(`
    SELECT alias, normalized, kind, source
    FROM entity_aliases
    WHERE entity_id=? AND status='active' AND kind!='canonical'
    ORDER BY kind='canonical' DESC, updated_at DESC, alias
  `).all(entityId)
    .filter((row) => {
      const alias = String(row.alias ?? '').toLowerCase();
      const norm = String(row.normalized ?? '');
      return (alias.length >= 3 && (clean.includes(alias) || alias.includes(clean)))
        || (norm.length >= 3 && (normalized.includes(norm) || norm.includes(normalized)));
    })
    .slice(0, 8);
}

function repoAffinityForBundle(bundle, repoHints = []) {
  if (!repoHints.length) return { score: 0, matches: [] };
  const hintIds = new Set(repoHints.map(hint => hint.repo_id));
  const matches = [];
  for (const entity of bundle.entities ?? []) {
    if (hintIds.has(entity.id)) matches.push({ source_id: canonicalSourceId('entity', entity.id), repo_id: entity.id, reason: 'repo_entity' });
  }
  for (const textUnit of bundle.textUnits ?? []) {
    for (const repoId of sourceRepoIds(textUnit)) {
      if (hintIds.has(repoId)) matches.push({ source_id: canonicalSourceId('text', textUnit.id), repo_id: repoId, reason: textUnit.source_kind ?? 'repo_text' });
    }
  }
  return {
    score: Math.min(1.5, matches.length * 0.5),
    matches: matches.slice(0, 12),
  };
}

function latestTaskVolunteeredContext(taskId) {
  if (!taskId) return { canonical: [], sourceOrigins: {} };
  const row = db.prepare(`
    SELECT canonical_source_ids, source_origins
    FROM context_volunteers
    WHERE task_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(taskId);
  return {
    canonical: normalizeSourceIds(parseJson(row?.canonical_source_ids, [])).canonical,
    sourceOrigins: normalizeSourceOrigins(parseJson(row?.source_origins, {})),
  };
}

function addPinnedTaskContextOrigin(sourceOrigins, canonical, taskId, provided = []) {
  if (!taskId) return sourceOrigins;
  if (normalizeSourceIds(provided ?? []).canonical.length) return sourceOrigins;
  if (!canonical.length) return sourceOrigins;
  const latest = latestTaskVolunteeredContext(taskId);
  if (!latest.canonical.length) return sourceOrigins;
  for (const sourceId of canonical) addSourceOrigin(sourceOrigins, sourceId, 'pinned_task_context');
  return sourceOrigins;
}

function recordFeedbackMissing({
  taskId = '',
  queryId = '',
  agentId = '',
  queryText = '',
  volunteeredSourceIds = [],
  source = 'brain-context',
  metadata = {},
  idempotencyKey = null,
} = {}) {
  const provided = normalizeSourceIds(volunteeredSourceIds).canonical;
  const latest = latestTaskVolunteeredContext(taskId);
  const canonical = provided.length ? provided : latest.canonical;
  if (!canonical.length) return null;
  const sourceOrigins = normalizeSourceOrigins(
    mergeSourceOrigins(latest.sourceOrigins, metadata.source_origins ?? metadata.sourceOrigins ?? {}),
    canonical,
  );
  addPinnedTaskContextOrigin(sourceOrigins, canonical, taskId, provided);
  const event = insertIdempotentTimeline(db, {
    source,
    type: 'context:feedback-missing',
    subject: taskId || queryId || agentId || '',
    data: {
      ...metadata,
      task_id: taskId,
      query_id: queryId,
      agent_id: agentId,
      query_text: String(queryText ?? '').slice(0, 1000),
      canonical_source_ids: canonical,
      source_origins: sourceOrigins,
    },
    tags: ['brain', 'context', 'feedback-missing'],
    idempotencyKey,
  });
  return {
    id: event.id,
    deduplicated: event.deduplicated,
    canonical_source_ids: canonical,
    source_origins: sourceOrigins,
  };
}

function recordAliasMergeTimeline({ source = 'manual', entityId, mergedFrom, aliases = [], name = '' } = {}) {
  if (!entityId || !mergedFrom) return null;
  const existing = db.prepare(`
    SELECT id FROM timeline
    WHERE type='entity:alias-merged' AND subject=? AND data LIKE ?
    LIMIT 1
  `).get(entityId, `%"merged_from":"${String(mergedFrom).replace(/"/g, '\\"')}"%`);
  if (existing) return Number(existing.id);
  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run(source, 'entity:alias-merged', entityId, JSON.stringify({
      entity_id: entityId,
      merged_from: mergedFrom,
      aliases,
      name,
    }), JSON.stringify(['entity', 'alias', 'merge']));
  return Number(event.lastInsertRowid);
}

function resolveVolunteeredSourceIds(taskId, provided = []) {
  const normalized = normalizeSourceIds(provided ?? []).canonical;
  return normalized.length ? normalized : latestTaskVolunteeredContext(taskId).canonical;
}

function resolveVolunteeredContext(taskId, provided = [], providedOrigins = {}) {
  const normalized = normalizeSourceIds(provided ?? []).canonical;
  const latest = latestTaskVolunteeredContext(taskId);
  const canonical = normalized.length ? normalized : latest.canonical;
  const sourceOrigins = normalizeSourceOrigins(
    mergeSourceOrigins(latest.sourceOrigins, providedOrigins),
    canonical,
  );
  addPinnedTaskContextOrigin(sourceOrigins, canonical, taskId, normalized);
  return {
    canonical,
    sourceOrigins,
  };
}

function phaseAttribution({ acceptedSourceIds = [], volunteeredSourceIds = [], sourceOrigins = {} } = {}) {
  return buildPhaseAttribution({ normalizeSourceIds, acceptedSourceIds, volunteeredSourceIds, sourceOrigins });
}

function markTaskContextUsed(taskId, acceptedSourceIds = []) {
  if (!taskId) return;
  const accepted = normalizeSourceIds(acceptedSourceIds ?? []).canonical;
  if (!accepted.length) return;
  db.prepare(`
    UPDATE context_volunteers
    SET used_source_ids=?, used_at=unixepoch()
    WHERE id = (
      SELECT id FROM context_volunteers
      WHERE task_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
  `).run(JSON.stringify(accepted), taskId);
}

function maybeRecordSourcePrecisionThresholds(sourceIds = []) {
  const ids = normalizeSourceIds(sourceIds).canonical;
  if (!ids.length) return;
  const precision = sourcePrecisionStats({ days: 90 });
  const recentCutoff = Math.floor(Date.now() / 1000) - 86400;
  for (const id of ids) {
    const stat = precision.bySource.get(id);
    if (!stat || stat.volunteered < 3) continue;
    const thresholdType = stat.precision >= 0.6 ? 'context:source-useful' : stat.used === 0 ? 'context:source-noisy' : null;
    if (!thresholdType) continue;
    const existing = db.prepare(`
      SELECT id FROM timeline
      WHERE type=? AND subject=? AND created_at > ?
      LIMIT 1
    `).get(thresholdType, id, recentCutoff);
    if (existing) continue;
    db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
      .run('brain-context', thresholdType, id, JSON.stringify(stat), JSON.stringify(['brain', 'context', 'precision']));
  }
}

function collectRetrievalIds(payload = {}) {
  const data = payload.data ?? payload;
  const local = data.local ?? data;
  const entityIds = [
    ...(local.entities ?? []),
    ...(data.entities ?? []),
    ...(local.vectorSources ?? []).filter((s) => String(s.canonical_source_id ?? '').startsWith('entity:')).map((s) => String(s.canonical_source_id).slice('entity:'.length)),
  ].map((e) => typeof e === 'object' ? e.id : e).filter(Boolean);
  const textUnitIds = [
    ...(local.textUnits ?? []),
    ...(data.textUnits ?? []),
    ...(data.reports ?? []).flatMap((r) => r.source_text_unit_ids ?? []),
    ...(local.vectorSources ?? []).filter((s) => String(s.canonical_source_id ?? '').startsWith('text:')).map((s) => String(s.canonical_source_id).slice('text:'.length)),
  ].map((u) => typeof u === 'object' ? u.id : u).map(Number).filter(Number.isInteger);
  const factIds = [
    ...(local.facts ?? []),
    ...(data.facts ?? []),
    ...(data.reports ?? []).flatMap((r) => r.fact_ids ?? []),
    ...(local.vectorSources ?? []).filter((s) => String(s.canonical_source_id ?? '').startsWith('fact:')).map((s) => String(s.canonical_source_id).slice('fact:'.length)),
  ].map((f) => typeof f === 'object' ? f.id : f).map(Number).filter(Number.isInteger);
  return {
    entityIds: [...new Set(entityIds)],
    textUnitIds: [...new Set(textUnitIds)],
    factIds: [...new Set(factIds)],
  };
}

function retrievalSourceMetadata(payload = {}) {
  const ids = collectRetrievalIds(payload);
  const canonical = [
    ...ids.entityIds.map((id) => canonicalSourceId('entity', id)),
    ...ids.textUnitIds.map((id) => canonicalSourceId('text', id)),
    ...ids.factIds.map((id) => canonicalSourceId('fact', id)),
  ].filter(Boolean);
  return {
    raw: {
      entity_ids: ids.entityIds,
      text_unit_ids: ids.textUnitIds,
      fact_ids: ids.factIds,
    },
    canonical: [...new Set(canonical)],
  };
}

function insertEvalCapture({
  queryText,
  route,
  agentId = '',
  taskId = '',
  response = {},
  routeIds = [route],
  requiredSourceIds = [],
  requiredAcceptanceIds = [],
  usedIds = [],
  routeAckState = null,
  artifactHash = null,
  acceptedIds = [],
  volunteeredSourceIds = [],
  skillUsedIds = [],
  skillHelpfulness = null,
  contextPackageId = null,
  latencyMs = null,
  metadata = {},
}) {
  if (!queryText || !route) return null;
  const ids = collectRetrievalIds(response);
  const accepted = normalizeSourceIds(acceptedIds ?? []);
  const volunteeredContext = resolveVolunteeredContext(taskId, volunteeredSourceIds ?? [], metadata.source_origins ?? metadata.sourceOrigins ?? {});
  const volunteered = normalizeSourceIds(volunteeredContext.canonical);
  const expansionMetadata = latestPackageExpansionMetadata(contextPackageId);
  const phases = phaseAttribution({
    acceptedSourceIds: accepted.canonical,
    volunteeredSourceIds: volunteered.canonical,
    sourceOrigins: volunteeredContext.sourceOrigins,
  });
  const normalizedRouteIds = normalizeRouteIds(routeIds, [route]);
  const normalizedRequiredSourceIds = normalizeStringList(requiredSourceIds.length ? requiredSourceIds : accepted.canonical);
  const normalizedRequiredAcceptanceIds = normalizeStringList(requiredAcceptanceIds.length ? requiredAcceptanceIds : accepted.canonical);
  const normalizedUsedIds = normalizeStringList(usedIds.length ? usedIds : accepted.canonical);
  const resolvedRouteAckState = normalizeRouteAckState(
    routeAckState ?? metadata.route_ack_state ?? metadata.routeAckState ?? {},
    normalizedRouteIds,
    route,
  );
  const resolvedArtifactHash = artifactHash ?? stableEvalArtifactHash({
    query_text: queryText,
    route,
    route_ids: normalizedRouteIds,
    required_source_ids: normalizedRequiredSourceIds,
    required_acceptance_ids: normalizedRequiredAcceptanceIds,
    used_ids: normalizedUsedIds,
    accepted_ids: accepted.canonical,
    volunteered_source_ids: volunteered.canonical,
    returned_entity_ids: ids.entityIds,
    returned_text_unit_ids: ids.textUnitIds,
    returned_fact_ids: ids.factIds,
    task_id: taskId,
    agent_id: agentId,
  });
  const r = db.prepare(`
    INSERT INTO eval_queries
      (query_text, agent_id, task_id, route, returned_entity_ids, returned_text_unit_ids, returned_fact_ids, accepted_ids, volunteered_source_ids, route_ids, required_source_ids, required_acceptance_ids, used_ids, artifact_hash, route_ack_state, skill_used_ids, skill_helpfulness, context_package_id, latency_ms, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    queryText,
    agentId,
    taskId,
    route,
    JSON.stringify(ids.entityIds),
    JSON.stringify(ids.textUnitIds),
    JSON.stringify(ids.factIds),
    JSON.stringify(accepted.canonical),
    JSON.stringify(volunteered.canonical),
    JSON.stringify(normalizedRouteIds),
    JSON.stringify(normalizedRequiredSourceIds),
    JSON.stringify(normalizedRequiredAcceptanceIds),
    JSON.stringify(normalizedUsedIds),
    resolvedArtifactHash,
    JSON.stringify(resolvedRouteAckState),
    JSON.stringify(Array.isArray(skillUsedIds) ? [...new Set(skillUsedIds.map(String).filter(Boolean))] : []),
    typeof skillHelpfulness === 'number' ? skillHelpfulness : null,
    contextPackageId == null ? null : Number(contextPackageId),
    latencyMs,
    JSON.stringify({
      ...(metadata ?? {}),
      ...expansionMetadata,
      accepted_ids_raw: accepted.raw,
      volunteered_source_ids_raw: volunteered.raw,
      source_origins: volunteeredContext.sourceOrigins,
      phase_attribution: phases,
    }),
  );
  markTaskContextUsed(taskId, accepted.canonical);
  markMemoriesUsed({ volunteeredSourceIds: volunteered.canonical, acceptedSourceIds: accepted.canonical });
  if (normalizedUsedIds.length) {
    try {
      const issues = validateSourceIds(db, normalizedUsedIds).filter((r) => !r.valid);
      if (issues.length) {
        db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
          .run(
            'brain-eval',
            'citation:quality-check',
            taskId || agentId || route,
            JSON.stringify({ used_ids: normalizedUsedIds, invalid: issues, route, agent_id: agentId, task_id: taskId }),
            JSON.stringify(['brain', 'citation', 'quality']),
          );
      }
    } catch {}
  }
  markFactsUsed({ volunteeredSourceIds: volunteered.canonical, acceptedSourceIds: accepted.canonical });
  maybeRecordSourcePrecisionThresholds(volunteered.canonical);
  return Number(r.lastInsertRowid);
}

function responseWithOptionalEval(payload, body, mode, queryText, startedAt) {
  const response = ok(payload, { mode, sources: retrievalSourceMetadata(payload) });
  const taskId = body.task_id ?? body.taskId ?? '';
  if (taskId) {
    const routeIds = normalizeRouteIds([mode]);
    const acceptedIds = body.accepted_ids ?? body.acceptedIds ?? [];
    const requiredSourceIds = normalizeStringList(body.required_source_ids ?? body.requiredSourceIds ?? acceptedIds);
    const requiredAcceptanceIds = normalizeStringList(body.required_acceptance_ids ?? body.requiredAcceptanceIds ?? acceptedIds);
    const usedIds = normalizeStringList(body.used_ids ?? body.usedIds ?? acceptedIds);
    const routeAckState = normalizeRouteAckState(
      body.route_ack_state ?? body.routeAckState ?? {},
      routeIds,
      mode,
    );
    const id = insertEvalCapture({
      queryText,
      route: mode,
      agentId: body.agent_id ?? body.agentId ?? '',
      taskId,
      response,
      routeIds,
      requiredSourceIds,
      requiredAcceptanceIds,
      usedIds,
      routeAckState,
      artifactHash: body.artifact_hash ?? body.artifactHash ?? null,
      acceptedIds,
      latencyMs: Date.now() - startedAt,
      metadata: { automatic: true, source_origins: body.source_origins ?? body.sourceOrigins ?? body.metadata?.source_origins ?? body.metadata?.sourceOrigins ?? {} },
      volunteeredSourceIds: body.volunteered_source_ids ?? body.volunteeredSourceIds ?? body.brain_context?.cited?.canonical_source_ids ?? [],
      skillUsedIds: body.skill_used_ids ?? body.skillUsedIds ?? [],
      skillHelpfulness: typeof body.skill_helpfulness === 'number' ? body.skill_helpfulness : typeof body.skillHelpfulness === 'number' ? body.skillHelpfulness : null,
      contextPackageId: body.context_package_id ?? body.contextPackageId ?? null,
    });
    response.meta.eval_id = id;
  }
  return response;
}

function encodeFactsExportCursor(row = {}) {
  return Buffer.from(JSON.stringify({
    v: 1,
    last_observed_at: Number(row.observed_at ?? 0),
    last_id: Number(row.id ?? 0),
  })).toString('base64url');
}

function decodeFactsExportCursor(value) {
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const lastObservedAt = Number(payload?.last_observed_at);
    const lastId = Number(payload?.last_id);
    if (Number(payload?.v) !== 1 || !Number.isInteger(lastObservedAt) || !Number.isInteger(lastId)) return null;
    return { lastObservedAt, lastId };
  } catch {
    return null;
  }
}

function factExportBaseWhere({ status = 'active', entityId = '' } = {}) {
  const clauses = [];
  const params = [];
  if (entityId) {
    clauses.push('entity_id=?');
    params.push(entityId);
  }
  if (status !== 'all') {
    clauses.push('status=?');
    params.push(status);
  }
  return {
    clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function factStatusApiProjection(projection = {}) {
  const byStatus = {
    active: Number(projection.by_status?.active ?? projection.active ?? 0),
    superseded: Number(projection.by_status?.superseded ?? projection.superseded ?? 0),
    disputed: Number(projection.by_status?.disputed ?? projection.disputed ?? 0),
  };
  const other = Number(projection.other ?? 0);
  const orphanByStatus = {
    active: Number(projection.orphan_by_status?.active ?? 0),
    superseded: Number(projection.orphan_by_status?.superseded ?? 0),
    disputed: Number(projection.orphan_by_status?.disputed ?? 0),
  };
  const orphanOther = Number(projection.orphan_other ?? projection.orphan_by_status?.other ?? 0);
  const total = Number(projection.facts_total ?? projection.total
    ?? (byStatus.active + byStatus.superseded + byStatus.disputed + other));
  const servingActive = Number(projection.serving_active_facts
    ?? Math.max(0, byStatus.active - orphanByStatus.active));

  return {
    ...projection,
    schema: 'brain.fact-status-projection.v1',
    total,
    facts_total: total,
    active: byStatus.active,
    superseded: byStatus.superseded,
    disputed: byStatus.disputed,
    other,
    by_status: byStatus,
    by_status_complete: { ...byStatus, other },
    raw_active_facts: byStatus.active,
    serving_active_facts: servingActive,
    historical_facts: byStatus.superseded + byStatus.disputed,
    historical_by_status: {
      superseded: byStatus.superseded,
      disputed: byStatus.disputed,
    },
    other_status_facts: other,
    orphan_by_status: orphanByStatus,
    orphan_by_status_complete: { ...orphanByStatus, other: orphanOther },
    orphan_other: orphanOther,
    semantics: {
      raw_active_facts: "all rows whose lifecycle status is 'active', including active-status orphans; the health field 'facts' remains an alias for this count",
      serving_active_facts: "active rows whose entity_id resolves to an existing entity; these are eligible for entity fact serving",
      historical_facts: "superseded plus disputed rows; retained for history or review and excluded from entity fact serving",
      orphan_by_status_complete: "facts whose entity_id has no matching entity, split by lifecycle status; 'other' includes nonstandard statuses",
    },
  };
}

function currentFactStatusApiProjection(options = {}) {
  return factStatusApiProjection(factStatusProjection(options));
}

function factIntegrityApiProjection(integrity = {}) {
  const statusProjection = factStatusApiProjection(integrity.status_projection ?? {});
  return {
    ...integrity,
    orphan_by_status: statusProjection.orphan_by_status_complete,
    status_projection: statusProjection,
  };
}

function currentFactIntegrityApiProjection(options = {}) {
  return factIntegrityApiProjection(auditFactEntityIntegrity(options));
}

function factExportCursorWhere(cursor, direction = 'asc') {
  if (!cursor) return { clause: '', params: [] };
  const comparator = direction === 'desc' ? '<' : '>';
  return {
    clause: ` AND (observed_at ${comparator} ? OR (observed_at = ? AND id ${comparator} ?))`,
    params: [cursor.lastObservedAt, cursor.lastObservedAt, cursor.lastId],
  };
}

function factContradictionDetails(row) {
  if (!row) return null;
  let siblings = [];
  if (row.status === 'disputed') {
    siblings = db.prepare(`
      SELECT id, source, value
      FROM facts
      WHERE entity_id=? AND field=? AND id!=? AND status IN ('active','disputed') AND value!=?
      ORDER BY id ASC
    `).all(row.entity_id, row.field, row.id, row.value);
  } else if (row.status === 'active') {
    siblings = db.prepare(`
      SELECT id, source, value
      FROM facts
      WHERE entity_id=? AND field=? AND id!=? AND status='active' AND value!=?
      ORDER BY id ASC
    `).all(row.entity_id, row.field, row.id, row.value);
  }
  if (!siblings.length) return null;
  return {
    field: row.field,
    conflicting_fact_ids: [row.id, ...siblings.map((sibling) => sibling.id)],
    conflicting_sources: [...new Set([row.source, ...siblings.map((sibling) => sibling.source)])],
  };
}

function factDisputeDetails(row) {
  if (!row || row.status !== 'disputed') return { dispute: null, updated_at: null };
  const defaultReason = 'cross-source contradiction under review';
  const statusEvents = db.prepare(`
    SELECT id, data, created_at
    FROM timeline
    WHERE type='fact:status-updated' AND subject=?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(row.entity_id);
  for (const event of statusEvents) {
    const data = parseJson(event.data, {});
    if (Number(data.fact_id) !== Number(row.id) || data.to_status !== 'disputed') continue;
    return {
      dispute: {
        state: 'open',
        reason: String(data.reason ?? '').trim() || defaultReason,
        timeline_event_id: Number(event.id),
      },
      updated_at: Number(event.created_at ?? 0) || null,
    };
  }
  const approvalEvents = db.prepare(`
    SELECT id, data, created_at
    FROM timeline
    WHERE type='approval:applied' AND subject=?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(row.entity_id);
  for (const event of approvalEvents) {
    const data = parseJson(event.data, {});
    const losingFactIds = Array.isArray(data.losing_fact_ids) ? data.losing_fact_ids.map(Number) : [];
    if (data.kind !== 'fact.contradiction' || data.losing_status !== 'disputed' || !losingFactIds.includes(Number(row.id))) continue;
    return {
      dispute: {
        state: 'open',
        reason: String(data.reason ?? '').trim() || defaultReason,
        timeline_event_id: Number(event.id),
      },
      updated_at: Number(event.created_at ?? 0) || null,
    };
  }
  return {
    dispute: {
      state: 'open',
      reason: defaultReason,
      timeline_event_id: null,
    },
    updated_at: null,
  };
}

function firstNonBlankString(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function formatFactExportRow(row) {
  const context = parseJson(row.context, {});
  const contextOwner = context.owner && typeof context.owner === 'object' ? context.owner : {};
  const enforcementOwner = context.enforcement?.owner && typeof context.enforcement.owner === 'object' ? context.enforcement.owner : {};
  const owner = firstNonBlankString(
    context.owner,
    context.owner_id,
    context.ownerId,
    contextOwner.owner_agent_id,
    contextOwner.ownerAgentId,
    contextOwner.owner_team,
    contextOwner.ownerTeam,
    enforcementOwner.owner_agent_id,
    enforcementOwner.ownerAgentId,
    enforcementOwner.owner_team,
    enforcementOwner.ownerTeam,
    row.source,
  );
  const supersededBy = db.prepare(`
    SELECT id, observed_at
    FROM facts
    WHERE supersedes=?
    ORDER BY observed_at DESC, id DESC
    LIMIT 1
  `).get(row.id);
  const contradiction = factContradictionDetails(row);
  const disputeDetails = factDisputeDetails(row);
  const factReuse = row.fact_reuse_accounting ?? factReuseAccounting(row, null);
  return {
    id: Number(row.id),
    canonical_source_id: `fact:${row.id}`,
    entity_id: row.entity_id,
    field: row.field,
    value: parseJson(row.value, null),
    owner,
    source: row.source,
    confidence: Number(row.confidence ?? 0),
    status: row.status,
    observed_at: Number(row.observed_at ?? 0),
    created_at: Number(row.observed_at ?? 0),
    updated_at: maxNullable(row.observed_at, supersededBy?.observed_at, disputeDetails.updated_at),
    supersedes: numberOrNull(row.supersedes),
    superseded_by: supersededBy ? Number(supersededBy.id) : null,
    volunteered_count: numberOrNull(row.volunteered_count),
    used_count: numberOrNull(row.used_count),
    last_volunteered_at: numberOrNull(row.last_volunteered_at),
    last_used_at: numberOrNull(row.last_used_at),
    fact_reuse_accounting: factReuse,
    contradiction,
    dispute: disputeDetails.dispute,
  };
}

function buildFactReuseReport({ days = 7 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const limit = Math.min(Math.max(Number(process.env.BRAIN_FACT_REUSE_SAMPLE_LIMIT ?? 100) || 100, 1), 1000);
  const sampledRows = db.prepare(`
    SELECT *
    FROM facts
    WHERE status='active'
      AND (
        observed_at > ?
        OR COALESCE(last_used_at, 0) > ?
        OR COALESCE(last_volunteered_at, 0) > ?
      )
    ORDER BY COALESCE(last_used_at, last_volunteered_at, observed_at) DESC, observed_at DESC, id DESC
    LIMIT ?
  `).all(since, since, since, limit);
  const rows = decorateFactRowsWithReuseAccounting(sampledRows).map((row) => ({
    fact_id: Number(row.id),
    canonical_source_id: `fact:${row.id}`,
    entity_id: row.entity_id,
    field: row.field,
    status: row.status,
    metric_state: row.fact_reuse_accounting.metric_state,
    stats_source: row.fact_reuse_accounting.stats_source,
    instrumentation_needed: row.fact_reuse_accounting.instrumentation_needed,
    volunteered_count: row.fact_reuse_accounting.volunteered_count,
    used_count: row.fact_reuse_accounting.used_count,
    reuse_count: row.fact_reuse_accounting.reuse_count,
    last_used_at: row.fact_reuse_accounting.last_used_at,
    precision: row.fact_reuse_accounting.precision,
    retrieval_relevance: row.fact_reuse_accounting.retrieval_relevance,
    reused: row.fact_reuse_accounting.reused,
    fields_missing: row.fact_reuse_accounting.fields_missing,
  }));
  const knownRows = rows.filter((row) => row.metric_state === 'known');
  const relevanceRows = knownRows.filter((row) => typeof row.retrieval_relevance === 'number');
  const instrumentationAvailable = knownRows.length > 0;
  return {
    window_start: new Date(since * 1000).toISOString(),
    window_end: new Date().toISOString(),
    sample_count: rows.length,
    known_rows: knownRows.length,
    unknown_rows: rows.length - knownRows.length,
    average_retrieval_relevance: relevanceRows.length
      ? round3(relevanceRows.reduce((sum, row) => sum + row.retrieval_relevance, 0) / relevanceRows.length)
      : null,
    total_reuse_count: knownRows.reduce((sum, row) => sum + Number(row.reuse_count ?? 0), 0),
    reused_fact_ids: knownRows.filter((row) => row.reused).map((row) => row.fact_id),
    excluded_ids: [],
    metric: {
      gate_status: instrumentationAvailable ? 'scored' : 'not_scored',
      gate_failed: false,
      instrumentation_needed: !instrumentationAvailable,
      error: null,
    },
    rows,
  };
}

function buildMemoryAcceptedUseReport({ days = 7 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const limit = Math.min(Math.max(Number(process.env.BRAIN_MEMORY_ACCOUNTING_SAMPLE_LIMIT ?? 100) || 100, 1), 1000);
  const sampledRows = db.prepare(`
    SELECT *
    FROM agent_memories
    WHERE visibility='public'
      AND ${LIVE}
      AND status='active'
      AND (
        created_at > ?
        OR COALESCE(last_used_at, 0) > ?
        OR COALESCE(last_volunteered_at, 0) > ?
      )
    ORDER BY COALESCE(last_used_at, last_volunteered_at, created_at) DESC, created_at DESC
    LIMIT ?
  `).all(since, since, since, limit);
  const rows = decorateMemoryRowsWithAcceptedUseAccounting(sampledRows).map((row) => ({
    memory_id: row.id,
    source_id: `memory:${row.id}`,
    agent_id: row.agent_id,
    mem_key: row.mem_key,
    accounting_state: row.accepted_use_accounting.accounting_state,
    stats_source: row.accepted_use_accounting.stats_source,
    instrumentation_needed: row.accepted_use_accounting.instrumentation_needed,
    accepted_count: row.accepted_use_accounting.accepted_count,
    used_count: row.accepted_use_accounting.used_count,
    volunteered_count: row.accepted_use_accounting.volunteered_count,
    ignored_count: row.accepted_use_accounting.ignored_count,
    last_used_at: row.accepted_use_accounting.last_used_at,
    retrieval_relevance: row.accepted_use_accounting.retrieval_relevance,
    reuse_count: row.accepted_use_accounting.reuse_count,
    reused: row.accepted_use_accounting.reused,
    fields_missing: row.accepted_use_accounting.fields_missing,
  }));
  const knownRows = rows.filter((row) => row.accounting_state === 'known');
  const relevanceRows = knownRows.filter((row) => typeof row.retrieval_relevance === 'number');
  return {
    window_start: new Date(since * 1000).toISOString(),
    window_end: new Date().toISOString(),
    sample_count: rows.length,
    known_rows: knownRows.length,
    unknown_rows: rows.length - knownRows.length,
    average_retrieval_relevance: relevanceRows.length
      ? round3(relevanceRows.reduce((sum, row) => sum + row.retrieval_relevance, 0) / relevanceRows.length)
      : null,
    total_reuse_count: knownRows.reduce((sum, row) => sum + Number(row.reuse_count ?? 0), 0),
    reused_memory_ids: knownRows.filter((row) => row.reused).map((row) => row.memory_id),
    rows,
  };
}

function buildLearningReport({ days = 7 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = Math.floor(Date.now() / 1000) - safeDays * 86400;
  const timelineRows = db.prepare(`
    SELECT type, data, tags, created_at FROM timeline
    WHERE created_at > ?
    ORDER BY created_at DESC
  `).all(since).map(r => ({ ...r, data: parseJson(r.data, {}), tags: parseJson(r.tags, []) }));
  const countType = (type) => timelineRows.filter(r => r.type === type).length;
  const feedbackMissingRows = timelineRows.filter(r => r.type === 'context:feedback-missing');
  const approvals = db.prepare(`
    SELECT kind, status, created_at FROM approvals
    WHERE created_at > ?
  `).all(since);
  const replayRows = db.prepare(`
    SELECT * FROM eval_queries
    WHERE created_at > ?
    ORDER BY created_at DESC
    LIMIT 500
  `).all(since).map((r) => ({
    ...r,
    returned_entity_ids: parseJson(r.returned_entity_ids, []),
    returned_text_unit_ids: parseJson(r.returned_text_unit_ids, []),
    returned_fact_ids: parseJson(r.returned_fact_ids, []),
    accepted_ids: parseJson(r.accepted_ids, []),
    volunteered_source_ids: parseJson(r.volunteered_source_ids, []),
    metadata: parseJson(r.metadata, {}),
  }));
  const manualReplayLimit = 200;
  const manualReplayRows = db.prepare(`
    SELECT * FROM eval_queries
    ORDER BY created_at DESC
    LIMIT ?
  `).all(manualReplayLimit);
  const manualReplayLatestCreatedAt = manualReplayRows.reduce((max, row) => Math.max(max, Number(row.created_at ?? 0)), 0);
  const manualReplay = {
    route: null,
    limit: manualReplayLimit,
    compareVectors: true,
    sampleCount: manualReplayRows.length,
    latestCreatedAt: manualReplayLatestCreatedAt || null,
    stamp: evalReplaySnapshotStamp(manualReplayRows, { route: null, limit: manualReplayLimit, compareVectors: true }),
  };
  const memoryAcceptedUse = buildMemoryAcceptedUseReport({ days: safeDays });
  const factReuse = buildFactReuseReport({ days: safeDays });
  let accepted = 0;
  let acceptedReturned = 0;
  let volunteered = 0;
  let volunteeredUsed = 0;
  let volunteeredSamples = 0;
  let sourceCoverage = 0;
  let packageSamples = 0;
  let expansionSamples = 0;
  let expandedSources = 0;
  let acceptedExpandedSources = 0;
  for (const sample of replayRows) {
    const returned = new Set([
      ...parseJson(sample.returned_entity_ids, []).map((id) => canonicalSourceId('entity', id)),
      ...sample.returned_text_unit_ids.map((id) => canonicalSourceId('text', id)),
      ...sample.returned_fact_ids.map((id) => canonicalSourceId('fact', id)),
    ]);
    const normalized = normalizeSourceIds(sample.accepted_ids).canonical;
    const volunteeredIds = normalizeSourceIds(sample.volunteered_source_ids).canonical;
    const expandedIds = normalizeSourceIds(sample.metadata?.expanded_source_ids ?? sample.metadata?.expandedSourceIds ?? []).canonical;
    accepted += normalized.length;
    acceptedReturned += normalized.filter((id) => returned.has(id)).length;
    volunteered += volunteeredIds.length;
    volunteeredUsed += volunteeredIds.filter((id) => normalized.includes(id)).length;
    if (volunteeredIds.length) volunteeredSamples++;
    if (sample.context_package_id != null) packageSamples++;
    if ((sample.metadata?.expansion_ids ?? sample.metadata?.expansionIds ?? []).length || expandedIds.length) {
      expansionSamples++;
      expandedSources += expandedIds.length;
      acceptedExpandedSources += expandedIds.filter((id) => normalized.includes(id)).length;
    }
    if (sample.returned_text_unit_ids.length || sample.returned_fact_ids.length) sourceCoverage++;
  }
  const skillReport = buildSkillProposalReport(db, { limit: 1000, parseJson });
  const correctionMining = mineCorrectionPatterns(db, {
    days: safeDays,
    limit: Number(process.env.BRAIN_CORRECTION_MINE_LIMIT ?? 1000),
    threshold: Number(process.env.BRAIN_CORRECTION_MINE_THRESHOLD ?? 2),
    thresholds: process.env.BRAIN_CORRECTION_MINE_THRESHOLDS ? parseJson(process.env.BRAIN_CORRECTION_MINE_THRESHOLDS, {}) : {},
    cooldownDays: Number(process.env.BRAIN_CORRECTION_MINE_COOLDOWN_DAYS ?? 7),
    create: false,
    source: 'learning-report',
  });
  const correctionTasks = db.prepare(`
    SELECT * FROM learning_tasks
    WHERE kind='correction.pattern' AND created_at > ?
    ORDER BY priority DESC, created_at DESC
    LIMIT 50
  `).all(since).map(row => parseLearningTask(row, parseJson));
  const citationRepairTasks = db.prepare(`
    SELECT * FROM learning_tasks
    WHERE kind IN ('citation.repair','source.mark_stale','source.refresh','proposal.reject') AND created_at > ?
    ORDER BY priority DESC, created_at DESC
    LIMIT 50
  `).all(since).map(row => parseLearningTask(row, parseJson));
  const pendingInstructionApprovals = db.prepare(`
    SELECT * FROM approvals
    WHERE kind LIKE 'team.instruction.%' AND status='pending'
    ORDER BY created_at DESC
    LIMIT 50
  `).all().map(row => ({ ...row, payload: parseJson(row.payload, {}), resolution: parseJson(row.resolution, {}) }));
  const precision = sourcePrecisionStats({ days: safeDays });
  const sourceRows = [...precision.bySource.values()].sort((a, b) => b.score - a.score);
  const instructionFeedbackRows = timelineRows.filter(r => r.type === 'instruction:feedback');
  const persistedInstructionScopeRows = persistedInstructionScopePrecision({ limit: 100 });
  const instructionScopeRows = persistedInstructionScopeRows.length
    ? persistedInstructionScopeRows
    : instructionScopePrecision({ rows: instructionFeedbackRows, limit: 100 });
  const instructionScopeStatsSource = persistedInstructionScopeRows.length ? 'persisted' : 'timeline';
  const retireCandidates = memoryRetireCandidates({ limit: 25 });
  const instructionCandidates = instructionLifecycleCandidates({ scopePrecision: instructionScopeRows, limit: 25 });
  const fixtureCandidates = evalFixturePromotionCandidates({ limit: 25 });
  const fixtureLifecycle = evalFixtureLifecycle({ limit: 25 });
  const latestSnapshotDay = db.prepare(`SELECT day FROM source_precision_snapshots ORDER BY day DESC LIMIT 1`).get()?.day ?? null;
  const latestSnapshot = latestSnapshotDay
    ? db.prepare(`SELECT * FROM source_precision_snapshots WHERE day=? ORDER BY score DESC LIMIT 25`).all(latestSnapshotDay)
    : [];
  const previousSnapshotDay = latestSnapshotDay
    ? db.prepare(`
      SELECT day FROM source_precision_snapshots
      WHERE day < ?
      ORDER BY day DESC
      LIMIT 1
    `).get(latestSnapshotDay)?.day ?? null
    : null;
  const previousSnapshot = previousSnapshotDay
    ? db.prepare(`SELECT * FROM source_precision_snapshots WHERE day=? ORDER BY score DESC LIMIT 25`).all(previousSnapshotDay)
    : [];
  const previousSnapshotById = new Map(previousSnapshot.map(row => [row.canonical_source_id, row]));
  const snapshotDiff = {
    previousSnapshotDay,
    added: [],
    removed: [],
    changed: [],
  };
  for (const row of latestSnapshot) {
    const prev = previousSnapshotById.get(row.canonical_source_id);
    if (!prev) {
      snapshotDiff.added.push({
        canonical_source_id: row.canonical_source_id,
        source_kind: row.source_kind,
        threshold_state: row.threshold_state,
        precision: row.precision,
        weighted_precision: row.weighted_precision,
        volunteered: row.volunteered,
        used: row.used,
        score: row.score,
      });
      continue;
    }
    if (
      prev.threshold_state !== row.threshold_state ||
      prev.precision !== row.precision ||
      prev.weighted_precision !== row.weighted_precision ||
      prev.volunteered !== row.volunteered ||
      prev.used !== row.used
    ) {
      snapshotDiff.changed.push({
        canonical_source_id: row.canonical_source_id,
        source_kind: row.source_kind,
        previous_threshold_state: prev.threshold_state,
        threshold_state: row.threshold_state,
        previous_precision: prev.precision,
        precision: row.precision,
        previous_weighted_precision: prev.weighted_precision,
        weighted_precision: row.weighted_precision,
        previous_volunteered: prev.volunteered,
        volunteered: row.volunteered,
        previous_used: prev.used,
        used: row.used,
        score_delta: Math.round(((row.score ?? 0) - (prev.score ?? 0)) * 1000) / 1000,
      });
    }
  }
  for (const prev of previousSnapshot) {
    if (!latestSnapshot.some(row => row.canonical_source_id === prev.canonical_source_id)) {
      snapshotDiff.removed.push({
        canonical_source_id: prev.canonical_source_id,
        source_kind: prev.source_kind,
        threshold_state: prev.threshold_state,
        precision: prev.precision,
        weighted_precision: prev.weighted_precision,
        volunteered: prev.volunteered,
        used: prev.used,
        score: prev.score,
      });
    }
  }
  const instructionScopeSnapshots = latestInstructionScopeSnapshots({ limit: 50 });
  const phaseImprovementSummary = summarizePhaseImprovementOutcomes(db, { days: safeDays, limit: 50 });
  const trajectoryReflection = trajectoryReflectionSummary(db, { limit: 25 });
  const originReplay = db.prepare(`
    SELECT metadata, accepted_ids, volunteered_source_ids FROM eval_queries
    WHERE created_at > ? AND volunteered_source_ids != '[]'
    ORDER BY created_at DESC LIMIT 500
  `).all(since);
  const originBuckets = Object.fromEntries(CANONICAL_SOURCE_ORIGINS.map(origin => [origin, { origin, volunteered: 0, used: 0 }]));
  const phaseBuckets = {};
  for (const row of originReplay) {
    const metadata = parseJson(row.metadata, {});
    const origins = normalizeSourceOrigins(
      metadata.source_origins && typeof metadata.source_origins === 'object' ? metadata.source_origins : {},
      normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical.concat(normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical),
    );
    const acceptedSet = new Set(normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical);
    for (const id of normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical) {
      const labels = Array.isArray(origins[id]) && origins[id].length ? origins[id] : ['unknown'];
      for (const label of labels) {
        const bucket = originBuckets[label] ??= { origin: label, volunteered: 0, used: 0 };
        bucket.volunteered++;
        if (acceptedSet.has(id)) bucket.used++;
      }
    }
    for (const phaseRow of Array.isArray(metadata.phase_attribution) ? metadata.phase_attribution : []) {
      const phase = phaseRow.phase ?? 'unknown';
      const bucket = phaseBuckets[phase] ??= { phase, samples: 0, volunteered: 0, used: 0, ignored: 0 };
      bucket.samples++;
      bucket.volunteered += Number(phaseRow.volunteered ?? 0);
      bucket.used += Number(phaseRow.accepted ?? phaseRow.used ?? 0);
      bucket.ignored += Number(phaseRow.ignored ?? 0);
    }
  }
  const originPrecision = Object.values(originBuckets).map(row => ({
    ...row,
    precision: row.volunteered ? Math.round((row.used / row.volunteered) * 1000) / 1000 : null,
  })).sort((a, b) => b.volunteered - a.volunteered);
  const phasePrecision = Object.values(phaseBuckets).map(row => ({
    ...row,
    precision: row.volunteered ? Math.round((row.used / row.volunteered) * 1000) / 1000 : null,
  })).sort((a, b) => b.volunteered - a.volunteered || a.phase.localeCompare(b.phase));
  const agentBuckets = {};
  const agentBucket = (agentId) => {
    const id = String(agentId || 'unknown');
    return agentBuckets[id] ??= {
      agent_id: id,
      eval_samples: 0,
      volunteered_samples: 0,
      feedback_supplied: 0,
      feedback_missing: 0,
      accepted_sources: 0,
      volunteered_sources: 0,
      volunteered_used: 0,
      learned_artifacts: 0,
      uncited_artifacts: 0,
    };
  };
  for (const sample of replayRows) {
    const bucket = agentBucket(sample.agent_id);
    const acceptedIds = normalizeSourceIds(sample.accepted_ids).canonical;
    const volunteeredIds = normalizeSourceIds(parseJson(sample.volunteered_source_ids, [])).canonical;
    bucket.eval_samples++;
    bucket.accepted_sources += acceptedIds.length;
    bucket.volunteered_sources += volunteeredIds.length;
    if (volunteeredIds.length) bucket.volunteered_samples++;
    if (acceptedIds.length) bucket.feedback_supplied++;
    bucket.volunteered_used += volunteeredIds.filter((id) => acceptedIds.includes(id)).length;
  }
  for (const row of feedbackMissingRows) {
    agentBucket(row.data?.agent_id ?? row.data?.agentId).feedback_missing++;
  }
  for (const row of timelineRows) {
    if (!Array.isArray(row.tags) || !row.tags.includes('learned-artifact')) continue;
    const agent = agentBucket(row.data?.agent_id ?? row.data?.agentId);
    // Citation-warning rows are also tagged learned-artifact; count them as the
    // uncited side rather than as additional learned artifacts.
    if (row.type === 'learned-artifact:citation-warning') {
      if (String(row.data?.issue ?? '').startsWith('missing_citation')) agent.uncited_artifacts++;
      continue;
    }
    agent.learned_artifacts++;
  }
	  const agents = Object.values(agentBuckets).map((row) => ({
    ...row,
    feedback_missing_rate: (row.feedback_missing + row.feedback_supplied)
      ? Math.round((row.feedback_missing / (row.feedback_missing + row.feedback_supplied)) * 1000) / 1000
      : null,
    volunteered_precision: row.volunteered_sources
      ? Math.round((row.volunteered_used / row.volunteered_sources) * 1000) / 1000
      : null,
    citation_feedback_rate: row.volunteered_samples
      ? Math.round((row.feedback_supplied / row.volunteered_samples) * 1000) / 1000
      : null,
    // cited learned artifacts ÷ total learned artifacts (cited + uncited),
    // where "uncited" are the agent's missing_citation warnings.
    citation_coverage: (row.learned_artifacts + row.uncited_artifacts)
      ? Math.round((row.learned_artifacts / (row.learned_artifacts + row.uncited_artifacts)) * 1000) / 1000
      : null,
	  })).sort((a, b) => (b.feedback_missing + b.eval_samples + b.learned_artifacts) - (a.feedback_missing + a.eval_samples + a.learned_artifacts));
	  const learningTaskQueue = buildLearningTaskQueueSummary({ db, parseJson, parseLearningTask, since });
	  const vectorCapability = sqliteVecStatus();
	  return {
    windowDays: safeDays,
    since,
    promotedMemories: countType('brain:memory-promoted'),
    repeatedContradictions: approvals.filter(a => a.kind === 'fact.contradiction').length,
    approvals: {
      opened: approvals.length,
      pending: approvals.filter(a => a.status === 'pending').length,
      approved: approvals.filter(a => a.status === 'approved').length,
      rejected: approvals.filter(a => a.status === 'rejected').length,
      resolved: approvals.filter(a => a.status === 'resolved').length,
    },
	    eval: {
	      samples: replayRows.length,
	      manualReplay,
	      acceptedSources: accepted,
      volunteeredSources: volunteered,
      sourceCoverage: replayRows.length ? Math.round((sourceCoverage / replayRows.length) * 1000) / 1000 : null,
      acceptanceRecall: accepted ? Math.round((acceptedReturned / accepted) * 1000) / 1000 : null,
      volunteeredPrecision: volunteered ? Math.round((volunteeredUsed / volunteered) * 1000) / 1000 : null,
      volunteeredSampleRate: replayRows.length ? Math.round((volunteeredSamples / replayRows.length) * 1000) / 1000 : null,
      feedbackMissing: feedbackMissingRows.length,
      feedbackMissingRate: (feedbackMissingRows.length + volunteeredSamples)
        ? Math.round((feedbackMissingRows.length / (feedbackMissingRows.length + volunteeredSamples)) * 1000) / 1000
        : null,
      contextPackageSamples: packageSamples,
      packageExpansionSamples: expansionSamples,
      packageExpansionRate: packageSamples ? Math.round((expansionSamples / packageSamples) * 1000) / 1000 : null,
      expandedSources,
      acceptedExpandedSources,
      expandedSourceAcceptanceRate: expandedSources ? Math.round((acceptedExpandedSources / expandedSources) * 1000) / 1000 : null,
    },
    memoryAcceptedUse,
    factReuse,
    contextPrecision: {
      sources: sourceRows.slice(0, 25),
      useful: sourceRows.filter(s => s.volunteered >= 3 && s.precision >= 0.6).slice(0, 10),
      noisy: sourceRows.filter(s => s.volunteered >= 3 && s.used === 0).sort((a, b) => b.volunteered - a.volunteered).slice(0, 10),
      entities: [...precision.byEntity.values()].sort((a, b) => b.score - a.score).slice(0, 25),
      origins: originPrecision,
      phases: phasePrecision,
      usefulPhases: phasePrecision.filter(phase => phase.volunteered >= 3 && phase.precision >= 0.6).slice(0, 10),
      weakPhases: phasePrecision.filter(phase => phase.volunteered >= 3 && (phase.precision ?? 0) <= 0.2).slice(0, 10),
      latestSnapshotDay,
      latestSnapshot,
      previousSnapshotDay,
      snapshotDiff,
    },
    memoryRetirement: {
      candidates: retireCandidates,
      count: retireCandidates.length,
    },
    vectorRollout: compareVectorReplay(replayRows),
    correctionMining: {
      candidates: correctionMining.candidates.slice(0, 25),
      candidateCount: correctionMining.candidates.length,
      createdTasks: correctionTasks,
      createdTaskCount: correctionTasks.length,
      pendingInstructionApprovals,
      pendingInstructionApprovalCount: pendingInstructionApprovals.length,
    },
    instructionFeedback: {
      events: instructionFeedbackRows.length,
      statsSource: instructionScopeStatsSource,
      scopes: instructionScopeRows.slice(0, 50),
      usefulScopes: instructionScopeRows.filter(scope => scope.feedback_count >= 2 && scope.precision >= 0.6).slice(0, 10),
      noisyScopes: instructionScopeRows.filter(scope => scope.feedback_count >= 2 && scope.used_count === 0).slice(0, 10),
      scopeSnapshots: instructionScopeSnapshots,
      candidates: instructionCandidates,
      candidateCount: instructionCandidates.length,
      harmfulCandidates: instructionCandidates.filter(candidate => candidate.harmful_count > 0).length,
      ignoredCandidates: instructionCandidates.filter(candidate => candidate.harmful_count === 0 && candidate.ignored_count >= 3).length,
    },
    fixturePromotion: {
      candidates: fixtureCandidates,
      candidateCount: fixtureCandidates.length,
    },
    fixtureLifecycle,
    citationRepair: {
      ...skillReport.citationRepair,
      createdTasks: citationRepairTasks,
      createdTaskCount: citationRepairTasks.length,
    },
    phaseImprovements: phaseImprovementSummary,
    trajectoryReflection,
    nextRecommendations: buildNextRecommendations({
      report: {
        contextPrecision: {
          weakPhases: phasePrecision.filter(phase => phase.volunteered >= 3 && (phase.precision ?? 0) <= 0.2).slice(0, 10),
        },
      },
      phaseImprovementSummary,
      trajectoryReflection,
    }),
	    learningTaskQueue,
	    vectorCapability,
	    agents,
    skills: skillReport.totals,
    signal: {
      useful: countType('brain:memory-promoted') + skillReport.totals.published + approvals.filter(a => ['approved', 'resolved'].includes(a.status)).length,
      noisy: skillReport.totals.held + skillReport.totals.rejected + approvals.filter(a => a.status === 'rejected').length,
    },
  };
}

function buildLearningMetrics({ days = 7 } = {}) {
  const report = buildLearningReport({ days });
  const routeInventory = routeInventoryReport();
  const pendingRows = db.prepare(`
    SELECT kind, created_at FROM approvals
    WHERE status='pending'
    ORDER BY created_at ASC
  `).all();
  const now = Math.floor(Date.now() / 1000);
  const oldestPendingAgeSeconds = pendingRows.length ? now - Number(pendingRows[0].created_at ?? now) : 0;
  const noisySourceCount = report.contextPrecision.noisy.length;
  const weakPhaseCount = report.contextPrecision.weakPhases.length;
  const harmfulInstructionCount = report.instructionFeedback.harmfulCandidates;
  const staleFixtureCount = report.fixtureLifecycle.counts.stale;
  const failedFixtureCount = report.fixtureLifecycle.counts.failed;
  const invalidCitationHoldCount = report.citationRepair.candidateCount;
  const phaseImprovementRegressionCount = report.phaseImprovements?.counts?.regressed ?? 0;
  const trajectoryReflectionPending = report.trajectoryReflection?.pendingCompaction ?? 0;
  const memoryAcceptedUseUnknown = report.memoryAcceptedUse?.unknown_rows ?? 0;
  const factReuseUnknown = report.factReuse?.unknown_rows ?? 0;
	  const staleLearningTaskCount = (report.learningTaskQueue.staleQueued ?? 0) + (report.learningTaskQueue.staleAssigned ?? 0);
	  const vectorDegraded = Boolean(report.vectorCapability?.degraded);
	  const thresholds = {
    routeSkew: routeInventory.skew,
    feedbackMissingRateWarn: Number(process.env.BRAIN_METRICS_FEEDBACK_MISSING_WARN ?? 0.35),
    citationFeedbackRateWarn: Number(process.env.BRAIN_METRICS_CITATION_FEEDBACK_WARN ?? 0.5),
    invalidCitationHoldsWarn: Number(process.env.BRAIN_METRICS_INVALID_CITATION_HOLDS_WARN ?? 3),
    noisySourceWarn: Number(process.env.BRAIN_METRICS_NOISY_SOURCE_WARN ?? 5),
    weakPhaseWarn: Number(process.env.BRAIN_METRICS_WEAK_PHASE_WARN ?? 1),
    pendingApprovalAgeWarnSeconds: Number(process.env.BRAIN_METRICS_PENDING_APPROVAL_AGE_WARN_SECONDS ?? 86400),
  };
  const agentWarnings = report.agents
    .filter(agent =>
      (agent.feedback_missing_rate ?? 0) > thresholds.feedbackMissingRateWarn
      || (agent.citation_feedback_rate != null && agent.citation_feedback_rate < thresholds.citationFeedbackRateWarn)
    )
    .map(agent => ({
      agent_id: agent.agent_id,
      feedback_missing_rate: agent.feedback_missing_rate,
      citation_feedback_rate: agent.citation_feedback_rate,
      volunteered_precision: agent.volunteered_precision,
    }));
	  const warnings = [
	    ...(routeInventory.skew ? [{ kind: 'route_skew', missing: routeInventory.missing }] : []),
	    ...(vectorDegraded ? [{ kind: 'vector_capability_degraded', ...report.vectorCapability.degradation, capability: report.vectorCapability }] : []),
	    ...(noisySourceCount >= thresholds.noisySourceWarn ? [{ kind: 'noisy_sources', count: noisySourceCount }] : []),
    ...(weakPhaseCount >= thresholds.weakPhaseWarn ? [{ kind: 'weak_retrieval_phases', count: weakPhaseCount, phases: report.contextPrecision.weakPhases }] : []),
    ...(harmfulInstructionCount > 0 ? [{ kind: 'harmful_instruction_feedback', count: harmfulInstructionCount }] : []),
    ...(staleFixtureCount > 0 ? [{ kind: 'stale_eval_fixtures', count: staleFixtureCount }] : []),
    ...(failedFixtureCount > 0 ? [{ kind: 'failing_eval_fixtures', count: failedFixtureCount }] : []),
    ...(invalidCitationHoldCount >= thresholds.invalidCitationHoldsWarn ? [{ kind: 'invalid_citation_holds', count: invalidCitationHoldCount, issueClasses: report.citationRepair.issueClasses }] : []),
    ...(phaseImprovementRegressionCount > 0 ? [{ kind: 'phase_improvement_regressions', count: phaseImprovementRegressionCount, phases: report.phaseImprovements?.byPhase ?? [] }] : []),
    ...(trajectoryReflectionPending > 0 ? [{ kind: 'trajectory_reflection_pending', count: trajectoryReflectionPending, heuristics: report.trajectoryReflection?.heuristicMemories ?? 0, rawMemories: report.trajectoryReflection?.rawMemories ?? 0 }] : []),
    ...(staleLearningTaskCount > 0 ? [{ kind: 'stale_learning_tasks', queued: report.learningTaskQueue.staleQueued, assigned: report.learningTaskQueue.staleAssigned }] : []),
    ...(oldestPendingAgeSeconds >= thresholds.pendingApprovalAgeWarnSeconds ? [{ kind: 'pending_approval_age', oldestPendingAgeSeconds }] : []),
    ...agentWarnings.map(agent => ({ kind: 'agent_learning_discipline', ...agent })),
  ];
  return {
    generatedAt: new Date().toISOString(),
    windowDays: report.windowDays,
    status: warnings.length ? 'warn' : 'ok',
    routeSkew: {
      present: true,
      skew: routeInventory.skew,
      missing: routeInventory.missing,
      routeCount: routeInventory.count,
    },
    counters: {
      evalSamples: report.eval.samples,
      acceptedSources: report.eval.acceptedSources,
      volunteeredSources: report.eval.volunteeredSources,
      volunteeredSamples: Math.round((report.eval.volunteeredSampleRate ?? 0) * report.eval.samples),
      feedbackMissing: report.eval.feedbackMissing,
      approvalsPending: report.approvals.pending,
      approvalsOpened: report.approvals.opened,
      rollbacks: db.prepare(`SELECT COUNT(*) AS c FROM learning_rollback_records WHERE created_at > ?`).get(report.since).c,
      memoryRetirementCandidates: report.memoryRetirement.count,
      correctionMiningCandidates: report.correctionMining.candidateCount,
      correctionLearningTasks: report.correctionMining.createdTaskCount,
      learningTasksOpen: report.learningTaskQueue.open,
      learningTasksQueued: report.learningTaskQueue.byStatus.queued ?? 0,
      learningTasksAssigned: report.learningTaskQueue.byStatus.assigned ?? 0,
      learningTasksInProgress: report.learningTaskQueue.byStatus.in_progress ?? 0,
      learningTasksBlocked: report.learningTaskQueue.byStatus.blocked ?? 0,
      learningTasksCompletedRecent: report.learningTaskQueue.recentCompleted,
      learningTasksStaleQueued: report.learningTaskQueue.staleQueued,
      learningTasksStaleAssigned: report.learningTaskQueue.staleAssigned,
      learningTaskEscalationsPending: report.learningTaskQueue.pendingEscalations,
      learningTaskRetries: report.learningTaskQueue.retryCount,
      pendingInstructionApprovals: report.correctionMining.pendingInstructionApprovalCount,
      instructionFeedbackEvents: report.instructionFeedback.events,
      instructionPrecisionScopes: report.instructionFeedback.scopes.length,
      noisyInstructionScopes: report.instructionFeedback.noisyScopes.length,
      usefulInstructionScopes: report.instructionFeedback.usefulScopes.length,
      instructionScopeSnapshotRows: report.instructionFeedback.scopeSnapshots.rows.length,
      degradingInstructionScopes: report.instructionFeedback.scopeSnapshots.degrading.length,
      improvingInstructionScopes: report.instructionFeedback.scopeSnapshots.improving.length,
      harmfulInstructionScopeSnapshots: report.instructionFeedback.scopeSnapshots.counts.harmful ?? 0,
      instructionLifecycleCandidates: report.instructionFeedback.candidateCount,
      harmfulInstructionCandidates: report.instructionFeedback.harmfulCandidates,
      fixturePromotionCandidates: report.fixturePromotion.candidateCount,
      activeEvalFixtures: report.fixtureLifecycle.counts.active,
      staleEvalFixtures: report.fixtureLifecycle.counts.stale,
      retiredEvalFixtures: report.fixtureLifecycle.counts.retired,
      failingEvalFixtures: report.fixtureLifecycle.counts.failed,
      citationRepairCandidates: report.citationRepair.candidateCount,
      citationRepairTasks: report.citationRepair.createdTaskCount,
      phaseImprovementOutcomes: report.phaseImprovements?.counts?.total ?? 0,
      phaseImprovementRegressions: report.phaseImprovements?.counts?.regressed ?? 0,
      trajectoryHeuristics: report.trajectoryReflection?.heuristicMemories ?? 0,
      trajectoryReflectionPending: report.trajectoryReflection?.pendingCompaction ?? 0,
      proposalRetryReady: report.skills.retryReady ?? 0,
      proposalRetryBlocked: report.skills.retryBlocked ?? 0,
      proposalRetryConsumed: report.skills.retryConsumed ?? 0,
      contextPackageSamples: report.eval.contextPackageSamples,
      packageExpansionSamples: report.eval.packageExpansionSamples,
      acceptedExpandedSources: report.eval.acceptedExpandedSources,
      memoryAcceptedUseSamples: report.memoryAcceptedUse?.sample_count ?? 0,
      memoryAcceptedUseKnown: report.memoryAcceptedUse?.known_rows ?? 0,
      memoryAcceptedUseUnknown,
      memoryReuseCount: report.memoryAcceptedUse?.total_reuse_count ?? 0,
      reusedMemories: report.memoryAcceptedUse?.reused_memory_ids?.length ?? 0,
      factReuseSamples: report.factReuse?.sample_count ?? 0,
      factReuseKnown: report.factReuse?.known_rows ?? 0,
      factReuseUnknown,
      factReuseCount: report.factReuse?.total_reuse_count ?? 0,
      reusedFacts: report.factReuse?.reused_fact_ids?.length ?? 0,
      noisySources: noisySourceCount,
      usefulSources: report.contextPrecision.useful.length,
      retrievalPhases: report.contextPrecision.phases.length,
      usefulRetrievalPhases: report.contextPrecision.usefulPhases.length,
	      weakRetrievalPhases: weakPhaseCount,
	      phaseImprovementOutcomes: report.phaseImprovements?.counts?.total ?? 0,
	      trajectoryHeuristics: report.trajectoryReflection?.heuristicMemories ?? 0,
	      vectorCapabilityDegraded: vectorDegraded ? 1 : 0,
	      vectorEmbeddingRows: report.vectorCapability?.embeddingRows ?? 0,
	      vectorNativeRows: report.vectorCapability?.nativeVectorRows ?? 0,
	      learnedArtifacts: report.agents.reduce((sum, agent) => sum + agent.learned_artifacts, 0),
	    },
    rates: {
      acceptanceRecall: report.eval.acceptanceRecall,
      volunteeredPrecision: report.eval.volunteeredPrecision,
      volunteeredSampleRate: report.eval.volunteeredSampleRate,
      feedbackMissingRate: report.eval.feedbackMissingRate,
      packageExpansionRate: report.eval.packageExpansionRate,
      expandedSourceAcceptanceRate: report.eval.expandedSourceAcceptanceRate,
      memoryRetrievalRelevance: report.memoryAcceptedUse?.average_retrieval_relevance ?? null,
      factRetrievalRelevance: report.factReuse?.average_retrieval_relevance ?? null,
      trajectoryMemoryPhasePrecision: report.contextPrecision.phases.find(phase => phase.phase === 'trajectory_memory_retrieval')?.precision ?? null,
    },
    gates: {
      factReuse: report.factReuse?.metric ?? {
        gate_status: 'not_scored',
        gate_failed: false,
        instrumentation_needed: true,
        error: null,
      },
    },
	    thresholds,
	    warnings,
	    vectorCapability: report.vectorCapability,
	    agents: report.agents,
	  };
	}

function evalWindowStats({ from, to } = {}) {
  const rows = db.prepare(`
    SELECT returned_entity_ids, returned_text_unit_ids, returned_fact_ids, accepted_ids, volunteered_source_ids
    FROM eval_queries
    WHERE created_at > ? AND created_at <= ?
    ORDER BY created_at DESC
    LIMIT 1000
  `).all(from, to);
  let accepted = 0;
  let acceptedReturned = 0;
  let volunteered = 0;
  let volunteeredUsed = 0;
  let volunteeredSamples = 0;
  for (const row of rows) {
    const returned = new Set([
      ...parseJson(row.returned_entity_ids, []).map((id) => canonicalSourceId('entity', id)),
      ...parseJson(row.returned_text_unit_ids, []).map((id) => canonicalSourceId('text', id)),
      ...parseJson(row.returned_fact_ids, []).map((id) => canonicalSourceId('fact', id)),
    ]);
    const acceptedIds = normalizeSourceIds(parseJson(row.accepted_ids, [])).canonical;
    const volunteeredIds = normalizeSourceIds(parseJson(row.volunteered_source_ids, [])).canonical;
    accepted += acceptedIds.length;
    acceptedReturned += acceptedIds.filter((id) => returned.has(id)).length;
    volunteered += volunteeredIds.length;
    volunteeredUsed += volunteeredIds.filter((id) => acceptedIds.includes(id)).length;
    if (volunteeredIds.length) volunteeredSamples++;
  }
  return {
    samples: rows.length,
    volunteeredSamples,
    acceptanceRecall: accepted ? Math.round((acceptedReturned / accepted) * 1000) / 1000 : null,
    volunteeredPrecision: volunteered ? Math.round((volunteeredUsed / volunteered) * 1000) / 1000 : null,
    volunteeredSampleRate: rows.length ? Math.round((volunteeredSamples / rows.length) * 1000) / 1000 : null,
  };
}

function diffRate(current, previous) {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 1000) / 1000;
}

function clampLearningDays(days = 7) {
  return Math.min(Math.max(Number(days) || 7, 1), 90);
}

function learningWindowStartDay(days) {
  return new Date(Date.now() - (Math.max(days, 1) - 1) * 86400_000).toISOString().slice(0, 10);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildLearningHistoryExport({ days = 7 } = {}) {
  const safeDays = clampLearningDays(days);
  const windowStartDay = learningWindowStartDay(safeDays);
  const sourcePrecisionSnapshots = db.prepare(`
    SELECT day, canonical_source_id, source_kind, volunteered, used, weighted_volunteered,
           weighted_used, precision, weighted_precision, threshold_state, score, created_at
    FROM source_precision_snapshots
    WHERE day >= ?
    ORDER BY day DESC, score DESC, canonical_source_id ASC
  `).all(windowStartDay).map(row => ({
    row_type: 'source_precision_snapshot',
    day: row.day,
    source_id: row.canonical_source_id,
    source_kind: row.source_kind,
    volunteered: Number(row.volunteered ?? 0),
    used: Number(row.used ?? 0),
    weighted_volunteered: Number(row.weighted_volunteered ?? 0),
    weighted_used: Number(row.weighted_used ?? 0),
    precision: row.precision,
    weighted_precision: row.weighted_precision,
    threshold_state: row.threshold_state,
    score: Number(row.score ?? 0),
    created_at: row.created_at,
  }));
  const instructionScopeSnapshots = db.prepare(`
    SELECT day, memory_id, source_id, scope_key, scope_label, project, session_id, user_id,
           agent_id, memory_scope_match, used_count, ignored_count, harmful_count,
           feedback_count, precision, threshold_state, created_at
    FROM instruction_scope_snapshots
    WHERE day >= ?
    ORDER BY day DESC, harmful_count DESC, ignored_count DESC, used_count ASC, source_id ASC
  `).all(windowStartDay).map(row => ({
    row_type: 'instruction_scope_snapshot',
    day: row.day,
    source_id: row.source_id,
    memory_id: Number(row.memory_id ?? 0),
    scope_key: row.scope_key,
    scope_label: row.scope_label,
    project: row.project,
    session_id: row.session_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    memory_scope_match: Number(row.memory_scope_match ?? 0),
    used_count: Number(row.used_count ?? 0),
    ignored_count: Number(row.ignored_count ?? 0),
    harmful_count: Number(row.harmful_count ?? 0),
    feedback_count: Number(row.feedback_count ?? 0),
    precision: row.precision,
    threshold_state: row.threshold_state,
    created_at: row.created_at,
  }));
  const rows = [...sourcePrecisionSnapshots, ...instructionScopeSnapshots]
    .sort((a, b) => String(b.day).localeCompare(String(a.day))
      || String(a.row_type).localeCompare(String(b.row_type))
      || String(a.source_id).localeCompare(String(b.source_id))
      || Number(a.memory_id ?? 0) - Number(b.memory_id ?? 0)
      || String(a.scope_key ?? '').localeCompare(String(b.scope_key ?? '')));
  return {
    generatedAt: new Date().toISOString(),
    windowDays: safeDays,
    windowStartDay,
    metrics: buildLearningMetrics({ days: safeDays }),
    memoryAcceptedUse: buildMemoryAcceptedUseReport({ days: safeDays }),
    factReuse: buildFactReuseReport({ days: safeDays }),
    sourcePrecisionSnapshots,
    instructionScopeSnapshots,
    rows,
    csv: serializeLearningHistoryCsv(rows),
  };
}

function serializeLearningHistoryCsv(rows = []) {
  const header = [
    'row_type',
    'day',
    'source_id',
    'source_kind',
    'memory_id',
    'scope_key',
    'scope_label',
    'project',
    'session_id',
    'user_id',
    'agent_id',
    'memory_scope_match',
    'volunteered',
    'used',
    'weighted_volunteered',
    'weighted_used',
    'precision',
    'weighted_precision',
    'threshold_state',
    'score',
    'used_count',
    'ignored_count',
    'harmful_count',
    'feedback_count',
    'created_at',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((key) => csvCell(row[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildBrainHealthView({ days = 7 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const now = Math.floor(Date.now() / 1000);
  const since = now - safeDays * 86400;
  const previousSince = since - safeDays * 86400;
  const report = buildLearningReport({ days: safeDays });
  const metrics = buildLearningMetrics({ days: safeDays });
  const latestCycle = db.prepare(`
    SELECT id, subject, data, tags, created_at FROM timeline
    WHERE source='brain-cycle' AND type='brain:cycle-report'
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  const latestMaintenance = db.prepare(`
    SELECT id, subject, data, tags, created_at FROM timeline
    WHERE source='brain-maintenance' AND type='brain:maintenance-processed'
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  const cycleData = latestCycle ? parseJson(latestCycle.data, {}) : null;
  const cycleTags = latestCycle ? parseJson(latestCycle.tags, []) : [];
  const maintenanceData = latestMaintenance ? parseJson(latestMaintenance.data, {}) : null;
  const cycleMaxAgeSeconds = Number(process.env.BRAIN_HEALTH_CYCLE_MAX_AGE_SECONDS ?? 90000);
  const cycleAgeSeconds = latestCycle ? Math.max(0, now - Number(latestCycle.created_at ?? now)) : null;
  const maintenanceAgeSeconds = latestMaintenance ? Math.max(0, now - Number(latestMaintenance.created_at ?? now)) : null;
  const cycleWarnings = Array.isArray(cycleData?.warnings) ? cycleData.warnings : [];
  const graphConnectivity = auditBrainConnectivity({ sampleLimit: 25 });
  const cycleStatus = !latestCycle ? 'missing'
    : cycleAgeSeconds > cycleMaxAgeSeconds ? 'stale'
      : cycleWarnings.length ? 'warn'
        : 'ok';
  const currentEval = evalWindowStats({ from: since, to: now });
  const previousEval = evalWindowStats({ from: previousSince, to: since });
  const approvalRows = db.prepare(`
    SELECT kind, created_at FROM approvals
    WHERE status='pending'
    ORDER BY created_at ASC
  `).all();
  const proposalRows = db.prepare(`
    SELECT id, kind, subject, payload, risk_level, requested_by, status, created_at
    FROM approvals
    WHERE status='pending'
    ORDER BY created_at ASC
    LIMIT 25
  `).all().map(row => ({
    ...row,
    payload: parseJson(row.payload, {}),
    ageSeconds: now - Number(row.created_at ?? now),
  }));
  const approvalsByKind = {};
  for (const row of approvalRows) {
    const bucket = approvalsByKind[row.kind] ??= { kind: row.kind, count: 0, oldestAgeSeconds: 0 };
    bucket.count++;
    bucket.oldestAgeSeconds = Math.max(bucket.oldestAgeSeconds, now - Number(row.created_at ?? now));
  }
  const proposalsByKind = {};
  for (const row of approvalRows) {
    const ageSeconds = now - Number(row.created_at ?? now);
    const bucket = proposalsByKind[row.kind] ??= { kind: row.kind, count: 0, oldestAgeSeconds: 0 };
    bucket.count++;
    bucket.oldestAgeSeconds = Math.max(bucket.oldestAgeSeconds, ageSeconds);
  }
  const contradictionApprovals = db.prepare(`
    SELECT status, created_at FROM approvals
    WHERE kind='fact.contradiction' AND created_at > ?
  `).all(since);
  const contradictionPending = approvalRows.filter(row => row.kind === 'fact.contradiction').length;
	  const contradictionRate = currentEval.samples
	    ? Math.round((contradictionApprovals.length / currentEval.samples) * 1000) / 1000
	    : null;
	  const vectorCapability = sqliteVecStatus();
	  const status = [metrics.status, cycleStatus].some(value => ['warn', 'stale', 'missing'].includes(value)) ? 'warn' : 'ok';
  const factStatus = currentFactStatusApiProjection();
  const factEntityIntegrity = currentFactIntegrityApiProjection({ limit: 8 });
  return {
    generatedAt: new Date().toISOString(),
    status,
    windowDays: safeDays,
    brain: {
      ok: true,
      nodes: STMT.nodeCount.get().c,
      edges: STMT.edgeCount.get().c,
      memories: STMT.memCount.get().c,
      entities: STMT.entityCount.get().c,
      timelineEvents: STMT.timelineCount.get().c,
      facts: STMT.factCount.get().c,
      factsRawActive: factStatus.raw_active_facts,
      factsServingActive: factStatus.serving_active_facts,
      factsHistorical: factStatus.historical_facts,
      factsTotal: factStatus.facts_total,
      factStatus,
      factEntityIntegrity,
	      fts: ftsAvailable,
      sqliteVec: vectorCapability,
      vectorCapability,
      routeSkew: metrics.routeSkew,
      connectivity: graphConnectivity,
	    },
    cycle: {
      status: cycleStatus,
      latestId: latestCycle?.id ?? null,
      subject: latestCycle?.subject ?? null,
      createdAt: latestCycle?.created_at ?? null,
      ageSeconds: cycleAgeSeconds,
      maxAgeSeconds: cycleMaxAgeSeconds,
      warnings: cycleWarnings,
      tags: cycleTags,
    },
    automation: {
      maintenance: {
        enabled: true,
        cadence: 'launchd StartInterval 3600s',
        latestId: latestMaintenance?.id ?? null,
        createdAt: latestMaintenance?.created_at ?? null,
        ageSeconds: maintenanceAgeSeconds,
        last: maintenanceData,
      },
      curator: {
        enabled: curatorPolicy().enabled,
        autoApplyKinds: curatorPolicy().autoApplyKinds,
        autoApplyRisk: curatorPolicy().autoApplyRisk,
        maxApplies: curatorPolicy().maxApplies,
      },
      routing: {
        enabled: maintenancePolicy().enabled,
        routableKinds: maintenancePolicy().routableKinds,
        routableRisk: maintenancePolicy().routableRisk,
        maxRoutes: maintenancePolicy().maxRoutes,
      },
      guardrails: {
        autoApply: 'only curator allowlisted safe reversible approvals',
        routeOnly: 'evidence-invalid skill proposals and low-confidence skill.publish rows become skill.evidence.repair work; invalid citations become citation/source repair tasks; expired learning-task leases recover or escalate; no approval apply',
        reviewGated: ['evidence-backed skill.publish', 'memory.retire', 'team.instruction.*', 'entity.alias.fuzzy_merge', 'fact.contradiction', 'edge.repair'],
      },
    },
    approvals: {
      pending: approvalRows.length,
      oldestPendingAgeSeconds: approvalRows.length ? now - Number(approvalRows[0].created_at ?? now) : 0,
      byKind: Object.values(approvalsByKind).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    },
    proposals: {
      pending: approvalRows.length,
      source: 'approvals-alias',
      note: 'Proposals are the same underlying governance queue exposed through /proposals; this is not a second backlog.',
      byKind: Object.values(proposalsByKind).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      pendingItems: proposalRows.map(row => ({
        id: row.id,
        kind: row.kind,
        subject: row.subject,
        riskLevel: row.risk_level,
        requestedBy: row.requested_by,
        ageSeconds: row.ageSeconds,
        suggestedReason: row.payload?.suggested_reason ?? row.payload?.suggestedReason ?? row.payload?.reason ?? '',
      })),
    },
    contradictions: {
      opened: contradictionApprovals.length,
      pending: contradictionPending,
      ratePerEvalSample: contradictionRate,
      repeatedContradictions: report.repeatedContradictions,
    },
    evalTrends: {
      current: currentEval,
      previous: previousEval,
      delta: {
        samples: currentEval.samples - previousEval.samples,
        acceptanceRecall: diffRate(currentEval.acceptanceRecall, previousEval.acceptanceRecall),
        volunteeredPrecision: diffRate(currentEval.volunteeredPrecision, previousEval.volunteeredPrecision),
        volunteeredSampleRate: diffRate(currentEval.volunteeredSampleRate, previousEval.volunteeredSampleRate),
      },
	      warnings: metrics.warnings.filter(warning => ['agent_learning_discipline', 'weak_retrieval_phases', 'noisy_sources'].includes(warning.kind)),
	    },
	    vectorCapability: {
	      ...vectorCapability,
	      warnings: metrics.warnings.filter(warning => warning.kind === 'vector_capability_degraded'),
	    },
	    vectorRollout: report.vectorRollout,
	    learning: {
      metricsStatus: metrics.status,
      counters: metrics.counters,
      rates: metrics.rates,
      warnings: metrics.warnings,
    },
  };
}

function parseEvalFixture(row) {
  return {
    id: row.id,
    eval_query_id: row.eval_query_id,
    query_text: row.query_text,
    route: row.route,
    agent_id: row.agent_id,
    task_id: row.task_id,
    required_source_ids: parseJson(row.required_source_ids, []),
    required_strings: parseJson(row.required_strings, []),
    metadata: parseJson(row.metadata, {}),
    promoted_by: row.promoted_by,
    status: row.status ?? 'active',
    stale_reason: row.stale_reason ?? '',
    stale_at: row.stale_at ?? null,
    retired_at: row.retired_at ?? null,
    failure_count: Number(row.failure_count ?? 0),
    last_replayed_at: row.last_replayed_at ?? null,
    last_failed_at: row.last_failed_at ?? null,
    created_at: row.created_at,
  };
}

function fixtureEvidenceState(fixture) {
  const validation = validateSourceIds(db, fixture.required_source_ids);
  const invalid = validation.filter(source => !source.valid);
  return {
    valid: invalid.length === 0,
    validation,
    invalid_source_ids: invalid.map(source => source.source_id),
    issues: [...new Set(invalid.flatMap(source => source.issues ?? []))],
  };
}

function markFixtureStaleIfNeeded(fixture, evidence) {
  if (fixture.status !== 'active' || evidence.valid) return fixture;
  const reason = evidence.issues.length
    ? `invalid evidence: ${evidence.issues.join(', ')}`
    : 'invalid evidence';
  db.prepare(`
    UPDATE eval_fixtures
    SET status='stale', stale_reason=?, stale_at=COALESCE(stale_at, unixepoch())
    WHERE id=? AND status='active'
  `).run(reason, fixture.id);
  return { ...fixture, status: 'stale', stale_reason: reason, stale_at: fixture.stale_at ?? Math.floor(Date.now() / 1000) };
}

function evalFixtureLifecycle({ limit = 25 } = {}) {
  const rows = db.prepare(`SELECT * FROM eval_fixtures ORDER BY created_at DESC`).all().map(parseEvalFixture);
  const fixtures = rows.map((fixture) => markFixtureStaleIfNeeded(fixture, fixtureEvidenceState(fixture)));
  const counts = {
    active: fixtures.filter(f => f.status === 'active').length,
    stale: fixtures.filter(f => f.status === 'stale').length,
    retired: fixtures.filter(f => f.status === 'retired').length,
    failed: fixtures.filter(f => f.status === 'active' && Number(f.failure_count ?? 0) > 0).length,
  };
  const stale = fixtures
    .filter(f => f.status === 'stale')
    .slice(0, limit)
    .map(f => ({ ...f, evidence: fixtureEvidenceState(f) }));
  const failing = fixtures
    .filter(f => f.status === 'active' && Number(f.failure_count ?? 0) > 0)
    .sort((a, b) => Number(b.failure_count ?? 0) - Number(a.failure_count ?? 0))
    .slice(0, limit);
  return { counts, stale, failing };
}

function runEvalFixtureReplay({ route = null, limit = 50, includeRetired = false } = {}) {
  const rows = route
    ? includeRetired
      ? db.prepare(`SELECT * FROM eval_fixtures WHERE route=? ORDER BY created_at DESC LIMIT ?`).all(route, limit)
      : db.prepare(`SELECT * FROM eval_fixtures WHERE route=? AND status!='retired' ORDER BY created_at DESC LIMIT ?`).all(route, limit)
    : includeRetired
      ? db.prepare(`SELECT * FROM eval_fixtures ORDER BY created_at DESC LIMIT ?`).all(limit)
      : db.prepare(`SELECT * FROM eval_fixtures WHERE status!='retired' ORDER BY created_at DESC LIMIT ?`).all(limit);
  const fixtures = rows.map(parseEvalFixture);
  const results = fixtures.map((rawFixture) => {
    const evidence = fixtureEvidenceState(rawFixture);
    const fixture = markFixtureStaleIfNeeded(rawFixture, evidence);
    const local = buildLocalContext({ q: fixture.query_text, limit: 10 });
    const returned = [
      ...local.entities.map(e => canonicalSourceId('entity', e.id)),
      ...local.facts.map(f => canonicalSourceId('fact', f.id)),
      ...local.textUnits.map(u => canonicalSourceId('text', u.id)),
    ].filter(Boolean);
    const returnedSet = new Set(returned);
    const payloadText = JSON.stringify(local);
    const missing_source_ids = normalizeSourceIds(fixture.required_source_ids).canonical.filter(id => !returnedSet.has(id));
    const missing_strings = fixture.required_strings.filter(text => !payloadText.includes(String(text)));
    const retrievalPassed = missing_source_ids.length === 0 && missing_strings.length === 0;
    if (fixture.status === 'active') {
      db.prepare(`
        UPDATE eval_fixtures
        SET last_replayed_at=unixepoch(),
            failure_count=CASE WHEN ? THEN failure_count ELSE failure_count + 1 END,
            last_failed_at=CASE WHEN ? THEN last_failed_at ELSE unixepoch() END
        WHERE id=?
      `).run(retrievalPassed ? 1 : 0, retrievalPassed ? 1 : 0, fixture.id);
    } else {
      db.prepare(`UPDATE eval_fixtures SET last_replayed_at=unixepoch() WHERE id=?`).run(fixture.id);
    }
    return {
      fixture_id: fixture.id,
      query_text: fixture.query_text,
      route: fixture.route,
      status: fixture.status,
      evidence_valid: evidence.valid,
      evidence_issues: evidence.issues,
      invalid_source_ids: evidence.invalid_source_ids,
      retrieval_passed: retrievalPassed,
      passed: evidence.valid && retrievalPassed,
      failure_kind: !evidence.valid ? 'stale_evidence' : retrievalPassed ? null : 'retrieval_regression',
      required_source_ids: fixture.required_source_ids,
      returned_source_ids: returned,
      missing_source_ids,
      required_strings: fixture.required_strings,
      missing_strings,
    };
  });
  return {
    fixtures: fixtures.length,
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => r.failure_kind === 'retrieval_regression').length,
    stale: results.filter(r => r.failure_kind === 'stale_evidence').length,
    results,
  };
}

function buildLocalContext({ q = '', entityId, limit = 5, includeVector = false, vectorLimit = 5, vectorMaxAgeDays = 30 }) {
  let entities = [];
  if (entityId) {
    entities = db.prepare(`SELECT * FROM entities WHERE id=? ORDER BY updated_at DESC LIMIT ?`).all(entityId, limit);
  } else if (q) {
    const like = `%${q}%`;
    const normalized = normalizeAlias(q);
    const normalizedLike = normalized ? `%${normalized}%` : '\u0000';
    entities = db.prepare(`
      SELECT DISTINCT e.*
      FROM entities e
      LEFT JOIN entity_aliases a ON a.entity_id=e.id AND a.status='active'
      WHERE e.name LIKE ?
         OR e.description LIKE ?
         OR e.data LIKE ?
         OR a.alias LIKE ?
         OR a.normalized LIKE ?
      ORDER BY e.updated_at DESC
      LIMIT ?
    `).all(like, like, like, like, normalizedLike, limit);
  } else {
    entities = db.prepare(`SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?`).all(limit);
  }
  entities = entities.map(r => ({
    ...r,
    data: parseJson(r.data, {}),
    tags: parseJson(r.tags, []),
    matched_aliases: q ? matchedAliasesForEntity(r.id, q) : [],
  }));
  const ids = entities.map(e => e.id);
  if (!ids.length && !includeVector) return { entities: [], facts: [], textUnits: [], edges: [], vectorSources: [] };

  const ph = ids.map(() => '?').join(',');
  const facts = ids.length
    ? db.prepare(`SELECT * FROM facts WHERE entity_id IN (${ph}) AND status='active' ORDER BY observed_at DESC LIMIT 50`).all(...ids)
      .map(r => ({ ...r, value: parseJson(r.value, null), context: parseJson(r.context, {}) }))
    : [];
  const edges = ids.length
    ? db.prepare(`SELECT * FROM entity_edges WHERE from_id IN (${ph}) OR to_id IN (${ph}) ORDER BY weight DESC LIMIT 50`).all(...ids, ...ids)
      .map(r => ({ ...r, text_unit_ids: parseJson(r.text_unit_ids, []) }))
    : [];
  const textUnits = ids.length
    ? db.prepare(`
      SELECT DISTINCT tu.id, tu.source_kind, tu.source_id, tu.title, tu.content, tu.metadata, tu.updated_at
      FROM text_units tu
      JOIN entity_text_units etu ON etu.text_unit_id = tu.id
      WHERE etu.entity_id IN (${ph})
      ORDER BY tu.updated_at DESC
      LIMIT 20
    `).all(...ids).map(r => ({ ...r, metadata: parseJson(r.metadata, {}) }))
    : [];

  const existingSources = new Set([
    ...entities.map(entity => canonicalSourceId('entity', entity.id)),
    ...facts.map(fact => canonicalSourceId('fact', fact.id)),
    ...textUnits.map(unit => canonicalSourceId('text', unit.id)),
  ]);
  const vectorSources = includeVector
    ? vectorCandidatesForQuery(q, { limit: vectorLimit, maxAgeDays: vectorMaxAgeDays })
      .filter(row => !existingSources.has(row.canonical_source_id))
      .map(row => ({ ...row, record: canonicalSourceRecord(row.canonical_source_id) }))
      .filter(row => row.record)
    : [];

  return { entities, facts, textUnits, edges, vectorSources };
}

function findSharedMemoryContext(q = '', limit = 3) {
  const clean = String(q ?? '').trim();
  if (!clean) return [];
  const like = `%${clean}%`;
  return db.prepare(`
    SELECT id, agent_id, mem_key, content, tags, created_at, last_volunteered_at, last_used_at, ignored_count
    FROM agent_memories
    WHERE visibility='public'
      AND ${LIVE}
      AND status='active'
      AND (content LIKE ? OR mem_key LIKE ? OR tags LIKE ?)
    ORDER BY ignored_count ASC, COALESCE(last_used_at, created_at) DESC
    LIMIT ?
  `).all(like, like, like, limit).map((row) => ({
    id: row.id,
    source_id: `memory:${row.id}`,
    agent_id: row.agent_id,
    key: row.mem_key,
    content: row.content,
    tags: parseJson(row.tags, []),
    created_at: row.created_at,
    last_volunteered_at: row.last_volunteered_at,
    last_used_at: row.last_used_at,
    ignored_count: row.ignored_count,
  }));
}

function findTrajectoryMemoryContext(q = '', limit = 2) {
  const clean = String(q ?? '').trim();
  if (!clean) return [];
  const like = `%${clean}%`;
  return db.prepare(`
    SELECT id, agent_id, mem_key, content, tags, created_at, last_volunteered_at, last_used_at, ignored_count
    FROM agent_memories
    WHERE visibility='public'
      AND ${LIVE}
      AND status='active'
      AND agent_id='task-trajectories'
      AND (content LIKE ? OR mem_key LIKE ? OR tags LIKE ?)
    ORDER BY ignored_count ASC, COALESCE(last_used_at, created_at) DESC
    LIMIT ?
  `).all(like, like, like, limit).map((row) => ({
    id: row.id,
    source_id: `memory:${row.id}`,
    agent_id: row.agent_id,
    key: row.mem_key,
    content: row.content,
    tags: parseJson(row.tags, []),
    created_at: row.created_at,
    last_volunteered_at: row.last_volunteered_at,
    last_used_at: row.last_used_at,
    ignored_count: row.ignored_count,
  }));
}

function sourceOriginsForBundle(bundle, origin) {
  const origins = Object.create(null);
  for (const id of bundle.entityIds ?? []) addSourceOrigin(origins, canonicalSourceId('entity', id), origin);
  for (const id of bundle.factIds ?? []) addSourceOrigin(origins, canonicalSourceId('fact', id), origin);
  for (const id of bundle.textUnitIds ?? []) addSourceOrigin(origins, canonicalSourceId('text', id), origin);
  const aliasMatchedEntityIds = new Set((bundle.entities ?? [])
    .filter(entity => Array.isArray(entity.matched_aliases) && entity.matched_aliases.length)
    .map(entity => entity.id));
  if (aliasMatchedEntityIds.size) {
    for (const id of bundle.entityIds ?? []) {
      if (aliasMatchedEntityIds.has(id)) addSourceOrigin(origins, canonicalSourceId('entity', id), 'related_entity');
    }
    for (const fact of bundle.facts ?? []) {
      if (aliasMatchedEntityIds.has(fact.entity_id)) addSourceOrigin(origins, canonicalSourceId('fact', fact.id), 'related_entity');
    }
    for (const textUnit of bundle.textUnits ?? []) addSourceOrigin(origins, canonicalSourceId('text', textUnit.id), 'related_entity');
  }
  const memoriesById = new Map((bundle.memories ?? []).map(memory => [Number(memory.id), memory]));
  for (const id of bundle.memoryIds ?? []) {
    const memory = memoriesById.get(Number(id));
    addSourceOrigin(origins, `memory:${id}`, memory?.agent_id === 'task-trajectories' ? 'trajectory_memory' : 'shared_memory');
  }
  return origins;
}

function attachVolunteerMetadata(bundle, precision, index, sourceOrigins, { repoHints = [] } = {}) {
  const repoAffinity = repoAffinityForBundle(bundle, repoHints);
  for (const match of repoAffinity.matches) addSourceOrigin(sourceOrigins, match.source_id, 'repo_affinity');
  return {
    ...bundle,
    sourceOrigins,
    score: Math.round((scoreVolunteerBundle(bundle, precision, index) + repoAffinity.score) * 1000) / 1000,
    repoAffinity,
    sourceStats: bundleCanonicalSourceIds(bundle)
      .map((id) => precision.bySource.get(id))
      .filter(Boolean)
      .slice(0, 8),
  };
}

function sourceKindForCanonical(id) {
  if (String(id).startsWith('entity:')) return 'entity';
  if (String(id).startsWith('fact:')) return 'fact';
  if (String(id).startsWith('text:')) return 'text';
  if (String(id).startsWith('memory:')) return 'memory';
  return 'source';
}

function sourceCharEstimate(record = {}) {
  const value = record.value ?? record.content ?? record.description ?? record.name ?? record.key ?? '';
  if (typeof value === 'string') return value.length;
  return JSON.stringify(value ?? {}).length;
}

function compressSourceRecord(record = {}, keptChars) {
  const limit = Math.max(1, Math.floor(Number(keptChars) || 1));
  const field = ['value', 'content', 'description', 'name', 'key']
    .find(key => typeof record[key] === 'string' && record[key].length > limit);
  if (!field) return { ...record, compressed: true, original_chars: sourceCharEstimate(record), kept_chars: sourceCharEstimate(record) };
  const original = record[field];
  return {
    ...record,
    [field]: original.slice(0, limit),
    compressed: true,
    original_chars: original.length,
    kept_chars: limit,
  };
}

function sourceTimestamp(record = {}) {
  return Number(record.updated_at ?? record.observed_at ?? record.created_at ?? 0) || null;
}

function normalizeContextBudget(body = {}) {
  const rawRisk = String(body.risk_level ?? body.riskLevel ?? 'medium').toLowerCase();
  const risk = rawRisk === 'normal'
    ? 'medium'
    : ['low', 'medium', 'high'].includes(rawRisk)
      ? rawRisk
      : 'medium';
  const defaultMaxChars = risk === 'high' ? 36_000 : risk === 'low' ? 12_000 : 24_000;
  const defaultMaxSources = risk === 'high' ? 40 : risk === 'low' ? 12 : 24;
  const rawCaps = body.source_kind_caps ?? body.sourceKindCaps ?? {};
  const sourceKindCaps = {};
  for (const [kind, value] of Object.entries(rawCaps && typeof rawCaps === 'object' ? rawCaps : {})) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) sourceKindCaps[kind] = Math.floor(n);
  }
  return {
    maxSources: Math.max(1, Math.floor(Number(body.max_sources ?? body.maxSources ?? defaultMaxSources))),
    maxChars: Math.max(500, Math.floor(Number(body.max_chars ?? body.maxChars ?? defaultMaxChars))),
    sourceKindCaps,
    freshnessDays: body.freshness_days ?? body.freshnessDays ?? null,
    riskLevel: risk,
  };
}

function bundleSourceRecords(bundle) {
  const rows = [];
  const push = (canonicalId, record, originRank = 0) => {
    if (!canonicalId) return;
    const stat = (bundle.sourceStats ?? []).find(s => s.source_id === canonicalId);
    rows.push({
      canonical_source_id: canonicalId,
      kind: sourceKindForCanonical(canonicalId),
      query: bundle.query,
      bundleScore: Number(bundle.score ?? 0),
      sourceScore: Number(stat?.score ?? 0),
      precision: stat?.precision ?? null,
      weightedPrecision: stat?.weightedPrecision ?? null,
      volunteered: Number(stat?.volunteered ?? 0),
      used: Number(stat?.used ?? 0),
      charEstimate: Math.max(1, sourceCharEstimate(record)),
      timestamp: sourceTimestamp(record),
      originRank,
    });
  };
  for (const entity of bundle.entities ?? []) push(canonicalSourceId('entity', entity.id), entity, 0);
  for (const fact of bundle.facts ?? []) push(canonicalSourceId('fact', fact.id), fact, 1);
  for (const textUnit of bundle.textUnits ?? []) push(canonicalSourceId('text', textUnit.id), textUnit, 2);
  for (const memory of bundle.memories ?? []) push(`memory:${memory.id}`, memory, 3);
  return rows;
}

function applyContextBudget(bundles, body = {}) {
  const budget = normalizeContextBudget(body);
  const seen = new Set();
  const candidates = [];
  for (const bundle of bundles) {
    for (const row of bundleSourceRecords(bundle)) {
      if (seen.has(row.canonical_source_id)) continue;
      seen.add(row.canonical_source_id);
      candidates.push(row);
    }
  }
  candidates.sort((a, b) =>
    (b.sourceScore + b.bundleScore) - (a.sourceScore + a.bundleScore)
    || a.originRank - b.originRank
    || a.canonical_source_id.localeCompare(b.canonical_source_id)
  );

  const selected = new Set();
  const compressed = new Map();
  const kindCounts = {};
  let chars = 0;
  const now = Math.floor(Date.now() / 1000);
  const staleCutoff = budget.freshnessDays == null ? null : now - Math.max(Number(budget.freshnessDays) || 1, 1) * 86400;
  const precisionMinSamples = Math.max(1, Number(process.env.BRAIN_CONTEXT_PRECISION_GATE_MIN_SAMPLES ?? 3) || 3);
  const precisionMin = Math.max(0, Math.min(1, Number(process.env.BRAIN_CONTEXT_PRECISION_GATE_MIN_PRECISION ?? 0.2)));
  const gateMemories = process.env.BRAIN_CONTEXT_PRECISION_GATE_MEMORY === '1';
  const compressFloor = Math.max(1, Math.floor(Number(process.env.BRAIN_CONTEXT_COMPRESS_MIN_CHARS ?? 500) || 500));
  const decisions = [];
  for (const row of candidates) {
    let outcome = 'included';
    let reason = 'within_budget';
    let keptChars = row.charEstimate;
    const precision = row.weightedPrecision ?? row.precision;
    if ((gateMemories || row.kind !== 'memory') && row.volunteered >= precisionMinSamples && precision != null && precision < precisionMin) {
      outcome = 'omitted';
      reason = 'low_precision';
    } else if (staleCutoff != null && row.timestamp && row.timestamp < staleCutoff) {
      outcome = 'omitted';
      reason = 'stale';
    } else if ((kindCounts[row.kind] ?? 0) >= (budget.sourceKindCaps[row.kind] ?? Infinity)) {
      outcome = 'omitted';
      reason = 'source_kind_cap';
    } else if (selected.size >= budget.maxSources) {
      outcome = 'retrievable';
      reason = 'max_sources';
    } else if (chars + row.charEstimate > budget.maxChars) {
      const remaining = budget.maxChars - chars;
      if (remaining >= compressFloor) {
        outcome = 'compressed';
        reason = 'max_chars_compressed';
        keptChars = remaining;
      } else {
        outcome = 'retrievable';
        reason = 'max_chars';
      }
    }
    const decision = { ...row, outcome, reason };
    if (outcome === 'included' || outcome === 'compressed') {
      selected.add(row.canonical_source_id);
      kindCounts[row.kind] = (kindCounts[row.kind] ?? 0) + 1;
      chars += keptChars;
    }
    if (outcome === 'compressed') {
      decision.original_chars = row.charEstimate;
      decision.kept_chars = keptChars;
      compressed.set(row.canonical_source_id, { original_chars: row.charEstimate, kept_chars: keptChars });
    }
    decisions.push(decision);
  }

  const compress = (record, canonicalId) => {
    const meta = compressed.get(canonicalId);
    if (!meta) return record;
    return compressSourceRecord(record, meta.kept_chars);
  };
  const filterBundle = (bundle) => {
    const keep = (id) => selected.has(id);
    const entities = (bundle.entities ?? []).filter(e => keep(canonicalSourceId('entity', e.id))).map(e => compress(e, canonicalSourceId('entity', e.id)));
    const facts = (bundle.facts ?? []).filter(f => keep(canonicalSourceId('fact', f.id))).map(f => compress(f, canonicalSourceId('fact', f.id)));
    const textUnits = (bundle.textUnits ?? []).filter(u => keep(canonicalSourceId('text', u.id))).map(u => compress(u, canonicalSourceId('text', u.id)));
    const memories = (bundle.memories ?? []).filter(m => keep(`memory:${m.id}`)).map(m => compress(m, `memory:${m.id}`));
    return {
      ...bundle,
      entityIds: entities.map(e => e.id),
      factIds: facts.map(f => f.id),
      textUnitIds: textUnits.map(u => u.id),
      memoryIds: memories.map(m => m.id),
      entities,
      facts,
      textUnits,
      memories,
      budget: {
        includedSourceIds: bundleCanonicalSourceIds({ entityIds: entities.map(e => e.id), factIds: facts.map(f => f.id), textUnitIds: textUnits.map(u => u.id), memoryIds: memories.map(m => m.id) }),
      },
    };
  };

  const filtered = bundles.map(filterBundle).filter(bundle => bundleCanonicalSourceIds(bundle).some(id => selected.has(id)));
  return {
    bundles: filtered,
    budget: {
      ...budget,
      selectedSources: selected.size,
      selectedChars: chars,
      kindCounts,
      decisions,
      included: decisions.filter(d => d.outcome === 'included').length,
      compressed: decisions.filter(d => d.outcome === 'compressed').length,
      omitted: decisions.filter(d => d.outcome === 'omitted').length,
      retrievable: decisions.filter(d => d.outcome === 'retrievable').length,
      compressedSourceIds: [...compressed.keys()],
    },
  };
}

function parseContextPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    query_text: row.query_text,
    summary: row.summary,
    original_source_ids: parseJson(row.original_source_ids, []),
    included_source_ids: parseJson(row.included_source_ids, []),
    omitted_source_ids: parseJson(row.omitted_source_ids, []),
    retrievable_source_ids: parseJson(row.retrievable_source_ids, []),
    source_origins: parseJson(row.source_origins, {}),
    character_estimate: row.character_estimate,
    token_estimate: row.token_estimate,
    budget: parseJson(row.budget, {}),
    timeline_event_id: row.timeline_event_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

function canonicalSourceRecord(sourceId) {
  const id = String(sourceId ?? '');
  if (id.startsWith('entity:')) {
    const entityId = id.slice('entity:'.length);
    const row = db.prepare(`SELECT * FROM entities WHERE id=?`).get(entityId);
    if (!row) return null;
    return { canonical_source_id: id, kind: 'entity', entity: { ...row, data: parseJson(row.data, {}), tags: parseJson(row.tags, []) } };
  }
  if (id.startsWith('fact:')) {
    const factId = Number(id.slice('fact:'.length));
    if (!Number.isInteger(factId)) return null;
    const row = db.prepare(`SELECT * FROM facts WHERE id=?`).get(factId);
    if (!row) return null;
    return { canonical_source_id: id, kind: 'fact', fact: { ...row, value: parseJson(row.value, null), context: parseJson(row.context, {}) } };
  }
	  if (id.startsWith('text:')) {
	    const textId = Number(id.slice('text:'.length));
	    if (!Number.isInteger(textId)) return null;
	    const row = db.prepare(`SELECT * FROM text_units WHERE id=?`).get(textId);
	    if (!row) return null;
	    return {
	      canonical_source_id: id,
	      kind: 'text',
	      textUnit: {
	        ...row,
	        source_metadata: parseJson(row.source_metadata, {}),
	        process_config: parseJson(row.process_config, {}),
	        metadata: parseJson(row.metadata, {}),
	      },
	    };
	  }
  if (id.startsWith('memory:')) {
    const memoryId = Number(id.slice('memory:'.length));
    if (!Number.isInteger(memoryId)) return null;
    const row = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(memoryId);
    if (!row) return null;
    return { canonical_source_id: id, kind: 'memory', memory: { ...row, tags: parseJson(row.tags, []) } };
  }
	  return null;
	}

	function relatedSourceIdsForRecord(record, { perSourceLimit = 8 } = {}) {
	  const related = [];
	  const add = (sourceId, reason, via = {}) => {
	    const canonical = normalizeSourceIds([sourceId]).canonical[0];
	    if (!canonical || canonical === record.canonical_source_id) return;
	    related.push({ source_id: canonical, reason, via });
	  };
	  if (record.kind === 'entity') {
	    const entityId = record.entity.id;
	    const facts = db.prepare(`
	      SELECT id FROM facts
	      WHERE entity_id=? AND status='active'
	      ORDER BY confidence DESC, observed_at DESC
	      LIMIT ?
	    `).all(entityId, perSourceLimit);
	    for (const fact of facts) add(`fact:${fact.id}`, 'entity_fact', { entity_id: entityId });
	    const textUnits = db.prepare(`
	      SELECT text_unit_id FROM entity_text_units
	      WHERE entity_id=?
	      ORDER BY confidence DESC, updated_at DESC
	      LIMIT ?
	    `).all(entityId, perSourceLimit);
	    for (const unit of textUnits) add(`text:${unit.text_unit_id}`, 'entity_text_unit', { entity_id: entityId });
	    const edges = db.prepare(`
	      SELECT from_id, to_id, kind, text_unit_ids FROM entity_edges
	      WHERE from_id=? OR to_id=?
	      ORDER BY evidence_count DESC, weight DESC, updated_at DESC
	      LIMIT ?
	    `).all(entityId, entityId, perSourceLimit);
	    for (const edge of edges) {
	      const peerId = edge.from_id === entityId ? edge.to_id : edge.from_id;
	      add(`entity:${peerId}`, 'entity_edge', { entity_id: entityId, edge_kind: edge.kind });
	      for (const textId of parseJson(edge.text_unit_ids, []).slice(0, 3)) add(`text:${textId}`, 'edge_text_evidence', { entity_id: entityId, peer_id: peerId, edge_kind: edge.kind });
	    }
	  } else if (record.kind === 'fact') {
	    const fact = record.fact;
	    add(`entity:${fact.entity_id}`, 'fact_entity', { fact_id: fact.id });
	    const contextIds = [
	      ...(Array.isArray(fact.context?.source_text_unit_ids) ? fact.context.source_text_unit_ids : []),
	      ...(Array.isArray(fact.context?.sourceTextUnitIds) ? fact.context.sourceTextUnitIds : []),
	      ...(Array.isArray(fact.context?.text_unit_ids) ? fact.context.text_unit_ids : []),
	      ...(Array.isArray(fact.context?.textUnitIds) ? fact.context.textUnitIds : []),
	    ];
	    for (const textId of contextIds) add(`text:${textId}`, 'fact_context_text_unit', { fact_id: fact.id });
	    const linkedText = db.prepare(`
	      SELECT text_unit_id, relation FROM fact_text_units
	      WHERE fact_id=?
	      ORDER BY confidence DESC, updated_at DESC
	      LIMIT ?
	    `).all(fact.id, perSourceLimit);
	    for (const row of linkedText) add(`text:${row.text_unit_id}`, 'fact_text_unit', { fact_id: fact.id, relation: row.relation });
	  } else if (record.kind === 'text') {
	    const textId = record.textUnit.id;
	    const entities = db.prepare(`
	      SELECT entity_id, relation FROM entity_text_units
	      WHERE text_unit_id=?
	      ORDER BY confidence DESC, updated_at DESC
	      LIMIT ?
	    `).all(textId, perSourceLimit);
	    for (const row of entities) add(`entity:${row.entity_id}`, 'text_entity_link', { text_unit_id: textId, relation: row.relation });
	    const facts = db.prepare(`
	      SELECT fact_id, relation FROM fact_text_units
	      WHERE text_unit_id=?
	      ORDER BY confidence DESC, updated_at DESC
	      LIMIT ?
	    `).all(textId, perSourceLimit);
	    for (const row of facts) add(`fact:${row.fact_id}`, 'text_fact_evidence', { text_unit_id: textId, relation: row.relation });
	    const edges = db.prepare(`
	      SELECT from_id, to_id, kind FROM entity_edges
	      WHERE text_unit_ids LIKE ?
	      ORDER BY evidence_count DESC, weight DESC, updated_at DESC
	      LIMIT ?
	    `).all(`%${textId}%`, perSourceLimit);
	    for (const edge of edges) {
	      add(`entity:${edge.from_id}`, 'text_edge_source', { text_unit_id: textId, edge_kind: edge.kind });
	      add(`entity:${edge.to_id}`, 'text_edge_target', { text_unit_id: textId, edge_kind: edge.kind });
	    }
	  }
	  return related;
	}
	
	function expandCanonicalSources(sourceIds = []) {
	  const missing = [];
	  const sources = [];
	  const expansionInputs = [];
	  const seen = new Set();
	  const seenInputs = new Set();
	  const addExpansionInput = (item) => {
	    const key = `${item.source_id}:${item.reason}:${JSON.stringify(item.via ?? {})}`;
	    if (seenInputs.has(key)) return;
	    seenInputs.add(key);
	    expansionInputs.push(item);
	  };
	  const pending = normalizeSourceIds(sourceIds).canonical.map(source_id => ({ source_id, reason: 'requested', via: {} }));
	  for (const item of pending) {
	    if (seen.has(item.source_id)) {
	      addExpansionInput(item);
	      continue;
	    }
	    seen.add(item.source_id);
	    addExpansionInput(item);
	    const record = canonicalSourceRecord(item.source_id);
	    if (record) {
	      sources.push(record);
	      for (const related of relatedSourceIdsForRecord(record)) {
	        if (seen.has(related.source_id)) addExpansionInput(related);
	        else pending.push(related);
	      }
	    } else {
	      missing.push(item.source_id);
	    }
	  }
	  return { sources, missing: [...new Set(missing)], expansionInputs };
	}

	function expandCanonicalSourcesLegacy(sourceIds = []) {
	  const missing = [];
	  const sources = [];
	  for (const id of normalizeSourceIds(sourceIds).canonical) {
	    const record = canonicalSourceRecord(id);
	    if (record) sources.push(record);
	    else missing.push(id);
	  }
	  return { sources, missing };
	}

function latestPackageExpansionMetadata(contextPackageId) {
  if (contextPackageId == null || contextPackageId === '') return {};
  const rows = db.prepare(`
    SELECT id, data FROM timeline
    WHERE type='context:package-expanded' AND subject=?
    ORDER BY created_at DESC, id DESC
    LIMIT 25
  `).all(String(contextPackageId));
  const expansionIds = [];
  const expandedSourceIds = [];
  for (const row of rows) {
    const data = parseJson(row.data, {});
    expansionIds.push(Number(row.id));
    expandedSourceIds.push(...normalizeSourceIds(data.returned_source_ids ?? data.returnedSourceIds ?? []).canonical);
  }
  return {
    expansion_ids: [...new Set(expansionIds.filter(Number.isInteger))],
    expanded_source_ids: [...new Set(expandedSourceIds)],
  };
}

function createContextPackage({
  taskId = '',
  agentId = '',
  queryText = '',
  summary = '',
  sourceIds = [],
  includedSourceIds = [],
  omittedSourceIds = [],
  retrievableSourceIds = [],
  sourceOrigins = {},
  budget = {},
  timelineEventId = null,
  expiresAt = null,
  ttlSeconds = null,
} = {}) {
  const original = normalizeSourceIds(sourceIds).canonical;
  const included = normalizeSourceIds(includedSourceIds.length ? includedSourceIds : original).canonical;
  const omitted = normalizeSourceIds(omittedSourceIds).canonical;
  const retrievable = normalizeSourceIds(retrievableSourceIds).canonical;
  const decisionChars = Array.isArray(budget.decisions)
    ? budget.decisions.reduce((sum, row) => sum + Number(row.charEstimate ?? 0), 0)
    : 0;
  const characterEstimate = Number(budget.selectedChars ?? decisionChars ?? 0) || 0;
  const expires = expiresAt == null && ttlSeconds != null
    ? Math.floor(Date.now() / 1000) + Math.max(1, Number(ttlSeconds) || 1)
    : expiresAt;
  const r = db.prepare(`
    INSERT INTO context_packages
      (task_id, agent_id, query_text, summary, original_source_ids, included_source_ids, omitted_source_ids, retrievable_source_ids, source_origins, character_estimate, token_estimate, budget, timeline_event_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    agentId,
    String(queryText ?? '').slice(0, 4000),
    String(summary ?? '').slice(0, 4000),
    JSON.stringify(original),
    JSON.stringify(included),
    JSON.stringify(omitted),
    JSON.stringify(retrievable),
    JSON.stringify(normalizeSourceOrigins(sourceOrigins)),
    characterEstimate,
    Math.ceil(characterEstimate / 4),
    JSON.stringify(budget ?? {}),
    timelineEventId,
    expires ?? null,
  );
  return Number(r.lastInsertRowid);
}

function buildHighPrecisionBundle(sourceId) {
  const id = String(sourceId ?? '');
  if (id.startsWith('fact:')) {
    const factId = Number(id.slice('fact:'.length));
    if (!Number.isInteger(factId)) return null;
    const fact = db.prepare(`SELECT * FROM facts WHERE id=? AND status='active'`).get(factId);
    if (!fact) return null;
    const parsedFact = { ...fact, value: parseJson(fact.value, null), context: parseJson(fact.context, {}) };
    const textUnitIds = [
      ...(parsedFact.context.source_text_unit_ids ?? []),
      ...(parsedFact.context.sourceTextUnitIds ?? []),
      ...(parsedFact.context.text_unit_ids ?? []),
      ...(parsedFact.context.textUnitIds ?? []),
    ].map(Number).filter(Number.isInteger);
    const entity = db.prepare(`SELECT * FROM entities WHERE id=?`).get(parsedFact.entity_id);
    const textUnits = textUnitIds.length
      ? db.prepare(`SELECT * FROM text_units WHERE id IN (${textUnitIds.map(() => '?').join(',')}) LIMIT 3`).all(...textUnitIds)
          .map(r => ({ ...r, metadata: parseJson(r.metadata, {}) }))
      : [];
    return {
      query: `historical:${id}`,
      entityIds: [parsedFact.entity_id],
      factIds: [factId],
      textUnitIds,
      memoryIds: [],
      entities: entity ? [{ ...entity, data: parseJson(entity.data, {}), tags: parseJson(entity.tags, []) }] : [],
      facts: [parsedFact],
      textUnits,
      memories: [],
    };
  }
  if (id.startsWith('text:')) {
    const textId = Number(id.slice('text:'.length));
    if (!Number.isInteger(textId)) return null;
    const textUnit = db.prepare(`SELECT * FROM text_units WHERE id=?`).get(textId);
    if (!textUnit) return null;
    const entityIds = db.prepare(`SELECT entity_id FROM entity_text_units WHERE text_unit_id=? LIMIT 5`).all(textId).map(r => r.entity_id);
    const entities = entityIds.length
      ? db.prepare(`SELECT * FROM entities WHERE id IN (${entityIds.map(() => '?').join(',')}) LIMIT 5`).all(...entityIds)
          .map(r => ({ ...r, data: parseJson(r.data, {}), tags: parseJson(r.tags, []) }))
      : [];
    const facts = entityIds.length
      ? db.prepare(`SELECT * FROM facts WHERE entity_id IN (${entityIds.map(() => '?').join(',')}) AND status='active' ORDER BY observed_at DESC LIMIT 5`).all(...entityIds)
          .map(r => ({ ...r, value: parseJson(r.value, null), context: parseJson(r.context, {}) }))
      : [];
    return {
      query: `historical:${id}`,
      entityIds,
      factIds: facts.map(f => f.id),
      textUnitIds: [textId],
      memoryIds: [],
      entities,
      facts,
      textUnits: [{ ...textUnit, metadata: parseJson(textUnit.metadata, {}) }],
      memories: [],
    };
  }
  return null;
}

function highPrecisionExpansion({ precision, usedSourceIds = [], limit = 1 } = {}) {
  const used = new Set(usedSourceIds);
  const minSamples = Number(process.env.BRAIN_CONTEXT_PRECISION_EXPAND_MIN_SAMPLES ?? 3);
  const minPrecision = Number(process.env.BRAIN_CONTEXT_PRECISION_EXPAND_MIN_PRECISION ?? 0.6);
  const rows = [...precision.bySource.values()]
    .filter(stat => ['fact', 'text'].includes(stat.kind))
    .filter(stat => !used.has(stat.source_id))
    .filter(stat => stat.volunteered >= minSamples && (stat.weightedPrecision ?? stat.precision ?? 0) >= minPrecision)
    .sort((a, b) => b.score - a.score);
  const bundles = [];
  for (const stat of rows) {
    const bundle = buildHighPrecisionBundle(stat.source_id);
    if (!bundle) continue;
    bundles.push(bundle);
    used.add(stat.source_id);
    if (bundles.length >= limit) break;
  }
  return bundles;
}

function lexicalVector(text) {
  const buckets = new Array(64).fill(0);
  for (const token of String(text ?? '').toLowerCase().match(/[a-z0-9:_-]{3,}/g) ?? []) {
    const hash = createHash('sha256').update(token).digest();
    buckets[hash[0] % buckets.length] += 1;
  }
  const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1;
  return buckets.map(value => value / norm);
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return null;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  if (!an || !bn) return null;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function vectorCandidatesForQuery(query, { limit = 5, maxAgeDays = 30 } = {}) {
  const terms = [...new Set(String(query ?? '').toLowerCase().match(/[a-z0-9:_-]{3,}/g) ?? [])];
  if (!terms.length) return [];
  const queryVector = lexicalVector(query);
  const nativeRows = vectorCandidatesForEmbedding(queryVector, { limit, maxAgeDays });
  if (nativeRows.length) {
    return nativeRows.map(row => ({ ...row, provider: 'sqlite-vec', model: `float[${queryVector.length}]`, metadata: {} }));
  }
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(Number(maxAgeDays) || 30, 1) * 86400;
  return db.prepare(`
    SELECT canonical_source_id, source_kind, provider, model, embedding_json, text_preview, metadata, refreshed_at
    FROM source_embeddings
    WHERE refreshed_at >= ?
    ORDER BY refreshed_at DESC
    LIMIT 500
  `).all(cutoff)
    .map(row => {
      const embedding = parseJson(row.embedding_json, []);
      const metadata = parseJson(row.metadata, {});
      const cosine = cosineSimilarity(queryVector, embedding);
      if (cosine != null) {
        return { ...row, metadata, score: Math.round(cosine * 1000) / 1000, score_kind: 'embedding_cosine' };
      }
      const haystack = String(row.text_preview ?? '').toLowerCase();
      const hits = terms.filter(term => haystack.includes(term)).length;
      return { ...row, metadata, score: hits / terms.length, score_kind: 'lexical_preview' };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function percentileValue(values, pct) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 1000) / 1000;
}

function compareVectorReplay(samples, {
  mode = 'union',
  limit = 5,
  maxAgeDays = 30,
} = {}) {
  const comparisonMode = String(mode ?? 'union') === 'replace' ? 'replace' : 'union';
  const thresholds = vectorReplayGateThresholds();
  const summary = {
    samples: 0,
    baselineAcceptedReturned: 0,
    vectorAcceptedReturned: 0,
    baselineReturned: 0,
    vectorReturned: 0,
    baselinePrecisionReturned: 0,
    vectorPrecisionReturned: 0,
    totalAccepted: 0,
    baselineRecall: null,
    vectorRecall: null,
    baselineAcceptanceRecall: null,
    vectorAcceptanceRecall: null,
    recallLift: null,
    baselineVolunteeredPrecision: null,
    vectorVolunteeredPrecision: null,
    volunteeredPrecisionLift: null,
    baselineSourceCoverage: null,
    vectorSourceCoverage: null,
    sourceCoverageLift: null,
    baselineLatencyMs: null,
    vectorLatencyMs: null,
    acceptanceRecallRegressed: false,
    volunteeredPrecisionRegressed: false,
    sourceCoverageRegressed: false,
    latencyBudgetExceeded: false,
    latencyP50Regressed: false,
    vectorCandidateSamples: 0,
    comparisonMode,
    rolloutAllowed: false,
    guard: 'insufficient_samples',
    thresholds,
    sqliteVec: sqliteVecStatus(),
  };
  const baselineLatencies = [];
  const vectorLatencies = [];

  for (const sample of samples) {
    const accepted = normalizeSourceIds(sample.accepted_ids).canonical;
    if (!accepted.length) continue;
    const baselineLatencyMs = Number(sample.latency_ms ?? sample.latencyMs);
    const hasBaselineLatency = Number.isFinite(baselineLatencyMs);
    const coverageTarget = normalizeStringList(sample.required_source_ids).length
      ? normalizeStringList(sample.required_source_ids)
      : accepted;
    const baseline = new Set([
      ...sample.returned_entity_ids.map((id) => canonicalSourceId('entity', id)),
      ...sample.returned_text_unit_ids.map((id) => canonicalSourceId('text', id)),
      ...sample.returned_fact_ids.map((id) => canonicalSourceId('fact', id)),
    ].filter(Boolean));
    const vectorStartedAt = performance.now();
    const vector = vectorCandidatesForQuery(sample.query_text, { limit, maxAgeDays })
      .map((row) => row.canonical_source_id)
      .filter(Boolean);
    const vectorLookupMs = performance.now() - vectorStartedAt;
    if (hasBaselineLatency) {
      baselineLatencies.push(baselineLatencyMs);
      vectorLatencies.push(baselineLatencyMs + vectorLookupMs);
    }
    if (vector.length) summary.vectorCandidateSamples++;
    const vectorSet = comparisonMode === 'replace'
      ? new Set(vector)
      : new Set([...baseline, ...vector]);
    summary.samples++;
    summary.totalAccepted += accepted.length;
    summary.baselineReturned += baseline.size;
    summary.vectorReturned += vectorSet.size;
    summary.baselineAcceptedReturned += accepted.filter(id => baseline.has(id)).length;
    summary.vectorAcceptedReturned += accepted.filter(id => vectorSet.has(id)).length;
    summary.baselinePrecisionReturned += accepted.filter(id => baseline.has(id)).length;
    summary.vectorPrecisionReturned += accepted.filter(id => vectorSet.has(id)).length;
    summary.totalCoverageTargets = (summary.totalCoverageTargets ?? 0) + coverageTarget.length;
    summary.baselineSourceCoverageReturned = (summary.baselineSourceCoverageReturned ?? 0) + coverageTarget.filter(id => baseline.has(id)).length;
    summary.vectorSourceCoverageReturned = (summary.vectorSourceCoverageReturned ?? 0) + coverageTarget.filter(id => vectorSet.has(id)).length;
  }
  if (summary.totalAccepted) {
    summary.baselineRecall = Math.round((summary.baselineAcceptedReturned / summary.totalAccepted) * 1000) / 1000;
    summary.vectorRecall = Math.round((summary.vectorAcceptedReturned / summary.totalAccepted) * 1000) / 1000;
    summary.baselineAcceptanceRecall = summary.baselineRecall;
    summary.vectorAcceptanceRecall = summary.vectorRecall;
    summary.recallLift = Math.round((summary.vectorRecall - summary.baselineRecall) * 1000) / 1000;
    summary.baselineVolunteeredPrecision = summary.baselineReturned
      ? Math.round((summary.baselinePrecisionReturned / summary.baselineReturned) * 1000) / 1000
      : null;
    summary.vectorVolunteeredPrecision = summary.vectorReturned
      ? Math.round((summary.vectorPrecisionReturned / summary.vectorReturned) * 1000) / 1000
      : null;
    summary.volunteeredPrecisionLift = summary.baselineVolunteeredPrecision != null && summary.vectorVolunteeredPrecision != null
      ? Math.round((summary.vectorVolunteeredPrecision - summary.baselineVolunteeredPrecision) * 1000) / 1000
      : null;
    summary.baselineSourceCoverage = summary.totalCoverageTargets
      ? Math.round((summary.baselineSourceCoverageReturned / summary.totalCoverageTargets) * 1000) / 1000
      : null;
    summary.vectorSourceCoverage = summary.totalCoverageTargets
      ? Math.round((summary.vectorSourceCoverageReturned / summary.totalCoverageTargets) * 1000) / 1000
      : null;
    summary.sourceCoverageLift = Math.round((summary.vectorSourceCoverage - summary.baselineSourceCoverage) * 1000) / 1000;
    summary.acceptanceRecallRegressed = summary.vectorAcceptanceRecall < summary.baselineAcceptanceRecall;
    summary.volunteeredPrecisionRegressed = summary.baselineVolunteeredPrecision != null && summary.vectorVolunteeredPrecision != null
      ? summary.vectorVolunteeredPrecision < (summary.baselineVolunteeredPrecision - Math.max(0, thresholds.maxVolunteeredPrecisionRegression))
      : false;
    summary.sourceCoverageRegressed = summary.vectorSourceCoverage < summary.baselineSourceCoverage;
    summary.baselineLatencyMs = {
      samples: baselineLatencies.length,
      p50: percentileValue(baselineLatencies, 50),
      p95: percentileValue(baselineLatencies, 95),
    };
    summary.vectorLatencyMs = {
      samples: vectorLatencies.length,
      p50: percentileValue(vectorLatencies, 50),
      p95: percentileValue(vectorLatencies, 95),
    };
    summary.latencyBudgetExceeded = Number.isFinite(thresholds.maxP95Ms)
      && summary.vectorLatencyMs.p95 != null
      && summary.vectorLatencyMs.p95 > thresholds.maxP95Ms;
    summary.latencyP50Regressed = Number.isFinite(thresholds.maxLatencyRegression)
      && summary.baselineLatencyMs.p50 != null
      && summary.vectorLatencyMs.p50 != null
      && summary.vectorLatencyMs.p50 > summary.baselineLatencyMs.p50 * (1 + Math.max(0, thresholds.maxLatencyRegression));
    if (summary.samples < thresholds.minSamples) {
      summary.guard = 'insufficient_samples';
    } else if (summary.vectorCandidateSamples <= 0) {
      summary.guard = 'no_vector_candidates';
    } else if (summary.volunteeredPrecisionRegressed) {
      summary.guard = 'volunteered_precision_regression';
    } else if (summary.acceptanceRecallRegressed) {
      summary.guard = 'acceptance_recall_regression';
    } else if (summary.sourceCoverageRegressed) {
      summary.guard = 'source_coverage_regression';
    } else if (summary.recallLift < thresholds.minRecallLift) {
      summary.guard = 'recall_lift_required';
    } else if (summary.sourceCoverageLift < thresholds.minCoverageLift) {
      summary.guard = 'source_coverage_lift_required';
    } else if (summary.latencyBudgetExceeded) {
      summary.guard = 'latency_budget_exceeded';
    } else if (summary.latencyP50Regressed) {
      summary.guard = 'latency_p50_regression';
    } else {
      summary.guard = 'pass';
    }
    summary.rolloutAllowed = summary.guard === 'pass';
  }
  return summary;
}

function extractContextCandidates(text, limit = 5) {
  const clean = String(text ?? '').trim();
  if (!clean) return [];
  const lower = clean.toLowerCase();
  const seen = new Set();
  const candidates = [];
  const push = (value) => {
    const q = String(value ?? '').trim();
    if (q.length < 3) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(q);
  };

  for (const entity of db.prepare(`SELECT name FROM entities ORDER BY updated_at DESC LIMIT 2000`).all()) {
    const name = String(entity.name ?? '').trim();
    if (name.length >= 3 && lower.includes(name.toLowerCase())) push(name);
    if (candidates.length >= limit) return candidates;
  }

  for (const row of db.prepare(`SELECT alias FROM entity_aliases WHERE status='active' ORDER BY updated_at DESC LIMIT 4000`).all()) {
    const alias = String(row.alias ?? '').trim();
    if (alias.length >= 3 && lower.includes(alias.toLowerCase())) push(alias);
    if (candidates.length >= limit) return candidates;
  }

  for (const phrase of clean.match(/[A-Z][A-Za-z0-9:_-]+(?:\s+[A-Z][A-Za-z0-9:_-]+){0,3}/g) ?? []) {
    push(phrase);
    if (candidates.length >= limit) return candidates;
  }
  for (const token of clean.match(/[A-Za-z][A-Za-z0-9:_-]{4,}/g) ?? []) {
    push(token);
    if (candidates.length >= limit) return candidates;
  }
  return candidates;
}

// `kind` remains the persisted entity-edge type. `type` is accepted as an
// additive API alias so new clients can use the clearer name without changing
// the unique key or breaking established producers.
function normalizeEntityEdgeWrite(body = {}) {
  const providedKind = body.kind;
  const providedType = body.type;
  if (providedKind !== undefined && providedType !== undefined
    && String(providedKind).trim() !== String(providedType).trim()) {
    throw Object.assign(new Error('kind and type must match when both are provided'), { status: 400 });
  }
  const kind = String(providedKind ?? providedType ?? '').trim();
  const from = String(body.from ?? '').trim();
  const to = String(body.to ?? '').trim();
  if (!from || !to || !kind) return null;
  return {
    from,
    to,
    kind,
    weight: body.weight ?? 1.0,
    description: body.description ?? '',
    textUnitIds: body.text_unit_ids ?? body.textUnitIds ?? [],
    evidenceCount: body.evidence_count ?? body.evidenceCount ?? null,
    promptVersion: body.prompt_version ?? body.promptVersion,
    confidence: body.confidence,
    provenance: body.provenance,
  };
}

export function createBrainServer({ corsAllowedOrigins }) {
  return createServer(async (req, res) => {
  const { pathname: path, searchParams } = new URL(req.url, `http://x`);
  const method = req.method ?? 'GET';

  if (applyCorsAndSecurityGuard({
    req,
    res,
    method,
    path,
    corsAllowedOrigins,
  })) return;

  try {
    let m;

    if (method === 'GET' && path === '/brain/health') {
      const health = brainHealthSignals({
        cycleMaxAgeSeconds: Number(searchParams.get('cycle_max_age_seconds') ?? searchParams.get('cycleMaxAgeSeconds') ?? process.env.BRAIN_HEALTH_CYCLE_MAX_AGE_SECONDS ?? 90000),
      });
      if (health.components?.factStatus) {
        health.components.factStatus = currentFactStatusApiProjection();
      }
      const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
        .run(
          'brain-health',
          'brain:health-score',
          'overall',
          JSON.stringify(health),
          JSON.stringify(['brain', 'health', 'trend']),
        );
      return send(res, 200, { ok: true, health, timelineEventId: Number(event.lastInsertRowid) });
    }

    if (await handleLearningRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson })) return;
    if (await handleApprovalQueueRoutes({ method, path, searchParams, req, res, db, readBody, send, fail, parseJson })) return;
    if (await handleSkillRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson })) return;
    if (await handleManagerContractRoutes({ method, path, req, res, db, readBody, send })) return;
    if (await handleRepoRoutes({ method, path, searchParams, req, res, db, readBody, send, parseJson, upsertFact, upsertTextUnitsFromSource })) return;
    if (await handleMetricsRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      readBody,
      send,
      buildLearningReport,
      buildLearningMetrics,
      buildLearningHistoryExport,
      buildBrainHealthView,
      writeSourcePrecisionSnapshot,
      writeInstructionScopeSnapshot,
      writeQualityMetricSnapshot,
      readQualityMetricTrend,
    })) return;
    if (await handleCoreRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      send,
      dashboards: {
        main: DASHBOARD_HTML,
        health: DASHBOARD_HEALTH_HTML,
        skills: DASHBOARD_SKILLS_HTML,
        learning: DASHBOARD_LEARNING_HTML,
        agents: DASHBOARD_AGENTS_HTML,
      },
      STMT,
      factStatusProjection: currentFactStatusApiProjection,
      auditFactEntityIntegrity: currentFactIntegrityApiProjection,
      ftsAvailable,
      sqliteVecStatus,
      routeInventoryReport,
    })) return;
    if (await handleGraphAppRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      db,
      send,
    })) return;
    if (await handleMemoryRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      db,
      readBody,
      send,
      getSharedMemories,
      getMemories,
      searchMemories,
      storeMemory,
      validateSourceIds,
      deleteMemory,
      getOldUnkeyedMemories,
      memByKey: STMT.memByKey,
      decorateMemoryRows: decorateMemoryRowsWithAcceptedUseAccounting,
      decorateMemoryRow: decorateMemoryRowWithAcceptedUseAccounting,
      controllerScopeUserId,
    })) return;
    if (await handleControllerRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      readBody,
      send,
      getController,
      listControllers,
      upsertController,
      linkControllerAgent,
      controllerScopeUserId,
    })) return;
    if (await handleTimelineRoutes({
      method,
      path,
      searchParams,
      req,
      res,
      db,
      readBody,
      send,
    })) return;
    if (await handleInstructionRoutes({
      method,
      path,
      req,
      res,
      readBody,
      send,
      recordInstructionFeedback,
    })) return;
    if (await handleSourceRoutes({
      method,
      path,
      req,
      res,
      db,
      readBody,
      send,
      validateSourceIds,
      sourceRow,
      canonicalSourceIds: canonicalSourceIdsForResolver,
    })) return;
    if (await handleContextRoutes({
      method,
      path,
      req,
      res,
      db,
      readBody,
      send,
      ok,
      canonicalSourceId,
      normalizeSourceIds,
      mergeSourceOrigins,
      bundleCanonicalSourceIds,
      sourcePrecisionStats,
      repoHintsForContext,
      extractContextCandidates,
      buildLocalContext,
      findTrajectoryMemoryContext,
      findSharedMemoryContext,
      sourceOriginsForBundle,
      attachVolunteerMetadata,
      highPrecisionExpansion,
      applyContextBudget,
      createContextPackage,
      parseContextPackage,
      expandCanonicalSources,
      latestTaskVolunteeredContext,
      recordFeedbackMissing,
      markMemoriesVolunteered,
    })) return;
    if (await handleEvalRoutes({
      method,
      path,
      req,
      res,
      db,
      readBody,
      send,
      parseJson,
      canonicalSourceId,
      normalizeSourceIds,
      collectRetrievalIds,
      resolveVolunteeredContext,
      latestPackageExpansionMetadata,
      phaseAttribution,
      markTaskContextUsed,
      markMemoriesUsed,
      markFactsUsed,
      maybeRecordSourcePrecisionThresholds,
      recordFeedbackMissing,
      validateSourceIds,
      sourcePrecisionStats,
      runEvalFixtureReplay,
      compareVectorReplay,
    })) return;
    if (await handleQueryRoutes({
      method,
      path,
      req,
      res,
      db,
      readBody,
      send,
      parseJson,
      buildLocalContext,
      responseWithOptionalEval,
    })) return;

    // ── Fleet report (aggregated 24h view, consumed by web app + fleet-report.mjs) ─
    if (method === 'GET' && path === '/fleet-report') {
      const since = Math.floor(Date.now() / 1000) - 86400;

      const cachedAgents = cachedBrainAgents();
      const live = await liveManagerFleet();
      const agents = live.ok ? live.agents : cachedAgents;
      const cacheDelta = live.ok ? live.agents.length - cachedAgents.length : null;
      const cacheDrift = live.ok
        ? {
            status: live.agents.length === cachedAgents.length ? 'aligned' : 'drift',
            liveTotal: live.agents.length,
            cachedTotal: cachedAgents.length,
            delta: cacheDelta,
            affectsAuthority: false,
            policy: 'diagnostic only while live manager is authoritative',
          }
        : {
            status: 'unknown',
            liveTotal: null,
            cachedTotal: cachedAgents.length,
            delta: null,
            affectsAuthority: true,
            policy: 'cache fallback only when live manager cannot be read',
          };
      const idaccSync = {
        owner: 'IDACC manager',
        mode: live.ok ? 'live-manager-poll' : 'brain-cache-fallback',
        automatic: true,
        cachePolicy: 'no-store',
        sourceRoute: live.ok ? 'manager GET /teams + GET /agents per team' : 'Brain entities cache fallback',
        teamSource: live.teamSource,
        teams: live.teams,
        managerUrl: live.managerUrl,
        fetchedAt: live.fetchedAt,
        dashboardPollMs: 10000,
        cacheDrift,
      };
      const warnings = [
        ...live.warnings,
        ...(!live.ok ? ['manager live fleet unavailable; showing cached Brain agent entities'] : []),
      ];

      const timelineSummary = fleetTimelineSummary(since);
      const { queriesDelivered, queriesFailed, costByAgent, execStats, watchdogAlerts } = timelineSummary;

      const authority = fleetAuthority(live.source);
      const gasSpend = buildFleetGasSpend(agents, since);
      const agentsWithGas = agents.map(agent => ({
        ...agent,
        onchain: {
          readOnly: true,
          controllerWallet: agent.controllerWallet,
          gasSpend: gasSpendPayload(gasSpend.byAgentId.get(agent.id)),
        },
      }));
      const identitySummary = summarizeFleetIdentity(agents);
      const idaccAuthority = {
        owner: 'IDACC manager',
        readOnly: true,
        route: 'GET /fleet-report',
        sourceRoute: live.ok ? 'manager GET /teams + GET /agents per team' : 'Brain entities cache fallback',
        managerUrl: live.managerUrl,
        teamSource: live.teamSource,
        teams: live.teams,
        authority: authority.authority,
        authoritative: authority.authoritative,
        statusAuthorityLabel: authority.statusAuthorityLabel,
        cachePolicy: 'no-store',
        cacheDrift,
        sync: idaccSync,
      };

      return send(res, 200, {
        generatedAt: new Date().toISOString(),
        fleet: aggregateFleet(agentsWithGas, live.source, {
          ...authority,
          idaccAuthority,
          managerUrl: live.managerUrl,
          teamSource: live.teamSource,
          teams: live.teams,
          fetchedAt: live.fetchedAt,
          cacheDrift,
          sync: idaccSync,
          warnings,
          errors: live.errors,
          providers: { skillmesh: identitySummary },
          skillmesh: identitySummary,
          identity: identitySummary,
          onchainGas: gasSpend.summary,
          timelineAggregation: {
            mode: 'targeted-sql',
            parsedRows: timelineSummary.parsedRows,
          },
        }),
        brain: {
          nodes:          STMT.nodeCount.get().c,
          edges:          STMT.edgeCount.get().c,
          memories:       STMT.memCount.get().c,
          entities:       STMT.entityCount.get().c,
          timelineEvents: STMT.timelineCount.get().c,
        facts:          STMT.factCount.get().c,
        },
        last24h: {
          queries: { delivered: queriesDelivered, failed: queriesFailed },
          skillExecutions: { ...execStats, settleRate: execStats.total ? execStats.settled / execStats.total : null },
          cloudCostUsd: Object.values(costByAgent).reduce((s, c) => s + c.totalUsd, 0),
          watchdogAlerts: watchdogAlerts.length,
        },
        costByAgent,
        recentWatchdogAlerts: watchdogAlerts.slice(-5),
      });
    }

    // ── Stats ─────────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/graph/stats') {
      return send(res, 200, {
        nodes:      STMT.nodeCount.get().c,
        edges:      STMT.edgeCount.get().c,
        memories:   STMT.memCount.get().c,
        domains:    STMT.domains.all(),
        topUsed:    STMT.topNodes.all(10),
        topLinked:  STMT.topDegree.all(10),
        topAgents:  STMT.topAgents.all(),
        fts:        ftsAvailable,
      });
    }

    if (method === 'GET' && path === '/providers/reputation') {
      const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 50), 1), 200);
      const since = Math.floor(Date.now() / 1000) - Math.min(Math.max(Number(searchParams.get('days') ?? 90), 1), 365) * 86400;
      const nodes = db.prepare(`SELECT * FROM skill_nodes ORDER BY skill_id ASC`).all();
      const rows = [];
      for (const node of nodes) {
        const events = db.prepare(`
          SELECT id, type, data, created_at
          FROM timeline
          WHERE subject=? AND created_at >= ? AND (source='skillmesh' OR type LIKE 'skill:%' OR type LIKE 'provider:%')
          ORDER BY created_at DESC
          LIMIT 500
        `).all(String(node.skill_id), since).map(event => ({ ...event, data: parseJson(event.data, {}) }));
        const executions = events.filter(event => event.type === 'skill:executed' || event.type === 'provider:executed');
        const settled = executions.filter(event => event.data?.settled === true || event.data?.status === 'settled' || event.data?.ok === true).length;
        const failed = executions.filter(event => event.data?.settled === false || event.data?.failed || event.data?.error || event.data?.ok === false).length;
        const latencies = executions.map(event => Number(event.data?.latency_ms ?? event.data?.latencyMs ?? event.data?.duration_ms ?? event.data?.durationMs)).filter(Number.isFinite);
        const testRows = events.filter(event => event.type === 'skill:test' || event.type === 'provider:test' || event.data?.tests);
        const testsPassed = testRows.reduce((sum, event) => sum + Number(event.data?.passed ?? event.data?.tests_passed ?? event.data?.testsPassed ?? (event.data?.ok === true ? 1 : 0)), 0);
        const testsFailed = testRows.reduce((sum, event) => sum + Number(event.data?.failed ?? event.data?.tests_failed ?? event.data?.testsFailed ?? (event.data?.ok === false ? 1 : 0)), 0);
        const ratings = events
          .map(event => event.data?.rating ?? event.data?.score ?? (event.type === 'skill:rating' ? event.data?.value : null))
          .filter(value => value !== null && value !== undefined && value !== '')
          .map(Number)
          .filter(Number.isFinite);
        const flags = events.filter(event =>
          event.type === 'skill:critical-flag' ||
          event.type === 'provider:critical-flag' ||
          event.data?.critical === true ||
          event.data?.critical_flag === true ||
          event.data?.criticalFlag === true
        );
        const execCount = executions.length;
        const settleRate = execCount ? settled / execCount : null;
        const testTotal = testsPassed + testsFailed;
        const testPassRate = testTotal ? testsPassed / testTotal : null;
        const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
        const avgRating = ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null;
        const score = Math.round(Math.max(0, Math.min(100,
          (settleRate == null ? 30 : settleRate * 45) +
          Math.min(15, Math.log10(execCount + 1) * 10) +
          (testPassRate == null ? 10 : testPassRate * 20) +
          (avgRating == null ? 5 : Math.min(5, avgRating) * 4) -
          Math.min(30, flags.length * 15) -
          (avgLatencyMs == null ? 0 : Math.min(10, avgLatencyMs / 5000))
        )));
        rows.push({
          skill_id: node.skill_id,
          name: node.name,
          domain: node.domain,
          score,
          exec_count: execCount,
          settled,
          failed,
          settle_rate: settleRate == null ? null : Math.round(settleRate * 1000) / 1000,
          avg_latency_ms: avgLatencyMs,
          tests_passed: testsPassed,
          tests_failed: testsFailed,
          test_pass_rate: testPassRate == null ? null : Math.round(testPassRate * 1000) / 1000,
          rating: avgRating == null ? null : Math.round(avgRating * 1000) / 1000,
          critical_flags: flags.length,
          evidence_timeline_ids: events.slice(0, 10).map(event => event.id),
        });
      }
      rows.sort((a, b) => b.score - a.score || b.exec_count - a.exec_count || a.name.localeCompare(b.name));
      return send(res, 200, ok({ providers: rows.slice(0, limit) }, { route: '/providers/reputation', profile: 'local' }));
    }

    // ── Graph: safety report for agent execution decisions ───────────────────
    m = path.match(/^\/graph\/nodes\/(\d+)\/safety-report$/);
    if (method === 'GET' && m) {
      const skillId = m[1];
      const node = STMT.nodeById.get(Number(skillId));
      if (!node) return fail(res, 404, 'brain.not_found', 'skill node not found', {
        hint: 'check the numeric skill id',
        retry_command: 'GET /graph/nodes',
      });
      const events = db.prepare(`
        SELECT id, type, subject, data, created_at
        FROM timeline
        WHERE subject=? AND (source='skillmesh' OR type LIKE 'skill:%' OR type LIKE 'provider:%')
        ORDER BY created_at DESC LIMIT 100
      `).all(skillId).map(e => ({ ...e, data: parseJson(e.data, {}) }));
      const executions = events.filter(e => e.type === 'skill:executed' || e.type === 'provider:executed');
      const settled = executions.filter(e => e.data?.settled === true || e.data?.status === 'settled' || e.data?.ok === true).length;
      const failures = executions.filter(e => e.data?.settled === false || e.data?.failed || e.data?.error || e.data?.ok === false).length;
      const settleRate = executions.length ? settled / executions.length : null;
      const latencies = executions
        .map(e => Number(e.data?.latency_ms ?? e.data?.latencyMs ?? e.data?.duration_ms ?? e.data?.durationMs))
        .filter(Number.isFinite);
      const avgLatencyMs = latencies.length
        ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null;
      const queryTestsPassed = Number(searchParams.get('tests_passed') ?? searchParams.get('testsPassed') ?? 0) || 0;
      const queryTestsFailed = Number(searchParams.get('tests_failed') ?? searchParams.get('testsFailed') ?? 0) || 0;
      const queryRatingParam = searchParams.get('rating');
      const queryRating = queryRatingParam == null || queryRatingParam === '' ? null : Number(queryRatingParam);
      const queryCriticalFlags = Math.max(0, Number(searchParams.get('critical_flags') ?? searchParams.get('criticalFlags') ?? (searchParams.get('critical_flag') === 'true' ? 1 : 0)) || 0);
      const testRows = events.filter(e =>
        e.type === 'skill:test' ||
        e.type === 'provider:test' ||
        e.data?.tests ||
        e.data?.tests_passed !== undefined ||
        e.data?.testsPassed !== undefined ||
        e.data?.tests_failed !== undefined ||
        e.data?.testsFailed !== undefined ||
        e.data?.failed_tests !== undefined ||
        typeof e.data?.passed === 'number' ||
        typeof e.data?.failed === 'number'
      );
      const testsPassed = queryTestsPassed + testRows.reduce((sum, e) => sum + Number(e.data?.passed ?? e.data?.tests_passed ?? e.data?.testsPassed ?? (e.data?.ok === true ? 1 : 0)), 0);
      const testsFailed = queryTestsFailed + testRows.reduce((sum, e) => sum + Number(e.data?.failed ?? e.data?.tests_failed ?? e.data?.testsFailed ?? e.data?.failed_tests ?? (e.data?.ok === false ? 1 : 0)), 0);
      const ratings = [
        ...(Number.isFinite(queryRating) ? [queryRating] : []),
        ...events
          .map(e => e.data?.rating ?? e.data?.score ?? ((e.type === 'skill:rating' || e.type === 'provider:rating') ? e.data?.value : null))
          .filter(value => value !== null && value !== undefined && value !== '')
          .map(Number)
          .filter(Number.isFinite),
      ];
      const criticalFlags = queryCriticalFlags + events.filter(e =>
        e.type === 'skill:critical-flag' ||
        e.type === 'provider:critical-flag' ||
        e.data?.critical === true ||
        e.data?.critical_flag === true ||
        e.data?.criticalFlag === true
      ).length;
      const testPassRate = testsPassed + testsFailed ? testsPassed / (testsPassed + testsFailed) : null;
      const avgRating = ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null;
      const providerReputation = {
        exec_count: executions.length,
        settled,
        failed: failures,
        settle_rate: settleRate == null ? null : Math.round(settleRate * 1000) / 1000,
        avg_latency_ms: avgLatencyMs,
        tests_passed: testsPassed,
        tests_failed: testsFailed,
        test_pass_rate: testPassRate == null ? null : Math.round(testPassRate * 1000) / 1000,
        rating: avgRating == null ? null : Math.round(avgRating * 1000) / 1000,
        critical_flags: criticalFlags,
        evidence_timeline_ids: events.slice(0, 10).map(e => e.id),
      };
      const textUnitIds = [...new Set(events.flatMap(e => [
        ...(Array.isArray(e.data?.text_unit_ids) ? e.data.text_unit_ids : []),
        ...(Array.isArray(e.data?.source_text_unit_ids) ? e.data.source_text_unit_ids : []),
        ...(Array.isArray(e.data?.evidence?.text_unit_ids) ? e.data.evidence.text_unit_ids : []),
      ]).map(Number).filter(Number.isInteger))];
      const textUnits = textUnitIds.length
        ? db.prepare(`SELECT id, source_kind, source_id, title FROM text_units WHERE id IN (${textUnitIds.map(() => '?').join(',')}) LIMIT 25`).all(...textUnitIds)
        : [];
      const evidence = events.slice(0, 10).map(e => ({
        timeline_event_id: e.id,
        type: e.type,
        created_at: e.created_at,
        text_unit_ids: [
          ...(Array.isArray(e.data?.text_unit_ids) ? e.data.text_unit_ids : []),
          ...(Array.isArray(e.data?.source_text_unit_ids) ? e.data.source_text_unit_ids : []),
        ].map(Number).filter(Number.isInteger),
      }));
      let riskLevel = 'unknown';
      let approvalRequired = false;
      const findings = [];
      if (criticalFlags > 0) {
        riskLevel = 'high';
        approvalRequired = true;
        findings.push({ severity: 'high', finding: 'Critical provider or skill safety flags are present.', evidence: evidence.slice(0, 5) });
      } else if (testsFailed > testsPassed && testsFailed > 0) {
        riskLevel = 'high';
        approvalRequired = true;
        findings.push({ severity: 'high', finding: 'Recent tests show more failures than passes.', evidence: evidence.slice(0, 5) });
      } else if (executions.length === 0) {
        riskLevel = 'medium';
        findings.push({ severity: 'medium', finding: 'No recent execution evidence is available.', evidence: evidence.slice(0, 3) });
      } else if (settleRate < 0.5 || failures >= 3) {
        riskLevel = 'high';
        approvalRequired = true;
        findings.push({ severity: 'high', finding: 'Recent executions show low settlement or repeated failures.', evidence: evidence.slice(0, 5) });
      } else if (settleRate < 0.8) {
        riskLevel = 'medium';
        findings.push({ severity: 'medium', finding: 'Settlement rate is below the preferred threshold.', evidence: evidence.slice(0, 5) });
      } else {
        riskLevel = 'low';
        findings.push({ severity: 'low', finding: 'Recent execution evidence is healthy.', evidence: evidence.slice(0, 5) });
      }
      // A do-not-install catalog verdict blocks execution regardless of
      // execution or settlement history.
      const nodeTags = parseJson(node.tags, []);
      const executionBlocked = isBlockedNode(nodeTags);
      if (executionBlocked) {
        riskLevel = 'high';
        approvalRequired = true;
        findings.unshift({
          severity: 'high',
          finding: `Node is tagged do-not-install per catalog verdict; execution is blocked until promoted out of candidate status (tags: ${nodeTags.filter(t => t === 'do-not-install' || t === 'candidate' || t === 'unvetted').join(', ') || nodeTags.join(', ')}).`,
          evidence: [],
        });
      }
      const report = {
        prompt_version: promptVersion('safetyReport'),
        summary: `${node.name}: ${executions.length} recent executions, settle rate ${settleRate === null ? 'unknown' : Math.round(settleRate * 100) + '%'}.`,
        findings,
        evidence,
        text_unit_ids: textUnitIds,
        text_units: textUnits,
        severity: executionBlocked ? 'high' : (findings[0]?.severity ?? 'medium'),
        confidence: executions.length ? Math.min(0.95, 0.5 + executions.length / 100) : 0.4,
        approval_required: approvalRequired,
        risk_level: riskLevel,
        route_eligible: !executionBlocked,
        suppressed: executionBlocked,
        provider_reputation: providerReputation,
        tests: {
          passed: testsPassed,
          failed: testsFailed,
          pass_rate: testPassRate == null ? null : Math.round(testPassRate * 1000) / 1000,
        },
        rating: avgRating == null ? null : Math.round(avgRating * 1000) / 1000,
        critical_flags: criticalFlags,
        risk_action: executionBlocked ? 'execute.blocked' : (approvalRequired ? 'approval.required' : 'execute.allowed'),
      };
      const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`).run(
        'brain-routes',
        'brain:safety-report',
        String(skillId),
        JSON.stringify({
          prompt_version: report.prompt_version,
          risk_level: report.risk_level,
          severity: report.severity,
          approval_required: report.approval_required,
          critical_flags: report.critical_flags,
          text_unit_ids: report.text_unit_ids,
          evidence_timeline_ids: report.evidence.map(e => e.timeline_event_id).filter(Number.isInteger),
        }),
        JSON.stringify(['brain', 'safety', report.prompt_version, report.risk_level]),
      );
      report.timeline_event_id = Number(event.lastInsertRowid);
      return send(res, 200, {
        ok: true,
        data: report,
        meta: { route: '/graph/nodes/:id/safety-report', profile: 'local', prompt_version: report.prompt_version },
        profile: 'local',
        ...report,
      });
    }

    // ── Graph: list/search nodes ──────────────────────────────────────────────
    if (method === 'GET' && path === '/graph/nodes') {
      const nodes = queryNodes({
        q:      searchParams.get('q')      ?? undefined,
        domain: searchParams.get('domain') ?? undefined,
        tag:    searchParams.get('tag')    ?? undefined,
        sort:   searchParams.get('sort')   ?? undefined,
        limit:  Number(searchParams.get('limit')  ?? 20),
        offset: Number(searchParams.get('offset') ?? 0),
      });
      return send(res, 200, { nodes });
    }

    // ── Skills: searchable index ──────────────────────────────────────────────
    if (method === 'GET' && path === '/skills/index') {
      const q = String(searchParams.get('q') ?? '').trim().slice(0, 160);
      const domain = String(searchParams.get('domain') ?? '').trim().slice(0, 80);
      const tag = String(searchParams.get('tag') ?? '').trim().slice(0, 80);
      const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
      const offset = Math.max(0, Number(searchParams.get('offset') ?? 0));
      const sort = String(searchParams.get('sort') ?? 'popular').toLowerCase();
      const graphNodes = queryNodes({ q, domain: domain || undefined, tag: tag || undefined, sort, limit, offset });
      const graphCatalogNodes = queryNodes({ sort: 'popular', limit: 1000, offset: 0 });
      const idaccCatalog = scanIdaccSkillCatalog();
      const usingIdaccCatalog = idaccCatalog.entries.length > 0;
      const mergedCatalog = usingIdaccCatalog
        ? mergeIdaccCatalogWithGraph(idaccCatalog.entries, graphCatalogNodes, { q, domain, tag, sort, limit, offset })
        : null;
      const nodes = mergedCatalog?.nodes ?? graphNodes;
      const catalogNodes = mergedCatalog?.catalogNodes ?? graphCatalogNodes;
      const graphOnlyNodes = mergedCatalog?.graphOnlyNodes ?? [];
      const total = mergedCatalog?.total ?? nodes.length;
      const sourceStats = db.prepare(`SELECT COUNT(*) AS graphRows, MAX(updated_at) AS lastUpdatedAt FROM skill_nodes`).get();
      const generatedAt = new Date().toISOString();
      const lastGraphUpdatedAt = sourceStats?.lastUpdatedAt
        ? new Date(Number(sourceStats.lastUpdatedAt) * 1000).toISOString()
        : null;
      const proposals = buildSkillProposalReport(db, { limit: 250 });
      const counts = nodes.reduce((acc, node) => {
        acc.total += 1;
        acc.chainable += node.chainable ? 1 : 0;
        acc.nonChainable += node.chainable ? 0 : 1;
        acc.byDomain[node.domain || 'knowledge'] = (acc.byDomain[node.domain || 'knowledge'] ?? 0) + 1;
        for (const tagName of node.tags ?? []) {
          acc.byTag[tagName] = (acc.byTag[tagName] ?? 0) + 1;
        }
        return acc;
      }, { total: 0, chainable: 0, nonChainable: 0, byDomain: {}, byTag: {} });
      const domainMap = new Map();
      const tagMap = new Map();
      let chainableCount = 0;
      let computeCostTotal = 0;
      let computeCostSeen = 0;
      let maxUseCount = 0;
      for (const node of catalogNodes) {
        if (node.chainable) chainableCount++;
        if (Number.isFinite(Number(node.computeCost))) {
          computeCostTotal += Number(node.computeCost);
          computeCostSeen++;
        }
        maxUseCount = Math.max(maxUseCount, Number(node.useCount ?? 0));
        const domainKey = node.domain || 'uncategorized';
        const domainRow = domainMap.get(domainKey) ?? { domain: domainKey, count: 0, chainable: 0, tags: new Map(), topSkills: [] };
        domainRow.count++;
        if (node.chainable) domainRow.chainable++;
        if (domainRow.topSkills.length < 5) {
          domainRow.topSkills.push({ skillId: node.skillId, name: node.name, useCount: node.useCount });
        }
        for (const nodeTag of node.tags || []) {
          domainRow.tags.set(nodeTag, (domainRow.tags.get(nodeTag) ?? 0) + 1);
          const tagRow = tagMap.get(nodeTag) ?? { tag: nodeTag, count: 0, domains: new Map(), topSkills: [] };
          tagRow.count++;
          tagRow.domains.set(domainKey, (tagRow.domains.get(domainKey) ?? 0) + 1);
          if (tagRow.topSkills.length < 5) {
            tagRow.topSkills.push({ skillId: node.skillId, name: node.name, domain: node.domain, useCount: node.useCount });
          }
          tagMap.set(nodeTag, tagRow);
        }
        domainMap.set(domainKey, domainRow);
      }
      const domains = [...domainMap.values()]
        .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain))
        .map(row => ({
          domain: row.domain,
          count: row.count,
          chainable: row.chainable,
          topTags: [...row.tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([tagName, count]) => ({ tag: tagName, count })),
          topSkills: row.topSkills,
        }));
      const tags = [...tagMap.values()]
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
        .map(row => ({
          tag: row.tag,
          count: row.count,
          topDomains: [...row.domains.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([domainName, count]) => ({ domain: domainName, count })),
          topSkills: row.topSkills,
        }));
      const tagSummaries = tags.slice(0, 12).map(row => ({ name: row.tag, count: row.count }));
      const domainSummaries = domains.map(row => ({ name: row.domain, count: row.count }));
      const topNodes = catalogNodes.slice(0, Math.min(limit, 20)).map(node => ({ skill_id: node.skillId, name: node.name, use_count: node.useCount }));
      const reuseGroups = [
        ...domains.slice(0, 8).map(row => ({
          kind: 'domain',
          key: `domain:${row.domain}`,
          label: row.domain,
          count: row.count,
          chainable: row.chainable,
          topTags: row.topTags,
          topSkills: row.topSkills,
        })),
        ...tags.slice(0, 8).map(row => ({
          kind: 'tag',
          key: `tag:${row.tag}`,
          label: row.tag,
          count: row.count,
          topDomains: row.topDomains,
          topSkills: row.topSkills,
        })),
      ].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, 12);
      const reuseSuggestions = [
        ...nodes.filter(node => node.chainable),
        ...catalogNodes.filter(node => !nodes.some(match => match.skillId === node.skillId)),
      ].slice(0, 10).map(node => ({
        skillId: node.skillId,
        name: node.name,
        domain: node.domain,
        chainable: node.chainable,
        useCount: node.useCount,
        tags: node.tags,
      }));
      const matchedIds = new Set(nodes.map(node => node.skillId));
      const searchHints = nodes.slice(0, 10).map(node => ({
        skillId: node.skillId,
        name: node.name,
        domain: node.domain,
        tags: node.tags,
        useCount: node.useCount,
        matched: matchedIds.has(node.skillId),
      }));
      return send(res, 200, {
        ok: true,
        data: {
          q,
          domain: domain || null,
          tag: tag || null,
          sort,
          limit,
          offset,
          total,
          counts,
          summary: {
            totalSkills: catalogNodes.length,
            idaccCatalogSkills: idaccCatalog.entries.length,
            brainGraphSkills: graphCatalogNodes.length,
            graphOnlySkills: graphOnlyNodes.length,
            chainable: chainableCount,
            nonChainable: catalogNodes.length - chainableCount,
            domains: domains.length,
            tags: tags.length,
            averageComputeCost: computeCostSeen ? Math.round((computeCostTotal / computeCostSeen) * 100) / 100 : null,
            maxUseCount,
          },
          facets: {
            domains,
            tags,
            chainable: [
              { value: true, count: chainableCount },
              { value: false, count: catalogNodes.length - chainableCount },
            ],
          },
          domains,
          domainSummaries,
          tagSummaries,
          reuseGroups,
          topNodes,
          nodes,
          graphOnlyNodes: graphOnlyNodes.slice(0, 25),
          searchHints,
          reuseSuggestions,
          proposalSummary: proposals.totals,
          proposalGaps: proposals.gaps.slice(0, 25),
        },
        meta: {
          route: '/skills/index',
          profile: 'local',
          generatedAt,
          freshness: {
            generatedAt,
            cacheControl: 'no-store',
            maxAgeSeconds: 0,
          },
          source: {
            authority: usingIdaccCatalog ? 'idacc-library' : 'brain-skill-graph',
            mode: usingIdaccCatalog ? 'idacc library catalog with Brain graph annotations' : 'additive read-only graph index',
            graphRows: Number(sourceStats?.graphRows ?? catalogNodes.length),
            brainGraphRows: graphCatalogNodes.length,
            graphOnlyRows: graphOnlyNodes.length,
            idaccLibraryRows: idaccCatalog.entries.length,
            idaccCatalogError: idaccCatalog.error,
            lastGraphUpdatedAt,
            installAuthority: false,
            localCatalogAuthority: usingIdaccCatalog,
            lifecycleAuthority: false,
            syncOwner: 'IDACC Capabilities',
            writeSurface: usingIdaccCatalog ? 'IDACC Capabilities /library/skills; Brain view is read-only' : 'POST /graph/sync via reviewed IDACC Capabilities skill sync',
          },
        },
        profile: 'local',
      });
    }

    // ── Graph: single node (with neighbors) ───────────────────────────────────
    m = path.match(/^\/graph\/nodes\/(\d+)$/);
    if (method === 'GET' && m) {
      const node = getNodeById(Number(m[1]));
      return node ? send(res, 200, { node }) : send(res, 404, { error: 'not found' });
    }

    // ── Graph: neighbors ─────────────────────────────────────────────────────
    m = path.match(/^\/graph\/nodes\/(\d+)\/neighbors$/);
    if (method === 'GET' && m) {
      const kinds = searchParams.get('kind')?.split(',').filter(Boolean) ?? [];
      return send(res, 200, { neighbors: getNeighbors(Number(m[1]), kinds) });
    }

    // ── Graph: increment use count ────────────────────────────────────────────
    m = path.match(/^\/graph\/nodes\/(\d+)\/use$/);
    if (method === 'POST' && m) {
      STMT.incrUse.run(Number(m[1]));
      return send(res, 200, { ok: true });
    }

    // ── Graph: skill execution stats (aggregated from timeline) ───────────────
    m = path.match(/^\/graph\/nodes\/(\d+)\/stats$/);
    if (method === 'GET' && m) {
      const skillId = m[1];
      const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100);
      const events = db.prepare(
        `SELECT * FROM timeline WHERE source='skillmesh' AND type='skill:executed' AND subject=?
         ORDER BY created_at DESC LIMIT ?`
      ).all(skillId, limit);

      let totalDuration = 0, durationCount = 0;
      let totalPayout   = 0n, payoutCount   = 0;
      let settled       = 0, unsettled     = 0;

      for (const e of events) {
        const d = JSON.parse(e.data ?? '{}');
        const durationMs = Number(d.durationMs ?? d.duration_ms ?? d.latencyMs ?? d.latency_ms);
        if (Number.isFinite(durationMs)) { totalDuration += durationMs; durationCount++; }
        const payoutWei = d.payoutWei ?? d.payout ?? d.payoutAmount;
        if (payoutWei !== undefined && payoutWei !== null && payoutWei !== '') {
          try { totalPayout += BigInt(payoutWei); payoutCount++; } catch {}
        }
        const isSettled = d.settled === true || d.status === 'settled';
        if (isSettled) settled++; else unsettled++;
      }

      const node = STMT.nodeById.get(Number(skillId));
      return send(res, 200, {
        skillId: Number(skillId),
        name: node?.name ?? null,
        executions: events.length,
        useCount: node?.use_count ?? 0,
        settled,
        unsettled,
        settleRate: events.length ? Math.round((settled / events.length) * 100) / 100 : null,
        avgDurationMs: durationCount ? Math.round(totalDuration / durationCount) : null,
        avgPayoutWei: payoutCount ? (totalPayout / BigInt(payoutCount)).toString() : null,
        recent: events.slice(0, 10).map(e => {
          const data = JSON.parse(e.data ?? '{}');
          return {
            timelineEventId: e.id,
            ts: new Date(e.created_at * 1000).toISOString(),
            sessionId: data.sessionId ?? data.session_id ?? null,
            status: data.status ?? (data.settled === true ? 'settled' : data.error ? 'error' : null),
            error: data.error ?? null,
            durationMs: data.durationMs ?? data.duration_ms ?? data.latencyMs ?? data.latency_ms ?? null,
            settled: data.settled === true || data.status === 'settled',
            payoutWei: data.payoutWei ?? data.payout ?? data.payoutAmount ?? null,
            inputRef: data.inputRef ?? data.input_ref ?? null,
            outputRef: data.outputRef ?? data.output_ref ?? null,
            receiptRef: data.receiptRef ?? data.receipt_ref ?? null,
            sourceRef: data.sourceRef ?? data.source_ref ?? null,
            inputHash: data.inputHash ?? data.input_hash ?? null,
            outputHash: data.outputHash ?? data.output_hash ?? null,
            receiptHash: data.receiptHash ?? data.receipt_hash ?? null,
            data,
          };
        }),
      });
    }

    // ── Graph: domains ────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/graph/domains') {
      return send(res, 200, { domains: STMT.domains.all() });
    }

    // ── Entities: per-agent SLA (7d availability + latency from timeline) ─────
    m = path.match(/^\/entities\/agent:([^/]+)\/sla$/);
    if (method === 'GET' && m) {
      const agentName = decodeURIComponent(m[1]);
      const since = Math.floor(Date.now() / 1000) - 7 * 86400;

      // Query-level latency from query:delivered events for this actor
      // Note: timeline records actor as the agent name in our brain-listener flow
      const queries = db.prepare(
        `SELECT created_at, data, type FROM timeline
         WHERE source='idagents' AND subject=? AND created_at > ?
         ORDER BY created_at DESC LIMIT 1000`
      ).all(agentName, since);

      const delivered = [], failed = [];
      for (const e of queries) {
        if (e.type === 'query:delivered') delivered.push(e);
        else if (e.type === 'query:failed') failed.push(e);
      }
      const total = delivered.length + failed.length;
      const availability = total ? delivered.length / total : null;

      // Cost / duration aggregation if agent:cost events exist for this name
      const cost = db.prepare(
        `SELECT data FROM timeline WHERE source='cost-tracker' AND type='agent:cost' AND subject=? AND created_at > ?`
      ).all(agentName, since);
      const durations = [], costs = [];
      for (const e of cost) {
        const d = JSON.parse(e.data ?? '{}');
        if (typeof d.durationMs === 'number') durations.push(d.durationMs);
        if (typeof d.costUsd === 'number') costs.push(d.costUsd);
      }
      durations.sort((a, b) => a - b);
      const p = (arr, q) => arr.length ? arr[Math.floor(arr.length * q)] : null;

      // Probe failures observed from watchdog alerts mentioning this agent
      const probeFailures = db.prepare(
        `SELECT COUNT(*) AS c FROM timeline
         WHERE source='watchdog' AND type='watchdog:alert' AND created_at > ?
         AND data LIKE ?`
      ).get(since, `%${agentName}%`)?.c ?? 0;

      const entity = db.prepare(`SELECT * FROM entities WHERE id=?`).get(`agent:${agentName}`);

      return send(res, 200, {
        agent: agentName,
        windowDays: 7,
        availability: availability !== null ? Math.round(availability * 1000) / 1000 : null,
        queries: { delivered: delivered.length, failed: failed.length, total },
        latencyMs: {
          samples: durations.length,
          p50: p(durations, 0.5),
          p95: p(durations, 0.95),
          p99: p(durations, 0.99),
        },
        cost: {
          samples: costs.length,
          totalUsd: Math.round(costs.reduce((s, c) => s + c, 0) * 10000) / 10000,
          avgUsd:   costs.length ? Math.round((costs.reduce((s, c) => s + c, 0) / costs.length) * 10000) / 10000 : null,
        },
        watchdogProbeFailures: probeFailures,
        currentStatus: entity?.status ?? 'unknown',
        currentModel:  entity ? JSON.parse(entity.data ?? '{}').model : null,
      });
    }

    // ── Graph: path finding ───────────────────────────────────────────────────
    if (method === 'GET' && path === '/graph/path') {
      const fromParam = String(searchParams.get('from') ?? '');
      const toParam = String(searchParams.get('to') ?? '');
      const depth = Math.min(Number(searchParams.get('depth') ?? 6), 10);
      const entityPath = fromParam.startsWith('entity:') && toParam.startsWith('entity:');
      if (entityPath) {
        const from = fromParam.slice('entity:'.length);
        const to = toParam.slice('entity:'.length);
        if (!from || !to) return send(res, 400, { error: 'from and to required' });
        const previous = new Map([[from, null]]);
        let frontier = [from];
        for (let level = 0; level < depth && frontier.length && !previous.has(to); level++) {
          const ph = frontier.map(() => '?').join(',');
          const edges = db.prepare(`
            SELECT from_id, to_id, kind, weight, confidence, provenance, description,
                   evidence_count, text_unit_ids, prompt_version, updated_at
            FROM entity_edges
            WHERE from_id IN (${ph}) OR to_id IN (${ph})
            ORDER BY weight DESC, evidence_count DESC, updated_at DESC
            LIMIT 5000
          `).all(...frontier, ...frontier);
          const frontierSet = new Set(frontier);
          const next = [];
          for (const edge of edges) {
            const a = String(edge.from_id);
            const b = String(edge.to_id);
            const neighbor = frontierSet.has(a) ? b : frontierSet.has(b) ? a : null;
            if (!neighbor || previous.has(neighbor)) continue;
            previous.set(neighbor, { node: frontierSet.has(a) ? a : b, edge });
            next.push(neighbor);
            if (neighbor === to) break;
          }
          frontier = next;
        }
        if (!previous.has(to)) return send(res, 200, { path: null, links: [], found: false });

        const ids = [];
        const pathEdges = [];
        let cursor = to;
        while (cursor) {
          ids.push(cursor);
          const step = previous.get(cursor);
          if (!step) break;
          pathEdges.push(step.edge);
          cursor = step.node;
        }
        ids.reverse();
        pathEdges.reverse();
        const ph = ids.map(() => '?').join(',');
        const nodeMap = new Map(db.prepare(`
          SELECT id, type, name, description, source, status, updated_at
          FROM entities WHERE id IN (${ph})
        `).all(...ids).map(row => [String(row.id), row]));
        const pathNodes = ids.map(id => {
          const row = nodeMap.get(id) || { id, name: id, type: 'entity' };
          return {
            id: `entity:${id}`,
            raw_id: id,
            label: row.name || id,
            type: row.type || 'entity',
            description: row.description || '',
            source: row.source || '',
            status: row.status || '',
            updatedAt: Number(row.updated_at ?? 0),
          };
        });
        const links = pathEdges.map(edge => {
          let provenance = {};
          let textUnitIds = [];
          try { provenance = JSON.parse(edge.provenance || '{}'); } catch {}
          try { textUnitIds = JSON.parse(edge.text_unit_ids || '[]'); } catch {}
          return {
            id: `entity-edge:${edge.from_id}:${edge.to_id}:${edge.kind}`,
            source: `entity:${edge.from_id}`,
            target: `entity:${edge.to_id}`,
            kind: edge.kind,
            type: edge.kind,
            weight: Number(edge.weight ?? 1),
            confidence: Number(edge.confidence ?? 0.5),
            provenance: {
              method: provenance.method || 'asserted',
              source: provenance.source || 'manual',
              evidenceCount: Number(edge.evidence_count ?? 0),
              textUnitIds: Array.isArray(textUnitIds) ? textUnitIds : [],
              promptVersion: String(edge.prompt_version || ''),
            },
            description: edge.description || '',
            updatedAt: Number(edge.updated_at ?? 0),
          };
        });
        return send(res, 200, { path: pathNodes, links, found: true, length: pathNodes.length, graph: 'entities' });
      }

      const from = Number(fromParam.replace(/^skill-node:/, ''));
      const to = Number(toParam.replace(/^skill-node:/, ''));
      if (!Number.isInteger(from) || !Number.isInteger(to)) return send(res, 400, { error: 'from and to required' });
      const path_ = findPath(from, to, depth);
      if (!path_) return send(res, 200, { path: null, found: false });
      const ph = path_.map(() => '?').join(',');
      const nodeMap = new Map(
        db.prepare(`SELECT * FROM skill_nodes WHERE skill_id IN (${ph})`).all(...path_).map(r => [r.skill_id, rowToNode(r)])
      );
      return send(res, 200, { path: path_.map(id => nodeMap.get(id)), found: true, length: path_.length });
    }

    // ── Graph: recommend ─────────────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/recommend') {
      const body = await readBody(req);
      const skills = recommendSkills({
        agentId: body.agentId,
        q:       body.q ?? body.query ?? body.task,
        tags:    body.tags ?? [],
        domain:  body.domain,
        limit:   Number(body.limit ?? 10),
        candidateDiscovery: Boolean(body.candidateDiscovery ?? body.includeCandidates ?? false),
      });
      return send(res, 200, { skills });
    }

    // ── Graph: upsert node ────────────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/nodes') {
      const body = await readBody(req);
      if (!isIntegerValue(body.skillId) || !body.name) return send(res, 400, { error: 'skillId and name required' });
      upsertNode(body);
      return send(res, 200, { ok: true });
    }

    // ── Graph: bulk upsert nodes ──────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/nodes/bulk') {
      const body = await readBody(req);
      if (!Array.isArray(body.nodes)) return send(res, 400, { error: 'nodes array required' });
      let count = 0;
      for (const node of body.nodes) {
        if (!isIntegerValue(node.skillId) || !node.name) continue;
        upsertNode(node);
        count++;
      }
      return send(res, 200, { ok: true, count });
    }

    // ── Graph: upsert edge ────────────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/edges') {
      const body = await readBody(req);
      if (!isIntegerValue(body.from) || !isIntegerValue(body.to) || !body.kind) return send(res, 400, { error: 'from, to, kind required' });
      upsertEdge(body);
      return send(res, 200, { ok: true });
    }

    // ── Graph: bulk upsert edges ──────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/edges/bulk') {
      const body = await readBody(req);
      if (!Array.isArray(body.edges)) return send(res, 400, { error: 'edges array required' });
      let count = 0;
      for (const edge of body.edges) {
        if (!isIntegerValue(edge.from) || !isIntegerValue(edge.to) || !edge.kind) continue;
        upsertEdge(edge);
        count++;
      }
      return send(res, 200, { ok: true, count });
    }

    // ── Graph: connectivity audit + deterministic repair ────────────────────
    if (method === 'GET' && path === '/graph/connectivity') {
      const sampleLimit = searchParams.get('limit') ?? searchParams.get('sample_limit') ?? searchParams.get('sampleLimit') ?? 25;
      return send(res, 200, { ok: true, connectivity: auditBrainConnectivity({ sampleLimit }) });
    }

    if (method === 'POST' && path === '/graph/connectivity/repair') {
      const body = await readBody(req);
      const dryRun = ['1', 'true', 'yes', 'on'].includes(String(body.dryRun ?? body.dry_run ?? false).toLowerCase());
      const source = String(body.source ?? 'brain-connectivity-api').slice(0, 120) || 'brain-connectivity-api';
      const sampleLimit = body.sampleLimit ?? body.sample_limit ?? 25;
      const agentTeam = connectIdaccAgentTeamGraph({ dryRun, source, sampleLimit });
      const sourceBacked = body.agentTeamOnly || body.agent_team_only
        ? { skipped: true, reason: 'agent_team_only' }
        : connectSourceBackedIsolatedEntities({ dryRun, source, sampleLimit });
      const operationalProvenance = body.agentTeamOnly || body.agent_team_only || body.sourceBackedOnly || body.source_backed_only
        ? { skipped: true, reason: 'filtered_by_request' }
        : connectOperationalProvenanceEntities({ dryRun, source, sampleLimit });
      const repair = {
        dryRun,
        agentTeam,
        sourceBacked,
        operationalProvenance,
        after: auditBrainConnectivity({ sampleLimit }),
      };
      return send(res, 200, { ok: true, repair });
    }

    // ── Graph: delete node ────────────────────────────────────────────────────
    m = path.match(/^\/graph\/nodes\/(\d+)$/);
    if (method === 'DELETE' && m) {
      deleteNode(Number(m[1]));
      return send(res, 200, { ok: true });
    }

    // ── Graph: sync node + edges atomically ───────────────────────────────────
    if (method === 'POST' && path === '/graph/sync') {
      const body = await readBody(req);
      const nodes = Array.isArray(body.nodes) ? body.nodes : [body.node ?? body];
      const edges = Array.isArray(body.edges) ? [...body.edges] : [];
      let nodeCount = 0;
      let edgeCount = 0;
      for (const node of nodes) {
        if (!isIntegerValue(node.skillId) || !node.name) continue;
        upsertNode(node);
        nodeCount++;
        appendGraphSyncNodeEdges(node, edges);
      }
      for (const edge of edges) {
        if (!isIntegerValue(edge.from) || !isIntegerValue(edge.to) || !edge.kind) continue;
        upsertEdge(edge);
        edgeCount++;
      }
      if (!nodeCount && !edgeCount) return send(res, 400, { error: 'sync requires at least one valid node or edge' });
      return send(res, 200, { ok: true, nodes: nodeCount, edges: edgeCount });
    }

    // ── Graph: compose skill chain ────────────────────────────────────────────
    if (method === 'POST' && path === '/graph/compose') {
      const b = await readBody(req);
      const result = composeChain({
        goal:        b.goal ?? '',
        agentId:     b.agentId,
        maxSteps:    Math.min(Number(b.maxSteps ?? 8), 12),
        maxCost:     Number(b.maxCost ?? 500),
        mustInclude: Array.isArray(b.mustInclude) ? b.mustInclude : [],
        domain:      b.domain,
      });
      return send(res, 200, result);
    }

    // ── Entities: list/search ────────────────────────────────────────────────
    if (method === 'GET' && path === '/entities') {
      const type   = searchParams.get('type')   ?? undefined;
      const source = searchParams.get('source') ?? undefined;
      const q      = searchParams.get('q')      ?? undefined;
      const limit  = Number(searchParams.get('limit') ?? 50);
      const conds = []; const params = [];
      if (type)   { conds.push('type=?');          params.push(type); }
      if (source) { conds.push('source=?');         params.push(source); }
      if (q)      { conds.push(`(name LIKE ? OR description LIKE ? OR data LIKE ? OR id IN (
                      SELECT entity_id FROM entity_aliases WHERE alias LIKE ? OR normalized LIKE ?
                    ))`);
                    params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q.toLowerCase()}%`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM entities ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit);
      return send(res, 200, { entities: rows.map(rowToEntity) });
    }

    if (method === 'GET' && path === '/communities') {
      const q = searchParams.get('q') ?? '';
      const entityId = searchParams.get('entity_id') ?? searchParams.get('entityId') ?? '';
      const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
      const rows = db.prepare(`SELECT * FROM communities ORDER BY updated_at DESC LIMIT ?`).all(limit)
        .map((row) => ({
          ...row,
          entity_ids: parseJson(row.entity_ids, []),
          metadata: parseJson(row.metadata, {}),
        }))
        .filter((row) => {
          if (entityId && !row.entity_ids.includes(entityId)) return false;
          if (!q) return true;
          const text = `${row.id}\n${row.title}\n${JSON.stringify(row.metadata)}\n${row.entity_ids.join('\n')}`.toLowerCase();
          return text.includes(q.toLowerCase());
        });
      return send(res, 200, { communities: rows });
    }

    if (method === 'GET' && path === '/community-reports') {
      const communityId = searchParams.get('community_id') ?? searchParams.get('communityId') ?? '';
      const promptVersion = searchParams.get('prompt_version') ?? searchParams.get('promptVersion') ?? '';
      const q = searchParams.get('q') ?? '';
      const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200);
      const clauses = [];
      const params = [];
      if (communityId) { clauses.push('community_id=?'); params.push(communityId); }
      if (promptVersion) { clauses.push('prompt_version=?'); params.push(promptVersion); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT * FROM community_reports
        ${where}
        ORDER BY rank DESC, confidence DESC, created_at DESC
        LIMIT ?
      `).all(...params, limit)
        .map((row) => ({
          ...row,
          findings: parseJson(row.findings, []),
          source_text_unit_ids: parseJson(row.source_text_unit_ids, []),
          fact_ids: parseJson(row.fact_ids, []),
        }))
        .filter((row) => {
          if (!q) return true;
          const text = `${row.community_id}\n${row.title}\n${row.summary}\n${JSON.stringify(row.findings)}`.toLowerCase();
          return text.includes(q.toLowerCase());
        });
      return send(res, 200, { reports: rows });
    }

    // ── Entity facts (Plan 22): active facts grouped by field + contradictions ──
    m = path.match(/^\/entities\/(.+)\/facts$/);
    if (method === 'GET' && m) {
      const eid = decodeURIComponent(m[1]);
      const rows = db.prepare(
        `SELECT * FROM facts WHERE entity_id=? AND status='active' ORDER BY field, confidence DESC, observed_at DESC`
      ).all(eid);
      const evidenceForFact = (factId) => db.prepare(`
        SELECT
          ftu.text_unit_id,
          ftu.relation,
          ftu.confidence,
          tu.source_kind,
          tu.source_id,
          tu.title,
          tu.content,
          tu.metadata,
          tu.updated_at
        FROM fact_text_units ftu
        JOIN text_units tu ON tu.id=ftu.text_unit_id
        WHERE ftu.fact_id=?
        ORDER BY ftu.confidence DESC, tu.updated_at DESC
        LIMIT 25
      `).all(factId).map(row => ({
        ...row,
        metadata: parseJson(row.metadata, {}),
      }));
      const fields = {};
      for (const r of rows) {
        const textUnits = evidenceForFact(r.id);
        (fields[r.field] ??= []).push({
          ...r,
          value: parseJson(r.value, null),
          context: parseJson(r.context, {}),
          text_unit_ids: textUnits.map(unit => unit.text_unit_id),
          text_units: textUnits,
        });
      }
      const contradictions = Object.entries(fields)
        .filter(([, vs]) => new Set(vs.map((v) => JSON.stringify(v.value))).size > 1)
        .map(([field, vs]) => ({
          field,
          claims: vs.map((v) => ({
            id: v.id,
            value: v.value,
            source: v.source,
            confidence: v.confidence,
            observed_at: v.observed_at,
            context: v.context,
            text_unit_ids: v.text_unit_ids,
          })),
        }));
      return send(res, 200, {
        entity_id: eid,
        fields,
        contradictions,
        fact_status: {
          served_status: 'active',
          historical_included: false,
          projection: currentFactStatusApiProjection({ entityId: eid }),
        },
      });
    }

    // ── Entities: single ─────────────────────────────────────────────────────
    m = path.match(/^\/entities\/(.+)$/);
    if (method === 'GET' && m) {
      const entityId = decodeURIComponent(m[1]);
      rollupEntityFactsData(entityId);
      const r = db.prepare(`SELECT * FROM entities WHERE id=?`).get(entityId);
      if (!r) return send(res, 404, { error: 'not found' });
      const edges = db.prepare(`SELECT * FROM entity_edges WHERE from_id=? OR to_id=?`).all(r.id, r.id)
        .map(edge => ({
          ...edge,
          type: edge.kind,
          text_unit_ids: parseJson(edge.text_unit_ids, []),
          provenance: parseJson(edge.provenance, { method: 'asserted', source: 'manual' }),
        }));
      return send(res, 200, { entity: rowToEntity(r), edges });
    }

    // ── Entities: upsert ─────────────────────────────────────────────────────
    if (method === 'POST' && path === '/entities') {
      const b = await readBody(req);
      if (!b.id || !b.type || !b.name) return send(res, 400, { error: 'id, type, name required' });
      const entity = upsertEntity(b);
      if (entity.action === 'merged-alias') {
        recordAliasMergeTimeline({ source: b.source ?? 'manual', entityId: entity.id, mergedFrom: entity.mergedFrom, aliases: b.aliases ?? [], name: b.name });
      }
      return send(res, 200, { ok: true, entity });
    }

    // ── Entities: bulk upsert ────────────────────────────────────────────────
    if (method === 'POST' && path === '/entities/bulk') {
      const b = await readBody(req);
      if (!Array.isArray(b.entities)) return send(res, 400, { error: 'entities array required' });
      let count = 0;
      const results = [];
      for (const e of b.entities) {
        if (!e.id||!e.type||!e.name) continue;
        const entity = upsertEntity(e);
        results.push(entity);
        if (entity.action === 'merged-alias') {
          recordAliasMergeTimeline({ source: e.source ?? 'manual', entityId: entity.id, mergedFrom: entity.mergedFrom, aliases: e.aliases ?? [], name: e.name });
        }
        count++;
      }
      const summary = results.reduce((acc, entity) => {
        acc[entity.action] = (acc[entity.action] ?? 0) + 1;
        return acc;
      }, {});
      return send(res, 200, { ok: true, count, summary, entities: results });
    }

    // ── Entity edges: upsert ─────────────────────────────────────────────────
    if (method === 'POST' && path === '/entity-edges') {
      const b = await readBody(req);
      const edge = normalizeEntityEdgeWrite(b);
      if (!edge) return send(res, 400, { error: 'from, to, kind or type required' });
      upsertEntityEdge(edge);
      return send(res, 200, { ok: true, type: edge.kind });
    }

    // ── Entity edges: bulk ───────────────────────────────────────────────────
    if (method === 'POST' && path === '/entity-edges/bulk') {
      const b = await readBody(req);
      if (!Array.isArray(b.edges)) return send(res, 400, { error: 'edges array required' });
      const edges = b.edges.map(normalizeEntityEdgeWrite);
      // Preserve the prior bulk behavior of ignoring incomplete edges, but
      // validate every complete one before making any writes.
      for (const edge of edges) if (edge) validateEntityEdgeSemantics(edge);
      let count = 0;
      for (const edge of edges) {
        if (!edge) continue;
        upsertEntityEdge(edge);
        count++;
      }
      return send(res, 200, { ok: true, count, skipped: edges.length - count });
    }

    if (path === '/facts/export' && method !== 'GET') {
      const body = JSON.stringify({
        error: {
          type: 'method_not_allowed',
          message: 'use GET /facts/export',
        },
      });
      res.writeHead(405, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Allow': 'GET',
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && path === '/facts/export') {
      const status = String(searchParams.get('status') ?? 'active').toLowerCase();
      if (!['active', 'superseded', 'disputed', 'all'].includes(status)) return send(res, 400, { error: 'invalid status' });
      const sort = String(searchParams.get('sort') ?? 'observed_at').toLowerCase();
      if (sort !== 'observed_at') return send(res, 400, { error: 'invalid sort' });
      const direction = String(searchParams.get('direction') ?? 'asc').toLowerCase();
      if (!['asc', 'desc'].includes(direction)) return send(res, 400, { error: 'invalid direction' });
      const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 100) || 100, 1), 500);
      const entityId = String(searchParams.get('entity_id') ?? searchParams.get('entityId') ?? '').trim();
      const rawCursor = searchParams.get('cursor') ?? '';
      const cursor = rawCursor ? decodeFactsExportCursor(rawCursor) : null;
      if (rawCursor && !cursor) return send(res, 400, { error: 'invalid cursor' });

      const baseWhere = factExportBaseWhere({ status, entityId });
      const cursorWhere = factExportCursorWhere(cursor, direction);
      const whereClause = baseWhere.clause
        ? `${baseWhere.clause}${cursorWhere.clause}`
        : cursorWhere.clause
          ? `WHERE ${cursorWhere.clause.replace(/^ AND /, '')}`
          : '';
      const orderClause = `ORDER BY observed_at ${direction.toUpperCase()}, id ${direction.toUpperCase()}`;
      const pageRows = db.prepare(`
        SELECT *
        FROM facts
        ${whereClause}
        ${orderClause}
        LIMIT ?
      `).all(...baseWhere.params, ...cursorWhere.params, limit + 1);
      const hasMore = pageRows.length > limit;
      const visibleRows = hasMore ? pageRows.slice(0, limit) : pageRows;
      const decoratedRows = decorateFactRowsWithReuseAccounting(visibleRows);
      const generatedAt = Math.floor(Date.now() / 1000);
      const matchingTotal = Number(db.prepare(`
        SELECT COUNT(*) AS c
        FROM facts
        ${baseWhere.clause}
      `).get(...baseWhere.params)?.c ?? 0);
      const byStatusRows = db.prepare(`
        SELECT status, COUNT(*) AS c
        FROM facts
        ${baseWhere.clause}
        GROUP BY status
      `).all(...baseWhere.params);
      const byStatus = { active: 0, superseded: 0, disputed: 0 };
      for (const row of byStatusRows) {
        if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = Number(row.c ?? 0);
      }
      const activeScopeWhere = factExportBaseWhere({ status: 'active', entityId });
      const healthActiveFacts = Number(db.prepare(`
        SELECT COUNT(*) AS c
        FROM facts
        ${activeScopeWhere.clause}
        `).get(...activeScopeWhere.params)?.c ?? 0);
      const scopeProjection = currentFactStatusApiProjection({ entityId });
      const facts = decoratedRows.map(formatFactExportRow);
      const lastVisible = visibleRows[visibleRows.length - 1] ?? null;
      const response = {
        ok: true,
        schema: 'brain.facts-export.v1',
        read_only: true,
        filters: {
          status,
          ...(entityId ? { entity_id: entityId } : {}),
          limit,
          sort,
          direction,
        },
        page: {
          count: facts.length,
          next_cursor: hasMore && lastVisible ? encodeFactsExportCursor(lastVisible) : null,
          has_more: hasMore,
          watermark: {
            max_id_seen: facts.length ? Math.max(...facts.map((fact) => fact.id)) : null,
            generated_at: generatedAt,
          },
        },
        totals: {
          matching: matchingTotal,
          health_active_facts: healthActiveFacts,
          by_status: byStatus,
          scope_total: scopeProjection.facts_total,
          scope_by_status: { ...scopeProjection.by_status, other: scopeProjection.other },
          serving_active: scopeProjection.serving_active_facts,
          orphan_by_status: { ...scopeProjection.orphan_by_status, other: scopeProjection.orphan_other },
          status_projection: scopeProjection,
        },
        facts,
      };
      if (!entityId && status === 'active') {
        response.reconciliation = {
          health_route: '/health',
          health_field: 'facts',
          health_scope: 'status=active',
          matches_health: matchingTotal === Number(STMT.factCount.get().c ?? 0),
          health_active_facts: Number(STMT.factCount.get().c ?? 0),
          export_active_facts: matchingTotal,
        };
      }
      return send(res, 200, response);
    }

    // ── Facts: read-only referential-integrity maintenance check ─────────────
    if (method === 'GET' && path === '/facts/integrity') {
      const limit = Math.min(Math.max(Number(searchParams.get('limit') ?? 25) || 25, 1), 200);
      return send(res, 200, {
        ok: true,
        read_only: true,
        ...factIntegrityApiProjection(checkFactEntityIntegrity({ limit })),
      });
    }

    // ── Facts: append (Plan 22, hybrid merge) ────────────────────────────────
    if (method === 'POST' && path === '/facts') {
      const b = await readBody(req);
      const entityId = normalizeFactEntityId(b.entity_id);
      if (!entityId || !b.field || b.value === undefined || !b.source)
        return send(res, 400, { error: 'entity_id, field, value, source required' });
      try { factEntityWriteTarget(entityId); }
      catch (error) { return factWriteErrorResponse(res, error, entityId); }
      return send(res, 200, { ok: true, ...upsertFact({ ...b, entity_id: entityId }) });
    }

    // ── Facts: bulk append ────────────────────────────────────────────────────
    if (method === 'POST' && path === '/facts/bulk') {
      const b = await readBody(req);
      if (!Array.isArray(b.facts)) return send(res, 400, { error: 'facts array required' });
      let idempotencyKey;
      try {
        idempotencyKey = normalizeIdempotencyKey(
          b.idempotency_key ?? b.idempotencyKey ?? null,
        );
      } catch (error) {
        return send(res, error.status ?? 400, idempotencyErrorBody(error));
      }
      const canonicalContent = { facts: b.facts };
      let transactionOpen = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        const receipt = readIdempotencyReceipt(db, {
          scope: 'facts.bulk',
          idempotencyKey,
          canonicalContent,
        });
        if (receipt) {
          db.exec('COMMIT');
          transactionOpen = false;
          return send(res, 200, { ...receipt.result, deduplicated: true });
        }

        let count = 0, contradictions = 0;
        const results = [];
        const skippedItems = [];
        for (const [index, f] of b.facts.entries()) {
          const entityId = normalizeFactEntityId(f?.entity_id);
          if (!entityId || !f?.field || f.value === undefined || !f?.source) {
            skippedItems.push({ index, error: 'entity_id, field, value, source required' });
            continue;
          }
          try { factEntityWriteTarget(entityId); }
          catch (error) {
            skippedItems.push({
              index,
              error: error?.message ?? 'fact entity not found',
              error_detail: factWriteErrorDetail(error, entityId),
              code: error?.code ?? 'fact_entity_not_found',
              entity_id: String(error?.entityId ?? entityId),
              rejected: true,
              quarantined: true,
            });
            continue;
          }
          const r = upsertFact({ ...f, entity_id: entityId });
          count++;
          if (r.contradiction) contradictions++;
          results.push({ index, ...r });
        }
        const response = {
          ok: true,
          count,
          contradictions,
          skipped: skippedItems.length,
          skippedItems,
          results,
        };
        writeIdempotencyReceipt(db, {
          scope: 'facts.bulk',
          idempotencyKey,
          canonicalContent,
          result: response,
        });
        db.exec('COMMIT');
        transactionOpen = false;
        return send(res, 200, { ...response, deduplicated: false });
      } catch (error) {
        if (transactionOpen) {
          try { db.exec('ROLLBACK'); } catch {}
        }
        if (error?.status) return send(res, error.status, idempotencyErrorBody(error));
        throw error;
      }
    }

    m = path.match(/^\/facts\/(\d+)\/status$/);
    if (method === 'POST' && m) {
      const b = await readBody(req);
      const status = b.status ?? '';
      if (!['active', 'superseded', 'disputed'].includes(status)) return send(res, 400, { error: 'invalid status' });
      const source = String(b.source ?? '').trim();
      if (!/\bcurator\b/i.test(source)) {
        return send(res, 403, {
          error: 'fact status changes require a curator source',
          hint: 'ordinary agents should submit learned artifacts, feedback, or approval requests instead of changing fact status directly',
        });
      }
      const fact = db.prepare(`SELECT * FROM facts WHERE id=?`).get(Number(m[1]));
      if (!fact) return send(res, 404, { error: 'fact not found' });
      db.prepare(`UPDATE facts SET status=? WHERE id=?`).run(status, Number(m[1]));
      rollupEntityFactsData(fact.entity_id);
      const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
        .run(
          source,
          'fact:status-updated',
          fact.entity_id,
          JSON.stringify({ fact_id: Number(m[1]), field: fact.field, from_status: fact.status, to_status: status, reason: b.reason ?? '', resolution: b.resolution ?? {} }),
          JSON.stringify(['brain', 'fact', status]),
        );
      return send(res, 200, { ok: true, id: Number(m[1]), status, timelineEventId: Number(event.lastInsertRowid) });
    }

    function producerContentFromBody(kind, b) {
      const explicit = String(b.content ?? '').trim();
      if (explicit) return explicit;
      if (kind === 'timeline-rollup') {
        const ids = Array.isArray(b.timeline_event_ids ?? b.timelineEventIds) ? (b.timeline_event_ids ?? b.timelineEventIds).map(Number).filter(Number.isInteger) : [];
        const limit = Math.min(Number(b.limit ?? 20), 100);
        const rows = ids.length
          ? db.prepare(`SELECT * FROM timeline WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(...ids)
          : db.prepare(`SELECT * FROM timeline ORDER BY created_at DESC LIMIT ?`).all(limit).reverse();
        return rows.map(row => [
          `Timeline event ${row.id}: ${row.type}`,
          `Source: ${row.source}`,
          `Subject: ${row.subject}`,
          `Created: ${row.created_at}`,
          `Data: ${JSON.stringify(parseJson(row.data, {}))}`,
        ].join('\n')).join('\n\n');
      }
      if (kind === 'memory-summary') {
        const ids = Array.isArray(b.memory_ids ?? b.memoryIds) ? (b.memory_ids ?? b.memoryIds).map(Number).filter(Number.isInteger) : [];
        const agentId = String(b.agent_id ?? b.agentId ?? '');
        const rows = ids.length
          ? db.prepare(`SELECT * FROM agent_memories WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(...ids)
          : db.prepare(`SELECT * FROM agent_memories WHERE agent_id=? ORDER BY created_at DESC LIMIT ?`).all(agentId, Math.min(Number(b.limit ?? 20), 100)).reverse();
        return rows.map(row => `Memory ${row.id} [${row.agent_id}/${row.mem_key ?? 'unkeyed'}]: ${row.content}`).join('\n');
      }
      if (kind === 'skill-definition') {
        const skillId = Number(b.skill_id ?? b.skillId ?? b.subject);
        const row = Number.isInteger(skillId) ? getNodeById(skillId) : null;
        const skill = b.skill ?? {};
        return [
          `Skill: ${row?.name ?? skill.name ?? b.name ?? b.subject ?? 'unnamed skill'}`,
          `ID: ${row?.skill_id ?? skillId ?? skill.skill_id ?? ''}`,
          `Domain: ${row?.domain ?? skill.domain ?? ''}`,
          `Description: ${row?.description ?? skill.description ?? b.description ?? ''}`,
          `Tags: ${JSON.stringify(row?.tags ?? skill.tags ?? [])}`,
          `Definition: ${JSON.stringify(skill)}`,
        ].join('\n');
      }
      if (kind === 'operational-report') {
        return [
          `Report: ${b.title ?? b.subject ?? 'operational report'}`,
          `Summary: ${b.summary ?? ''}`,
          `Report data: ${JSON.stringify(b.report ?? b.data ?? {})}`,
        ].join('\n');
      }
      if (kind === 'fact-context') {
        const factId = Number(b.fact_id ?? b.factId);
        const row = Number.isInteger(factId) ? db.prepare(`SELECT * FROM facts WHERE id=?`).get(factId) : null;
        return [
          `Fact context: ${factId || b.subject || ''}`,
          row ? `Entity: ${row.entity_id}` : '',
          row ? `Field: ${row.field}` : '',
          row ? `Value: ${row.value}` : '',
          row ? `Source: ${row.source}` : '',
          row ? `Context: ${row.context}` : '',
          `Notes: ${b.notes ?? b.summary ?? ''}`,
        ].filter(Boolean).join('\n');
      }
      return '';
    }

    function textUnitProducerInput(b = {}) {
      const producerKind = String(b.producer_kind ?? b.producerKind ?? b.kind ?? '').trim();
      const allowed = new Set(['project-doc', 'timeline-rollup', 'memory-summary', 'skill-definition', 'operational-report', 'fact-context']);
      if (!allowed.has(producerKind)) {
        throw Object.assign(new Error('unsupported text-unit producer kind'), { status: 400 });
      }
      const sourceKind = String(b.source_kind ?? b.sourceKind ?? producerKind);
      const sourceId = String(b.source_id ?? b.sourceId ?? `${producerKind}:${createHash('sha1').update(JSON.stringify(b)).digest('hex').slice(0, 12)}`);
      const content = producerContentFromBody(producerKind, b);
      if (!content.trim()) throw Object.assign(new Error('producer content required'), { status: 400 });
      const title = String(b.title ?? `${producerKind} ${sourceId}`);
      const metadata = {
        ...(b.metadata ?? {}),
        producer_kind: producerKind,
        producer_version: 'brain.producer.v1',
        source_ref: { kind: sourceKind, id: sourceId },
        ...(b.fact_id || b.factId ? { fact_id: Number(b.fact_id ?? b.factId) } : {}),
      };
      const processConfig = {
        strategy: 'recursive',
        parser: `producer:${producerKind}`,
        prompt_version: 'brain.producer.v1',
        ...(b.process_config ?? b.processConfig ?? {}),
        extraction_config: {
          producer_kind: producerKind,
          ...((b.process_config ?? b.processConfig ?? {}).extraction_config ?? (b.process_config ?? b.processConfig ?? {}).extractionConfig ?? {}),
        },
      };
      return { producerKind, sourceKind, sourceId, title, content, metadata, processConfig };
    }

    // ── Source/evidence ingest: chunk source material into auditable text units ─
    if (method === 'POST' && path === '/text-units/produce') {
      const b = await readBody(req);
      try {
        const input = textUnitProducerInput(b);
        const result = upsertTextUnitsFromSource({
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
          title: input.title,
          content: input.content,
          metadata: input.metadata,
          parentTextUnitId: b.parent_text_unit_id ?? b.parentTextUnitId ?? null,
          processConfig: input.processConfig,
        });
        const factId = Number(b.fact_id ?? b.factId);
        const factLinks = Number.isInteger(factId)
          ? linkFactToTextUnits(factId, result.textUnitIds, { relation: 'context', confidence: 0.9 })
          : 0;
        return send(res, 200, { ok: true, producerKind: input.producerKind, ...result, factLinks: (result.factLinks ?? 0) + factLinks });
      } catch (error) {
        return send(res, error.status ?? 500, { error: error.message ?? 'text-unit producer failed' });
      }
    }

    if (method === 'POST' && path === '/text-units/ingest') {
      const b = await readBody(req);
      if (!b.source_kind && !b.sourceKind) return send(res, 400, { error: 'source_kind required' });
      if (!b.source_id && !b.sourceId) return send(res, 400, { error: 'source_id required' });
      if (!b.content) return send(res, 400, { error: 'content required' });
      const result = upsertTextUnitsFromSource({
        sourceKind: b.source_kind ?? b.sourceKind,
        sourceId: b.source_id ?? b.sourceId,
        title: b.title ?? '',
        content: b.content,
        metadata: b.metadata ?? {},
        parentTextUnitId: b.parent_text_unit_id ?? b.parentTextUnitId ?? null,
        processConfig: b.process_config ?? b.processConfig ?? {},
      });
      return send(res, 200, { ok: true, ...result });
    }

    // ── Source/evidence read ─────────────────────────────────────────────────
    m = path.match(/^\/text-units\/(\d+)$/);
    if (method === 'GET' && m) {
      const unit = db.prepare(`SELECT * FROM text_units WHERE id=?`).get(Number(m[1]));
      if (!unit) return send(res, 404, { error: 'not found' });
      const links = db.prepare(`SELECT * FROM entity_text_units WHERE text_unit_id=?`).all(Number(m[1]));
      const factLinks = db.prepare(`
        SELECT ftu.*, f.entity_id, f.field, f.value, f.source, f.confidence AS fact_confidence, f.status
        FROM fact_text_units ftu
        JOIN facts f ON f.id=ftu.fact_id
        WHERE ftu.text_unit_id=?
        ORDER BY ftu.confidence DESC, f.observed_at DESC
      `).all(Number(m[1])).map(row => ({
        ...row,
        value: parseJson(row.value, null),
      }));
      return send(res, 200, {
        textUnit: {
          ...unit,
          source_metadata: parseJson(unit.source_metadata, {}),
          process_config: parseJson(unit.process_config, {}),
          metadata: parseJson(unit.metadata, {}),
        },
        entityLinks: links,
        factLinks,
      });
    }

    if (method === 'GET' && path === '/text-units') {
      const q = searchParams.get('q') ?? '';
      const sourceKind = searchParams.get('source_kind') ?? searchParams.get('sourceKind');
      const limit = Math.min(Number(searchParams.get('limit') ?? 20), 100);
      const conds = []; const params = [];
      if (q) { conds.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
      if (sourceKind) { conds.push('source_kind=?'); params.push(sourceKind); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM text_units ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, limit)
        .map(r => ({
          ...r,
          source_metadata: parseJson(r.source_metadata, {}),
          process_config: parseJson(r.process_config, {}),
          metadata: parseJson(r.metadata, {}),
        }));
      return send(res, 200, { textUnits: rows });
    }

    // ── Deterministic indexing phase for cycle/orchestrator callers ──────────
    if (method === 'POST' && path === '/brain/index') {
      const b = await readBody(req);
      const relinkLimit = Math.min(Number(b.relinkLimit ?? 500), 5000);
      const ids = db.prepare(`SELECT id FROM text_units ORDER BY updated_at DESC LIMIT ?`).all(relinkLimit).map(r => r.id);
      let entityLinks = 0;
      let factLinks = 0;
      for (const id of ids) {
        entityLinks += linkTextUnitToEntities(id);
        factLinks += linkFactsForTextUnit(id);
      }
      const inferred = inferEdgesFromTextUnits({ limit: Math.min(Number(b.edgeLimit ?? 500), 5000) });
      const communities = buildDeterministicCommunities();
      const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
        .run('brain-cycle', 'brain:indexed', 'deterministic', JSON.stringify({ entityLinks, factLinks, ...inferred, ...communities }), JSON.stringify(['brain', 'index']));
      return send(res, 200, { ok: true, entityLinks, factLinks, ...inferred, ...communities, timelineEventId: Number(event.lastInsertRowid) });
    }

    // Approval create/list/get/resolve routes live in routes/approvals.mjs.
    m = path.match(/^\/(?:approvals|proposals)\/(\d+)\/apply$/);
    if (method === 'POST' && m) {
      const b = await readBody(req);
      const approvalId = Number(m[1]);
      const approval = db.prepare(`SELECT * FROM approvals WHERE id=?`).get(approvalId);
      const vectorCapability = sqliteVecStatus();
      if (!approval) {
        return send(res, 404, operatorError('brain.not_found', 'approval not found', 'check the approval id before apply'));
      }
      const payload = parseJson(approval.payload, {});
      const expectedStamp = b.expectedStamp ?? b.expectedApprovalStamp;
      if (expectedStamp && expectedStamp !== approvalSnapshotStamp(approval)) {
        return send(res, 409, operatorError(
          'brain.conflict',
          'approval changed since review',
          'refresh the approval queue and review the current payload before applying',
          { approval_id: approvalId, current_status: approval.status },
          { level: 'medium', action: 'refresh' },
        ));
      }
      if (approval.status !== 'approved') {
        return send(res, 409, operatorError('brain.conflict', 'approval must be approved before apply', 'resolve the queue item to approved before apply'));
      }
      const vectorGate = normalizeVectorExecutionGate(payload);
      if (vectorGate.required && !vectorCapability.available && !vectorGate.allowFallback) {
        return send(res, 412, operatorError(
          'brain.vector_disabled',
          'approval requires native vector capability before execution',
          'enable sqlite-vec support or relax the approval execution gate to allow lexical fallback',
          {
            vector_capability: vectorCapability,
            execution_gate: vectorGate,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: false }),
          },
          { level: 'high', action: 'execution-blocked' },
        ));
      }
      if (approval.kind === 'memory.retire') {
        const authorizationConfig = AUTHORIZATION_APPROVAL_KINDS[approval.kind];
        const confirmationPhrase = String(payload.confirmation_phrase ?? payload.confirmationPhrase ?? approval.subject ?? approval.kind);
        const confirmed = b.confirm === true
          || b.confirmed === true
          || (b.confirmation != null && String(b.confirmation) === confirmationPhrase);
        if (authorizationConfig?.confirmationRequired && !confirmed) {
          return send(res, 412, operatorError(
            'brain.confirmation_required',
            `${authorizationConfig.description} requires explicit confirmation before authorization`,
            'repeat the apply request with confirm=true or the configured confirmation phrase',
            {
              confirmation_required: true,
              operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: false }),
            },
            { level: 'high', action: 'confirmation-required' },
          ));
        }
        const memoryId = Number(b.memory_id ?? b.memoryId ?? payload.memory_id ?? payload.memoryId);
        if (!Number.isInteger(memoryId)) {
          return send(res, 400, operatorError('brain.validation', 'memory_id required', 'provide memory_id in the request body or approval payload'));
        }
        const memory = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(memoryId);
        if (!memory) return send(res, 404, operatorError('brain.not_found', 'memory not found', 'check the memory id before apply'));
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE agent_memories SET status='retired' WHERE id=?`).run(memoryId);
          const afterMemory = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(memoryId);
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            memory_id: memoryId,
            retired_memory: {
              agent_id: memory.agent_id,
              key: memory.mem_key,
              content: memory.content,
              tags: parseJson(memory.tags, []),
              visibility: memory.visibility,
              created_at: memory.created_at,
            },
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'memory.restore',
            beforeState: { memory },
            afterState: { memory: afterMemory, memory_id: memoryId },
            metadata: { reason: resolution.reason },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'approval:applied',
              approval.subject,
              JSON.stringify({ approval_id: approvalId, kind: approval.kind, memory_id: memoryId, reason: resolution.reason, retired_memory: resolution.retired_memory, status: 'retired', rollback_record_id: rollbackRecordId }),
              JSON.stringify(['brain', 'approval', 'memory']),
            );
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            memoryId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'skill.revise' || approval.kind === 'skill.remove') {
        const eventType = approval.kind === 'skill.revise' ? 'skill:revision-task' : 'skill:remove-decision';
        const skillId = Number(b.skill_id ?? b.skillId ?? payload.skill_id ?? payload.skillId);
        db.exec('BEGIN IMMEDIATE');
        try {
          let disabled = false;
          let previousSkill = null;
          let previousEntity = null;
          if (approval.kind === 'skill.remove' && Number.isInteger(skillId)) {
            previousSkill = db.prepare(`SELECT * FROM skill_nodes WHERE skill_id=?`).get(skillId) ?? null;
            previousEntity = db.prepare(`SELECT * FROM entities WHERE id=?`).get(`skill:${skillId}`) ?? null;
            db.prepare(`UPDATE skill_nodes SET chainable=0, updated_at=unixepoch() WHERE skill_id=?`).run(skillId);
            db.prepare(`UPDATE entities SET status='retire-approved', updated_at=unixepoch() WHERE id=?`).run(`skill:${skillId}`);
            disabled = true;
          }
          const evidenceIds = {
            source_text_unit_ids: payload.source_text_unit_ids ?? payload.sourceTextUnitIds ?? [],
            fact_ids: payload.fact_ids ?? payload.factIds ?? [],
            timeline_event_ids: payload.timeline_event_ids ?? payload.timelineEventIds ?? [],
          };
          const learningTaskId = approval.kind === 'skill.revise'
            ? createLearningTask({
                kind: 'skill.revision',
                subject: payload.gap ?? approval.subject,
                approvalId,
                assignee: b.assignee ?? payload.assignee ?? '',
                priority: Number(b.priority ?? payload.priority ?? payload.demand ?? 0) || 0,
                evidenceIds,
                payload: {
                  approval_kind: approval.kind,
                  gap: payload.gap ?? approval.subject,
                  skill_id: Number.isInteger(skillId) ? skillId : null,
                  reason: b.reason ?? payload.suggested_reason ?? '',
                  approval_payload: payload,
                },
              })
            : null;
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: approval.kind === 'skill.remove' ? 'skill.enable' : 'learning_task.cancel',
            beforeState: approval.kind === 'skill.remove'
              ? { skill: previousSkill, entity: previousEntity }
              : { learning_task_existed: false },
            afterState: approval.kind === 'skill.remove'
              ? { disabled, skill_id: Number.isInteger(skillId) ? skillId : null }
              : { learning_task_id: learningTaskId },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '', evidence_ids: evidenceIds },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              eventType,
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                kind: approval.kind,
                gap: payload.gap ?? approval.subject,
                skill_id: Number.isInteger(skillId) ? skillId : null,
                disabled,
                learning_task_id: learningTaskId,
                rollback_record_id: rollbackRecordId,
                payload,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'skill']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            event_type: eventType,
            timeline_event_id: Number(event.lastInsertRowid),
            learning_task_id: learningTaskId,
            skill_id: Number.isInteger(skillId) ? skillId : null,
            disabled,
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            eventType,
            timelineEventId: Number(event.lastInsertRowid),
            disabled,
            learningTaskId,
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'team.instruction.retire') {
        const memoryId = Number(b.memory_id ?? b.memoryId ?? payload.memory_id ?? payload.memoryId);
        if (!Number.isInteger(memoryId)) {
          return send(res, 400, operatorError('brain.validation', 'memory_id required', 'provide memory_id for the instruction to retire'));
        }
        const memory = db.prepare(`SELECT * FROM agent_memories WHERE id=? AND agent_id='team-instructions'`).get(memoryId);
        if (!memory) return send(res, 404, operatorError('brain.not_found', 'instruction memory not found', 'check the team instruction memory id'));
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE agent_memories SET status='retired' WHERE id=?`).run(memoryId);
          const afterMemory = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(memoryId);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'memory.status.restore',
            beforeState: { memory },
            afterState: { memory: afterMemory },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'team:instruction-retired',
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                memory_id: memoryId,
                key: memory.mem_key,
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'learning', 'instruction']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            memory_id: memoryId,
            key: memory.mem_key,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            memoryId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'team.instruction.supersede') {
        const memoryId = Number(b.memory_id ?? b.memoryId ?? payload.memory_id ?? payload.memoryId);
        const instruction = String(b.instruction ?? payload.replacement_instruction ?? payload.proposed_instruction ?? '').trim();
        if (!Number.isInteger(memoryId)) {
          return send(res, 400, operatorError('brain.validation', 'memory_id required', 'provide memory_id for the instruction to supersede'));
        }
        if (!instruction) {
          return send(res, 400, operatorError('brain.validation', 'replacement instruction required', 'include replacement_instruction in the approval payload or instruction in the apply body'));
        }
        const beforeMemory = db.prepare(`SELECT * FROM agent_memories WHERE id=? AND agent_id='team-instructions'`).get(memoryId);
        if (!beforeMemory) return send(res, 404, operatorError('brain.not_found', 'instruction memory not found', 'check the team instruction memory id'));
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`UPDATE agent_memories SET status='superseded' WHERE id=?`).run(memoryId);
          const stored = storeMemory({
            agentId: 'team-instructions',
            key: beforeMemory.mem_key,
            content: instruction,
            tags: [...new Set([...parseJson(beforeMemory.tags, []), 'team-instruction', 'self-learning'])],
            shared: true,
            project: payload.project ?? beforeMemory.project ?? '',
            taskId: payload.task_id ?? payload.taskId ?? beforeMemory.task_id ?? '',
            sessionId: payload.session_id ?? payload.sessionId ?? beforeMemory.session_id ?? '',
            userId: payload.user_id ?? payload.userId ?? beforeMemory.user_id ?? '',
            turnId: payload.turn_id ?? payload.turnId ?? beforeMemory.turn_id ?? '',
            supersedes: memoryId,
          });
          const afterMemory = db.prepare(`SELECT * FROM agent_memories WHERE id=?`).get(stored.id);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'memory.restore',
            beforeState: { memory: beforeMemory },
            afterState: { memory: afterMemory },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'team:instruction-superseded',
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                previous_memory_id: memoryId,
                memory_id: afterMemory?.id ?? null,
                key: beforeMemory.mem_key,
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'learning', 'instruction']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            previous_memory_id: memoryId,
            memory_id: afterMemory?.id ?? null,
            key: beforeMemory.mem_key,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            memoryId: afterMemory?.id ?? null,
            previousMemoryId: memoryId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'team.instruction.update') {
        const instruction = String(b.instruction ?? payload.proposed_instruction ?? '').trim();
        if (!instruction) {
          return send(res, 400, operatorError('brain.validation', 'instruction required', 'include the proposed instruction in the approval payload or apply request body'));
        }
        const key = `instruction:${payload.correction_class ?? approval.subject}`.slice(0, 180);
        db.exec('BEGIN IMMEDIATE');
        try {
          const beforeMemory = db.prepare(`SELECT * FROM agent_memories WHERE agent_id=? AND mem_key=? AND ${LIVE} AND status='active'`)
            .get('team-instructions', key) ?? null;
          if (beforeMemory) {
            db.prepare(`UPDATE agent_memories SET status='superseded' WHERE id=?`).run(beforeMemory.id);
          }
          storeMemory({
            agentId: 'team-instructions',
            key,
            content: instruction,
            tags: ['team-instruction', 'self-learning', payload.correction_class ?? 'correction'],
            shared: true,
            project: payload.project ?? '',
            taskId: payload.task_id ?? payload.taskId ?? '',
            supersedes: beforeMemory?.id ?? null,
          });
          const afterMemory = db.prepare(`SELECT * FROM agent_memories WHERE agent_id=? AND mem_key=? AND ${LIVE} AND status='active'`)
            .get('team-instructions', key);
          if (beforeMemory && afterMemory) {
            db.prepare(`UPDATE agent_memories SET superseded_by=? WHERE id=?`).run(afterMemory.id, beforeMemory.id);
          }
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: beforeMemory ? 'memory.restore' : 'memory.delete',
            beforeState: { memory: beforeMemory },
            afterState: { memory: afterMemory },
            metadata: {
              correction_class: payload.correction_class ?? '',
              evidence_timeline_ids: payload.evidence_timeline_ids ?? [],
              reason: b.reason ?? payload.suggested_reason ?? '',
            },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'team:instruction-updated',
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                correction_class: payload.correction_class ?? '',
                instruction,
                memory_id: afterMemory?.id ?? null,
                key,
                evidence_timeline_ids: payload.evidence_timeline_ids ?? [],
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'learning', 'instruction']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            memory_id: afterMemory?.id ?? null,
            key,
            instruction,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            memoryId: afterMemory?.id ?? null,
            key,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'eval.fixture.promote') {
        const evalQueryId = Number(b.eval_query_id ?? b.evalQueryId ?? payload.eval_query_id ?? payload.evalQueryId);
        if (!Number.isInteger(evalQueryId)) {
          return send(res, 400, operatorError('brain.validation', 'eval_query_id required', 'provide eval_query_id in the request body or approval payload'));
        }
        const row = db.prepare(`SELECT * FROM eval_queries WHERE id=?`).get(evalQueryId);
        if (!row) return send(res, 404, operatorError('brain.not_found', 'eval query not found', 'check the eval query id before promotion'));
        const existing = db.prepare(`SELECT * FROM eval_fixtures WHERE eval_query_id=?`).get(evalQueryId);
        if (existing) return send(res, 409, operatorError('brain.conflict', 'eval query already promoted', 'retire the existing fixture or use its id', { fixture_id: existing.id }));
        const required = normalizeSourceIds(payload.required_source_ids ?? payload.requiredSourceIds ?? parseJson(row.accepted_ids, [])).canonical;
        const requiredStrings = Array.isArray(b.required_strings)
          ? b.required_strings
          : Array.isArray(b.requiredStrings)
            ? b.requiredStrings
            : Array.isArray(payload.required_strings)
              ? payload.required_strings
              : Array.isArray(payload.requiredStrings)
                ? payload.requiredStrings
                : extractFixtureStrings(row.query_text, parseJson(row.metadata, {}));
        if (!required.length && !requiredStrings.length) {
          return send(res, 400, operatorError('brain.validation', 'fixture requires source ids or exact strings', 'include required_source_ids or deterministic required_strings'));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const fixture = db.prepare(`
            INSERT INTO eval_fixtures
              (eval_query_id, query_text, route, agent_id, task_id, required_source_ids, required_strings, metadata, promoted_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            row.id,
            row.query_text,
            row.route,
            row.agent_id,
            row.task_id,
            JSON.stringify(required),
            JSON.stringify([...new Set(requiredStrings.map(String).filter(Boolean))]),
            JSON.stringify({ source: 'approval', approval_id: approvalId, eval_metadata: parseJson(row.metadata, {}), reason: b.reason ?? payload.suggested_reason ?? '' }),
            b.promoted_by ?? b.promotedBy ?? 'approval',
          );
          const fixtureId = Number(fixture.lastInsertRowid);
          const afterFixture = db.prepare(`SELECT * FROM eval_fixtures WHERE id=?`).get(fixtureId);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'eval.fixture.delete',
            beforeState: { fixture_existed: false, eval_query: row },
            afterState: { fixture: afterFixture },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '', required_source_ids: required, required_strings: requiredStrings },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'eval:fixture-promoted',
              String(evalQueryId),
              JSON.stringify({
                approval_id: approvalId,
                eval_query_id: evalQueryId,
                fixture_id: fixtureId,
                required_source_ids: required,
                required_strings: requiredStrings,
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'eval', 'fixture']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            eval_query_id: evalQueryId,
            fixture_id: fixtureId,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            fixtureId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'eval.fixture.retire') {
        const fixtureId = Number(b.fixture_id ?? b.fixtureId ?? payload.fixture_id ?? payload.fixtureId ?? approval.subject);
        if (!Number.isInteger(fixtureId)) {
          return send(res, 400, operatorError('brain.validation', 'fixture_id required', 'provide fixture_id in the request body or approval payload'));
        }
        const fixture = db.prepare(`SELECT * FROM eval_fixtures WHERE id=?`).get(fixtureId);
        if (!fixture) return send(res, 404, operatorError('brain.not_found', 'eval fixture not found', 'check the fixture id before retire'));
        if (fixture.status === 'retired') return send(res, 409, operatorError('brain.conflict', 'eval fixture already retired', 'inspect the existing fixture lifecycle', { fixture_id: fixtureId }));
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`
            UPDATE eval_fixtures
            SET status='retired', retired_at=unixepoch(), stale_reason=CASE WHEN stale_reason='' THEN ? ELSE stale_reason END
            WHERE id=?
          `).run(b.reason ?? payload.suggested_reason ?? payload.suggestedReason ?? 'retired by approval', fixtureId);
          const afterFixture = db.prepare(`SELECT * FROM eval_fixtures WHERE id=?`).get(fixtureId);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'eval.fixture.restore',
            beforeState: { fixture },
            afterState: { fixture: afterFixture },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? payload.suggestedReason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'eval:fixture-retired',
              String(fixtureId),
              JSON.stringify({
                approval_id: approvalId,
                fixture_id: fixtureId,
                previous_status: fixture.status,
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? payload.suggestedReason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'eval', 'fixture']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            fixture_id: fixtureId,
            previous_status: fixture.status,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? payload.suggestedReason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            fixtureId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'edge.repair') {
        const subjectRef = parseEdgeReviewSubject(approval.subject);
        const edgeTable = payload.table === 'skill_edges' || payload.table === 'entity_edges' ? payload.table : subjectRef?.table;
        const edgeId = Number(b.edge_id ?? b.edgeId ?? payload.edge_id ?? payload.edgeId ?? subjectRef?.edge_id);
        const tableConfig = EDGE_REPAIR_TABLES[edgeTable];
        if (!tableConfig || !Number.isInteger(edgeId)) {
          return send(res, 400, operatorError('brain.validation', 'edge repair approval missing table or edge_id', 'include table and edge_id in the approval payload or review subject'));
        }
        const beforeEdge = db.prepare(`SELECT * FROM ${edgeTable} WHERE id=?`).get(edgeId);
        if (!beforeEdge) return send(res, 404, operatorError('brain.not_found', 'edge not found', 'check the target edge before apply'));
        const requestedRepair = (b.repair && typeof b.repair === 'object')
          ? b.repair
          : (payload.proposed_repair && typeof payload.proposed_repair === 'object' ? payload.proposed_repair : {});
        const action = String(requestedRepair.action ?? b.action ?? 'update').trim() || 'update';
        if (action !== 'update') {
          return send(res, 400, operatorError('brain.validation', 'edge repair apply supports update only', 'provide repair.action="update" with repair.fields'));
        }
        const fields = requestedRepair.fields && typeof requestedRepair.fields === 'object' ? requestedRepair.fields : {};
        const invalidFields = Object.keys(fields).filter(key => !tableConfig.updatableFields.has(key));
        if (invalidFields.length) {
          return send(res, 400, operatorError('brain.validation', `unsupported edge repair field(s): ${invalidFields.join(', ')}`, 'limit repair.fields to the supported edge columns'));
        }
        const nextEdge = edgeRepairFieldMap(edgeTable, beforeEdge, fields);
        if (!nextEdge) {
          return send(res, 400, operatorError('brain.validation', 'could not build edge repair patch', 'check the requested repair payload'));
        }
        const collision = db.prepare(`SELECT id FROM ${edgeTable} WHERE from_id=? AND to_id=? AND kind=? AND id != ?`)
          .get(nextEdge.from_id, nextEdge.to_id, nextEdge.kind, edgeId);
        if (collision) {
          return send(res, 409, operatorError('brain.conflict', 'edge repair would collide with an existing edge', 'choose from_id, to_id, and kind that do not duplicate another edge', { existing_edge_id: collision.id }));
        }
        const validation = graphEdgeIssues(db, { ...nextEdge, id: edgeId }, { table: edgeTable });
        const unresolvedIssues = blockingEdgeIssues(validation);
        if (unresolvedIssues.length) {
          return send(res, 409, operatorError(
            'brain.conflict',
            'edge repair must clear the flagged quality issues before apply',
            'update the repair fields so the edge is no longer invalid, orphaned, low-evidence, or stale',
            { issues: validation.issues, edge: validation.snapshot },
            { level: 'medium', action: 'repair-edge' },
          ));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          if (edgeTable === 'entity_edges') {
            db.prepare(`
              UPDATE entity_edges
              SET from_id=?, to_id=?, kind=?, weight=?, description=?, evidence_count=?, text_unit_ids=?, prompt_version=?, updated_at=unixepoch()
              WHERE id=?
            `).run(
              nextEdge.from_id,
              nextEdge.to_id,
              nextEdge.kind,
              nextEdge.weight,
              nextEdge.description ?? '',
              nextEdge.evidence_count,
              nextEdge.text_unit_ids ?? '[]',
              nextEdge.prompt_version ?? beforeEdge.prompt_version ?? 'edge-description.v1',
              edgeId,
            );
          } else {
            db.prepare(`
              UPDATE skill_edges
              SET from_id=?, to_id=?, kind=?, weight=?, evidence_count=?, updated_at=unixepoch()
              WHERE id=?
            `).run(
              nextEdge.from_id,
              nextEdge.to_id,
              nextEdge.kind,
              nextEdge.weight,
              nextEdge.evidence_count,
              edgeId,
            );
          }
          const afterEdge = db.prepare(`SELECT * FROM ${edgeTable} WHERE id=?`).get(edgeId);
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'edge.restore',
            beforeState: { table: edgeTable, edge: beforeEdge },
            afterState: { table: edgeTable, edge: afterEdge },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '', repair_fields: fields, issues: payload.issues ?? [] },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'edge:repair-applied',
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                table: edgeTable,
                edge_id: edgeId,
                repair_fields: fields,
                rollback_record_id: rollbackRecordId,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'edge', 'repair']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            table: edgeTable,
            edge_id: edgeId,
            repair_fields: fields,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            table: edgeTable,
            edgeId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'entity.alias.fuzzy_merge') {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const candidateIds = candidates.map(c => String(c.entity_id ?? c.id ?? '')).filter(Boolean);
        if (candidateIds.length < 2) return send(res, 400, operatorError('brain.validation', 'fuzzy merge approval missing two candidate entity_ids', 'include at least two candidate entity ids in the approval payload'));
        let canonicalId = b.canonical_id ?? b.canonicalId ?? null;
        if (canonicalId && !candidateIds.includes(String(canonicalId))) {
          return send(res, 400, operatorError('brain.validation', 'canonical_id must be one of the approval candidates', 'choose a canonical_id from the candidate list'));
        }
        if (!canonicalId) {
          const ranked = db.prepare(
            `SELECT id FROM entities WHERE id IN (${candidateIds.map(() => '?').join(',')})
             ORDER BY (status='active') DESC, updated_at DESC, length(id) ASC, id ASC`
          ).all(...candidateIds);
          canonicalId = ranked[0]?.id ?? candidateIds.slice().sort()[0];
        }
        let loserId = b.loser_id ?? b.loserId ?? candidateIds.find(id => id !== String(canonicalId));
        if (!loserId || String(loserId) === String(canonicalId)) {
          return send(res, 400, operatorError('brain.validation', 'could not determine a distinct loser entity', 'provide a loser_id different from canonical_id'));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const merge = curatorMergeEntities({
            loserId: String(loserId),
            canonicalId: String(canonicalId),
            reason: b.reason ?? payload.reason ?? 'curator fuzzy alias merge',
            by: b.source ?? 'curator',
          });
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject,
            inverseAction: 'entity.unmerge',
            beforeState: merge.beforeState,
            afterState: merge.afterState,
            metadata: { canonical_id: merge.canonicalId, loser_id: merge.loserId, similarity: payload.similarity, reason: b.reason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(b.source ?? 'curator', 'entity:alias-fuzzy-merged', merge.canonicalId, JSON.stringify({
              approval_id: approvalId,
              canonical_entity_id: merge.canonicalId,
              merged_entity_id: merge.loserId,
              rollback_record_id: rollbackRecordId,
              reversible: true,
              hard_delete: false,
            }), JSON.stringify(['brain', 'approval', 'entity', 'alias', 'merge']));
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            canonical_id: merge.canonicalId,
            loser_id: merge.loserId,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            canonicalId: merge.canonicalId,
            loserId: merge.loserId,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'entity.type') {
        const entityId = String(b.entity_id ?? b.entityId ?? payload.entity_id ?? payload.entityId ?? (String(approval.subject ?? '').startsWith('entity:') ? String(approval.subject).slice('entity:'.length) : approval.subject) ?? '');
        const newType = String(b.new_type ?? b.newType ?? payload.proposed_type ?? payload.proposedType ?? payload.new_type ?? '');
        if (!entityId || !newType) return send(res, 400, operatorError('brain.validation', 'entity_id and proposed/new type required', 'provide entity_id and new_type/proposed_type'));
        db.exec('BEGIN IMMEDIATE');
        try {
          const change = curatorChangeEntityType({ entityId, newType });
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject || `entity:${entityId}`,
            inverseAction: 'entity.retype',
            beforeState: { entity: change.before },
            afterState: { entity: change.after },
            metadata: { entity_id: entityId, from_type: change.before.type, to_type: change.after.type, reason: b.reason ?? payload.reason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(b.source ?? 'curator', 'entity:type-changed', entityId, JSON.stringify({
              approval_id: approvalId,
              entity_id: entityId,
              from_type: change.before.type,
              to_type: change.after.type,
              rollback_record_id: rollbackRecordId,
              reversible: true,
            }), JSON.stringify(['brain', 'approval', 'entity', 'schema', 'type']));
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            entity_id: entityId,
            from_type: change.before.type,
            to_type: change.after.type,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            entityId,
            fromType: change.before.type,
            toType: change.after.type,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      const authorizationConfig = AUTHORIZATION_APPROVAL_KINDS[approval.kind];
      if (authorizationConfig) {
        const confirmationPhrase = String(payload.confirmation_phrase ?? payload.confirmationPhrase ?? approval.subject ?? approval.kind);
        const confirmed = b.confirm === true
          || b.confirmed === true
          || (b.confirmation != null && String(b.confirmation) === confirmationPhrase);
        if (authorizationConfig.confirmationRequired && !confirmed) {
          return send(res, 412, operatorError(
            'brain.confirmation_required',
            `${authorizationConfig.description} requires explicit confirmation before authorization`,
            'repeat the apply request with confirm=true or the configured confirmation phrase',
            {
              confirmation_required: true,
              operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: false }),
            },
            { level: 'high', action: 'confirmation-required' },
          ));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const authorization = {
            kind: approval.kind,
            subject: approval.subject,
            payload,
            confirmation_required: authorizationConfig.confirmationRequired,
            confirmed,
            authorized_by: b.source ?? 'curator',
          };
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              authorizationConfig.eventType,
              approval.subject,
              JSON.stringify({
                approval_id: approvalId,
                authorization,
                reason: b.reason ?? payload.suggested_reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'authorization']),
            );
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            authorization,
            timeline_event_id: Number(event.lastInsertRowid),
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            authorization,
            timelineEventId: Number(event.lastInsertRowid),
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind === 'skill.publish') {
        const definition = payload.definition ?? b.definition ?? {};
        const skillName = String(definition.name ?? payload.name ?? b.name ?? approval.subject ?? '').trim();
        if (!skillName) {
          return send(res, 400, operatorError('brain.validation', 'skill definition name required', 'include definition.name in the approval payload before apply'));
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
            .run(
              b.source ?? 'curator',
              'skill:published',
              skillName,
              JSON.stringify({
                approval_id: approvalId,
                name: skillName,
                definition,
                compute_cost: Number(payload.computeCost ?? payload.compute_cost ?? 0) || 0,
                demand: Number(payload.demand ?? 0) || 0,
                reason: b.reason ?? payload.suggested_reason ?? payload.reason ?? '',
              }),
              JSON.stringify(['brain', 'approval', 'skill', 'publish']),
            );
          const rollbackRecordId = recordLearningRollback({
            approvalId,
            kind: approval.kind,
            subject: approval.subject || skillName,
            inverseAction: 'skill.publish.retract',
            beforeState: { published: false },
            afterState: { published: true, timeline_event_id: Number(event.lastInsertRowid), skill_name: skillName },
            metadata: { reason: b.reason ?? payload.suggested_reason ?? '' },
            createdBy: b.source ?? 'curator',
          });
          const resolution = {
            ...parseJson(approval.resolution, {}),
            applied: true,
            skill_name: skillName,
            timeline_event_id: Number(event.lastInsertRowid),
            rollback_record_id: rollbackRecordId,
            reason: b.reason ?? payload.suggested_reason ?? '',
          };
          db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
            .run(JSON.stringify(resolution), approvalId);
          db.exec('COMMIT');
          return send(res, 200, operatorOk({
            id: approvalId,
            status: 'resolved',
            skillName,
            timelineEventId: Number(event.lastInsertRowid),
            rollbackRecordId,
            operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
          }, { route: path, action: 'apply' }));
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      }

      if (approval.kind !== 'fact.contradiction') return send(res, 400, operatorError('brain.validation', 'unsupported approval kind', 'use a supported approval/proposal kind for apply'));
      const claims = Array.isArray(payload.claims) ? payload.claims : [];
      const claimIds = claims.map(c => Number(c.id)).filter(Number.isInteger);
      const winningFactId = Number(b.winning_fact_id ?? b.winningFactId ?? payload.winning_fact_id ?? payload.winningFactId);
      if (!Number.isInteger(winningFactId) || !claimIds.includes(winningFactId)) {
        return send(res, 400, operatorError('brain.validation', 'winning_fact_id must identify one approval claim', 'choose one of the approval claim ids as the winner'));
      }
      const losingStatus = b.losing_status ?? b.losingStatus ?? 'disputed';
      if (!['superseded', 'disputed'].includes(losingStatus)) return send(res, 400, operatorError('brain.validation', 'invalid losing status', 'use superseded or disputed'));
      const winner = db.prepare(`SELECT * FROM facts WHERE id=?`).get(winningFactId);
      if (!winner) return send(res, 404, operatorError('brain.not_found', 'winning fact not found', 'check the selected winning fact id'));

      db.exec('BEGIN IMMEDIATE');
      try {
        const beforeFacts = claimIds.map(id => db.prepare(`SELECT * FROM facts WHERE id=?`).get(id)).filter(Boolean);
        db.prepare(`UPDATE facts SET status='active' WHERE id=?`).run(winningFactId);
        const losingFactIds = claimIds.filter(id => id !== winningFactId);
        for (const id of losingFactIds) db.prepare(`UPDATE facts SET status=? WHERE id=?`).run(losingStatus, id);
        rollupEntityFactsData(winner.entity_id);
        const afterFacts = claimIds.map(id => db.prepare(`SELECT * FROM facts WHERE id=?`).get(id)).filter(Boolean);
        const resolution = {
          ...parseJson(approval.resolution, {}),
          applied: true,
          winning_fact_id: winningFactId,
          losing_fact_ids: losingFactIds,
          losing_status: losingStatus,
          reason: b.reason ?? '',
        };
        const rollbackRecordId = recordLearningRollback({
          approvalId,
          kind: approval.kind,
          subject: approval.subject,
          inverseAction: 'facts.restore-statuses',
          beforeState: { facts: beforeFacts.map(f => ({ id: f.id, status: f.status })) },
          afterState: { facts: afterFacts.map(f => ({ id: f.id, status: f.status })) },
          metadata: { field: payload.field, source_fact_ids: claimIds, reason: b.reason ?? '' },
          createdBy: b.source ?? 'curator',
        });
        resolution.rollback_record_id = rollbackRecordId;
        db.prepare(`UPDATE approvals SET status='resolved', resolution=?, resolved_at=unixepoch() WHERE id=?`)
          .run(JSON.stringify(resolution), approvalId);
        const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
          .run(
            b.source ?? 'curator',
            'approval:applied',
            approval.subject,
            JSON.stringify({
              approval_id: approvalId,
              kind: approval.kind,
              field: payload.field,
              source_fact_ids: claimIds,
              winning_fact_id: winningFactId,
              losing_fact_ids: losingFactIds,
              losing_status: losingStatus,
              reason: b.reason ?? '',
              rollback_record_id: rollbackRecordId,
            }),
            JSON.stringify(['brain', 'approval', 'fact']),
          );
        db.exec('COMMIT');
        return send(res, 200, operatorOk({
          id: approvalId,
          status: 'resolved',
          winningFactId,
          losingFactIds,
          timelineEventId: Number(event.lastInsertRowid),
          rollbackRecordId,
          operator_envelope: buildOperatorEnvelope({ approvalId, approvalKind: approval.kind, path, payload, vectorCapability, applied: true }),
        }, { route: path, action: 'apply' }));
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    }

    fail(res, 404, 'brain.not_found', 'not found', {
      hint: 'check the route path and method',
      retry_command: 'GET /routes',
      risk: { level: 'low', action: 'inspect-route' },
    });
  } catch (err) {
    fail(res, err.status ?? 500, err.status === 400 ? 'brain.validation' : 'brain.internal', err?.message ?? String(err), {
      hint: err.status === 400 ? 'check request JSON and required fields' : 'inspect Brain logs and retry after fixing the server-side error',
      retry_command: 'GET /health',
      risk: { level: err.status && err.status < 500 ? 'medium' : 'high', action: 'retry-or-debug' },
    });
  }
  });
}
