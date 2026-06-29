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
    const isBrainGraph = url.host === '127.0.0.1:4200' && url.pathname.endsWith('/dashboard/graph');
    parts.push(isBrainGraph ? (
      <a key={`a-${match.index}`} className="ext-link" href="#" onClick={(e) => { e.preventDefault(); void call('brain:openGraph'); }}>
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
function sortedKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
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
  // per-key test results: 'cat', 'custom', or a registered server name
  const [test, setTest] = useState<Record<string, TestResult>>({});

  const catEntry = MCP_CATALOG.find((e) => e.id === catId);
  function pickCatalog(id: string) {
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
    try { setAutoTags(await call<Record<string, string[]>>('skills:categorize', true)); }
    catch (e) { setNote(`categorize failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setCategorizing(false); }
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
  async function addProfile(profile: McpServerProfile | null, after: () => void) {
    if (!profile) return;
    setBusy(true);
    setNote(`checking MCP registry for ${profile.name}…`);
    try {
      const latest = await call<McpServerProfile[]>('mcp:list').catch(() => mcp);
      const existing = latest.find((p) => p.name === profile.name);
      if (existing) {
        const before = existing.transport === 'stdio' ? [existing.command, ...(existing.args ?? [])].filter(Boolean).join(' ') : existing.url;
        const next = profile.transport === 'stdio' ? [profile.command, ...(profile.args ?? [])].filter(Boolean).join(' ') : profile.url;
        if (!window.confirm(`Replace MCP server "${profile.name}" in the registry?\n\nBefore: ${before ?? '(none)'}\nAfter:  ${next ?? '(none)'}\n\nAgents already attached keep their current copy until you attach/rebuild again.`)) return;
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
      const latest = await call<LibrarySkillEntry[]>('librarySkills').catch(() => []);
      if (!latest.some((s) => s.name === name)) {
        setNote(`delete blocked: skill ${name} is no longer in the library.`);
        setSkills(latest);
        setConfirmDel(null);
        return;
      }
      await call('deleteSkill', name);
      setNote(`deleted skill ${name} ✓`);
      setConfirmDel(null);
      setTagFilter(new Set());
      await reload();
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
              <b><input style={{ width: 200 }} value={catName} onChange={(e) => setCatName(e.target.value)} /></b>
              {(catEntry.inputs ?? []).map((inp) => (
                <Fragment key={inp.key}>
                  <span>{inp.label}{inp.required ? ' *' : ''}</span>
                  <b>
                    <input
                      style={{ width: 320 }}
                      type={inp.secret ? 'password' : 'text'}
                      placeholder={inp.placeholder}
                      value={catInputs[inp.key] ?? ''}
                      onChange={(e) => setCatInputs((c) => ({ ...c, [inp.key]: e.target.value }))}
                    />
                  </b>
                </Fragment>
              ))}
            </>
          ) : null}
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          <span className="grow small"><TestCell r={test.cat} /></span>
          <button className="btn" disabled={test.cat?.testing} onClick={() => void runTest('cat', buildCatalog())}>{test.cat?.testing ? 'Testing…' : 'Test'}</button>
          <button className="btn primary" disabled={busy || !buildCatalog()} onClick={() => void addProfile(buildCatalog(), () => setTest((t) => ({ ...t, cat: {} })))}>Add</button>
        </div>

        <button className="btn small" style={{ marginTop: 12 }} onClick={() => setShowCustom((s) => !s)}>
          {showCustom ? '− custom server' : '+ custom server (advanced)'}
        </button>
        {showCustom ? (
          <>
            <div className="kv" style={{ gridTemplateColumns: '120px 1fr', gap: '8px 12px', marginTop: 8 }}>
              <span>transport</span>
              <b>
                <select className="cell-select" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
                  {TRANSPORTS.map((t) => (<option key={t} value={t}>{t}</option>))}
                </select>
              </b>
              <span>name</span>
              <b><input style={{ width: 200 }} placeholder="name" value={mName} onChange={(e) => setMName(e.target.value)} /></b>
              {transport === 'stdio' ? (
                <>
                  <span>command</span>
                  <b><input style={{ width: 200 }} placeholder="npx" value={cmd} onChange={(e) => setCmd(e.target.value)} /></b>
                  <span>args</span>
                  <b><input style={{ width: 360 }} placeholder="-y @scope/pkg /tmp (space-separated)" value={argsStr} onChange={(e) => setArgsStr(e.target.value)} /></b>
                  <span>env</span>
                  <b><input style={{ width: 360 }} placeholder="KEY=value, KEY2=value2" value={envStr} onChange={(e) => setEnvStr(e.target.value)} /></b>
                </>
              ) : (
                <>
                  <span>url</span>
                  <b><input style={{ width: 360 }} placeholder="https://host/mcp" value={url} onChange={(e) => setUrl(e.target.value)} /></b>
                  <span>headers</span>
                  <b><input style={{ width: 360 }} placeholder="Authorization=Bearer …" value={envStr} onChange={(e) => setEnvStr(e.target.value)} /></b>
                </>
              )}
            </div>
            <div className="row-actions" style={{ marginTop: 8 }}>
              <span className="grow small"><TestCell r={test.custom} /></span>
              <button className="btn" disabled={test.custom?.testing} onClick={() => void runTest('custom', buildCustom())}>{test.custom?.testing ? 'Testing…' : 'Test'}</button>
              <button className="btn primary" disabled={busy || !buildCustom()} onClick={() => void addProfile(buildCustom(), () => { setMName(''); setArgsStr(''); setEnvStr(''); setUrl(''); setTest((t) => ({ ...t, custom: {} })); })}>Add custom</button>
            </div>
          </>
        ) : null}
      </section>
      ) : null}

      {tab === 'skills' ? (
      <section className="card grow">
        <div className="row-actions" style={{ alignItems: 'baseline' }}>
          <h3 className="grow">Skill catalog — know-how for the agent</h3>
          <button className="btn primary small" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? '− Cancel' : '+ Create skill'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Markdown instructions (the <a className="ext-link" href="https://agentskills.io" target="_blank" rel="noreferrer">agentskills.io</a> <span className="mono">SKILL.md</span> standard) that teach an agent <i>how</i> to do things with the tools it already has. Browse, filter by tag, then install on <b>{targetLabel}</b> — applies to every selected agent immediately.
        </p>

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
            const all = targetCount > 0 && have === targetCount;
            return (
              <div className="skill-card" key={s.name}>
                <div className="skill-card-head">
                  <span className="b">{s.name}</span>
                  {s.license ? <span className="muted small">· {s.license}</span> : null}
                  <span className="grow" />
                  <span className={have > 0 ? 'ok-text small' : 'muted small'}>{have}/{targetCount}</span>
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
                    <button className="btn icon-danger" disabled={busy} title="Delete from library" onClick={() => setConfirmDel(s.name)}>✕</button>
                  )}
                </div>
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
