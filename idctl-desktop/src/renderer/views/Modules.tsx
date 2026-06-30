import { Fragment, useEffect, useMemo, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { LibrarySkillEntry, LibraryPluginEntry, McpServerSpec, SetMcpResult, CreateSkillInput } from '../../../../idctl/src/api/client.ts';
import {
  type McpServerProfile,
  type McpTransport,
} from '../../../../idctl/src/settings/schema.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';
import { runtimeSupports, capabilityDenyReason, type RuntimeCapability } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';

/** Each Capabilities tab maps to the runtime capability an agent must support. */
const TAB_CAPABILITY: Record<'mcp' | 'skills' | 'plugins', RuntimeCapability> = {
  mcp: 'mcp',
  skills: 'skills',
  plugins: 'plugins',
};
/** An agent's effective runtime (top-level, falling back to metadata). */
function agentRuntime(a: Agent): string | undefined {
  return a.runtime ?? a.metadata?.runtime;
}

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

interface TestResult { ok?: boolean; tools?: string[]; error?: string; testing?: boolean }
type TargetAgent = Agent & { team?: string };
type TeamAgentsGroup = { team: string; agents: Agent[] };
type BrainSkillStats = { totalSkills?: number; chainable?: number; nonChainable?: number; domains?: number; tags?: number; averageComputeCost?: number | null; maxUseCount?: number };
type BrainSkillFacet = { domain?: string; tag?: string; name?: string; count?: number };
type BrainSkillSummary = {
  summary?: BrainSkillStats;
  facets?: { domains?: BrainSkillFacet[]; tags?: BrainSkillFacet[]; chainable?: { value?: boolean; count?: number }[] };
  reuseGroups?: { kind?: string; key?: string; label?: string; count?: number }[];
  proposalSummary?: Record<string, unknown>;
  profile?: string;
  meta?: { route?: string; profile?: string; generatedAt?: string };
} | null;
type BrainFleetReport = {
  generatedAt?: string;
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

function brainDashboardTabForPath(pathname: string): BrainDashboardTab | null {
  return BRAIN_DASHBOARD_TABS.find((x) => x.path === pathname)?.tab ?? null;
}

function openBrainDashboardTab(tab: BrainDashboardTabSpec) {
  if (tab.guard && !window.confirm(tab.guard.confirm)) return;
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

function BrainDashboardLauncher({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brain-dashboard-tabs${compact ? ' compact' : ''}`} title="Open a whitelisted Brain dashboard tab">
      {!compact ? <span className="muted small">Brain</span> : null}
      {BRAIN_DASHBOARD_TABS.map((x) => (
        <button
          key={x.tab}
          className={`btn small${x.guard ? ' guarded' : ''}`}
          title={x.guard?.title ?? `Open Brain ${x.label}`}
          onClick={() => openBrainDashboardTab(x)}
        >
          {x.label}
        </button>
      ))}
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
      <a key={`a-${match.index}`} className="ext-link" href="#" onClick={(e) => { e.preventDefault(); void call('brain:openDashboard', brainTab); }}>
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

export function Modules({ store }: { store: FleetStore }) {
  const [mcp, setMcp] = useState<McpServerProfile[]>([]);
  const [skills, setSkills] = useState<LibrarySkillEntry[]>([]);
  // App-side categorization overlay: skill name → auto-derived tags (merged into
  // the catalog display + tag search for skills whose SKILL.md has no tags).
  const [autoTags, setAutoTags] = useState<Record<string, string[]>>({});
  const [categorizing, setCategorizing] = useState(false);
  const [brainSkills, setBrainSkills] = useState<BrainSkillSummary>(null);
  const [brainCore, setBrainCore] = useState<BrainCoreHealthReport>(null);
  const [brainAgents, setBrainAgents] = useState<BrainAgentsReport>(null);
  const [brainFleet, setBrainFleet] = useState<BrainFleetReport>(null);
  const [brainGraph, setBrainGraph] = useState<BrainGraphReport>(null);
  const [brainSyncing, setBrainSyncing] = useState(false);
  const [brainDrift, setBrainDrift] = useState<SkillBrainDrift | null>(null);
  const [plugins, setPlugins] = useState<LibraryPluginEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>('');
  const [tab, setTab] = useState<'mcp' | 'skills' | 'plugins'>(() => {
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
  useEffect(() => { call<{ coordinators?: Record<string, string> }>('coordinator:hierarchy').then((h) => setCoords(h.coordinators ?? {})).catch(() => {}); }, [store.lastUpdated]);
  // Capability gating: an agent can only be a target for the active tab's
  // capability if its runtime can actually consume it (e.g. ollama can't use
  // MCP — see LOCAL_MODEL_TOOL_CALLING_PLAN.md). Incompatible agents are shown
  // disabled and excluded from every apply/attach/install action.
  const capForTab: RuntimeCapability = TAB_CAPABILITY[tab];
  const agentSupports = (a: Agent) => runtimeSupports(agentRuntime(a), capForTab);
  const baseAgents: TargetAgent[] =
    scope === 'team' ? store.agents : scope === 'leads' ? store.allAgents.filter((a) => coords[a.team ?? ''] === a.name) : store.allAgents;
  const eligibleAgents = baseAgents.filter(agentSupports);
  const incompatAgents = baseAgents.filter((a) => !agentSupports(a));
  const targetTeamOf = (a: { team?: string }) => a.team ?? activeTeam;

  const [touched, setTouched] = useState(false);
  const [explicit, setExplicit] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTouched(false);
    setExplicit(new Set());
    setNote('');
  }, [store.team]);
  // Switching tabs changes the eligible set, so reset the explicit selection.
  useEffect(() => {
    setTouched(false);
    setExplicit(new Set());
  }, [tab]);
  // Default (untouched) = every ELIGIBLE agent; an explicit set is always
  // intersected with eligibility so an incompatible agent can never be a target.
  const selectedIds: Set<string> = touched ? explicit : new Set(eligibleAgents.map((a) => a.id));
  // Team scope honors the chip selection; cross-team scopes target every eligible agent.
  const targetAgents = scope === 'team' ? eligibleAgents.filter((a) => selectedIds.has(a.id)) : eligibleAgents;
  const targetCount = targetAgents.length;
  function baseSet(): Set<string> {
    return touched ? new Set(explicit) : new Set(eligibleAgents.map((a) => a.id));
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
  function mcpCount(name: string): number {
    return targetAgents.filter((a) => (((a.metadata as any)?.mcpServers ?? []) as { name: string }[]).some((s) => s.name === name)).length;
  }
  function skillCount(skill: string): number {
    return targetAgents.filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill)).length;
  }

  // add-MCP: catalog-driven (default) + custom (advanced)
  const [catId, setCatId] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catName, setCatName] = useState<string>(MCP_CATALOG[0]?.id ?? '');
  const [catInputs, setCatInputs] = useState<Record<string, string>>({});
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
    setPlugins(await call<LibraryPluginEntry[]>('libraryPlugins').catch(() => []));
    setAutoTags(await call<Record<string, string[]>>('skills:autoTags').catch(() => ({})));
    setBrainSkills(await call<BrainSkillSummary>('skills:brainSummary').catch(() => null));
    setBrainCore(await call<BrainCoreHealthReport>('brain:coreHealth').catch(() => null));
    setBrainAgents(await call<BrainAgentsReport>('brain:agentsReport').catch(() => null));
    setBrainFleet(await call<BrainFleetReport>('brain:fleetReport').catch(() => null));
    setBrainGraph(await call<BrainGraphReport>('brain:graphReport').catch(() => null));
  }
  useEffect(() => {
    reload();
  }, [store.team, store.lastUpdated]);

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
    return call<TeamAgentsGroup[]>('agents:allTeams').catch(() => []);
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
  async function freshCapabilityTargets(label: string): Promise<TargetAgent[] | null> {
    const groups = await freshGroups();
    const fresh: TargetAgent[] = [];
    for (const rendered of targetAgents) {
      const expectedTeam = targetTeamOf(rendered);
      const current = findFreshTarget(groups, rendered);
      if (!current) {
        setNote(`${label} blocked: ${expectedTeam}/${rendered.name} is no longer in the current roster. Refreshed; review targets and try again.`);
        store.refresh();
        return null;
      }
      if (!agentSupports(current)) {
        setNote(`${label} blocked: ${expectedTeam}/${current.name} no longer supports ${tab === 'mcp' ? 'MCP' : tab}. Refreshed; review targets and try again.`);
        store.refresh();
        return null;
      }
      if (capabilityAgentStamp(current, expectedTeam) !== capabilityAgentStamp({ ...rendered, team: expectedTeam }, expectedTeam)) {
        setNote(`${label} blocked: ${expectedTeam}/${rendered.name} capability state changed. Refreshed; review the current row before applying.`);
        store.refresh();
        return null;
      }
      fresh.push(current);
    }
    return fresh;
  }
  // Apply an action to every selected agent after fresh target validation.
  async function applyToTargets(label: string, fn: (a: TargetAgent) => Promise<unknown>) {
    if (targetCount === 0) {
      setNote('select at least one agent above');
      return;
    }
    setBusy(true);
    setNote(`checking ${label} targets…`);
    try {
      const freshTargets = await freshCapabilityTargets(label);
      if (!freshTargets) return;
      const scopeLabel = scope === 'team' ? `team ${activeTeam}` : scope === 'leads' ? 'all team leads' : 'all teams';
      if (!window.confirm(`Apply "${label}" to ${freshTargets.length} current target${freshTargets.length === 1 ? '' : 's'}?\n\nScope: ${scopeLabel}\nTargets: ${describeTargets(freshTargets)}\n\nThis can change agent capabilities or rebuild running agents.`)) return;
      setNote(`rechecking ${label} targets…`);
      const latestTargets = await freshCapabilityTargets(label);
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
    });
  }
  async function detachServer(p: McpServerProfile) {
    await applyToTargets(`detach ${p.name}`, async (a) => {
      await call<SetMcpResult>('setAgentMcp', a.id, curMcp(a).filter((s) => s.name !== p.name), targetTeamOf(a));
    });
  }
  async function removeMcpProfile(name: string) {
    setBusy(true);
    setNote(`checking MCP registry for ${name}…`);
    try {
      const latest = await call<McpServerProfile[]>('mcp:list').catch(() => []);
      if (!latest.some((p) => p.name === name)) {
        setNote(`remove blocked: MCP server "${name}" is no longer in the registry.`);
        setMcp(latest);
        return;
      }
      if (!window.confirm(`Remove MCP server "${name}" from the current registry?\n\nThis does not detach it from agents that already have it, but it will no longer be available to attach from this catalog.`)) return;
      setMcp(await call<McpServerProfile[]>('mcp:remove', name));
      setNote(`removed MCP server ${name} ✓`);
    } finally {
      setBusy(false);
    }
  }
  async function rebuildTargets() {
    await applyToTargets('rebuild', (a) => call('rebuildAgent', a.name, targetTeamOf(a)));
  }
  async function installSkillAll(skill: string) {
    await applyToTargets(`install ${skill}`, (a) => call('installSkill', skill, a.name, targetTeamOf(a)));
  }
  async function uninstallSkillAll(skill: string) {
    await applyToTargets(`uninstall ${skill}`, (a) => call('uninstallSkill', skill, a.name, targetTeamOf(a)));
  }
  // Two-step confirm for the destructive library delete (window.confirm is not
  // reliable in Electron, and a single misclick must not nuke a skill).
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  async function removeSkill(name: string) {
    setBusy(true);
    setNote(`checking skill ${name}…`);
    try {
      const installed = skillFleetUsage(name);
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
      setNote(`deleted skill ${name} ✓ — Brain catalog review needed`);
    } catch (err) {
      setNote(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // ---- Skills catalog: search + tag filtering ----------------------------
  const [skillQuery, setSkillQuery] = useState('');
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
      await reload();
      setBrainDrift({ kind: 'created', skill: entry.name, at: Date.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNote(`create failed: ${/already_exists/.test(msg) ? 'a skill with that name already exists' : msg}`);
    } finally {
      setBusy(false);
    }
  }

  // # selected agents that have at least one MCP server attached (→ show Rebuild).
  const anyAttached = targetAgents.some((a) => curMcp(a).length > 0);
  const targetLabel = targetCount === 0 ? 'no agents' : targetCount === 1 ? targetAgents[0].name : `${targetCount} agents`;
  function skillFleetUsage(skill: string): TargetAgent[] {
    return store.allAgents
      .filter((a) => (((a.metadata as any)?.skills ?? []) as string[]).includes(skill))
      .map((a) => ({ ...a, team: a.team ?? activeTeam }));
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
  const brainSyncWriteBlocked = !brainCore || brainCore.ok !== true;
  const brainSyncDisabled = brainSyncing || skills.length === 0 || brainSyncWriteBlocked;
  const brainSyncTitle = brainSyncWriteBlocked
    ? 'Brain core health is unavailable or not ok; open Brain Skills/Health before writing the skill catalog'
    : 'Preview, fresh-read, then upsert the local skill catalog into Brain /skills/index';
  const brainDomainFacets = (brainSkills?.facets?.domains ?? []).map(brainFacetLabel).filter(Boolean).slice(0, 4);
  const brainTagFacets = (brainSkills?.facets?.tags ?? []).map(brainFacetLabel).filter(Boolean).slice(0, 4);
  const catalogDraft = buildCatalog();
  const customDraft = buildCustom();
  const catalogReplace = catalogDraft ? mcp.find((p) => p.name === catalogDraft.name) : undefined;
  const customReplace = customDraft ? mcp.find((p) => p.name === customDraft.name) : undefined;

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
            <span className="muted small" title="every eligible agent across all teams (incompatible runtimes excluded)">apply to <b>{eligibleAgents.length}</b> {scope === 'leads' ? 'team lead' : 'agent'}{eligibleAgents.length === 1 ? '' : 's'} across all teams{incompatAgents.length ? ` · ${incompatAgents.length} excluded` : ''}</span>
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
                  const compat = agentSupports(a);
                  const on = compat && selectedIds.has(a.id);
                  const why = compat ? undefined : `${a.name} · ${agentRuntime(a) ?? 'unknown runtime'} — ${capabilityDenyReason(agentRuntime(a), capForTab)}`;
                  return (
                    <button
                      key={a.id}
                      className={`chip${on ? ' on' : ''}${compat ? '' : ' incompat'}`}
                      disabled={busy || !compat}
                      title={why}
                      onClick={() => compat && toggleAgent(a.id)}
                    >
                      {on ? '✓ ' : ''}{a.name}{compat ? '' : ' ⊘'}
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
        ] as ['mcp' | 'skills' | 'plugins', string][]).map(([id, label]) => (
          <button key={id} className={`tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {incompatAgents.length > 0 ? (
        <div className="muted small" title={incompatAgents.map((a) => `${a.name} (${agentRuntime(a) ?? 'unknown'})`).join(', ')}>
          ⊘ {incompatAgents.length} agent{incompatAgents.length > 1 ? 's' : ''} can’t use {tab === 'mcp' ? 'MCP' : tab} on their runtime{eligibleAgents.length === 0 ? ' — no eligible agents in this team' : ''} — {incompatAgents.map((a) => a.name).join(', ')}.
        </div>
      ) : null}

      {note ? <div className="muted small">{note}</div> : null}

      {tab === 'mcp' ? (
      <section className="card grow">
        <h3>MCP servers — new tools via external servers</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          External tool servers your agent connects to — they give it brand-new <b>tools</b> (filesystem, web search, databases, GitHub…). Pick one, <b>Test</b> it (launches it and lists its tools), then <b>Attach</b> to <b>{targetLabel}</b> and Rebuild. Attach/Detach apply to every selected agent. <b>Claude & Codex runtimes</b> only — local models gain MCP once the tool-calling loop ships.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>name</th>
              <th>endpoint</th>
              <th>attached</th>
              <th>test</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {mcp.map((p) => {
              const tr = test[p.name];
              const have = mcpCount(p.name);
              return (
                <tr key={p.name}>
                  <td className="b">{p.name} <span className="muted small">{p.transport}</span></td>
                  <td className="mono small">{p.transport === 'stdio' ? [p.command, ...(p.args ?? [])].join(' ') : p.url}</td>
                  <td className={have > 0 ? 'ok-text small' : 'muted small'}>{have}/{targetCount}</td>
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
                <td colSpan={5} className="muted center pad">No MCP servers registered yet — add one below.</td>
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

        <h3 style={{ marginTop: 18 }}>Add a server</h3>
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
      </section>
      ) : null}

      {tab === 'skills' ? (
      <section className="card grow">
        <div className="row-actions" style={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <h3 className="grow">Skill catalog — know-how for the agent</h3>
          <span className="chip tag" title="Local SKILL.md folders found in the manager library">
            Local {skills.length}
          </span>
          <span className={`chip ${brainCatalogNeedsReview ? 'brain-review' : brainSkills?.summary ? 'tag' : ''}`} title={brainStatusTitle}>
            {brainStatusLabel}
          </span>
          <span className={`chip ${brainCoreNeedsOperatorReview ? 'brain-review' : 'tag'}`} title={brainCoreTitle}>
            {brainCoreStatus}
          </span>
          <span className={`chip ${brainFleetNeedsReview ? 'brain-review' : 'tag'}`} title={brainFleetTitle}>
            {brainFleetStatus}
          </span>
          <span className={`chip ${brainAgentsNeedOperatorReview ? 'brain-review' : 'tag'}`} title={brainAgentsTitle}>
            {brainAgentsStatus}
          </span>
          <span className={`chip ${brainGraphNeedsReview ? 'brain-review' : 'tag'}`} title={brainGraphTitle}>
            {brainGraphStatus}
          </span>
          <button className="btn small" disabled={brainSyncDisabled} title={brainSyncTitle} onClick={() => void syncSkillsToBrain()}>
            {brainSyncing ? 'Syncing…' : 'Preview & sync'}
          </button>
          <BrainDashboardLauncher />
          <button className="btn primary small" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? '− Cancel' : '+ Create skill'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Markdown instructions (the <a className="ext-link" href="https://agentskills.io" target="_blank" rel="noreferrer">agentskills.io</a> <span className="mono">SKILL.md</span> standard) that teach an agent <i>how</i> to do things with the tools it already has. Browse, filter by tag, then install on <b>{targetLabel}</b> — applies to every selected agent immediately.
        </p>

        {brainCatalogNeedsReview ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain catalog review needed</b>
              <div className="muted small">{brainReviewDetail}</div>
            </div>
            {brainNeedsLocalSync ? (
              <button className="btn small" disabled={brainSyncDisabled} title={brainSyncTitle} onClick={() => void syncSkillsToBrain()}>
                {brainSyncing ? 'Syncing…' : 'Preview & sync'}
              </button>
            ) : null}
            <BrainDashboardLauncher compact />
          </div>
        ) : null}

        {brainCoreNeedsOperatorReview ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain core health review</b>
              <div className="muted small">{brainCoreDetail}</div>
            </div>
            <BrainDashboardLauncher compact />
          </div>
        ) : null}

        {brainFleetNeedsReview ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain fleet authority review</b>
              <div className="muted small">{brainFleetDetail}</div>
            </div>
            <BrainDashboardLauncher compact />
          </div>
        ) : null}

        {brainAgentsNeedOperatorReview ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain agents authority review</b>
              <div className="muted small">{brainAgentsDetail}</div>
            </div>
            <BrainDashboardLauncher compact />
          </div>
        ) : null}

        {brainGraphNeedsReview ? (
          <div className="skill-brain-review">
            <div className="grow">
              <b>Brain graph contract review</b>
              <div className="muted small">{brainGraphDetail}</div>
            </div>
            <BrainDashboardLauncher compact />
          </div>
        ) : null}

        <div className="skill-catalog-summary">
          <div>
            <b>{filteredSkills.length}/{skills.length}</b>
            <span className="muted small"> shown</span>
          </div>
          <div>
            <b>{skillTagStats.frontmatter}</b>
            <span className="muted small"> tagged</span>
          </div>
          <div>
            <b>{skillTagStats.autoOnly}</b>
            <span className="muted small"> auto-tagged</span>
          </div>
          <div>
            <b>{skillTagStats.untagged}</b>
            <span className="muted small"> untagged</span>
          </div>
          <div>
            <b>{brainSkills?.reuseGroups?.length ?? 0}</b>
            <span className="muted small"> Brain reuse groups</span>
          </div>
          <div className="skill-catalog-facets">
            {skillTagStats.topTags.map(([tag, count]) => (
              <button key={tag} className={`chip tag${tagFilter.has(tag) ? ' on' : ''}`} title={`${count} local skill${count === 1 ? '' : 's'}`} onClick={() => toggleTag(tag)}>
                {tag} {count}
              </button>
            ))}
            {brainDomainFacets.map((domain) => <span key={`d-${domain}`} className="chip tag" title="Brain skill domain">Brain:{domain}</span>)}
            {brainTagFacets.map((tag) => <span key={`t-${tag}`} className="chip tag" title="Brain skill tag">Brain:{tag}</span>)}
          </div>
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

        {allTags.length > 0 ? (
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <input className="catalog-search" placeholder="search skills…" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
            <span className="chips">
              {allTags.map((t) => (
                <button key={t} className={`chip${tagFilter.has(t) ? ' on' : ''}`} onClick={() => toggleTag(t)}>
                  {tagFilter.has(t) ? '✓ ' : ''}{t}
                </button>
              ))}
            </span>
            {tagFilter.size > 0 ? <button className="btn small" onClick={() => setTagFilter(new Set())}>clear</button> : null}
            <span className="grow" />
            {categorizing
              ? <span className="muted small">✦ categorizing…</span>
              : <button className="btn small" disabled={busy} title="Re-run AI auto-categorization for untagged skills" onClick={() => void recategorize()}>↻ re-categorize</button>}
          </div>
        ) : skills.length > 0 ? (
          <div className="row-actions" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
            <input className="catalog-search" placeholder="search skills…" value={skillQuery} onChange={(e) => setSkillQuery(e.target.value)} />
            {categorizing ? <span className="muted small">✦ categorizing…</span> : null}
          </div>
        ) : null}

        <div className="skill-catalog">
          {filteredSkills.map((s) => {
            const have = skillCount(s.name);
            const fleetHave = skillFleetUsage(s.name).length;
            const all = targetCount > 0 && have === targetCount;
            return (
              <div className="skill-card" key={s.name}>
                <div className="skill-card-head">
                  <span className="b">{s.name}</span>
                  {s.license ? <span className="muted small">· {s.license}</span> : null}
                  <span className="grow" />
                  <span className={have > 0 ? 'ok-text small' : 'muted small'} title={`${have}/${targetCount} selected targets; ${fleetHave} fleet agent${fleetHave === 1 ? '' : 's'} currently list this skill`}>
                    {have}/{targetCount}
                  </span>
                  {fleetHave !== have ? <span className="chip tag" title="Current whole-fleet install count">Fleet {fleetHave}</span> : null}
                  <button className="btn" disabled={busy || targetCount === 0 || all} onClick={() => void installSkillAll(s.name)}>
                    {all ? 'Installed' : `Install → ${targetLabel}`}
                  </button>
                  {have > 0 ? (
                    <button className="btn" disabled={busy} title={`Uninstall from ${targetLabel}`} onClick={() => void uninstallSkillAll(s.name)}>
                      Uninstall
                    </button>
                  ) : null}
                  {confirmDel === s.name ? (
                    <>
                      <button className="btn icon-danger" disabled={busy} title="Permanently delete this skill's SKILL.md from the library" onClick={() => void removeSkill(s.name)}>
                        Delete?
                      </button>
                      <button className="btn" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn icon-danger" disabled={busy || fleetHave > 0} title={fleetHave > 0 ? 'Uninstall from all fleet agents before deleting the library SKILL.md' : 'Delete from library'} onClick={() => setConfirmDel(s.name)}>✕</button>
                  )}
                </div>
                {fleetHave > 0 ? (
                  <div className="skill-usage-note">
                    Installed on {fleetHave} fleet agent{fleetHave === 1 ? '' : 's'}; library delete unlocks after the skill is uninstalled everywhere.
                  </div>
                ) : null}
                {s.description ? <p className="muted small skill-desc"><LinkedDescription text={s.description} /></p> : null}
                {(() => {
                  const fm = new Set(s.tags ?? []);
                  const tags = [...new Set([...(s.tags ?? []), ...(autoTags[s.name] ?? [])])];
                  return tags.length > 0 ? (
                    <div className="chips skill-tags">
                      {tags.map((t) => (
                        <button
                          key={t}
                          className={`chip tag${tagFilter.has(t) ? ' on' : ''}${fm.has(t) ? '' : ' auto'}`}
                          title={fm.has(t) ? t : `${t} — auto-categorized`}
                          onClick={() => toggleTag(t)}
                        >{t}</button>
                      ))}
                    </div>
                  ) : null;
                })()}
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
        <h3>Plugins — bundled extensions</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Packaged Claude Code extensions that can bundle skills, MCP servers, slash-commands, and scripts together. These ship with the manager (<span className="mono">plugins/claude-code</span>); they're attached to agents via team config.
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>name</th>
              <th>version</th>
              <th>provider</th>
              <th>description</th>
            </tr>
          </thead>
          <tbody>
            {plugins.map((p) => {
              const provider = p.author || p.source || null;
              const isUrl = !!provider && /^https?:\/\//i.test(provider);
              return (
                <tr key={p.name}>
                  <td className="b">{p.name}</td>
                  <td className="muted small">{p.version ?? '—'}</td>
                  <td className="muted small" title={p.source ?? undefined}>
                    {provider == null ? '—' : isUrl ? (
                      <a className="ext-link" href={provider} target="_blank" rel="noreferrer">
                        {provider.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
                      </a>
                    ) : provider}
                  </td>
                  <td className="muted"><LinkedDescription text={p.description} /></td>
                </tr>
              );
            })}
            {plugins.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted center pad">
                  No plugins found. Plugins live in <span className="mono">plugins/claude-code</span> on the manager host.
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
