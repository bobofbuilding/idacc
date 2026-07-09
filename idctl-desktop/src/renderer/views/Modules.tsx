import { Fragment, useEffect, useMemo, useState } from 'react';
import { call, useSyncVersion, type FleetStore } from '../store.ts';
import type { LibrarySkillEntry, LibraryPluginEntry, LibraryPluginInspection, McpServerSpec, SetMcpResult, CreateSkillInput, ProjectPluginSkillResult } from '../../../../idctl/src/api/client.ts';
import {
  type McpServerProfile,
  type McpTransport,
} from '../../../../idctl/src/settings/schema.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';
import { runtimeSupports } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';

type CapabilityTab = 'mcp' | 'skills' | 'plugins';

/** An agent's effective runtime (top-level, falling back to metadata). */
function agentRuntime(a: Agent): string | undefined {
  return a.runtime ?? a.metadata?.runtime;
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

interface TestResult { ok?: boolean; tools?: string[]; error?: string; testing?: boolean }
type TargetAgent = Agent & { team?: string };
type TeamAgentsGroup = { team: string; agents: Agent[] };
type SkillAgentRecommendation = { agent: TargetAgent; score: number; reasons: string[]; installed: boolean };
type LocalSkillCandidate = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: string;
  sourcePath: string;
  installed: boolean;
  duplicate: boolean;
};
type PluginRow = LibraryPluginEntry & Partial<LibraryPluginInspection> & { packageSource: string; bundledPortable?: boolean };
type BrainSkillStats = { totalSkills?: number; chainable?: number; nonChainable?: number; domains?: number; tags?: number; averageComputeCost?: number | null; maxUseCount?: number };
type BrainSkillFacet = { domain?: string; tag?: string; name?: string; count?: number };
type BrainSkillSummary = {
  summary?: BrainSkillStats;
  facets?: { domains?: BrainSkillFacet[]; tags?: BrainSkillFacet[]; chainable?: { value?: boolean; count?: number }[] };
  reuseGroups?: { kind?: string; key?: string; label?: string; count?: number }[];
  proposalSummary?: Record<string, unknown>;
  profile?: string;
  meta?: { route?: string; profile?: string; generatedAt?: string; cacheControl?: string | null; noStore?: boolean };
} | null;
type BrainFleetReport = {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  fleet?: {
    source?: string;
    total?: number;
    running?: number;
    authority?: string;
    authoritative?: boolean;
    activeLabel?: string;
    statusAuthorityLabel?: string;
    managerUrl?: string;
    teamSource?: string;
    warnings?: string[];
    cacheDrift?: { status?: string; liveTotal?: number | null; cachedTotal?: number | null; delta?: number | null };
  };
} | null;
type BrainCoreHealthReport = {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  ok?: boolean;
  nodes?: number;
  edges?: number;
  memories?: number;
  entities?: number;
  timelineEvents?: number;
  facts?: number;
  fts?: boolean;
  sqliteVec?: { available?: boolean; degraded?: boolean; state?: string; dimensions?: number; extension?: string; fallback?: string; error?: string | null };
  routeInventory?: { skew?: boolean; missing?: string[]; count?: number; routes?: string[] };
  warnings?: string[];
} | null;
type BrainAgentsReport = {
  generatedAt?: string;
  route?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  total?: number;
  running?: number;
  source?: string;
  authority?: string;
  authoritative?: boolean;
  statusAuthorityLabel?: string;
  duplicateNames?: string[];
  controllerTotal?: number;
  activeControllerLinks?: number;
  scopedControllerMatches?: number;
  bareControllerMatches?: number;
  ambiguousBareControllerLinks?: number;
  unlinkedAgents?: number;
  slaFetchLimit?: number;
  slaOmitted?: number;
  cacheDrift?: { status?: string; liveTotal?: number | null; cachedTotal?: number | null; delta?: number | null };
  warnings?: string[];
} | null;
type BrainGraphReport = {
  generatedAt?: string;
  cacheControl?: string | null;
  noStore?: boolean;
  graph?: {
    nodeCount?: number;
    linkCount?: number;
    directNodeCount?: number;
    directLinkCount?: number;
    defaultIncludesNeighbors?: boolean;
    neighborsParamHonored?: boolean;
    sourceAuthority?: string;
    sourceAuthorityLabel?: string;
    identityBridgeCount?: number;
    warnings?: string[];
  };
} | null;
type BrainSkillSyncResult = {
  ok: boolean;
  total: number;
  count: number;
  memory: boolean;
  summary?: BrainSkillStats | null;
  index?: BrainSkillSummary;
  generatedAt?: string;
};
type SkillBrainDrift = { kind: 'created' | 'deleted' | 'retagged'; skill: string; at: number };
type BrainDashboardTab = 'fleet' | 'health' | 'skills' | 'learning' | 'agents' | 'graph';
type BrainDashboardTabSpec = {
  tab: BrainDashboardTab;
  label: string;
  path: string;
  guard?: {
    title: string;
    confirm: string;
  };
};
type LiveFleetTotals = { total: number; running: number };
type BrainDashboardReviewMap = Partial<Record<BrainDashboardTab, string | null | undefined>>;

const SKILL_ROLE_RULES: Array<{ role: string[]; skill: string[]; reason: string }> = [
  { role: ['lead', 'coordinator', 'manager', 'ops', 'operations', 'hr'], skill: ['coordination', 'workflow', 'communication', 'messaging', 'planning', 'admin', 'routing'], reason: 'coordination role' },
  { role: ['coder', 'code', 'engineer', 'frontend', 'backend', 'implementation'], skill: ['coding', 'deployment', 'documentation', 'testing', 'plugin', 'registry', 'workflow'], reason: 'engineering role' },
  { role: ['research', 'researcher', 'analyst', 'knowledge'], skill: ['research', 'knowledge', 'documentation', 'catalog', 'learning'], reason: 'research role' },
  { role: ['onchain', 'chain', 'wallet', 'settlement', 'token', 'economist'], skill: ['onchain', 'wallet', 'marketplace', 'identity', 'token'], reason: 'onchain role' },
  { role: ['security', 'legal', 'counsel', 'policy'], skill: ['identity', 'admin', 'documentation', 'security', 'policy'], reason: 'governance role' },
];

const BRAIN_DASHBOARD_TABS: BrainDashboardTabSpec[] = [
  { tab: 'fleet', label: 'Fleet', path: '/dashboard' },
  {
    tab: 'health',
    label: 'Health',
    path: '/dashboard/health',
    guard: {
      title: 'Guarded: Brain Health loads report and triage routes before showing approval controls.',
      confirm: 'Open Brain Health?\n\nThis Brain tab loads report and triage routes before showing approval controls. In the current Brain build, those read-looking reports may reconcile stale eval fixture state. Continue only if you are intentionally reviewing Brain Health.',
    },
  },
  { tab: 'skills', label: 'Skills', path: '/dashboard/skills' },
  {
    tab: 'learning',
    label: 'Learning',
    path: '/dashboard/learning',
    guard: {
      title: 'Guarded: Brain Learning separates passive reports from manual eval replay/vector comparison.',
      confirm: 'Open Brain Learning?\n\nThis Brain tab loads learning report routes and exposes manual eval replay/vector comparison. In the current Brain build, report refresh may reconcile stale eval fixture state. Continue only if you are intentionally reviewing Brain Learning.',
    },
  },
  { tab: 'agents', label: 'Agents', path: '/dashboard/agents' },
  { tab: 'graph', label: 'Graph', path: '/dashboard/graph' },
];

function brainDashboardTabForPath(pathname: string): BrainDashboardTabSpec | null {
  return BRAIN_DASHBOARD_TABS.find((x) => x.path === pathname) ?? null;
}

function openBrainDashboardTab(tab: BrainDashboardTabSpec, reviewReason?: string | null) {
  const review = reviewReason?.trim();
  if (tab.guard || review) {
    const base = tab.guard?.confirm ?? `Open Brain ${tab.label}?`;
    const message = review
      ? `${base}\n\nCurrent IDACC review:\n${review}\n\nContinue only if you are intentionally reviewing this Brain tab.`
      : base;
    if (!window.confirm(message)) return;
  }
  void call('brain:openDashboard', tab.tab);
}

function brainFleetAuthority(report: BrainFleetReport): string {
  const source = report?.fleet?.source ?? '';
  return report?.fleet?.authority
    ?? (source === 'brain-cache' ? 'cache' : source === 'live-manager-partial' ? 'partial' : source === 'live-manager' ? 'live-unversioned' : 'unknown');
}

function brainFleetContractCurrent(report: BrainFleetReport): boolean {
  return !!(report?.fleet?.authority && report.fleet.statusAuthorityLabel);
}

function brainFleetReviewNeeded(report: BrainFleetReport): boolean {
  const fleet = report?.fleet;
  if (!fleet) return true;
  if (!brainFleetContractCurrent(report)) return true;
  if (fleet.authority !== 'live' || fleet.authoritative !== true) return true;
  return (fleet.warnings ?? []).length > 0;
}

function brainFleetStatusLabel(report: BrainFleetReport): string {
  const fleet = report?.fleet;
  if (!fleet) return 'Fleet --';
  const count = `${fleet.running ?? 0}/${fleet.total ?? 0}`;
  const authority = brainFleetAuthority(report);
  if (authority === 'live-unversioned') return `Fleet ${count} live (stale)`;
  if (authority === 'live') return `Fleet ${count} live`;
  if (authority === 'partial') return `Fleet ${count} partial`;
  if (authority === 'cache') return `Fleet ${count} cache`;
  return `Fleet ${count} ${authority}`;
}

function brainFleetStatusTitle(report: BrainFleetReport): string {
  const fleet = report?.fleet;
  if (!fleet) return 'Brain /fleet-report unavailable; Brain dashboard tabs may be offline or stale.';
  return [
    `Source: ${fleet.source ?? 'unknown'}`,
    `Status authority: ${fleet.statusAuthorityLabel ?? 'missing (Brain service likely needs restart/redeploy to load the current dashboard contract)'}`,
    `Count: ${fleet.running ?? 0}/${fleet.total ?? 0}`,
    fleet.managerUrl ? `Manager: ${fleet.managerUrl}` : '',
    fleet.teamSource ? `Teams: ${fleet.teamSource}` : '',
    fleet.cacheDrift?.status === 'drift' ? `Cache drift: live ${fleet.cacheDrift.liveTotal} vs Brain ${fleet.cacheDrift.cachedTotal}` : '',
    ...(fleet.warnings ?? []),
  ].filter(Boolean).join('\n');
}

function brainFleetReviewDetail(report: BrainFleetReport): string {
  const fleet = report?.fleet;
  if (!fleet) return 'Brain /fleet-report is unavailable. Open Brain Fleet or check the Brain service before comparing dashboard counts.';
  if (!brainFleetContractCurrent(report)) {
    return `Brain reports ${fleet.running ?? 0}/${fleet.total ?? 0} from ${fleet.source ?? 'unknown'}, but authority labels are missing. Restart/redeploy Brain before trusting dashboard-tab authority copy.`;
  }
  if (fleet.authority !== 'live' || fleet.authoritative !== true) {
    return `${fleet.statusAuthorityLabel ?? 'Brain fleet source is not live-authoritative.'} Counts may be partial or cache-only.`;
  }
  if ((fleet.warnings ?? []).length) return (fleet.warnings ?? []).join(' ');
  return 'Brain Fleet authority is live.';
}

function agentStatusIsRunning(status?: string): boolean {
  return !!status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(status);
}

function brainFleetMismatchDetail(report: BrainFleetReport, live: LiveFleetTotals): string | null {
  const fleet = report?.fleet;
  if (!fleet || live.total <= 0) return null;
  const brainRunning = typeof fleet.running === 'number' ? fleet.running : null;
  const brainTotal = typeof fleet.total === 'number' ? fleet.total : null;
  const runningMismatch = brainRunning !== null && brainRunning !== live.running;
  const totalMismatch = brainTotal !== null && brainTotal !== live.total;
  if (!runningMismatch && !totalMismatch) return null;
  return `IDACC live fleet sees ${live.running}/${live.total}, but Brain /fleet-report reports ${brainRunning ?? '?'}/${brainTotal ?? '?'}. Restart or redeploy Brain, or review manager URL/team scope, before trusting Brain Fleet, Health, or Agents counts.`;
}

function brainCoreNeedsReview(report: BrainCoreHealthReport): boolean {
  if (!report) return true;
  return report.ok !== true || !!report.routeInventory?.skew || !!report.sqliteVec?.degraded || report.sqliteVec?.available === false || (report.warnings ?? []).length > 0;
}

function brainCoreStatusLabel(report: BrainCoreHealthReport): string {
  if (!report) return 'Core --';
  const count = `${report.nodes ?? 0}n/${report.edges ?? 0}e`;
  if (report.ok !== true) return `Core ${count} down`;
  if (report.routeInventory?.skew) return `Core ${count} routes`;
  if (report.sqliteVec?.degraded || report.sqliteVec?.available === false) return `Core ${count} vector`;
  return `Core ${count}`;
}

function brainCoreStatusTitle(report: BrainCoreHealthReport): string {
  if (!report) return 'Brain /health unavailable. This safe core check does not open Brain Health or Learning dashboards.';
  return [
    `Safe route: GET /health`,
    `Generated: ${report.generatedAt ?? 'unknown'}`,
    `Counts: ${report.nodes ?? 0} nodes / ${report.edges ?? 0} edges / ${report.memories ?? 0} memories / ${report.facts ?? 0} facts`,
    `Route inventory: ${report.routeInventory?.skew ? 'missing critical routes' : 'current'} (${report.routeInventory?.count ?? report.routeInventory?.routes?.length ?? '?'} routes)`,
    report.routeInventory?.missing?.length ? `Missing: ${report.routeInventory.missing.join(', ')}` : '',
    `sqlite-vec: ${report.sqliteVec?.available ? 'available' : 'fallback'}${report.sqliteVec?.dimensions ? `, dim ${report.sqliteVec.dimensions}` : ''}`,
    ...(report.warnings ?? []),
  ].filter(Boolean).join('\n');
}

function brainCoreReviewDetail(report: BrainCoreHealthReport): string {
  if (!report) return 'Brain /health is unavailable. IDACC cannot verify core Brain liveness without opening guarded Brain Health or Learning tabs.';
  if (report.ok !== true) return 'Brain /health did not report ok=true. Check the Brain service before relying on dashboard tabs.';
  if (report.routeInventory?.skew) {
    return `Brain /health reports route inventory drift. Missing: ${(report.routeInventory.missing ?? []).join(', ') || 'critical routes'}.`;
  }
  if (report.sqliteVec?.degraded || report.sqliteVec?.available === false) {
    return 'Brain core is reachable, but native sqlite-vec is degraded or unavailable; vector rollout decisions should stay behind Learning replay review.';
  }
  if ((report.warnings ?? []).length) return (report.warnings ?? []).join(' ');
  return 'Brain core health is reachable through safe GET /health.';
}

function brainAgentsNeedsReview(report: BrainAgentsReport): boolean {
  if (!report) return true;
  return report.authority !== 'live'
    || report.authoritative !== true
    || (report.duplicateNames ?? []).length > 0
    || (report.ambiguousBareControllerLinks ?? 0) > 0
    || (report.unlinkedAgents ?? 0) > 0
    || (report.slaOmitted ?? 0) > 0
    || (report.warnings ?? []).length > 0;
}

function brainAgentsStatusLabel(report: BrainAgentsReport): string {
  if (!report) return 'Agents --';
  const count = `${report.running ?? 0}/${report.total ?? 0}`;
  if (report.authority !== 'live') return `Agents ${count} ${report.authority ?? 'unknown'}`;
  if ((report.unlinkedAgents ?? 0) > 0 || (report.ambiguousBareControllerLinks ?? 0) > 0) return `Agents ${count} review`;
  return `Agents ${count}`;
}

function brainAgentsStatusTitle(report: BrainAgentsReport): string {
  if (!report) return 'Brain Agents report unavailable; Brain Agents dashboard authority and controller fallbacks are not verified.';
  const linked = (report.scopedControllerMatches ?? 0) + (report.bareControllerMatches ?? 0);
  return [
    `Route: ${report.route ?? '/dashboard/agents'}`,
    `Source: ${report.source ?? 'unknown'} (${report.authority ?? 'unknown'})`,
    `Status authority: ${report.statusAuthorityLabel ?? 'missing (Brain service likely needs restart/redeploy to expose current authority labels)'}`,
    `Agents: ${report.running ?? 0}/${report.total ?? 0}`,
    `Controller links: ${linked}/${report.total ?? 0} matched; ${report.controllerTotal ?? 0} controllers / ${report.activeControllerLinks ?? 0} active links`,
    report.duplicateNames?.length ? `Duplicate names: ${report.duplicateNames.join(', ')}` : '',
    report.ambiguousBareControllerLinks ? `Ambiguous bare controller links: ${report.ambiguousBareControllerLinks}` : '',
    report.unlinkedAgents ? `Unlinked agents: ${report.unlinkedAgents}` : '',
    report.slaOmitted ? `SLA omitted after first ${report.slaFetchLimit ?? 50} rows: ${report.slaOmitted}` : '',
    report.cacheDrift?.status === 'drift' ? `Cache drift: live ${report.cacheDrift.liveTotal} vs Brain ${report.cacheDrift.cachedTotal}` : '',
    ...(report.warnings ?? []),
  ].filter(Boolean).join('\n');
}

function brainAgentsReviewDetail(report: BrainAgentsReport): string {
  if (!report) return 'Brain Agents authority is unavailable. Open IDACC Health for live fleet state before trusting Brain Agents rows.';
  const linked = (report.scopedControllerMatches ?? 0) + (report.bareControllerMatches ?? 0);
  if (report.authority !== 'live' || report.authoritative !== true) {
    return `${report.statusAuthorityLabel ?? 'Brain Agents fleet source is not live-authoritative.'} Use IDACC Health before lifecycle decisions.`;
  }
  if ((report.ambiguousBareControllerLinks ?? 0) > 0) {
    return `${report.ambiguousBareControllerLinks} Brain Agents controller link(s) are bare-name ambiguous. Create scoped team/name or agent-id links before trusting controller fallback copy.`;
  }
  if ((report.unlinkedAgents ?? 0) > 0) {
    return `${report.unlinkedAgents} of ${report.total ?? 0} Brain Agents rows have no scoped accountable-controller link (${linked} matched). Treat controller fallback as incomplete.`;
  }
  if ((report.slaOmitted ?? 0) > 0) {
    return `Brain Agents fetches SLA for the first ${report.slaFetchLimit ?? 50} rows only; ${report.slaOmitted} rows are intentionally unknown, not healthy.`;
  }
  if ((report.warnings ?? []).length) return (report.warnings ?? []).join(' ');
  return 'Brain Agents authority, scoped controller links, and SLA coverage are current.';
}

function brainSkillContractGaps(report: BrainSkillSummary): string[] {
  const gaps: string[] = [];
  if (!report?.summary) return ['Brain /skills/index is unavailable'];
  if (report.meta?.route !== '/skills/index') gaps.push('route metadata');
  if (!(report.profile || report.meta?.profile)) gaps.push('profile label');
  if (!Array.isArray(report.facets?.domains)) gaps.push('domain facets');
  if (!Array.isArray(report.facets?.tags)) gaps.push('tag facets');
  if (!Array.isArray(report.reuseGroups)) gaps.push('reuse groups');
  if (!report.proposalSummary) gaps.push('proposal summary');
  if (report.meta?.noStore !== true) gaps.push('no-store cache header');
  return gaps;
}

function brainSkillContractCurrent(report: BrainSkillSummary): boolean {
  return brainSkillContractGaps(report).length === 0;
}

function brainSkillContractDetail(report: BrainSkillSummary): string {
  const gaps = brainSkillContractGaps(report);
  if (!report?.summary) {
    return 'Brain /skills/index is unavailable. Open Brain Skills or check the Brain service before comparing the local catalog with Brain.';
  }
  if (gaps.length) {
    return `Brain /skills/index is missing ${gaps.join(', ')}. Restart/redeploy Brain before treating Skills, Graph, and skill reuse suggestions as fully synced.`;
  }
  const domainCount = report.facets?.domains?.length ?? report.summary.domains ?? 0;
  const tagCount = report.facets?.tags?.length ?? report.summary.tags ?? 0;
  const reuseCount = report.reuseGroups?.length ?? 0;
  return `Brain Skills catalog contract is current (${domainCount} domains, ${tagCount} tags, ${reuseCount} reuse groups).`;
}

function brainFacetLabel(facet: BrainSkillFacet): string {
  return String(facet.domain ?? facet.tag ?? facet.name ?? '').trim();
}

function brainGraphContractCurrent(report: BrainGraphReport): boolean {
  return !!(report?.graph?.sourceAuthority && report.graph.sourceAuthorityLabel && report.graph.neighborsParamHonored);
}

function brainGraphReviewNeeded(report: BrainGraphReport): boolean {
  const graph = report?.graph;
  if (!graph) return true;
  if (!brainGraphContractCurrent(report)) return true;
  return (graph.warnings ?? []).length > 0;
}

function brainGraphStatusLabel(report: BrainGraphReport): string {
  const graph = report?.graph;
  if (!graph) return 'Graph --';
  const count = `${graph.nodeCount ?? 0}n/${graph.linkCount ?? 0}e`;
  if (brainGraphContractCurrent(report) && !(graph.warnings ?? []).length) return `Graph ${count}`;
  if (graph.neighborsParamHonored) return `Graph ${count} stale`;
  return `Graph ${count} review`;
}

function brainGraphStatusTitle(report: BrainGraphReport): string {
  const graph = report?.graph;
  if (!graph) return 'Brain /graph/app/data unavailable; Brain Graph may be offline or stale.';
  return [
    `Default neighbors: ${graph.defaultIncludesNeighbors === true ? 'on' : graph.defaultIncludesNeighbors === false ? 'off' : 'unknown'}`,
    `neighbors=0 honored: ${graph.neighborsParamHonored === true ? 'yes' : graph.neighborsParamHonored === false ? 'no' : 'unknown'}`,
    `Source authority: ${graph.sourceAuthorityLabel ?? 'missing (Brain service likely needs restart/redeploy to load the current Graph contract)'}`,
    `Expanded: ${graph.nodeCount ?? 0} nodes / ${graph.linkCount ?? 0} edges`,
    graph.directNodeCount != null ? `Direct: ${graph.directNodeCount} nodes / ${graph.directLinkCount ?? 0} edges` : '',
    graph.identityBridgeCount != null ? `Identity bridge links: ${graph.identityBridgeCount}` : '',
    ...(graph.warnings ?? []),
  ].filter(Boolean).join('\n');
}

function brainGraphReviewDetail(report: BrainGraphReport): string {
  const graph = report?.graph;
  if (!graph) return 'Brain /graph/app/data is unavailable. Open Brain Graph or check the Brain service before trusting graph search and entity status copy.';
  if (!graph.neighborsParamHonored) {
    return 'Brain Graph did not confirm neighbors=0. Filtered graph search may include stale neighbor expansion or miss the direct-match boundary.';
  }
  if (!graph.sourceAuthority || !graph.sourceAuthorityLabel) {
    return `Brain Graph honors the neighbor toggle (${graph.directNodeCount ?? 0} direct vs ${graph.nodeCount ?? 0} expanded nodes), but source-authority labels are missing. Restart/redeploy Brain before treating Graph agent/entity status copy as authoritative.`;
  }
  if ((graph.warnings ?? []).length) return (graph.warnings ?? []).join(' ');
  return 'Brain Graph source contract is current.';
}

function BrainDashboardLauncher({ compact = false, reviewTabs = {} }: { compact?: boolean; reviewTabs?: BrainDashboardReviewMap }) {
  return (
    <span className={`brain-dashboard-tabs${compact ? ' compact' : ''}`} title="Open a whitelisted Brain dashboard tab">
      {!compact ? <span className="muted small">Brain</span> : null}
      {BRAIN_DASHBOARD_TABS.map((x) => {
        const review = reviewTabs[x.tab]?.trim();
        return (
          <button
            key={x.tab}
            className={`btn small${x.guard ? ' guarded' : ''}${review ? ' review' : ''}`}
            title={[review ? `Review active: ${review}` : '', x.guard?.title ?? `Open Brain ${x.label}`].filter(Boolean).join('\n')}
            onClick={() => openBrainDashboardTab(x, review)}
          >
            {x.label}
          </button>
        );
      })}
    </span>
  );
}

/** Strip the registry-only `enabled` flag to get the on-the-wire spec. */
function toSpec(p: McpServerProfile): McpServerSpec {
  const { enabled: _enabled, ...spec } = p;
  return spec;
}
/** Render a compact test result (✓ N tools / ✕ error / testing…). */
function TestCell({ r }: { r?: TestResult }) {
  if (!r || (r.ok === undefined && !r.testing && !r.error)) return <span className="muted">—</span>;
  if (r.testing) return <span className="warn-text">testing…</span>;
  if (r.ok) return <span className="ok-text" title={(r.tools ?? []).join(', ')}>✓ {r.tools?.length ?? 0} tools</span>;
  return <span className="status-error" title={r.error}>✕ {(r.error ?? 'failed').slice(0, 44)}</span>;
}

function LinkedDescription({ text }: { text?: string | null }) {
  if (!text) return null;
  const parts: JSX.Element[] = [];
  const linkRe = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(text)) !== null) {
    if (match.index > last) parts.push(<Fragment key={`t-${last}`}>{text.slice(last, match.index)}</Fragment>);
    const [, label, href] = match;
    const url = new URL(href);
    const brainTab = url.port === '4200' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      ? brainDashboardTabForPath(url.pathname)
      : null;
    parts.push(brainTab ? (
      <a key={`a-${match.index}`} className="ext-link" href="#" onClick={(e) => { e.preventDefault(); openBrainDashboardTab(brainTab); }}>
        {label}
      </a>
    ) : (
      <a key={`a-${match.index}`} className="ext-link" href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    ));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={`t-${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}

// agentskills.io `name` rule: 1–64 chars, lowercase alphanumerics + single
// hyphens, no leading/trailing/consecutive hyphens. (Folder name == skill name.)
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function skillNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'required';
  if (n.length > 64) return 'max 64 characters';
  if (!SKILL_NAME_RE.test(n)) return 'lowercase letters, digits, single hyphens';
  return null;
}
/** Split a comma/space separated tag string into a clean list. */
function splitTags(s: string): string[] {
  return s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
}

/** Parse "KEY=value, KEY2=value2" into an object (or undefined if empty). */
function parseKV(s: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of s.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
function mcpEndpoint(p: McpServerProfile): string {
  return p.transport === 'stdio'
    ? [p.command, ...(p.args ?? [])].filter(Boolean).join(' ') || '(none)'
    : p.url ?? '(none)';
}
function pluginClassificationLabel(p: PluginRow): string {
  switch (p.classification) {
    case 'portable-package': return 'Portable package';
    case 'instruction-skill': return 'Skill digestible';
    case 'hybrid-tool-plugin': return 'Hybrid tools';
    case 'native-tool-plugin': return 'Tool plugin';
    case 'manifest-only': return 'Manifest only';
    default: return 'Uninspected';
  }
}
function pluginProjectionLabel(p: PluginRow): string {
  if (p.classification === 'portable-package') return 'Adapter package';
  switch (p.skillProjection) {
    case 'available': return 'Digest';
    case 'already-in-catalog': return 'In Skills';
    case 'blocked-tools': return 'Adapter review';
    default: return 'Plugin';
  }
}
function pluginAdapterSummary(p: PluginRow): string {
  if (p.name === 'idacc-context-retrieval') return 'Skill + MCP + native + fallback';
  if (p.classification === 'instruction-skill') return 'Instruction wrapper';
  if (p.classification === 'hybrid-tool-plugin') return 'Skill + tools';
  if (p.classification === 'native-tool-plugin') return 'Tools';
  if (p.classification === 'manifest-only') return 'Manifest';
  return 'Unverified';
}
function pluginIsDigestedSkill(p: PluginRow): boolean {
  return p.name !== 'idacc-context-retrieval'
    && p.classification === 'instruction-skill'
    && p.skillProjection === 'already-in-catalog';
}
function capabilitySurface(tab: CapabilityTab, runtime: string | undefined): { label: string; title: string; advisory?: boolean } {
  const rt = runtime ?? 'unknown runtime';
  if (tab === 'mcp') {
    if (runtimeSupports(runtime, 'mcp')) {
      return { label: 'MCP-ready', title: `${rt}: native MCP/tool-calling path is available when the model/harness supports tools.` };
    }
    return {
      label: 'MCP fallback',
      title: `${rt}: MCP attachment is allowed as neutral metadata, but this runtime needs manager-side resolution, a runtime switch, or direct fallback before tools can execute.`,
      advisory: true,
    };
  }
  if (tab === 'skills') {
    if (runtimeSupports(runtime, 'skills')) return { label: 'Skill-ready', title: `${rt}: SKILL.md instructions can be assigned through the manager skill surface.` };
    return {
      label: 'Skill fallback',
      title: `${rt}: skill assignment is allowed, but the manager/runtime must provide a workspace or prompt-side adapter before instructions are deployed natively.`,
      advisory: true,
    };
  }
  if (runtimeSupports(runtime, 'plugins')) return { label: 'Native+portable', title: `${rt}: native plugin, Skill, MCP, and direct-fallback adapters may all be available depending on the package manifest.` };
  if (runtimeSupports(runtime, 'mcp')) return { label: 'MCP+Skill', title: `${rt}: portable plugin packages can route through MCP tools plus Skill/direct-fallback adapters.` };
  if (runtimeSupports(runtime, 'skills')) return { label: 'Skill+fallback', title: `${rt}: portable plugin packages can route through Skill instructions plus direct fallback.` };
  return {
    label: 'Fallback',
    title: `${rt}: portable plugin assignment is allowed, but this runtime needs a package-declared fallback or manager adapter before native features execute.`,
    advisory: true,
  };
}
function capabilitySurfaceSummary(tab: CapabilityTab, agents: TargetAgent[]): string {
  if (!agents.length) return 'No targets in scope.';
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const surface = capabilitySurface(tab, agentRuntime(agent)).label;
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(' · ');
}
function pluginRuntimeReach(p: PluginRow, agents: TargetAgent[]): string {
  if (!agents.length) return 'No selected targets';
  const native = agents.filter((agent) => runtimeSupports(agentRuntime(agent), 'plugins')).length;
  const mcp = agents.filter((agent) => runtimeSupports(agentRuntime(agent), 'mcp')).length;
  const skill = agents.filter((agent) => runtimeSupports(agentRuntime(agent), 'skills')).length;
  if (p.classification === 'portable-package') {
    return `native ${native} · MCP ${mcp} · Skill ${skill} · fallback ${agents.length}`;
  }
  if (p.classification === 'instruction-skill') {
    return `Skill ${skill} · fallback ${agents.length}`;
  }
  if (p.classification === 'hybrid-tool-plugin' || p.classification === 'native-tool-plugin') {
    return `native ${native} · review ${agents.length - native}`;
  }
  return `native ${native} · unverified`;
}
function mcpProfileStamp(p: McpServerProfile): string {
  return JSON.stringify({
    name: p.name,
    transport: p.transport,
    command: p.command ?? '',
    args: p.args ?? [],
    url: p.url ?? '',
    env: p.env ?? {},
    headers: p.headers ?? {},
    enabled: p.enabled !== false,
  });
}
function sortedKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}
function skillCatalogStamp(skills: LibrarySkillEntry[], autoTags: Record<string, string[]>): string {
  return JSON.stringify(skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      tags: sortedKey([...(skill.tags ?? []), ...(autoTags[skill.name] ?? [])].map((tag) => String(tag ?? '').trim().slice(0, 80))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)));
}
function brainSkillSummaryStamp(report: BrainSkillSummary): string {
  return JSON.stringify({
    total: report?.summary?.totalSkills ?? null,
    generatedAt: report?.meta?.generatedAt ?? '',
    route: report?.meta?.route ?? '',
    profile: report?.meta?.profile ?? report?.profile ?? '',
    domains: report?.facets?.domains?.length ?? null,
    tags: report?.facets?.tags?.length ?? null,
    reuseGroups: report?.reuseGroups?.length ?? null,
    gaps: brainSkillContractGaps(report).sort(),
  });
}
function mcpKey(a: { metadata?: unknown }): string {
  const servers = (((a.metadata as any)?.mcpServers ?? []) as McpServerSpec[])
    .map((s) => JSON.stringify({ name: s.name, transport: s.transport, command: s.command, args: s.args ?? [], url: s.url ?? '', env: s.env ?? {}, headers: s.headers ?? {} }))
    .sort();
  return servers.join('|');
}
function skillsKey(a: { metadata?: unknown }): string {
  return sortedKey((((a.metadata as any)?.skills ?? []) as string[]).map(String));
}
function capabilityAgentStamp(a: TargetAgent, fallbackTeam: string): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    team: a.team ?? fallbackTeam,
    runtime: agentRuntime(a) ?? '',
    status: a.status ?? '',
    health: a.health ?? '',
    mcp: mcpKey(a),
    skills: skillsKey(a),
  });
}
function capabilityTargetSetStamp(agents: TargetAgent[], fallbackTeam: string): string {
  return sortedKey(agents.map((a) => `${a.team ?? fallbackTeam}:${a.id || a.name}`));
}

export function Modules({ store }: { store: FleetStore }) {
  const [mcp, setMcp] = useState<McpServerProfile[]>([]);
  const [skills, setSkills] = useState<LibrarySkillEntry[]>([]);
  const [localSkillCandidates, setLocalSkillCandidates] = useState<LocalSkillCandidate[]>([]);
  // App-side categorization overlay: skill name → auto-derived tags (merged into
  // the catalog display + tag search for skills whose SKILL.md has no tags).
  const [autoTags, setAutoTags] = useState<Record<string, string[]>>({});
  const [categorizing, setCategorizing] = useState(false);
  const [skillCatalogRefreshing, setSkillCatalogRefreshing] = useState(false);
  const [localSkillRefreshing, setLocalSkillRefreshing] = useState(false);
  const [brainSkills, setBrainSkills] = useState<BrainSkillSummary>(null);
  const [brainCore, setBrainCore] = useState<BrainCoreHealthReport>(null);
  const [brainAgents, setBrainAgents] = useState<BrainAgentsReport>(null);
  const [brainFleet, setBrainFleet] = useState<BrainFleetReport>(null);
  const [brainGraph, setBrainGraph] = useState<BrainGraphReport>(null);
  const [brainSyncing, setBrainSyncing] = useState(false);
  const [brainDrift, setBrainDrift] = useState<SkillBrainDrift | null>(null);
  const [plugins, setPlugins] = useState<LibraryPluginEntry[]>([]);
  const [pluginInspections, setPluginInspections] = useState<LibraryPluginInspection[]>([]);
  const [agentGroupsSnapshot, setAgentGroupsSnapshot] = useState<TeamAgentsGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>('');
  const modulesVersion = useSyncVersion('modules');
  const [tab, setTab] = useState<CapabilityTab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'skills' || t === 'plugins' ? t : 'mcp';
  });

  // Multi-agent targets within the active team. Capabilities apply to ALL
  // selected agents; switch teams with the team picker in the header. Default
  // (untouched) = every agent in the team; toggling switches to an explicit set.
  const activeTeam = store.team ?? 'default';
  // Apply scope: this team / all teams / all team leads. Cross-team scopes route each apply to
  // the agent's OWN team.
  const [scope, setScope] = useState<'team' | 'all' | 'leads'>('team');
  const [coords, setCoords] = useState<Record<string, string>>({});
  useEffect(() => {
    call<{ primary?: { team: string; agent: string } | null; coordinators?: Record<string, string> }>('coordinator:hierarchy')
      .then((h) => {
        const next = { ...(h.coordinators ?? {}) };
        if (h.primary && !next[h.primary.team]) next[h.primary.team] = h.primary.agent;
        setCoords(next);
      })
      .catch(() => {});
  }, [store.lastUpdated]);
  // Capability assignment is runtime-neutral at the IDACC layer. Native runtime
  // support is shown as an advisory execution surface, not used as a hard target
  // filter, so API/subscription/local runtimes can all receive MCP, skills, and
  // portable plugin package state without silently dropping agents.
  const snapshotAllAgents = useMemo<TargetAgent[]>(
    () => agentGroupsSnapshot
      ? agentGroupsSnapshot.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team })))
      : store.allAgents.map((a) => ({ ...a, team: (a as TargetAgent).team ?? activeTeam })),
    [agentGroupsSnapshot, store.allAgents, activeTeam],
  );
  const snapshotTeamAgents = useMemo<TargetAgent[]>(
    () => agentGroupsSnapshot
      ? (agentGroupsSnapshot.find((g) => g.team === activeTeam)?.agents ?? []).map((a) => ({ ...a, team: activeTeam }))
      : store.agents.map((a) => ({ ...a, team: (a as TargetAgent).team ?? activeTeam })),
    [agentGroupsSnapshot, activeTeam, store.agents],
  );
  const baseAgents: TargetAgent[] =
    scope === 'team' ? snapshotTeamAgents : scope === 'leads' ? snapshotAllAgents.filter((a) => coords[a.team ?? ''] === a.name) : snapshotAllAgents;
  const eligibleAgents = baseAgents;
  const advisoryAgents = baseAgents.filter((a) => capabilitySurface(tab, agentRuntime(a)).advisory);
  const targetTeamOf = (a: { team?: string }) => a.team ?? activeTeam;

  const [touched, setTouched] = useState(false);
  const [explicit, setExplicit] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTouched(false);
    setExplicit(new Set());
    setNote('');
  }, [store.team, scope]);
  // Switching tabs changes the eligible set, so reset the explicit selection.
  useEffect(() => {
    setTouched(false);
    setExplicit(new Set());
  }, [tab]);
  // Skills/plugins default to every current agent in scope. MCP defaults to the
  // active team too, so single-team Attach/Detach works without an extra arming
  // step; broad cross-team MCP changes still require an explicit "all" choice.
  const defaultTargetAgents = tab === 'mcp' && scope !== 'team' ? [] : eligibleAgents;
  const selectedIds: Set<string> = touched ? explicit : new Set(defaultTargetAgents.map((a) => a.id));
  const targetAgents = touched
    ? eligibleAgents.filter((a) => selectedIds.has(a.id))
    : defaultTargetAgents;
  const targetCount = targetAgents.length;
  function baseSet(): Set<string> {
    return touched ? new Set(explicit) : new Set(defaultTargetAgents.map((a) => a.id));
  }
  function toggleAgent(id: string) {
    const n = baseSet();
    n.has(id) ? n.delete(id) : n.add(id);
    setExplicit(n);
    setTouched(true);
  }
  function selectAll() { setExplicit(new Set(eligibleAgents.map((a) => a.id))); setTouched(true); }
  function selectNone() { setExplicit(new Set()); setTouched(true); }

  // How many selected agents currently have a given MCP server / skill.
  function mcpCountIn(agents: TargetAgent[], name: string): number {
    return agents.filter((a) => (((a.metadata as any)?.mcpServers ?? []) as { name: string }[]).some((s) => s.name === name)).length;
  }
  function mcpCount(name: string): number {
    return mcpCountIn(targetAgents, name);
  }
  function skillCount(skill: string): number {
    return targetAgents.filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill)).length;
  }
  function agentSkillList(a: { metadata?: unknown }): string[] {
    return (((a.metadata as any)?.skills ?? []) as string[]).map(String);
  }
  function agentHasSkill(a: { metadata?: unknown }, skill: string): boolean {
    return agentSkillList(a).includes(skill);
  }
  function skillAgentKey(a: TargetAgent): string {
    return `${targetTeamOf(a)}:${a.id || a.name}`;
  }
  function skillAgentLabel(a: TargetAgent): string {
    return `${targetTeamOf(a)}/${a.name}`;
  }
  function agentRoleText(a: TargetAgent): string {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const values = [
      targetTeamOf(a),
      a.name,
      a.alias,
      a.type,
      agentRuntime(a),
      meta.description,
      meta.role,
      meta.persona,
      meta.instructions,
    ];
    return values
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(' ')
      .toLowerCase();
  }
  const skillAttachAgents = useMemo<TargetAgent[]>(() => {
    const source = snapshotAllAgents.length
      ? snapshotAllAgents
      : snapshotTeamAgents;
    const byKey = new Map<string, TargetAgent>();
    for (const a of source) {
      const item: TargetAgent = { ...a, team: a.team ?? activeTeam };
      byKey.set(skillAgentKey(item), item);
    }
    return [...byKey.values()].sort((a, b) => skillAgentLabel(a).localeCompare(skillAgentLabel(b)));
  }, [snapshotAllAgents, snapshotTeamAgents]);
  function findSkillAttachAgent(key: string): TargetAgent | null {
    return skillAttachAgents.find((a) => skillAgentKey(a) === key) ?? null;
  }

  // add-MCP: catalog-driven (default) + custom (advanced)
  const [catId, setCatId] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catName, setCatName] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catInputs, setCatInputs] = useState<Record<string, string>>({});
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  // custom form
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [mName, setMName] = useState('');
  const [cmd, setCmd] = useState('npx');
  const [argsStr, setArgsStr] = useState('');
  const [url, setUrl] = useState('');
  const [envStr, setEnvStr] = useState('');
  const [catReplaceArmed, setCatReplaceArmed] = useState(false);
  const [customReplaceArmed, setCustomReplaceArmed] = useState(false);
  // per-key test results: 'cat', 'custom', or a registered server name
  const [test, setTest] = useState<Record<string, TestResult>>({});

  const catEntry = MCP_CATALOG.find((e) => e.id === catId);
  function resetMcpReplaceReview(scope: 'cat' | 'custom') {
    if (scope === 'cat') setCatReplaceArmed(false);
    else setCustomReplaceArmed(false);
    setNote('');
  }
  function pickCatalog(id: string) {
    resetMcpReplaceReview('cat');
    setCatId(id);
    const e = MCP_CATALOG.find((x) => x.id === id);
    setCatName(e?.id ?? '');
    setCatInputs(Object.fromEntries((e?.inputs ?? []).map((i) => [i.key, i.default ?? ''])));
    setTest((t) => ({ ...t, cat: {} }));
  }
  function buildCatalog(): McpServerProfile | null {
    if (!catEntry) return null;
    for (const inp of catEntry.inputs ?? []) {
      if (inp.required && !(catInputs[inp.key] ?? inp.default ?? '').trim()) return null;
    }
    return buildFromCatalog(catEntry, catName, catInputs);
  }
  function buildCustom(): McpServerProfile | null {
    const name = mName.trim();
    if (!name) return null;
    if (transport === 'stdio') {
      if (!cmd.trim()) return null;
      return { name, transport, command: cmd.trim(), ...(argsStr.trim() && { args: argsStr.trim().split(/\s+/) }), ...(parseKV(envStr) && { env: parseKV(envStr) }), enabled: true };
    }
    if (!url.trim()) return null;
    return { name, transport, url: url.trim(), ...(parseKV(envStr) && { headers: parseKV(envStr) }), enabled: true };
  }

  async function reload() {
    setMcp(await call<McpServerProfile[]>('mcp:list').catch(() => []));
    setSkills(await call<LibrarySkillEntry[]>('librarySkills').catch(() => []));
    setLocalSkillCandidates(await call<LocalSkillCandidate[]>('skills:localCandidates').catch(() => []));
    setPlugins(await call<LibraryPluginEntry[]>('libraryPlugins').catch(() => []));
    setPluginInspections(await call<LibraryPluginInspection[]>('libraryPluginInspections').catch(() => []));
    setAutoTags(await call<Record<string, string[]>>('skills:autoTags').catch(() => ({})));
    setBrainSkills(await call<BrainSkillSummary>('skills:brainSummary').catch(() => null));
    setBrainCore(await call<BrainCoreHealthReport>('brain:coreHealth').catch(() => null));
    setBrainAgents(await call<BrainAgentsReport>('brain:agentsReport').catch(() => null));
    setBrainFleet(await call<BrainFleetReport>('brain:fleetReport').catch(() => null));
    setBrainGraph(await call<BrainGraphReport>('brain:graphReport').catch(() => null));
  }
  useEffect(() => {
    reload();
  }, [store.team, store.lastUpdated, modulesVersion]);

  async function refreshSkillCatalog() {
    setSkillCatalogRefreshing(true);
    setNote('refreshing skill catalog…');
    try {
      const before = skillCatalogStamp(skills, autoTags);
      const [latestSkills, latestTags, latestBrain] = await Promise.all([
        call<LibrarySkillEntry[]>('librarySkills').catch(() => skills),
        call<Record<string, string[]>>('skills:autoTags').catch(() => autoTags),
        call<BrainSkillSummary>('skills:brainSummary').catch(() => brainSkills),
      ]);
      const latestCandidates = await call<LocalSkillCandidate[]>('skills:localCandidates').catch(() => localSkillCandidates);
      const after = skillCatalogStamp(latestSkills, latestTags);
      setSkills(latestSkills);
      setLocalSkillCandidates(latestCandidates);
      setAutoTags(latestTags);
      setBrainSkills(latestBrain);
      if (after !== before) {
        setBrainDrift({ kind: 'retagged', skill: 'skill catalog', at: Date.now() });
        setNote(`skill catalog refreshed: ${latestSkills.length} local skills · review Brain sync`);
      } else {
        setNote(`skill catalog current: ${latestSkills.length} local skills`);
      }
    } catch (err) {
      setNote(`skill refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSkillCatalogRefreshing(false);
    }
  }

  // Auto-categorize on load: any skill with neither frontmatter tags nor a cached
  // overlay gets tagged via one batch AI call (heuristic fallback), cached so it
  // only runs once per new skill. `needs` flips false afterward, so this settles.
  useEffect(() => {
    if (categorizing) return;
    const needs = skills.some((s) => !(s.tags && s.tags.length) && !(autoTags[s.name] && autoTags[s.name].length));
    if (!needs) return;
    let alive = true;
    setCategorizing(true);
    call<Record<string, string[]>>('skills:categorize')
      .then((m) => { if (alive) setAutoTags(m); })
      .catch(() => {})
      .finally(() => { if (alive) setCategorizing(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, autoTags]);

  // Re-run AI categorization for all untagged skills (ignores the cache).
  async function recategorize() {
    setCategorizing(true);
    try {
      setAutoTags(await call<Record<string, string[]>>('skills:categorize', true));
      if (skills.length) setBrainDrift({ kind: 'retagged', skill: 'skill tags', at: Date.now() });
      setNote('updated skill categories — Sync Brain to refresh graph tags');
    }
    catch (e) { setNote(`categorize failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setCategorizing(false); }
  }
  async function syncSkillsToBrain() {
    if (!skills.length) {
      setNote('nothing to sync — no library skills found');
      return;
    }
    setBrainSyncing(true);
    setNote('checking Brain core health before sync…');
    try {
      const latestCore = await call<BrainCoreHealthReport>('brain:coreHealth').catch(() => null);
      setBrainCore(latestCore);
      if (!latestCore || latestCore.ok !== true) {
        setNote('Brain sync blocked: Brain core health is unavailable or not ok. Open Brain Skills/Health, restart Brain if needed, then retry.');
        return;
      }
      setNote('checking local skill catalog before Brain sync…');
      const [latestSkills, latestTags, latestBrain] = await Promise.all([
        call<LibrarySkillEntry[]>('librarySkills').catch(() => skills),
        call<Record<string, string[]>>('skills:autoTags').catch(() => autoTags),
        call<BrainSkillSummary>('skills:brainSummary').catch(() => brainSkills),
      ]);
      if (!brainSkillContractCurrent(latestBrain)) {
        setBrainSkills(latestBrain);
        setNote(`Brain sync blocked: ${brainSkillContractDetail(latestBrain)}`);
        return;
      }
      const renderedStamp = skillCatalogStamp(skills, autoTags);
      const latestStamp = skillCatalogStamp(latestSkills, latestTags);
      if (latestStamp !== renderedStamp) {
        setSkills(latestSkills);
        setAutoTags(latestTags);
        setBrainSkills(latestBrain);
        setBrainDrift({ kind: 'retagged', skill: 'skill catalog', at: Date.now() });
        setNote('Brain sync blocked: local skill catalog changed. Review the refreshed catalog, then sync again.');
        return;
      }
      const brainCount = latestBrain?.summary?.totalSkills;
      const brainPreviewStamp = brainSkillSummaryStamp(latestBrain);
      const preview = [
        'Sync local skill catalog to Brain?',
        '',
        `Local SKILL.md entries: ${latestSkills.length}`,
        `Brain /skills/index before sync: ${typeof brainCount === 'number' ? brainCount : 'unknown or unavailable'}`,
        brainDrift ? `Review reason: ${brainReviewDetail}` : 'Review reason: manual refresh',
        '',
        'This additively upserts IDACC skill nodes and rewrites the shared skill-catalog memory.',
        'It does not delete Brain-only skill nodes or install/uninstall skills on agents.',
      ].join('\n');
      if (!window.confirm(preview)) return;
      setNote('rechecking skill catalog and Brain index before Brain write…');
      const [afterSkills, afterTags, afterBrain] = await Promise.all([
        call<LibrarySkillEntry[]>('librarySkills').catch(() => latestSkills),
        call<Record<string, string[]>>('skills:autoTags').catch(() => latestTags),
        call<BrainSkillSummary>('skills:brainSummary').catch(() => latestBrain),
      ]);
      if (skillCatalogStamp(afterSkills, afterTags) !== latestStamp) {
        setSkills(afterSkills);
        setAutoTags(afterTags);
        setBrainDrift({ kind: 'retagged', skill: 'skill catalog', at: Date.now() });
        setNote('Brain sync blocked: skill catalog changed after preview. Review the refreshed catalog and sync again.');
        return;
      }
      if (brainSkillSummaryStamp(afterBrain) !== brainPreviewStamp) {
        setBrainSkills(afterBrain);
        setNote('Brain sync blocked: Brain skill index changed after preview. Review the refreshed Brain catalog status, then sync again.');
        return;
      }
      setNote('syncing skill catalog to Brain…');
      const r = await call<BrainSkillSyncResult>('skills:syncBrain', { catalogStamp: latestStamp });
      const syncedBrain = r.index ?? await call<BrainSkillSummary>('skills:brainSummary').catch(() => null);
      if (syncedBrain?.summary) {
        setBrainSkills(syncedBrain);
      } else {
        setBrainSkills({
          ...afterBrain,
          summary: r.summary ?? afterBrain?.summary,
          meta: { ...(afterBrain?.meta ?? {}), generatedAt: r.generatedAt ?? afterBrain?.meta?.generatedAt },
        });
      }
      setBrainDrift(null);
      setNote(`synced ${r.count}/${r.total} skills to Brain${r.memory ? ' · shared memory ✓' : ''}`);
    } catch (e) {
      setNote(`Brain skill sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBrainSyncing(false);
    }
  }
  useEffect(() => {
    pickCatalog(MCP_CATALOG[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runTest(key: string, profile: McpServerProfile | null) {
    if (!profile) {
      setTest((t) => ({ ...t, [key]: { ok: false, error: 'fill the required fields first' } }));
      return;
    }
    setTest((t) => ({ ...t, [key]: { testing: true } }));
    const res = await call<TestResult>('mcp:test', toSpec(profile)).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    setTest((t) => ({ ...t, [key]: res }));
  }
  async function addProfile(profile: McpServerProfile | null, after: () => void, opts: { replacementArmed?: boolean } = {}) {
    if (!profile) return;
    setBusy(true);
    setNote(`checking MCP registry for ${profile.name}…`);
    try {
      const latest = await call<McpServerProfile[]>('mcp:list').catch(() => mcp);
      const existing = latest.find((p) => p.name === profile.name);
      if (existing) {
        if (!opts.replacementArmed) {
          setMcp(latest);
          setNote(`Review replacement for MCP server "${profile.name}" before adding.`);
          return;
        }
        const before = mcpEndpoint(existing);
        const next = mcpEndpoint(profile);
        if (!window.confirm(`Replace MCP server "${profile.name}" in the registry?\n\nBefore: ${before ?? '(none)'}\nAfter:  ${next ?? '(none)'}\n\nAgents already attached keep their current copy until you attach/rebuild again.`)) return;
        const afterConfirm = await call<McpServerProfile[]>('mcp:list').catch(() => latest);
        const still = afterConfirm.find((p) => p.name === profile.name);
        if (!still || mcpProfileStamp(still) !== mcpProfileStamp(existing)) {
          setMcp(afterConfirm);
          setNote(`replace blocked: MCP server "${profile.name}" changed during confirmation. Review the current registry and try again.`);
          return;
        }
      }
      setMcp(await call<McpServerProfile[]>('mcp:add', profile));
      setNote(existing ? `replaced MCP server ${profile.name} ✓` : `added MCP server ${profile.name} ✓`);
      after();
    } finally {
      setBusy(false);
    }
  }

  async function freshGroups(): Promise<TeamAgentsGroup[]> {
    return call<TeamAgentsGroup[]>('agents:allTeams', { force: true }).catch(() => []);
  }
  async function refreshAgentGroupsSnapshot(): Promise<TeamAgentsGroup[]> {
    const groups = await freshGroups();
    setAgentGroupsSnapshot(groups);
    return groups;
  }
  function findFreshTarget(groups: TeamAgentsGroup[], rendered: TargetAgent): TargetAgent | null {
    const expectedTeam = targetTeamOf(rendered);
    const agents = groups.find((g) => g.team === expectedTeam)?.agents ?? [];
    const found = agents.find((a) => a.id === rendered.id) ?? agents.find((a) => a.name === rendered.name);
    return found ? { ...found, team: expectedTeam } : null;
  }
  function describeTargets(agents: TargetAgent[]): string {
    const labels = agents.map((a) => `${targetTeamOf(a)}/${a.name}`);
    if (labels.length <= 6) return labels.join(', ');
    return `${labels.slice(0, 6).join(', ')}, ...and ${labels.length - 6} more`;
  }
  async function freshCapabilityTargets(label: string, opts: { strictCapabilities?: boolean } = {}): Promise<TargetAgent[] | null> {
    const strictCapabilities = opts.strictCapabilities !== false;
    const groups = await freshGroups();
    let latestCoords = coords;
    if (scope === 'leads') {
      const hierarchy = await call<{ primary?: { team: string; agent: string } | null; coordinators?: Record<string, string> }>('coordinator:hierarchy').catch(() => null);
      if (!hierarchy) {
        setNote(`${label} blocked: could not verify the current lead hierarchy. Refresh and try again.`);
        return null;
      }
      latestCoords = { ...(hierarchy.coordinators ?? {}) };
      if (hierarchy.primary && !latestCoords[hierarchy.primary.team]) latestCoords[hierarchy.primary.team] = hierarchy.primary.agent;
      setCoords(latestCoords);
    }
    if (!touched) {
      const currentScopeTargets: TargetAgent[] =
        scope === 'team'
          ? (groups.find((g) => g.team === activeTeam)?.agents ?? []).map((a) => ({ ...a, team: activeTeam }))
          : scope === 'leads'
            ? groups.flatMap((g) => {
              const lead = latestCoords[g.team];
              return lead ? g.agents.filter((a) => a.name === lead).map((a) => ({ ...a, team: g.team })) : [];
            })
            : groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team })));
      if (capabilityTargetSetStamp(currentScopeTargets, activeTeam) !== capabilityTargetSetStamp(targetAgents, activeTeam)) {
        setNote(`${label} blocked: the ${scope === 'team' ? 'team' : scope === 'leads' ? 'team-lead' : 'all-team'} target set changed. Refreshed; review the current targets before applying.`);
        store.refresh();
        return null;
      }
    }
    const fresh: TargetAgent[] = [];
    for (const rendered of targetAgents) {
      const expectedTeam = targetTeamOf(rendered);
      const current = findFreshTarget(groups, rendered);
      if (!current) {
        setNote(`${label} blocked: ${expectedTeam}/${rendered.name} is no longer in the current roster. Refreshed; review targets and try again.`);
        store.refresh();
        return null;
      }
      if (strictCapabilities && capabilityAgentStamp(current, expectedTeam) !== capabilityAgentStamp({ ...rendered, team: expectedTeam }, expectedTeam)) {
        setNote(`${label} blocked: ${expectedTeam}/${rendered.name} capability state changed. Refreshed; review the current row before applying.`);
        store.refresh();
        return null;
      }
      if (scope === 'leads' && latestCoords[expectedTeam] !== current.name) {
        setNote(`${label} blocked: ${expectedTeam}/${rendered.name} is no longer the current team lead. Refreshed; review targets and try again.`);
        store.refresh();
        return null;
      }
      fresh.push(current);
    }
    return fresh;
  }
  // Apply an action to every selected agent after fresh target validation.
  async function applyToTargets(label: string, fn: (a: TargetAgent) => Promise<unknown>, opts: { strictCapabilities?: boolean } = {}) {
    if (targetCount === 0) {
      setNote('select at least one agent above');
      return;
    }
    setBusy(true);
    setNote(`checking ${label} targets…`);
    try {
      const freshTargets = await freshCapabilityTargets(label, opts);
      if (!freshTargets) return;
      const scopeLabel = scope === 'team' ? `team ${activeTeam}` : scope === 'leads' ? 'all team leads' : 'all teams';
      if (!window.confirm(`Apply "${label}" to ${freshTargets.length} current target${freshTargets.length === 1 ? '' : 's'}?\n\nScope: ${scopeLabel}\nTargets: ${describeTargets(freshTargets)}\n\nThis can change agent capabilities or rebuild running agents.`)) return;
      setNote(`rechecking ${label} targets…`);
      const latestTargets = await freshCapabilityTargets(label, opts);
      if (!latestTargets) return;
      setNote(`${label} · ${latestTargets.length} agent${latestTargets.length > 1 ? 's' : ''}…`);
      for (const a of latestTargets) await fn(a);
      setNote(`${label} ✓ (${latestTargets.length})`);
      store.refresh();
    } catch (err) {
      setNote(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function curMcp(a: { metadata?: unknown }): McpServerSpec[] {
    return ((a.metadata as any)?.mcpServers ?? []) as McpServerSpec[];
  }
  async function attachServer(p: McpServerProfile) {
    await applyToTargets(`attach ${p.name}`, async (a) => {
      const next = [...curMcp(a).filter((s) => s.name !== p.name), toSpec(p)];
      await call<SetMcpResult>('setAgentMcp', a.id, next, targetTeamOf(a));
    }, { strictCapabilities: false });
  }
  async function detachServer(p: McpServerProfile) {
    await applyToTargets(`detach ${p.name}`, async (a) => {
      await call<SetMcpResult>('setAgentMcp', a.id, curMcp(a).filter((s) => s.name !== p.name), targetTeamOf(a));
    }, { strictCapabilities: false });
  }
  async function removeMcpProfile(name: string) {
    setBusy(true);
    setNote(`checking MCP registry for ${name}…`);
    try {
      const latest = await call<McpServerProfile[]>('mcp:list').catch(() => []);
      const existing = latest.find((p) => p.name === name);
      if (!existing) {
        setNote(`remove blocked: MCP server "${name}" is no longer in the registry.`);
        setMcp(latest);
        return;
      }
      if (!window.confirm(`Remove MCP server "${name}" from the current registry?\n\nThis does not detach it from agents that already have it, but it will no longer be available to attach from this catalog.`)) return;
      const afterConfirm = await call<McpServerProfile[]>('mcp:list').catch(() => latest);
      const still = afterConfirm.find((p) => p.name === name);
      if (!still || mcpProfileStamp(still) !== mcpProfileStamp(existing)) {
        setMcp(afterConfirm);
        setNote(`remove blocked: MCP server "${name}" changed during confirmation. Review the current registry and try again.`);
        return;
      }
      setMcp(await call<McpServerProfile[]>('mcp:remove', name));
      setNote(`removed MCP server ${name} ✓`);
    } finally {
      setBusy(false);
    }
  }
  async function rebuildTargets() {
    await applyToTargets('rebuild', (a) => call('rebuildAgent', a.name, targetTeamOf(a)), { strictCapabilities: false });
  }
  async function installSkillAll(skill: string) {
    let changed = 0;
    await applyToTargets(`attach ${skill}`, async (a) => {
      if (agentHasSkill(a, skill)) return;
      changed++;
      await call('installSkill', skill, a.name, targetTeamOf(a));
    }, { strictCapabilities: false });
    if (changed) {
      await refreshAgentGroupsSnapshot();
      await reload();
    }
  }
  async function uninstallSkillAll(skill: string) {
    let changed = 0;
    await applyToTargets(`remove ${skill}`, async (a) => {
      if (!agentHasSkill(a, skill)) return;
      changed++;
      await call('uninstallSkill', skill, a.name, targetTeamOf(a));
    }, { strictCapabilities: false });
    if (changed) {
      await refreshAgentGroupsSnapshot();
      await reload();
    }
  }
  async function installSkillRecommended(skill: string, recommendations: SkillAgentRecommendation[]) {
    const targets = recommendations.filter((r) => !r.installed).slice(0, 4).map((r) => r.agent);
    if (!targets.length) {
      setNote(`${skill} has no pending recommended agents`);
      return;
    }
    setBusy(true);
    setNote(`attaching ${skill} to recommended agents…`);
    try {
      const groups = await freshGroups();
      let changed = 0;
      for (const rendered of targets) {
        const current = findFreshTarget(groups, rendered);
        if (!current || agentHasSkill(current, skill)) continue;
        await call('installSkill', skill, current.name, targetTeamOf(current));
        changed++;
      }
      if (changed) await refreshAgentGroupsSnapshot();
      await reload();
      store.refresh();
      setNote(changed ? `attached ${skill} to ${changed} recommended agent${changed === 1 ? '' : 's'} ✓` : `${skill} was already attached to the recommended agents`);
    } catch (err) {
      setNote(`attach recommended failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  async function uninstallSkillFleet(skill: string) {
    setBusy(true);
    setNote(`checking fleet usage for ${skill}…`);
    try {
      const installed = await freshSkillFleetUsage(skill);
      if (!installed) {
        setNote(`remove blocked: could not verify current fleet skill usage for ${skill}. Refresh and try again.`);
        return;
      }
      if (!installed.length) {
        await reload();
        setNote(`${skill} is not installed on any fleet agents`);
        return;
      }
      const preview = describeTargets(installed.slice(0, 12));
      const extra = installed.length > 12 ? `, +${installed.length - 12} more` : '';
      if (!window.confirm(`Remove skill "${skill}" from every current fleet agent that has it?\n\nAgents: ${preview}${extra}\n\nThis does not delete the library SKILL.md. It only detaches the skill from agent metadata and live runtime skill folders.`)) return;
      const latest = await freshSkillFleetUsage(skill);
      if (!latest) {
        setNote(`remove blocked: could not recheck fleet skill usage for ${skill}.`);
        return;
      }
      setNote(`removing ${skill} from ${latest.length} fleet agent${latest.length === 1 ? '' : 's'}…`);
      for (const a of latest) {
        await call('uninstallSkill', skill, a.name, targetTeamOf(a));
      }
      if (latest.length) await refreshAgentGroupsSnapshot();
      await reload();
      setNote(`removed ${skill} from ${latest.length} fleet agent${latest.length === 1 ? '' : 's'} ✓`);
      store.refresh();
    } catch (err) {
      setNote(`fleet remove failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Two-step confirm for the destructive library delete (window.confirm is not
  // reliable in Electron, and a single misclick must not nuke a skill).
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  async function removeSkill(name: string) {
    setBusy(true);
    setNote(`checking skill ${name}…`);
    try {
      const installed = await freshSkillFleetUsage(name);
      if (!installed) {
        setNote(`delete blocked: could not verify current fleet skill usage for ${name}. Refresh and try again.`);
        return;
      }
      if (installed.length) {
        setNote(`delete blocked: ${name} is still installed on ${installed.length} fleet agent${installed.length === 1 ? '' : 's'} (${describeTargets(installed.slice(0, 6))}${installed.length > 6 ? ', ...' : ''}). Uninstall it from all teams before deleting the library SKILL.md.`);
        return;
      }
      const latest = await call<LibrarySkillEntry[]>('librarySkills').catch(() => []);
      if (!latest.some((s) => s.name === name)) {
        setNote(`delete blocked: skill ${name} is no longer in the library.`);
        setSkills(latest);
        setConfirmDel(null);
        return;
      }
      await call('deleteSkill', name);
      setConfirmDel(null);
      setTagFilter(new Set());
      await reload();
      setBrainDrift({ kind: 'deleted', skill: name, at: Date.now() });
      setNote(`deleted skill ${name} ✓ — Brain skill sync pending`);
    } catch (err) {
      setNote(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // ---- Skills catalog: search + tag filtering ----------------------------
  const [skillQuery, setSkillQuery] = useState('');
  const [skillAgentDrafts, setSkillAgentDrafts] = useState<Record<string, string>>({});
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of skills) {
      for (const t of s.tags ?? []) set.add(t);
      for (const t of autoTags[s.name] ?? []) set.add(t);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [skills, autoTags]);
  function toggleTag(t: string) {
    setTagFilter((prev) => {
      const n = new Set(prev);
      n.has(t) ? n.delete(t) : n.add(t);
      return n;
    });
  }
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return skills.filter((s) => {
      const tags = [...(s.tags ?? []), ...(autoTags[s.name] ?? [])];
      if (tagFilter.size > 0 && !tags.some((t) => tagFilter.has(t))) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q) ||
        tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [skills, skillQuery, tagFilter, autoTags]);
  const skillTagStats = useMemo(() => {
    const counts = new Map<string, number>();
    let frontmatter = 0;
    let autoOnly = 0;
    for (const s of skills) {
      const fm = s.tags ?? [];
      const auto = autoTags[s.name] ?? [];
      if (fm.length) frontmatter += 1;
      else if (auto.length) autoOnly += 1;
      for (const t of new Set([...fm, ...auto])) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return {
      frontmatter,
      autoOnly,
      untagged: Math.max(0, skills.length - frontmatter - autoOnly),
      topTags: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
    };
  }, [skills, autoTags]);
  const importableLocalSkills = useMemo(
    () => localSkillCandidates.filter((candidate) => !candidate.installed).slice(0, 12),
    [localSkillCandidates],
  );
  const installedLocalSkillCandidates = useMemo(
    () => localSkillCandidates.filter((candidate) => candidate.installed).length,
    [localSkillCandidates],
  );

  // ---- Skills: create a new skill (agentskills.io SKILL.md) ---------------
  const [showCreate, setShowCreate] = useState(false);
  const blankSkill = { name: '', description: '', tags: '', category: '', license: '', compatibility: '', tools: '', body: '' };
  const [ns, setNs] = useState(blankSkill);
  const nameErr = skillNameError(ns.name);
  const createValid = !nameErr && ns.description.trim().length > 0 && ns.description.trim().length <= 1024;
  async function createSkill() {
    if (!createValid) return;
    setBusy(true);
    setNote(`creating skill ${ns.name.trim()}…`);
    try {
      const metadata: Record<string, string> = {};
      const tags = splitTags(ns.tags);
      if (tags.length) metadata.tags = tags.join(', ');
      if (ns.category.trim()) metadata.category = ns.category.trim();
      const input: CreateSkillInput = {
        name: ns.name.trim(),
        description: ns.description.trim(),
        ...(ns.license.trim() && { license: ns.license.trim() }),
        ...(ns.compatibility.trim() && { compatibility: ns.compatibility.trim() }),
        ...(ns.tools.trim() && { allowedTools: ns.tools.trim() }),
        ...(Object.keys(metadata).length && { metadata }),
        ...(ns.body.trim() && { body: ns.body }),
      };
      const entry = await call<LibrarySkillEntry>('createSkill', input);
      setNote(`created skill ${entry.name} ✓ — now in the catalog`);
      setNs(blankSkill);
      setShowCreate(false);
      setSkillQuery(entry.name);
      setTagFilter(new Set());
      await reload();
      setBrainDrift({ kind: 'created', skill: entry.name, at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNote(`create failed: ${/already_exists/.test(msg) ? 'a skill with that name already exists' : msg}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshLocalSkillCandidates() {
    setLocalSkillRefreshing(true);
    setNote('scanning local SKILL.md folders…');
    try {
      const candidates = await call<LocalSkillCandidate[]>('skills:localCandidates').catch(() => []);
      setLocalSkillCandidates(candidates);
      const importable = candidates.filter((candidate) => !candidate.installed).length;
      setNote(`local skill scan complete: ${importable} importable candidate${importable === 1 ? '' : 's'}`);
    } catch (err) {
      setNote(`local skill scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLocalSkillRefreshing(false);
    }
  }

  async function importLocalSkill(candidate: LocalSkillCandidate) {
    if (candidate.installed) return;
    const message = [
      `Import local skill "${candidate.name}" from ${candidate.source}?`,
      '',
      `Source: ${candidate.sourcePath}`,
      '',
      'IDACC will copy the SKILL.md body into the manager library. Existing library skills are not overwritten.',
      'After import, attach it to agents and sync Brain before relying on routing/graph surfaces.',
    ].join('\n');
    if (!window.confirm(message)) return;
    setBusy(true);
    setNote(`importing local skill ${candidate.name}…`);
    try {
      const entry = await call<LibrarySkillEntry>('skills:importLocalCandidate', candidate.id);
      setSkillQuery(entry.name);
      setTagFilter(new Set());
      await reload();
      setBrainDrift({ kind: 'created', skill: entry.name, at: Date.now() });
      setNote(`imported ${entry.name} into manager skill catalog ✓`);
    } catch (err) {
      setNote(`import failed: ${err instanceof Error ? err.message : String(err)}`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function digestPluginAsSkill(plugin: PluginRow) {
    if (plugin.skillProjection !== 'available') return;
    const message = [
      `Digest plugin "${plugin.name}" into the SKILL.md catalog?`,
      '',
      'IDACC will fresh-read the plugin detail and current skill catalog before writing.',
      'Only instruction-only plugins are allowed here; tool-bearing packages stay as plugins until they have reviewed adapters.',
      '',
      'After this succeeds, Preview & sync Brain is still required before Brain Skills/Graph use the new skill node.',
    ].join('\n');
    if (!window.confirm(message)) return;
    setBusy(true);
    setNote('');
    try {
      const result = await call<ProjectPluginSkillResult>('projectPluginSkill', plugin.name);
      const skillName = result.entry?.name ?? plugin.name;
      setNote(`digested plugin ${plugin.name} into skill ${skillName} ✓ — sync Brain when ready`);
      setSkillQuery(skillName);
      setTagFilter(new Set());
      await reload();
      setBrainDrift({ kind: 'created', skill: skillName, at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNote(`digest failed: ${msg}`);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  // # selected agents that have at least one MCP server attached (→ show Rebuild).
  const anyAttached = targetAgents.some((a) => curMcp(a).length > 0);
  const targetLabel = targetCount === 0 ? 'no selected agents' : targetCount === 1 ? targetAgents[0].name : `${targetCount} agents`;
  const allPluginRows = useMemo<PluginRow[]>(() => {
    const inspectionByName = new Map(pluginInspections.map((inspection) => [inspection.name, inspection]));
    const idaccPortableDefaults: Partial<PluginRow> = {
      hasSkillMd: true,
      hasTools: true,
      toolCount: 3,
      tools: ['contract', 'mcp', 'resolve'],
      entrypoint: 'SKILL.md',
      adapterKinds: ['skill', 'mcp', 'native-plugin', 'direct-fallback'],
      classification: 'portable-package',
      skillProjection: 'blocked-tools',
      notes: ['Bundled IDACC package with Skill, MCP, native plugin, and direct-fallback adapters.'],
    };
    const rows: PluginRow[] = plugins.map((plugin) => ({
      ...plugin,
      ...(inspectionByName.get(plugin.name) ?? {}),
      ...(plugin.name === 'idacc-context-retrieval' ? idaccPortableDefaults : {}),
      packageSource: plugin.name === 'idacc-context-retrieval' ? 'manager + IDACC portable package' : 'manager native inventory',
      bundledPortable: plugin.name === 'idacc-context-retrieval',
    }));
    if (!rows.some((plugin) => plugin.name === 'idacc-context-retrieval')) {
      rows.unshift({
        name: 'idacc-context-retrieval',
        version: '0.1.0',
        description: 'IDACC portable retrieval-handle resolver for future Headroom-backed context compression pilots.',
        source: 'bundled with IDACC',
        hasManifest: true,
        ...idaccPortableDefaults,
        packageSource: 'IDACC bundled portable package',
        bundledPortable: true,
      });
    }
    return rows;
  }, [plugins, pluginInspections]);
  const digestedPluginRows = useMemo(() => allPluginRows.filter(pluginIsDigestedSkill), [allPluginRows]);
  const pluginRows = useMemo(() => allPluginRows.filter((plugin) => !pluginIsDigestedSkill(plugin)), [allPluginRows]);
  function skillFleetUsage(skill: string): TargetAgent[] {
    return snapshotAllAgents.filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill));
  }
  async function freshSkillFleetUsage(skill: string): Promise<TargetAgent[] | null> {
    const groups = await call<TeamAgentsGroup[]>('agents:allTeams', { force: true }).catch(() => null);
    if (!groups) return null;
    return groups
      .flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team })))
      .filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill));
  }
  function skillTagsFor(skill: LibrarySkillEntry): string[] {
    return [...new Set([...(skill.tags ?? []), ...(autoTags[skill.name] ?? [])].map(String).filter(Boolean))];
  }
  function skillSearchText(skill: LibrarySkillEntry): string {
    return [skill.name, skill.description ?? '', ...skillTagsFor(skill)].join(' ').toLowerCase();
  }
  function skillTokens(skill: LibrarySkillEntry): string[] {
    return [...new Set(skillSearchText(skill).split(/[^a-z0-9]+/).filter((t) => t.length >= 4))];
  }
  function skillRecommendations(skill: LibrarySkillEntry): SkillAgentRecommendation[] {
    const skillText = skillSearchText(skill);
    const tokens = skillTokens(skill);
    return skillAttachAgents
      .map((agent) => {
        const roleText = agentRoleText(agent);
        const installed = agentHasSkill(agent, skill.name);
        const reasons: string[] = [];
        let score = installed ? 1 : 0;
        for (const token of tokens) {
          if (roleText.includes(token)) {
            score += 4;
            if (reasons.length < 3) reasons.push(token);
          }
        }
        for (const rule of SKILL_ROLE_RULES) {
          if (rule.skill.some((token) => skillText.includes(token)) && rule.role.some((token) => roleText.includes(token))) {
            score += 8;
            if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
          }
        }
        const team = targetTeamOf(agent).toLowerCase();
        if (team && skillText.includes(team.replace(/-team$/, ''))) {
          score += 3;
          if (reasons.length < 3) reasons.push('team match');
        }
        return { agent, score, reasons, installed };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || Number(a.installed) - Number(b.installed) || skillAgentLabel(a.agent).localeCompare(skillAgentLabel(b.agent)));
  }
  async function applySkillToAgent(skill: string, rendered: TargetAgent, action: 'install' | 'uninstall') {
    const actionLabel = action === 'install' ? 'attach' : 'remove';
    const expectedTeam = targetTeamOf(rendered);
    setBusy(true);
    setNote(`checking ${expectedTeam}/${rendered.name} before ${actionLabel}…`);
    try {
      const groups = await freshGroups();
      const current = findFreshTarget(groups, rendered);
      if (!current) {
        setNote(`${actionLabel} blocked: ${expectedTeam}/${rendered.name} is no longer in the current roster. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      if (current.id && rendered.id && current.id !== rendered.id) {
        setNote(`${actionLabel} blocked: ${expectedTeam}/${rendered.name} now points to a different agent id. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      const hasSkill = agentHasSkill(current, skill);
      if (action === 'install' && hasSkill) {
        setNote(`${expectedTeam}/${current.name} already has ${skill}`);
        return;
      }
      if (action === 'uninstall' && !hasSkill) {
        setNote(`${expectedTeam}/${current.name} does not have ${skill}`);
        return;
      }
      const prompt = [
        `${actionLabel === 'attach' ? 'Attach' : 'Remove'} skill "${skill}" ${actionLabel === 'attach' ? 'to' : 'from'} ${expectedTeam}/${current.name}?`,
        '',
        'IDACC will recheck the current roster again before writing.',
        'This changes one agent capability and can affect the next rebuild or runtime sync.',
      ].join('\n');
      if (!window.confirm(prompt)) return;
      const recheckGroups = await freshGroups();
      const latest = findFreshTarget(recheckGroups, current);
      if (!latest || latest.id !== current.id || latest.name !== current.name) {
        setNote(`${actionLabel} blocked: ${expectedTeam}/${current.name} changed identity during confirmation. Refreshed; review and try again.`);
        store.refresh();
        return;
      }
      const latestHasSkill = agentHasSkill(latest, skill);
      if (action === 'install' && latestHasSkill) {
        await reload();
        setNote(`${expectedTeam}/${latest.name} already has ${skill}`);
        return;
      }
      if (action === 'uninstall' && !latestHasSkill) {
        await reload();
        setNote(`${expectedTeam}/${latest.name} already lacks ${skill}`);
        store.refresh();
        return;
      }
      await call(action === 'install' ? 'installSkill' : 'uninstallSkill', skill, latest.name, expectedTeam);
      await refreshAgentGroupsSnapshot();
      await reload();
      setNote(`${skill} ${action === 'install' ? 'attached to' : 'removed from'} ${expectedTeam}/${latest.name} ✓`);
      store.refresh();
    } catch (err) {
      setNote(`${actionLabel} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  const brainTotal = brainSkills?.summary?.totalSkills;
  const brainMissingLocal = typeof brainTotal === 'number' && brainTotal < skills.length;
  const brainExtraNodes = typeof brainTotal === 'number' && brainTotal > skills.length;
  const brainContractCurrent = brainSkillContractCurrent(brainSkills);
  const brainContractNeedsReview = !brainContractCurrent;
  const brainNeedsLocalSync = !!brainDrift || brainMissingLocal;
  const brainCatalogNeedsReview = brainNeedsLocalSync || brainContractNeedsReview;
  const brainStatusLabel = !brainSkills?.summary
    ? 'Brain --'
    : brainDrift
      ? 'Brain review'
      : brainMissingLocal
        ? `Brain behind ${brainTotal}/${skills.length}`
        : brainContractNeedsReview
          ? `Brain ${brainTotal ?? '?'} stale`
          : brainExtraNodes
            ? `Brain +${brainTotal - skills.length}`
            : `Brain ${brainTotal}`;
  const brainStatusTitle = [
    brainSkills?.meta?.generatedAt ? `Brain index generated ${brainSkills.meta.generatedAt}` : 'Brain skill index unavailable',
    `Contract: ${brainContractCurrent ? 'current' : brainSkillContractGaps(brainSkills).join(', ')}`,
    brainSkills?.meta?.profile || brainSkills?.profile ? `Profile: ${brainSkills?.meta?.profile ?? brainSkills?.profile ?? ''}` : '',
    brainSkills?.facets ? `Facets: ${brainSkills.facets.domains?.length ?? 0} domains / ${brainSkills.facets.tags?.length ?? 0} tags` : '',
    Array.isArray(brainSkills?.reuseGroups) ? `Reuse groups: ${brainSkills?.reuseGroups?.length ?? 0}` : '',
    `Local catalog ${skills.length}${typeof brainTotal === 'number' ? `; Brain index ${brainTotal}` : ''}`,
    brainExtraNodes ? 'Brain may include learned or previously synced skill nodes that are not in the local catalog.' : '',
  ].filter(Boolean).join('\n');
  const brainReviewDetail = brainDrift?.kind === 'created'
    ? `Created ${brainDrift.skill} locally. Sync Brain to make the definition visible in Brain Skills and Graph.`
    : brainDrift?.kind === 'deleted'
      ? `Deleted ${brainDrift.skill} locally. Sync Brain refreshes shared catalog memory, but Brain-only skill nodes are intentionally retained for learned history.`
      : brainDrift?.kind === 'retagged'
        ? 'Skill auto-tags changed locally. Sync Brain to refresh graph tags and the shared skill memory.'
        : brainMissingLocal
          ? `Local catalog has ${skills.length} skills while Brain reports ${brainTotal ?? 'unknown'}. Sync Brain to upsert current local definitions.`
          : brainSkillContractDetail(brainSkills);
  const idaccFleetTotals = useMemo<LiveFleetTotals>(() => ({
    total: store.allAgents.length,
    running: store.allAgents.filter((a) => agentStatusIsRunning(a.status)).length,
  }), [store.allAgents]);
  const brainCoreNeedsOperatorReview = brainCoreNeedsReview(brainCore);
  const brainCoreStatus = brainCoreStatusLabel(brainCore);
  const brainCoreTitle = brainCoreStatusTitle(brainCore);
  const brainCoreDetail = brainCoreReviewDetail(brainCore);
  const brainFleetMismatch = brainFleetMismatchDetail(brainFleet, idaccFleetTotals);
  const brainFleetNeedsReview = brainFleetReviewNeeded(brainFleet) || !!brainFleetMismatch;
  const brainFleetStatus = brainFleetMismatch
    ? `Fleet ${brainFleet?.fleet?.running ?? '?'}/${brainFleet?.fleet?.total ?? '?'} drift`
    : brainFleetStatusLabel(brainFleet);
  const brainFleetTitle = [brainFleetStatusTitle(brainFleet), brainFleetMismatch].filter(Boolean).join('\n');
  const brainFleetDetail = brainFleetMismatch ?? brainFleetReviewDetail(brainFleet);
  const brainAgentsNeedOperatorReview = brainAgentsNeedsReview(brainAgents);
  const brainAgentsStatus = brainAgentsStatusLabel(brainAgents);
  const brainAgentsTitle = brainAgentsStatusTitle(brainAgents);
  const brainAgentsDetail = brainAgentsReviewDetail(brainAgents);
  const brainGraphNeedsReview = brainGraphReviewNeeded(brainGraph);
  const brainGraphStatus = brainGraphStatusLabel(brainGraph);
  const brainGraphTitle = brainGraphStatusTitle(brainGraph);
  const brainGraphDetail = brainGraphReviewDetail(brainGraph);
  const brainCheckItems = [
    { label: brainStatusLabel, title: brainStatusTitle, review: brainCatalogNeedsReview },
    { label: brainCoreStatus, title: brainCoreTitle, review: brainCoreNeedsOperatorReview },
    { label: brainFleetStatus, title: brainFleetTitle, review: brainFleetNeedsReview },
    { label: brainAgentsStatus, title: brainAgentsTitle, review: brainAgentsNeedOperatorReview },
    { label: brainGraphStatus, title: brainGraphTitle, review: brainGraphNeedsReview },
  ];
  const brainDashboardReviewCount = brainCheckItems.filter((item) => item.review).length;
  const brainSkillSyncVisible = brainNeedsLocalSync;
  const brainSkillStatusLabel = brainSkillSyncVisible
    ? 'Brain sync needed'
    : typeof brainTotal === 'number'
      ? `Brain ${brainTotal}`
      : 'Brain --';
  const brainSkillStatusTitle = [
    brainStatusTitle,
    brainDashboardReviewCount
      ? `${brainDashboardReviewCount} Brain dashboard check${brainDashboardReviewCount === 1 ? '' : 's'} need review. These stay in guarded Brain tab launchers, not the Skills catalog.`
      : '',
  ].filter(Boolean).join('\n\n');
  const brainDashboardReviewTabs: BrainDashboardReviewMap = {
    fleet: brainFleetNeedsReview ? brainFleetDetail : undefined,
    health: brainCoreNeedsOperatorReview ? brainCoreDetail : undefined,
    skills: brainCatalogNeedsReview ? brainReviewDetail : undefined,
    learning: brainCoreNeedsOperatorReview ? brainCoreDetail : undefined,
    agents: brainAgentsNeedOperatorReview ? brainAgentsDetail : undefined,
    graph: brainGraphNeedsReview ? brainGraphDetail : undefined,
  };
  const brainSyncWriteBlocked = !brainCore || brainCore.ok !== true;
  const brainSyncContractBlocked = brainContractNeedsReview;
  const brainSyncDisabled = brainSyncing || skills.length === 0 || brainSyncWriteBlocked || brainSyncContractBlocked;
  const brainSyncTitle = brainSyncWriteBlocked
    ? 'Brain core health is unavailable or not ok; open Brain Skills/Health before writing the skill catalog'
    : brainSyncContractBlocked
      ? brainSkillContractDetail(brainSkills)
    : 'Preview, fresh-read, then upsert the local skill catalog into Brain /skills/index';
  const brainDomainFacets = (brainSkills?.facets?.domains ?? []).map(brainFacetLabel).filter(Boolean).slice(0, 4);
  const brainTagFacets = (brainSkills?.facets?.tags ?? []).map(brainFacetLabel).filter(Boolean).slice(0, 4);
  const catalogDraft = buildCatalog();
  const customDraft = buildCustom();
  const catalogReplace = catalogDraft ? mcp.find((p) => p.name === catalogDraft.name) : undefined;
  const customReplace = customDraft ? mcp.find((p) => p.name === customDraft.name) : undefined;
  const mcpAttachedTotal = mcp.reduce((sum, profile) => sum + mcpCount(profile.name), 0);
  const mcpAttachedScopeTotal = mcp.reduce((sum, profile) => sum + mcpCountIn(eligibleAgents, profile.name), 0);

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>Capabilities</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span className="muted small">scope</span>
          <select className="cell-select" value={scope} onChange={(e) => setScope(e.target.value as 'team' | 'all' | 'leads')} title="Apply to the active team, every team, or every team's lead">
            <option value="team">This team</option>
            <option value="all">All teams</option>
            <option value="leads">All team leads</option>
          </select>
          {scope !== 'team' ? (
            <>
              <span className="muted small" title={`Runtime-neutral target scope. ${capabilitySurfaceSummary(tab, eligibleAgents)}`}>
                available <b>{eligibleAgents.length}</b> {scope === 'leads' ? 'team lead' : 'agent'}{eligibleAgents.length === 1 ? '' : 's'} across all teams
              </span>
              <span className="muted small">
                selected <b>{targetCount}</b>
              </span>
              <button
                className="btn small"
                disabled={busy || eligibleAgents.length === 0}
                title={tab === 'mcp' ? 'MCP bulk changes require explicitly arming the target set' : 'Set the current cross-team target selection'}
                onClick={() => (targetCount === eligibleAgents.length ? selectNone() : selectAll())}
              >
                {targetCount === eligibleAgents.length ? 'none' : 'all'}
              </button>
            </>
          ) : (
          <>
          <span className="muted small">team</span>
          <select className="cell-select" value={activeTeam} onChange={(e) => void store.setTeam(e.target.value)}>
            {store.teams.filter((t) => t.name === activeTeam || store.allAgents.some((a) => a.team === t.name && !!a.status && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/i.test(a.status))).map((t) => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>
          <span className="muted small">apply to</span>
          {store.agents.length === 0 ? (
            <span className="muted small">(no agents)</span>
          ) : (
            <>
              <span className="chips">
                {store.agents.map((a) => {
                  const surface = capabilitySurface(tab, agentRuntime(a));
                  const on = selectedIds.has(a.id);
                  return (
                    <button
                      key={a.id}
                      className={`chip${on ? ' on' : ''}${surface.advisory ? ' incompat' : ''}`}
                      disabled={busy}
                      title={`${a.name} · ${agentRuntime(a) ?? 'unknown runtime'} — ${surface.title}`}
                      onClick={() => toggleAgent(a.id)}
                    >
                      {on ? '✓ ' : ''}{a.name} · {surface.label}
                    </button>
                  );
                })}
              </span>
              <button className="btn small" disabled={busy || eligibleAgents.length === 0} onClick={() => (targetCount === eligibleAgents.length ? selectNone() : selectAll())}>
                {targetCount === eligibleAgents.length ? 'none' : 'all'}
              </button>
            </>
          )}
          </>
          )}
        </div>
      </header>

      <div className="tabs">
        {([
          ['mcp', 'MCP servers'],
          ['skills', 'Skills'],
          ['plugins', 'Plugins'],
        ] as [CapabilityTab, string][]).map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {eligibleAgents.length > 0 ? (
        <div className="muted small" title={eligibleAgents.map((a) => `${targetTeamOf(a)}/${a.name}: ${capabilitySurface(tab, agentRuntime(a)).title}`).join('\n')}>
          Runtime-neutral targeting: {capabilitySurfaceSummary(tab, eligibleAgents)}{advisoryAgents.length ? ` · ${advisoryAgents.length} fallback/advisory` : ''}.
        </div>
      ) : null}

      {note ? <div className="muted small">{note}</div> : null}

      {tab === 'mcp' ? (
      <section className="card grow">
        <div className="row-actions" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h3 className="grow">MCP</h3>
          <span className="chip tag" title="Registered MCP server profiles">Servers {mcp.length}</span>
          <span
            className="chip tag"
            title={targetCount ? 'Total attachments across selected targets' : 'No MCP targets selected yet; showing attachments across the current scope'}
          >
            Attached {targetCount ? mcpAttachedTotal : mcpAttachedScopeTotal}
          </span>
          <button className="btn small" onClick={() => setShowAddMcp((show) => !show)}>
            {showAddMcp ? 'Close add' : '+ Add server'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Tool servers for <b>{targetLabel}</b>. Attach or detach, then rebuild affected agents.
          {tab === 'mcp' && scope !== 'team' && !touched ? ' Choose all to arm a broad cross-team MCP change.' : ''}
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>server</th>
              <th>attached</th>
              <th>status</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            {mcp.map((p) => {
              const tr = test[p.name];
              const have = mcpCount(p.name);
              const scopeHave = mcpCountIn(eligibleAgents, p.name);
              return (
                <tr key={p.name}>
                  <td>
                    <div className="b">{p.name} <span className="muted small">{p.transport}</span></div>
                    <div className="mono small">{p.transport === 'stdio' ? [p.command, ...(p.args ?? [])].join(' ') : p.url}</div>
                  </td>
                  <td className={(targetCount ? have : scopeHave) > 0 ? 'ok-text small' : 'muted small'}>
                    {targetCount ? `${have}/${targetCount}` : `${scopeHave}/${eligibleAgents.length} in scope`}
                  </td>
                  <td className="small"><TestCell r={tr} /></td>
                  <td className="row-actions">
                    <button className="btn" disabled={busy || targetCount === 0 || have === targetCount} onClick={() => void attachServer(p)}>Attach</button>
                    <button className="btn" disabled={busy || have === 0} onClick={() => void detachServer(p)}>Detach</button>
                    <button className="btn" disabled={tr?.testing} onClick={() => void runTest(p.name, p)}>{tr?.testing ? '…' : 'Test'}</button>
                    <button className="btn" onClick={() => void removeMcpProfile(p.name)}>✕</button>
                  </td>
                </tr>
              );
            })}
            {mcp.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted center pad">No MCP servers registered.</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        {anyAttached ? (
          <div className="row-actions" style={{ marginTop: 10 }}>
            <span className="muted small grow">attach/detach updates take effect on rebuild</span>
            <button className="btn" disabled={busy || targetCount === 0} onClick={() => void rebuildTargets()}>Rebuild {targetLabel}</button>
          </div>
        ) : null}

        {showAddMcp || mcp.length === 0 ? (
        <>
        <h3 style={{ marginTop: 18 }}>Add server</h3>
        <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '8px 12px' }}>
          <span>from catalog</span>
          <b>
            <select value={catId} onChange={(e) => pickCatalog(e.target.value)}>
              {MCP_CATALOG.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </b>
          {catEntry ? (
            <>
              <span></span>
              <b className="muted small">{catEntry.description}</b>
              <span>name</span>
              <b><input style={{ width: 200 }} value={catName} onChange={(e) => { resetMcpReplaceReview('cat'); setCatName(e.target.value); }} /></b>
              {(catEntry.inputs ?? []).map((inp) => (
                <Fragment key={inp.key}>
                  <span>{inp.label}{inp.required ? ' *' : ''}</span>
                  <b>
                    <input
                      style={{ width: 320 }}
                      type={inp.secret ? 'password' : 'text'}
                      placeholder={inp.placeholder}
                      value={catInputs[inp.key] ?? ''}
                      onChange={(e) => { resetMcpReplaceReview('cat'); setCatInputs((c) => ({ ...c, [inp.key]: e.target.value })); }}
                    />
                  </b>
                </Fragment>
              ))}
            </>
          ) : null}
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="grow small"><TestCell r={test.cat} /></span>
          <button className="btn" disabled={test.cat?.testing} onClick={() => void runTest('cat', catalogDraft)}>{test.cat?.testing ? 'Testing…' : 'Test'}</button>
          <button className="btn primary" disabled={busy || !catalogDraft || (!!catalogReplace && !catReplaceArmed)} onClick={() => void addProfile(catalogDraft, () => { setTest((t) => ({ ...t, cat: {} })); setCatReplaceArmed(false); }, { replacementArmed: catReplaceArmed })}>{catalogReplace ? 'Replace' : 'Add'}</button>
        </div>
        {catalogDraft && catalogReplace ? (
          <div className="mcp-replace-review">
            <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={catReplaceArmed} onChange={(e) => { setCatReplaceArmed(e.target.checked); setNote(''); }} />
              Replace existing MCP server
            </label>
            <span className="muted small">Before: {mcpEndpoint(catalogReplace)}</span>
            <span className="muted small">After: {mcpEndpoint(catalogDraft)}</span>
          </div>
        ) : null}

        <button className="btn small" style={{ marginTop: 12 }} onClick={() => setShowCustom((s) => !s)}>
          {showCustom ? '− custom server' : '+ custom server (advanced)'}
        </button>
        {showCustom ? (
          <>
            <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '8px 12px', marginTop: 8 }}>
              <span>transport</span>
              <b>
                <select className="cell-select" value={transport} onChange={(e) => { resetMcpReplaceReview('custom'); setTransport(e.target.value as McpTransport); }}>
                  {TRANSPORTS.map((t) => (<option key={t} value={t}>{t}</option>))}
                </select>
              </b>
              <span>name</span>
              <b><input style={{ width: 200 }} placeholder="name" value={mName} onChange={(e) => { resetMcpReplaceReview('custom'); setMName(e.target.value); }} /></b>
              {transport === 'stdio' ? (
                <>
                  <span>command</span>
                  <b><input style={{ width: 200 }} placeholder="npx" value={cmd} onChange={(e) => { resetMcpReplaceReview('custom'); setCmd(e.target.value); }} /></b>
                  <span>args</span>
                  <b><input style={{ width: 360 }} placeholder="-y @scope/pkg /tmp (space-separated)" value={argsStr} onChange={(e) => { resetMcpReplaceReview('custom'); setArgsStr(e.target.value); }} /></b>
                  <span>env</span>
                  <b><input style={{ width: 360 }} placeholder="KEY=value, KEY2=value2" value={envStr} onChange={(e) => { resetMcpReplaceReview('custom'); setEnvStr(e.target.value); }} /></b>
                </>
              ) : (
                <>
                  <span>url</span>
                  <b><input style={{ width: 360 }} placeholder="https://host/mcp" value={url} onChange={(e) => { resetMcpReplaceReview('custom'); setUrl(e.target.value); }} /></b>
                  <span>headers</span>
                  <b><input style={{ width: 360 }} placeholder="Authorization=Bearer …" value={envStr} onChange={(e) => { resetMcpReplaceReview('custom'); setEnvStr(e.target.value); }} /></b>
                </>
              )}
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <span className="grow small"><TestCell r={test.custom} /></span>
              <button className="btn" disabled={test.custom?.testing} onClick={() => void runTest('custom', customDraft)}>{test.custom?.testing ? 'Testing…' : 'Test'}</button>
              <button className="btn primary" disabled={busy || !customDraft || (!!customReplace && !customReplaceArmed)} onClick={() => void addProfile(customDraft, () => { setMName(''); setArgsStr(''); setEnvStr(''); setUrl(''); setTest((t) => ({ ...t, custom: {} })); setCustomReplaceArmed(false); }, { replacementArmed: customReplaceArmed })}>{customReplace ? 'Replace custom' : 'Add custom'}</button>
            </div>
            {customDraft && customReplace ? (
              <div className="mcp-replace-review">
                <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={customReplaceArmed} onChange={(e) => { setCustomReplaceArmed(e.target.checked); setNote(''); }} />
                  Replace existing MCP server
                </label>
                <span className="muted small">Before: {mcpEndpoint(customReplace)}</span>
                <span className="muted small">After: {mcpEndpoint(customDraft)}</span>
              </div>
            ) : null}
          </>
        ) : null}
        </>
        ) : null}
      </section>
      ) : null}

      {tab === 'skills' ? (
      <section className="card grow">
        <div className="row-actions" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h3 className="grow">Skills</h3>
          <span className="chip tag" title="Local SKILL.md folders found in the manager library">
            {skills.length} local
          </span>
          <span className="chip tag" title="HR-synced agents available for direct skill attachment">
            {skillAttachAgents.length} agents
          </span>
          <button className="btn small" disabled={skillCatalogRefreshing} onClick={() => void refreshSkillCatalog()}>
            {skillCatalogRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <span className={`chip ${brainSkillSyncVisible ? 'brain-review' : typeof brainTotal === 'number' ? 'tag' : ''}`} title={brainSkillStatusTitle}>
            {brainSkillStatusLabel}
          </span>
          <button className="btn small" disabled={brainSyncDisabled} title={brainSyncTitle} onClick={() => void syncSkillsToBrain()}>
            {brainSyncing ? 'Syncing…' : 'Preview & sync'}
          </button>
          <BrainDashboardLauncher reviewTabs={brainDashboardReviewTabs} />
          <button className="btn primary small" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? '− Cancel' : '+ Create skill'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Search, attach, import, and sync the manager SKILL.md catalog for <b>{targetLabel}</b>.
        </p>

        {brainSkillSyncVisible ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain skill sync pending</b>
              <div className="muted small">{brainReviewDetail}</div>
            </div>
            <button className="btn small" disabled={brainSyncDisabled} title={brainSyncTitle} onClick={() => void syncSkillsToBrain()}>
              {brainSyncing ? 'Syncing…' : 'Preview & sync'}
            </button>
          </div>
        ) : null}

        {importableLocalSkills.length > 0 ? (
          <details className="local-skill-candidates">
            <summary className="local-skill-candidates-summary">
              <b>{importableLocalSkills.length} importable local skill{importableLocalSkills.length === 1 ? '' : 's'}</b>
              <span className="muted small">
                {installedLocalSkillCandidates > 0 ? `${installedLocalSkillCandidates} already in catalog` : 'Codex/Agents skills not yet in catalog'}
              </span>
            </summary>
            <div className="row-actions local-skill-candidates-head">
              <span className="muted small grow">Import useful local skills into the manager catalog before attaching them to agents.</span>
              <button className="btn small" disabled={localSkillRefreshing} onClick={() => void refreshLocalSkillCandidates()}>
                {localSkillRefreshing ? 'Scanning…' : 'Rescan'}
              </button>
            </div>
            <div className="local-skill-candidate-list">
              {importableLocalSkills.map((candidate) => (
                <div className="local-skill-candidate" key={candidate.id}>
                  <div className="grow">
                    <div className="row-actions local-skill-candidate-title">
                      <b>{candidate.name}</b>
                      <span className="chip tag">{candidate.source}</span>
                      {candidate.tags.slice(0, 4).map((tag) => <span key={tag} className="chip tag">{tag}</span>)}
                    </div>
                    <div className="muted small skill-desc"><LinkedDescription text={candidate.description} /></div>
                  </div>
                  <button className="btn primary small" disabled={busy} onClick={() => void importLocalSkill(candidate)}>
                    Import
                  </button>
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <div className="skill-toolbar">
          <div className="skill-toolbar-main">
            <input className="catalog-search" placeholder="Search skills" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
            <span className="muted small"><b>{filteredSkills.length}</b> of {skills.length}</span>
            <span className="muted small">{skillTagStats.frontmatter + skillTagStats.autoOnly} tagged · {skillTagStats.untagged} untagged · {allTags.length} tags</span>
          </div>
          <div className="skill-toolbar-tags">
            {skillTagStats.topTags.map(([tag, count]) => (
              <button key={tag} className={`chip tag${tagFilter.has(tag) ? ' on' : ''}`} title={`${count} local skill${count === 1 ? '' : 's'}`} onClick={() => toggleTag(tag)}>
                {tag} {count}
              </button>
            ))}
            {tagFilter.size > 0 ? <button className="btn small" onClick={() => setTagFilter(new Set())}>Clear</button> : null}
            {categorizing
              ? <span className="muted small">categorizing...</span>
              : <button className="btn small" disabled={busy} title="Re-run AI auto-categorization for untagged skills" onClick={() => void recategorize()}>Re-tag</button>}
          </div>
          {(brainDomainFacets.length || brainTagFacets.length) ? (
            <div className="skill-toolbar-brain">
              {brainDomainFacets.map((domain) => <span key={`d-${domain}`} className="chip tag" title="Brain skill domain">Brain:{domain}</span>)}
              {brainTagFacets.map((tag) => <span key={`t-${tag}`} className="chip tag" title="Brain skill tag">Brain:{tag}</span>)}
              <span className="muted small">{brainSkills?.reuseGroups?.length ?? 0} Brain reuse groups</span>
            </div>
          ) : null}
        </div>

        {showCreate ? (
          <div className="create-skill">
            <div className="kv" style={{ gridTemplateColumns: '130px 1fr', gap: '8px 12px' }}>
              <span>name *</span>
              <b>
                <input style={{ width: 260 }} placeholder="lowercase-with-hyphens" value={ns.name} onChange={(e) => setNs((p) => ({ ...p, name: e.target.value }))} />
                {ns.name ? (
                  <span className={`small ${nameErr ? 'status-error' : 'ok-text'}`} style={{ marginLeft: 8 }}>{nameErr ? `✕ ${nameErr}` : '✓'}</span>
                ) : <span className="muted small" style={{ marginLeft: 8 }}>folder name == skill name · max 64</span>}
              </b>
              <span>description *</span>
              <b>
                <textarea style={{ width: '100%', minHeight: 46 }} placeholder="What the skill does and WHEN to use it (keywords help the agent pick it). Max 1024 chars." value={ns.description} onChange={(e) => setNs((p) => ({ ...p, description: e.target.value }))} />
                <span className="muted small">{ns.description.trim().length}/1024</span>
              </b>
              <span>tags</span>
              <b><input style={{ width: '100%' }} placeholder="comma-separated, e.g. documents, pdf, extraction" value={ns.tags} onChange={(e) => setNs((p) => ({ ...p, tags: e.target.value }))} /></b>
              <span>category</span>
              <b><input style={{ width: 260 }} placeholder="optional primary category" value={ns.category} onChange={(e) => setNs((p) => ({ ...p, category: e.target.value }))} /></b>
              <span>license</span>
              <b><input style={{ width: 260 }} placeholder="optional, e.g. MIT" value={ns.license} onChange={(e) => setNs((p) => ({ ...p, license: e.target.value }))} /></b>
              <span>compatibility</span>
              <b><input style={{ width: '100%' }} placeholder="optional env requirements, e.g. Requires git + python 3.14" value={ns.compatibility} onChange={(e) => setNs((p) => ({ ...p, compatibility: e.target.value }))} /></b>
              <span>allowed-tools</span>
              <b><input style={{ width: '100%' }} placeholder="optional, space-separated, e.g. Bash(git:*) Read" value={ns.tools} onChange={(e) => setNs((p) => ({ ...p, tools: e.target.value }))} /></b>
              <span>instructions</span>
              <b><textarea style={{ width: '100%', minHeight: 120, fontFamily: 'var(--mono, monospace)' }} placeholder="Markdown body (step-by-step instructions, examples, edge cases). Left blank, a stub is generated." value={ns.body} onChange={(e) => setNs((p) => ({ ...p, body: e.target.value }))} /></b>
            </div>
            <div className="row-actions" style={{ marginTop: 10 }}>
              <span className="muted small grow">writes <span className="mono">skills/{ns.name.trim() || '<name>'}/SKILL.md</span> on the manager · won't overwrite an existing skill</span>
              <button className="btn primary" disabled={busy || !createValid} onClick={() => void createSkill()}>Create skill</button>
            </div>
          </div>
        ) : null}

          <div className="skill-catalog">
          {filteredSkills.map((s) => {
            const have = skillCount(s.name);
            const fleetHave = skillFleetUsage(s.name).length;
            const all = targetCount > 0 && have === targetCount;
            const recommendations = skillRecommendations(s);
            const topRecommendations = recommendations.filter((r) => !r.installed).slice(0, 4);
            const recommendedCount = topRecommendations.length;
            const recommendedKey = topRecommendations[0] ? skillAgentKey(topRecommendations[0].agent) : '';
            const selectedAgentKey = skillAgentDrafts[s.name] || recommendedKey || (skillAttachAgents[0] ? skillAgentKey(skillAttachAgents[0]) : '');
            const selectedAgent = selectedAgentKey ? findSkillAttachAgent(selectedAgentKey) : null;
            const selectedAgentHasSkill = selectedAgent ? agentHasSkill(selectedAgent, s.name) : false;
            return (
              <div className="skill-card" key={s.name}>
                <div className="skill-card-head">
                  <span className="b">{s.name}</span>
                  {s.license ? <span className="muted small">· {s.license}</span> : null}
                  <span className="grow" />
                  <span className={have > 0 ? 'ok-text small' : 'muted small'} title={`${have}/${targetCount} selected targets currently list this skill`}>
                    selected {have}/{targetCount}
                  </span>
                  <span className="chip tag" title="Current whole-fleet install count">fleet {fleetHave}</span>
                  {recommendedCount > 0 ? (
                    <button className="btn primary small" disabled={busy} title="Attach to the best matching agents for this skill" onClick={() => void installSkillRecommended(s.name, topRecommendations)}>
                      Attach recommended ({recommendedCount})
                    </button>
                  ) : null}
                  <button className={`btn small${recommendedCount ? '' : ' primary'}`} disabled={busy || targetCount === 0 || all} onClick={() => void installSkillAll(s.name)}>
                    {all ? 'Attached to scope' : `Attach to ${targetLabel}`}
                  </button>
                </div>
                {s.description ? <p className="muted small skill-desc"><LinkedDescription text={s.description} /></p> : null}
                <details className="skill-card-details">
                  <summary>Advanced: choose one agent, remove, tags</summary>
                  <div className="row-actions skill-card-manage">
                    {have > 0 ? (
                      <button className="btn small" disabled={busy} title={`Uninstall from ${targetLabel}`} onClick={() => void uninstallSkillAll(s.name)}>
                        Uninstall selected
                      </button>
                    ) : null}
                    {fleetHave > 0 ? (
                      <button className="btn small" disabled={busy} title="Remove this skill from every fleet agent that currently has it" onClick={() => void uninstallSkillFleet(s.name)}>
                        Remove from fleet
                      </button>
                    ) : null}
                    {confirmDel === s.name ? (
                      <>
                        <button className="btn icon-danger small" disabled={busy} title="Permanently delete this skill's SKILL.md from the library" onClick={() => void removeSkill(s.name)}>
                          Delete?
                        </button>
                        <button className="btn small" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
                      </>
                    ) : (
                      <button className="btn icon-danger small" disabled={busy || fleetHave > 0} title={fleetHave > 0 ? 'Uninstall from all fleet agents before deleting the library SKILL.md' : 'Delete from library'} onClick={() => setConfirmDel(s.name)}>Delete library copy</button>
                    )}
                  </div>
                  {fleetHave > 0 ? (
                    <div className="skill-usage-note">
                      Installed on {fleetHave} fleet agent{fleetHave === 1 ? '' : 's'}: {describeTargets(skillFleetUsage(s.name).slice(0, 6))}{fleetHave > 6 ? ', ...' : ''}. Library delete unlocks after the skill is uninstalled everywhere.
                    </div>
                  ) : null}
                  <div className="skill-agent-live">
                    <div className="skill-agent-live-row">
                      <span className="muted small">Agent</span>
                      <select
                        className="skill-agent-select"
                        disabled={busy || skillAttachAgents.length === 0}
                        value={selectedAgentKey}
                        onChange={(e) => setSkillAgentDrafts((prev) => ({ ...prev, [s.name]: e.target.value }))}
                      >
                        {skillAttachAgents.length === 0 ? <option value="">No agents</option> : null}
                        {skillAttachAgents.map((a) => {
                          const key = skillAgentKey(a);
                          return (
                            <option key={key} value={key}>
                              {skillAgentLabel(a)}{agentHasSkill(a, s.name) ? ' · attached' : ''}
                            </option>
                          );
                        })}
                      </select>
                      <button className="btn small" disabled={busy || !selectedAgent || selectedAgentHasSkill} onClick={() => selectedAgent && void applySkillToAgent(s.name, selectedAgent, 'install')}>
                        {selectedAgentHasSkill ? 'Attached' : 'Attach'}
                      </button>
                      {selectedAgentHasSkill && selectedAgent ? (
                        <button className="btn small" disabled={busy} onClick={() => void applySkillToAgent(s.name, selectedAgent, 'uninstall')}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                    {topRecommendations.length > 0 ? (
                      <div className="skill-recommendations">
                        <span className="muted small">Suggested</span>
                        {topRecommendations.map((r) => (
                          <button
                            key={skillAgentKey(r.agent)}
                            className="chip tag skill-rec-chip"
                            disabled={busy}
                            title={`Role match: ${r.reasons.slice(0, 3).join(', ') || 'metadata match'}`}
                            onClick={() => void applySkillToAgent(s.name, r.agent, 'install')}
                          >
                            + {skillAgentLabel(r.agent)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {(() => {
                    const fm = new Set(s.tags ?? []);
                    const tags = [...new Set([...(s.tags ?? []), ...(autoTags[s.name] ?? [])])];
                    return tags.length > 0 ? (
                      <div className="chips skill-tags">
                        {tags.map((t) => (
                          <button
                            key={t}
                            className={`chip tag${tagFilter.has(t) ? ' on' : ''}${fm.has(t) ? '' : ' auto'}`}
                            title={fm.has(t) ? t : `${t} - auto-categorized`}
                            onClick={() => toggleTag(t)}
                          >{t}</button>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </details>
              </div>
            );
          })}
          {skills.length === 0 ? (
            <p className="muted center pad">No library skills found on this manager. Create one above to get started.</p>
          ) : filteredSkills.length === 0 ? (
            <p className="muted center pad">No skills match the current filter.</p>
          ) : null}
        </div>
      </section>
      ) : null}

      {tab === 'plugins' ? (
      <section className="card grow">
        <div className="row-actions" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h3 className="grow">Plugins</h3>
          <span className="chip tag" title="Packages still shown in the plugin catalog">Active {pluginRows.length}</span>
          {digestedPluginRows.length > 0 ? (
            <span className="chip tag" title={`${digestedPluginRows.map((p) => p.name).join(', ')} now live in Skills`}>
              In Skills {digestedPluginRows.length}
            </span>
          ) : null}
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Adapter packages stay here. Digested instruction wrappers move to Skills.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>package</th>
              <th>kind</th>
              <th>reach</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            {pluginRows.map((p) => {
              const provider = p.author || p.source || null;
              const isUrl = !!provider && /^https?:\/\//i.test(provider);
              return (
                <tr key={p.name}>
                  <td>
                    <div className="b">{p.name}</div>
                    <div className="muted small" title={p.source ?? undefined}>
                      {p.version ?? '—'} · {p.packageSource}
                      {provider == null ? null : isUrl ? (
                        <>
                          {' · '}
                          <a className="ext-link" href={provider} target="_blank" rel="noreferrer">
                            {provider.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                          </a>
                        </>
                      ) : <span> · {provider}</span>}
                    </div>
                    {p.description ? <div className="muted small"><LinkedDescription text={p.description} /></div> : null}
                  </td>
                  <td>
                    <span className={`chip tag${p.classification === 'portable-package' ? ' on' : ''}`} title={(p.notes ?? []).join('\n') || pluginAdapterSummary(p)}>
                      {pluginClassificationLabel(p)}
                    </span>
                    <div className="muted small" title={(p.tools ?? []).join(', ')}>
                      {pluginAdapterSummary(p)}
                      {p.hasTools ? ` · ${p.toolCount ?? p.tools?.length ?? 0} tool${(p.toolCount ?? p.tools?.length ?? 0) === 1 ? '' : 's'}` : p.hasSkillMd ? ' · SKILL.md' : ''}
                    </div>
                  </td>
                  <td className="muted small">{pluginRuntimeReach(p, targetAgents)}</td>
                  <td>
                    {p.skillProjection === 'available' ? (
                      <button className="btn small" disabled={busy} title="Fresh-read and project this instruction-only plugin into the skill catalog" onClick={() => void digestPluginAsSkill(p)}>
                        Digest
                      </button>
                    ) : (
                      <span className="muted small" title={(p.notes ?? []).join('\n')}>
                        {pluginProjectionLabel(p)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {pluginRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted center pad">
                  No active plugin packages. Digested wrappers now live in Skills.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
      ) : null}
    </div>
  );
}
