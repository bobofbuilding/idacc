import { useEffect, useState } from 'react';
import { call, agentsLeadFirst, type FleetStore, type TeamAgent } from '../store.ts';
import { statusClass } from '../agentStatus.ts';
import type { RuntimeCooldown } from '../../../../idctl/src/api/client.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { RUNTIMES, offerableRuntimes, effortOptions, runtimeHasEffort, speedOptions, runtimeHasSpeed } from '../../../../idctl/src/settings/runtimeCatalog.ts';

/**
 * The fleet agent grid — per-agent runtime/model switching + lifecycle actions, with a
 * detail panel for the selected agent. Holistic by default: when the app is in "All teams"
 * view it lists every team's agents grouped by team and routes each action to that agent's
 * own team. Extracted from the Dashboard so it can live in HR Manager.
 */

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };
type RuntimeFreshness = { runtime: string; count: number; source: 'codex-cache' | 'provider' | 'curated' | 'none'; provider?: string; lastCheckedMs: number | null };
type AgentConfigState = { runtime?: string; model?: string; effort: string; speed: string };
type RuntimeRateLimitMeta = { laneId?: string; coolingUntilMs?: number; reason?: string; observedAtMs?: number; queryId?: string; resetText?: string; message?: string };
type RuntimeFailoverMeta = { fromLaneId?: string; toLaneId?: string; queryId?: string; observedAtMs?: number };
interface AgentConfigDraft {
  key: string;
  id: string;
  name: string;
  team: string;
  status: string;
  baseline: AgentConfigState;
  next: AgentConfigState;
}
const SOURCE_LABEL: Record<RuntimeFreshness['source'], string> = {
  'codex-cache': 'codex CLI cache', provider: 'live provider sync', curated: 'curated fallback', none: 'no models',
};
function agoMs(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}
function modelFamily(model: string): 'claude' | 'openai' | 'ollama' | 'other' {
  const m = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(m)) return 'claude';
  if (/gpt|codex|^o\d|davinci/.test(m)) return 'openai';
  if (/:|qwen|llama|mistral|gemma|phi|deepseek|gpt-oss/.test(m)) return 'ollama';
  return 'other';
}
function runtimeAccepts(runtime: string): Set<string> {
  if (runtime.startsWith('claude')) return new Set(['claude']);
  if (runtime === 'codex') return new Set(['openai']);
  if (runtime === 'cursor-cli') return new Set(['claude', 'openai']);
  if (runtime === 'ollama') return new Set(['ollama']);
  return new Set(['claude', 'openai', 'ollama', 'other']);
}
function runtimeModelMismatch(runtime?: string, model?: string): string | null {
  if (!runtime || !model) return null;
  const fam = modelFamily(model);
  if (fam === 'other') return null;
  return runtimeAccepts(runtime).has(fam) ? null : `${runtimeLabel(runtime)} runtime expects a ${[...runtimeAccepts(runtime)][0]} model, but "${model}" looks like ${fam}`;
}
function short(s?: string): string {
  if (!s) return '—';
  return s.replace('claude-code-cli', 'claude').replace(/^claude-/, '').replace(/-cli$/, '');
}
// Reasoning effort only applies to the subscription runtimes that read ID_AGENT_EFFORT, and
// each accepts a DIFFERENT scale (codex: minimal–high · claude CLI/local: low–xhigh) — see
// effortOptions() in runtimeCatalog. Local servers (ollama) and cursor-cli have no knob.
function effortOf(a: Agent): string {
  const e = a.metadata?.effort;
  return typeof e === 'string' ? e : '';
}
function speedOf(a: Agent): string {
  const s = a.metadata?.speed;
  return typeof s === 'string' && s ? s : 'default';
}
function runtimeOf(a: Agent): string | undefined {
  return a.runtime ?? (typeof a.metadata?.runtime === 'string' ? a.metadata.runtime : undefined);
}
function displayValue(value: string | undefined, fallback = 'default'): string {
  const v = (value ?? '').trim();
  return v || fallback;
}
function metadataNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const row = entry as { name?: unknown; path?: unknown; command?: unknown; url?: unknown };
        return [row.name, row.path, row.command, row.url].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? '';
      }
      return '';
    })
    .map((s) => s.trim())
    .filter(Boolean);
}
function skillsOf(a: Agent): string[] {
  return metadataNames(a.metadata?.skills);
}
function pluginsOf(a: Agent): string[] {
  return metadataNames(a.metadata?.plugins);
}
function mcpServersOf(a: Agent): string[] {
  return metadataNames(a.metadata?.mcpServers);
}
function delegatesOf(a: Agent): string[] {
  const direct = metadataNames(a.metadata?.delegates);
  if (direct.length) return direct;
  return metadataNames((a.metadata as { delegates_to?: unknown } | undefined)?.delegates_to);
}
function instructionsOf(a: Agent): string {
  const i = a.metadata?.instructions;
  return typeof i === 'string' ? i.trim() : '';
}
function descriptionOf(a: Agent): string {
  const d = a.metadata?.description;
  return typeof d === 'string' ? d.trim() : '';
}
function isRemoteEndpoint(a: Agent): boolean {
  return a.deploymentShape === 'remote-endpoint' || runtimeOf(a) === 'public-agent-remote';
}
function agentHint(a: Agent): string {
  if (a.last_error) return a.last_error;
  if (a.health && a.health !== a.status) return a.health;
  if (!a.port && !isRemoteEndpoint(a)) return 'pending local process';
  if (isRemoteEndpoint(a) && !a.public_endpoint_url) return 'pending endpoint';
  return '';
}
function timeAgo(ms?: number | null): string {
  if (!ms) return '—';
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
function timeUntil(ms?: number | null): string {
  if (!ms) return '';
  const delta = Math.max(0, ms - Date.now());
  if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s left`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m left`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h left`;
  return `${Math.round(delta / 86_400_000)}d left`;
}
function chips(values: string[], empty = 'none') {
  return values.length ? <span className="chips">{values.map((s) => <span className="chip" key={s}>{s}</span>)}</span> : <span className="muted">{empty}</span>;
}
function runtimeLaneOf(a: Agent): string {
  const lane = a.metadata?.runtimeCredentialLane;
  if (typeof lane === 'string' && lane.trim()) return lane.trim();
  const rate = a.metadata?.runtimeRateLimit;
  return typeof rate?.laneId === 'string' ? rate.laneId : '';
}
function runtimeRateLimitOf(a: Agent): RuntimeRateLimitMeta | null {
  const raw = a.metadata?.runtimeRateLimit;
  return raw && typeof raw === 'object' ? raw : null;
}
function runtimeFailoverOf(a: Agent): RuntimeFailoverMeta | null {
  const raw = a.metadata?.runtimeRateLimitFailover;
  return raw && typeof raw === 'object' ? raw : null;
}
function activeCooldowns(rows: RuntimeCooldown[]): RuntimeCooldown[] {
  const now = Date.now();
  return rows.filter((row) => Number(row.coolingUntilMs) > now);
}
function cooldownFor(a: Agent, rows: RuntimeCooldown[]): RuntimeCooldown | null {
  const lane = runtimeLaneOf(a);
  const runtime = runtimeOf(a);
  return rows.find((row) => (row.agentId && row.agentId === a.id)
    || (lane && row.laneId === lane)
    || (row.agentName === a.name && (!runtime || row.runtime === runtime))) ?? null;
}
function rateLimitActive(a: Agent, rows: RuntimeCooldown[]): boolean {
  const meta = runtimeRateLimitOf(a);
  return Boolean(cooldownFor(a, rows) || (meta?.coolingUntilMs && meta.coolingUntilMs > Date.now()));
}
function cooldownLabel(row: RuntimeCooldown): string {
  const left = timeUntil(row.coolingUntilMs);
  return `${row.laneId}${left ? ` · ${left}` : ''}${row.reason ? ` · ${row.reason}` : ''}`;
}
function cooldownTitle(row: RuntimeCooldown): string {
  return [cooldownLabel(row), row.resetText ? `reset: ${row.resetText}` : '', row.message ?? ''].filter(Boolean).join('\n');
}

export function AgentTable({ store, onProbe, probeBusy, navigate }: { store: FleetStore; onProbe?: (a: TeamAgent) => void; probeBusy?: string | null; navigate?: (view: string) => void }) {
  const cols = onProbe ? 9 : 8;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [coords, setCoords] = useState<Record<string, string>>({}); // team → coordinator (lead) name
  const [showStopped, setShowStopped] = useState(false); // by default the grid shows only running agents
  const [freshness, setFreshness] = useState<RuntimeFreshness[]>([]);
  const [runtimeCooldowns, setRuntimeCooldowns] = useState<RuntimeCooldown[]>([]);
  const [showModels, setShowModels] = useState(false);
  const [configDrafts, setConfigDrafts] = useState<Record<string, AgentConfigDraft>>({});
  const configDraftList = Object.values(configDrafts);
  const viewAll = store.viewAll;
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);
  const shown: TeamAgent[] = viewAll ? store.allAgents : orderedAgents;
  const sel: TeamAgent | undefined = shown.find((a) => a.id === selected) ?? shown[0];
  const teamOf = (a: TeamAgent): string | undefined => (viewAll ? a.team : undefined);
  const groups = viewAll
    ? Object.values(
        store.allAgents.reduce<Record<string, { team: string; agents: TeamAgent[] }>>((acc, a) => {
          const t = a.team ?? '—';
          (acc[t] ??= { team: t, agents: [] }).agents.push(a);
          return acc;
        }, {}),
      ).sort((x, y) => {
        const xa = x.agents.some((a) => statusClass(a.status) === 'ok');
        const ya = y.agents.some((a) => statusClass(a.status) === 'ok');
        return xa !== ya ? (xa ? -1 : 1) : x.team.localeCompare(y.team);
      })
    : [];
  const isActive = (a: TeamAgent) => statusClass(a.status) === 'ok';
  const activeCount = shown.filter(isActive).length;
  const stoppedCount = shown.length - activeCount;
  const coolingRows = activeCooldowns(runtimeCooldowns);
  const selectedCooldown = sel ? cooldownFor(sel, coolingRows) : null;
  const selectedRateLimit = sel ? runtimeRateLimitOf(sel) : null;
  const selectedFailover = sel ? runtimeFailoverOf(sel) : null;

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setCatalog).catch(() => setCatalog({}));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
    call<{ coordinators?: Record<string, string> }>('coordinator:hierarchy').then((h) => setCoords(h.coordinators ?? {})).catch(() => {});
    call<RuntimeFreshness[]>('runtime:freshness').then(setFreshness).catch(() => setFreshness([]));
    call<RuntimeCooldown[]>('runtime:cooldowns').then(setRuntimeCooldowns).catch(() => setRuntimeCooldowns([]));
  }, [store.lastUpdated]);

  // ★ marks the team's coordinator (lead); routing changes live in HR Manager.
  const teamFor = (a: TeamAgent) => a.team ?? store.team ?? 'default';
  const isLead = (a: TeamAgent) => (coords[teamFor(a)] ?? (teamFor(a) === store.team ? store.coordinator : undefined)) === a.name;
  const draftKeyFor = (a: TeamAgent) => `${teamFor(a)}:${a.id}`;
  function agentStamp(a: TeamAgent): string {
    return JSON.stringify({
      id: a.id,
      name: a.name,
      team: teamFor(a),
      status: a.status ?? '',
      runtime: runtimeOf(a) ?? '',
      model: a.model ?? '',
      effort: effortOf(a),
      speed: speedOf(a),
      type: a.type ?? '',
      health: a.health ?? '',
      port: a.port ?? '',
      deploymentShape: a.deploymentShape ?? '',
    });
  }
  async function freshFleetAgents(): Promise<TeamAgent[] | null> {
    const groups = await call<{ team: string; agents: Agent[] }[]>('agents:allTeams').catch(() => null);
    if (groups) return groups.flatMap((g) => g.agents.map((a) => ({ ...a, team: g.team })));
    const ag = await call<Agent[]>('agents').catch(() => null);
    return ag ? ag.map((a) => ({ ...a, team: store.team ?? 'default' })) : null;
  }
  function findFreshAgent(list: TeamAgent[], a: TeamAgent): TeamAgent | undefined {
    const team = teamFor(a);
    return list.find((x) => teamFor(x) === team && x.id === a.id)
      ?? list.find((x) => teamFor(x) === team && x.name === a.name);
  }
  async function ensureAgentFresh(a: TeamAgent, action: string): Promise<TeamAgent | null> {
    const list = await freshFleetAgents();
    if (!list) {
      window.alert(`Could not verify ${teamFor(a)}/${a.name} before ${action}. Refresh Health and try again.`);
      return null;
    }
    const current = findFreshAgent(list, a);
    if (!current) {
      window.alert(`${teamFor(a)}/${a.name} is no longer present in the fleet snapshot. Health will refresh now.`);
      store.refresh();
      return null;
    }
    if (agentStamp(current) !== agentStamp(a)) {
      window.alert(`${teamFor(a)}/${a.name} changed before ${action}. Health will refresh now; review the current row before applying the action.`);
      store.refresh();
      return null;
    }
    return current;
  }
  function configOf(a: TeamAgent): AgentConfigState {
    return { runtime: runtimeOf(a), model: a.model, effort: effortOf(a), speed: speedOf(a) };
  }
  function configChanges(from: AgentConfigState, to: AgentConfigState): Array<[string, string | undefined, string | undefined]> {
    return ([
      ['runtime', from.runtime, to.runtime],
      ['model', from.model, to.model],
      ['effort', from.effort, to.effort],
      ['speed', from.speed, to.speed],
    ] as Array<[string, string | undefined, string | undefined]>).filter(([, before, after]) => String(before ?? '') !== String(after ?? ''));
  }
  function sameConfig(a: AgentConfigState, b: AgentConfigState): boolean {
    return configChanges(a, b).length === 0;
  }
  function stageConfig(a: TeamAgent, partial: Partial<AgentConfigState>) {
    const key = draftKeyFor(a);
    setConfigDrafts((prev) => {
      const baseline = prev[key]?.baseline ?? configOf(a);
      const next = { ...(prev[key]?.next ?? baseline), ...partial };
      const out = { ...prev };
      if (sameConfig(baseline, next)) delete out[key];
      else out[key] = { key, id: a.id, name: a.name, team: teamFor(a), status: a.status, baseline, next };
      return out;
    });
  }
  function stageRuntime(a: TeamAgent, runtime: string) {
    if (!runtime) return;
    const key = draftKeyFor(a);
    setConfigDrafts((prev) => {
      const baseline = prev[key]?.baseline ?? configOf(a);
      const current = prev[key]?.next ?? baseline;
      const models = catalog[runtime] ?? [];
      const model = !current.model || runtimeModelMismatch(runtime, current.model) ? models[0] ?? current.model : current.model;
      const effort = !runtimeHasEffort(runtime)
        ? baseline.effort
        : current.effort && !effortOptions(runtime).includes(current.effort) ? '' : current.effort;
      const speed = !runtimeHasSpeed(runtime)
        ? baseline.speed
        : speedOptions(runtime).includes(current.speed) ? current.speed : speedOptions(runtime)[0] ?? 'default';
      const next = { ...current, runtime, model, effort, speed };
      const out = { ...prev };
      if (sameConfig(baseline, next)) delete out[key];
      else out[key] = { key, id: a.id, name: a.name, team: teamFor(a), status: a.status, baseline, next };
      return out;
    });
  }
  async function applyConfigDrafts() {
    const drafts = Object.values(configDrafts);
    if (!drafts.length) return;
    const staleRowsFor = (list: TeamAgent[]) => {
      const currentByKey = new Map(list.map((a) => [draftKeyFor(a), a]));
      return drafts.flatMap((d) => {
        const current = currentByKey.get(d.key);
        if (!current) return [`${d.team}/${d.name}: agent is no longer visible in the fleet snapshot`];
        const reasons = configChanges(d.baseline, configOf(current)).map(([field, before, after]) => `${field} changed from ${displayValue(before)} to ${displayValue(after)}`);
        if (current.name !== d.name) reasons.push(`name changed from ${d.name} to ${current.name}`);
        if (current.status !== d.status) reasons.push(`status changed from ${d.status} to ${current.status}`);
        return reasons.length ? [`${d.team}/${d.name}: ${reasons.join('; ')}`] : [];
      });
    };
    const freshList = await freshFleetAgents();
    if (!freshList) {
      window.alert('Could not verify the current fleet before applying Health config. Refresh and try again.');
      return;
    }
    const staleRows = staleRowsFor(freshList);
    if (staleRows.length) {
      window.alert([
        'Staged Health config is stale.',
        '',
        ...staleRows.slice(0, 8).map((row) => `- ${row}`),
        staleRows.length > 8 ? `- +${staleRows.length - 8} more` : '',
        '',
        'Discard and re-stage from the current fleet snapshot before applying.',
      ].filter(Boolean).join('\n'));
      store.refresh();
      return;
    }
    const summaries = drafts.flatMap((d) => configChanges(d.baseline, d.next).map(([field, before, after]) => `${d.team}/${d.name} ${field}: ${displayValue(before)} -> ${displayValue(after)}`));
    if (!summaries.length) {
      setConfigDrafts({});
      return;
    }
    if (!window.confirm([
      'Apply staged Health config changes?',
      '',
      ...summaries.slice(0, 14).map((row) => `- ${row}`),
      summaries.length > 14 ? `- +${summaries.length - 14} more` : '',
      '',
      'This writes manager config and rebuilds each touched agent once so the new runtime settings are picked up.',
    ].filter(Boolean).join('\n'))) return;
    const latestList = await freshFleetAgents();
    if (!latestList) {
      window.alert('Could not verify the fleet immediately before writing Health config. Refresh and try again.');
      return;
    }
    const latestStaleRows = staleRowsFor(latestList);
    if (latestStaleRows.length) {
      window.alert([
        'Fleet changed after the review prompt.',
        '',
        ...latestStaleRows.slice(0, 8).map((row) => `- ${row}`),
        latestStaleRows.length > 8 ? `- +${latestStaleRows.length - 8} more` : '',
        '',
        'No config was written. Review the latest Health table and try again.',
      ].filter(Boolean).join('\n'));
      store.refresh();
      return;
    }
    setBusy('apply config changes');
    try {
      for (const d of drafts) {
        if (String(d.baseline.runtime ?? '') !== String(d.next.runtime ?? '') && d.next.runtime) {
          await call('setAgentRuntime', d.id, d.next.runtime, d.team);
        }
        if (String(d.baseline.model ?? '') !== String(d.next.model ?? '') && d.next.model) {
          await call('remote', `/model ${d.name} ${d.next.model}`, undefined, d.team);
        }
        if (String(d.baseline.effort ?? '') !== String(d.next.effort ?? '')) {
          await call('setAgentEffort', d.id, d.next.effort, d.team);
        }
        if (String(d.baseline.speed ?? '') !== String(d.next.speed ?? '')) {
          await call('setAgentSpeed', d.id, d.next.speed, d.team);
        }
        await call('remote', `/agent ${d.name} rebuild`, undefined, d.team);
      }
      setConfigDrafts({});
      store.refresh();
      setBusy(null);
    } catch (err) {
      setBusy(`config apply failed — ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => setBusy(null), 5000);
    }
  }
  function confirmAgentChange(
    a: TeamAgent,
    label: string,
    detail: string,
    changes: Array<[string, string | undefined, string | undefined]> = [],
    effects: string[] = [],
  ): boolean {
    const team = teamFor(a);
    const currentRuntime = runtimeOf(a);
    const state = [
      `Status: ${a.status}${isActive(a) ? ' (running)' : ''}`,
      `Runtime/model: ${displayValue(currentRuntime, 'unset')} / ${displayValue(a.model, 'unset')}`,
    ].join('\n');
    const diff = changes.length
      ? `\n\nChanges:\n${changes.map(([field, before, after]) => `- ${field}: ${displayValue(before)} -> ${displayValue(after)}`).join('\n')}`
      : '';
    const impact = effects.length ? `\n\nWill:\n${effects.map((effect) => `- ${effect}`).join('\n')}` : '';
    const active = isActive(a) ? '\n\nThis agent is currently running; the change may restart or redirect live work.' : '';
    return window.confirm(`${label} for ${team}/${a.name}?\n\n${detail}\n\n${state}${diff}${impact}${active}`);
  }
  useEffect(() => {
    call<Record<string, string[]>>('runtime:probe').then(setCatalog).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function probeRuntimes() {
    setBusy('probe runtimes');
    try {
      setCatalog(await call<Record<string, string[]>>('runtime:probe'));
      setFreshness(await call<RuntimeFreshness[]>('runtime:freshness').catch(() => freshness));
      setShowModels(true);
    }
    catch (err) { window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function run(label: string, cmd: string, team?: string) {
    setBusy(label);
    try { await call('remote', cmd, undefined, team); store.refresh(); }
    catch (err) { window.alert(`${label} failed: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(null); }
  }
  async function probeAgent(a: TeamAgent) {
    const fresh = await ensureAgentFresh(a, 'probing');
    if (!fresh) return;
    if (onProbe) onProbe(fresh);
    else await run(`probe ${fresh.name}`, `/agent ${fresh.name} probe`, teamOf(fresh));
  }
  async function action(a: TeamAgent, act: string) {
    if (!act) return;
    if ((act === 'Start' || act === 'Rebuild') && configDrafts[draftKeyFor(a)]) {
      window.alert(`Apply or discard staged config for ${teamFor(a)}/${a.name} before ${act.toLowerCase()}ing it.`);
      return;
    }
    const fresh = await ensureAgentFresh(a, act.toLowerCase());
    if (!fresh) return;
    const team = teamOf(fresh);
    if (act === 'Delete') {
      if (confirmAgentChange(
        fresh,
        'Delete agent',
        'This removes the agent from the manager roster. Working files are left in place.',
        [],
        ['Remove this agent from future routing and Health views'],
      )) await run(`delete ${fresh.name}`, `/delete ${fresh.name}`, team);
      return;
    }
    if (act === 'Reset session') {
      // Start a fresh conversation — drops the agent's accumulated context. Use this to deflate a
      // bloated codex session (multi-million-token prompts) so its next turns are cheap again.
      if (!confirmAgentChange(
        fresh,
        'Reset session',
        'This clears the agent conversation context.',
        [],
        ['Drop accumulated session context for future turns'],
      )) return;
      await run(`reset session ${fresh.name}`, `/clear ${fresh.name}`, team);
      return;
    }
    if (act === 'Probe') {
      await probeAgent(fresh);
      return;
    }
    if ((act === 'Start' || act === 'Stop' || act === 'Rebuild') && !confirmAgentChange(
      fresh,
      act,
      act === 'Start'
        ? 'This starts the agent process.'
        : act === 'Stop'
          ? 'This stops the agent process and can interrupt current work.'
          : 'This restarts the agent process so runtime/config changes take effect.',
      [],
      [act === 'Start' ? 'Start this agent process' : act === 'Stop' ? 'Stop this agent process' : 'Restart this agent process with current runtime/config'],
    )) return;
    await run(`${act} ${fresh.name}`, `/agent ${fresh.name} ${act.toLowerCase()}`, team);
  }
  const renderRow = (a: TeamAgent) => {
    const currentRuntime = runtimeOf(a);
    const draft = configDrafts[draftKeyFor(a)];
    const displayRuntime = draft?.next.runtime ?? currentRuntime;
    const displayModel = draft?.next.model ?? a.model;
    const displayEffort = draft?.next.effort ?? effortOf(a);
    const displaySpeed = draft?.next.speed ?? speedOf(a);
    const runtimeModels = catalog[displayRuntime ?? ''] ?? [];
    const modelOpts = Array.from(new Set([displayModel, ...runtimeModels].filter(Boolean))) as string[];
    const isLocal = (a.type ?? '') === 'claude' || RUNTIMES.includes(currentRuntime ?? '');
    const runtimeOpts = Array.from(new Set([currentRuntime, ...offerableRuntimes(providers, currentRuntime)].filter(Boolean))) as string[];
    const mismatch = runtimeModelMismatch(displayRuntime, displayModel);
    const cooling = rateLimitActive(a, coolingRows);
    const cooldown = cooldownFor(a, coolingRows);
    return (
      <tr key={`${a.team ?? ''}-${a.id}`} className={`${sel?.id === a.id ? 'sel' : ''}${draft ? ' config-staged' : ''}`} onClick={() => setSelected(a.id)}>
        <td className="b">
          <span className={`star readonly${isLead(a) ? ' on' : ''}`} title={isLead(a) ? `${a.name} is ${teamFor(a)}'s lead` : 'Lead changes live in HR Manager'} style={{ marginRight: 5 }}>
            {isLead(a) ? '★' : ''}
          </span>
          {a.name}
        </td>
        <td><span className={`dot ${statusClass(a.status)}`} /> {a.status}</td>
        <td onClick={(e) => e.stopPropagation()}>
          {isLocal ? (
            <select className="cell-select" value={displayRuntime ?? ''} onChange={(e) => stageRuntime(a, e.target.value)}>
              {runtimeOpts.map((r) => <option key={r} value={r}>{runtimeLabel(r)}</option>)}
            </select>
          ) : (
            <span className="muted" title="remote agents have no switchable runtime">{short(currentRuntime ?? a.type)}</span>
          )}
          {cooling ? <span className="warn-text" title={cooldown ? cooldownTitle(cooldown) : 'runtime rate limit cooling'} style={{ marginLeft: 4, cursor: 'help' }}>⚠</span> : null}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className={`cell-select${mismatch ? ' mismatch' : ''}`} value={displayModel ?? ''} onChange={(e) => stageConfig(a, { model: e.target.value })} title={mismatch ?? undefined}>
            {modelOpts.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
          {mismatch ? <span className="warn-text" title={mismatch} style={{ marginLeft: 4, cursor: 'help' }}>⚠</span> : null}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {runtimeHasEffort(displayRuntime) ? (
            <select className="cell-select" value={displayEffort} onChange={(e) => stageConfig(a, { effort: e.target.value })}
              title={`Reasoning effort for the ${runtimeLabel(displayRuntime ?? '')} runtime — lower spends fewer subscription tokens per turn`}>
              <option value="">default</option>
              {effortOptions(displayRuntime).map((eff) => <option key={eff} value={eff}>{eff}</option>)}
            </select>
          ) : (
            <span className="muted" title="local & cursor runtimes have no reasoning-effort setting">—</span>
          )}
        </td>
        <td onClick={(e) => e.stopPropagation()}>
          {runtimeHasSpeed(displayRuntime) ? (
            <select className="cell-select" value={displaySpeed} onChange={(e) => stageConfig(a, { speed: e.target.value })}
              title={`Output speed for the ${runtimeLabel(displayRuntime ?? '')} runtime`}>
              {speedOptions(displayRuntime).map((speed) => <option key={speed} value={speed}>{speed}</option>)}
            </select>
          ) : (
            <span className="muted" title="this runtime has no output-speed setting">—</span>
          )}
        </td>
        <td className="muted" title="port is assigned by the manager">{a.port || '—'}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <select className="cell-select" value="" onChange={(e) => { void action(a, e.target.value); e.target.value = ''; }}>
            <option value="">⋯</option>
            <option>Start</option>
            <option>Stop</option>
            <option>Rebuild</option>
            <option>Reset session</option>
            <option>Probe</option>
            <option>Delete</option>
          </select>
        </td>
        {onProbe ? (
          <td onClick={(e) => e.stopPropagation()}>
            <button className="btn small" disabled={probeBusy === a.name} onClick={() => void probeAgent(a)}>{probeBusy === a.name ? '…' : 'Probe'}</button>
          </td>
        ) : null}
      </tr>
    );
  };

  return (
    <>
      <section className="card grow" style={{ minWidth: 0 }}>
        <div className="row-actions" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Fleet <span className="muted small">· {activeCount} active{busy ? ` · ${busy}…` : ''}</span></h3>
          <span className="grow" />
          {stoppedCount ? (
            <label className="muted small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }} title="By default only running agents are shown — reveal stopped ones to start/manage them">
              <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} /> show stopped ({stoppedCount})
            </label>
          ) : null}
          {coolingRows.length ? (
            <span className="warn-text small" title={coolingRows.map(cooldownLabel).join('\n')}>
              runtime cooldowns {coolingRows.length}
            </span>
          ) : null}
          <button className="btn small" onClick={() => setShowModels((v) => !v)} title="Show each runtime's model list, where it comes from, and when it was last refreshed">
            {showModels ? 'Hide models' : `Models${freshness.length ? ` (${freshness.filter((f) => f.count).length})` : ''}`}
          </button>
          {navigate ? <button className="btn small" onClick={() => navigate('teams:route')} title="Change team coordinators and primary routing in HR Manager Route → Hierarchy & sync">Open HR Route</button> : null}
          <button className="btn" disabled={!!busy} onClick={() => void probeRuntimes()} title="Probe each runtime's backing inference provider for its newest available models (also auto-refreshes every 6h)">Probe runtimes</button>
        </div>
        {showModels ? (
          <div className="card" style={{ background: 'var(--bg-2)', margin: '0 0 8px', padding: '6px 10px' }}>
            <div className="muted small" style={{ marginBottom: 4 }}>
              Per-runtime models &amp; freshness — auto-refreshed on boot + every 6h, or hit <b>Probe runtimes</b> now.
            </div>
            {freshness.filter((f) => f.count || f.source !== 'none').map((f) => (
              <div key={f.runtime} className="row-actions" style={{ gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <b style={{ minWidth: 130 }}>{runtimeLabel(f.runtime)}</b>
                <span className="muted small" style={{ minWidth: 64 }}>{f.count} model{f.count === 1 ? '' : 's'}</span>
                <span className={`small ${f.source === 'curated' || f.source === 'none' ? 'warn-text' : 'ok-text'}`} style={{ minWidth: 140 }}
                  title={f.source === 'curated' ? 'No live model API for this runtime — using a curated fallback list (subscription runtimes have no /models endpoint).' : SOURCE_LABEL[f.source]}>
                  {SOURCE_LABEL[f.source]}{f.provider ? ` · ${f.provider}` : ''}
                </span>
                <span className="muted small">{f.lastCheckedMs ? `checked ${agoMs(f.lastCheckedMs)}` : ''}</span>
              </div>
            ))}
            {freshness.length === 0 ? <div className="muted small">Loading model freshness…</div> : null}
          </div>
        ) : null}
        {configDraftList.length ? (
          <div className="agent-config-draft">
            <b>{configDraftList.length} staged config change{configDraftList.length === 1 ? '' : 's'}</b>
            <span className="muted small">Apply reviews the full diff, blocks stale rows, and rebuilds each touched agent once.</span>
            <span className="grow" />
            <button className="btn small" disabled={!!busy} onClick={() => setConfigDrafts({})}>Discard</button>
            <button className="btn primary small" disabled={!!busy} onClick={() => void applyConfigDrafts()}>Apply changes</button>
          </div>
        ) : null}
        <table className="grid">
          <thead>
            <tr><th>Agent</th><th>Status</th><th>Runtime</th><th>Model</th><th title="Reasoning effort — lower spends fewer subscription tokens (codex & Claude CLI only)">Effort</th><th title="Output speed — Claude Code runtimes only">Speed</th><th>Port</th><th>Actions</th>{onProbe ? <th>Probe</th> : null}</tr>
          </thead>
          <tbody>
            {groups.flatMap((g) => {
              // The team's actual ★ lead floats to the top of its group (not just a "lead"-named agent).
              const teamLead = coords[g.team] ?? (g.team === store.team ? store.coordinator : undefined);
              const rows = agentsLeadFirst(g.agents, teamLead).filter((a) => showStopped || isActive(a as TeamAgent));
              if (!rows.length) return [];
              return [
                <tr key={`hdr-${g.team}`} className="group-row">
                  <td colSpan={cols} className="muted small b" style={{ background: 'var(--panel, #1b1b1b)', padding: '4px 8px' }}>
                    {g.team} · {g.agents.filter((x) => statusClass(x.status) === 'ok').length}/{g.agents.length} running
                  </td>
                </tr>,
                ...rows.map((a) => renderRow(a as TeamAgent)),
              ];
            })}
            {activeCount === 0 && !showStopped ? (
              <tr><td colSpan={cols} className="muted center pad">{store.connection === 'offline' ? 'manager unreachable' : stoppedCount ? 'no running agents — tick “show stopped” to start one' : 'no agents'}</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {sel ? (
        <section className="card detail">
          <h3>{sel.name}</h3>
          <div className="kv">
            <span>status</span><b><span className={`dot ${statusClass(sel.status)}`} /> {sel.status}</b>
            {agentHint(sel) ? (<><span>hint</span><b className="warn-text">{agentHint(sel)}</b></>) : null}
            {viewAll ? (<><span>team</span><b>{sel.team ?? '—'}</b></>) : null}
            <span>runtime</span><b>{runtimeOf(sel) ?? sel.type ?? '—'}</b>
            {runtimeLaneOf(sel) ? (<><span>runtime lane</span><b className="mono small">{runtimeLaneOf(sel)}</b></>) : null}
            {selectedCooldown ? (
              <>
                <span>lane cooldown</span><b className="warn-text" title={cooldownTitle(selectedCooldown)}>{cooldownLabel(selectedCooldown)}</b>
              </>
            ) : selectedRateLimit ? (
              <>
                <span>rate limit</span><b className={selectedRateLimit.coolingUntilMs && selectedRateLimit.coolingUntilMs > Date.now() ? 'warn-text' : 'muted'}>
                  {selectedRateLimit.laneId ?? 'runtime'}{selectedRateLimit.coolingUntilMs ? ` · ${timeUntil(selectedRateLimit.coolingUntilMs) || 'expired'}` : ''}{selectedRateLimit.reason ? ` · ${selectedRateLimit.reason}` : ''}
                </b>
              </>
            ) : null}
            {selectedFailover ? (
              <>
                <span>failover</span><b className="small">{selectedFailover.fromLaneId ?? '—'} -&gt; {selectedFailover.toLaneId ?? '—'}{selectedFailover.observedAtMs ? ` · ${timeAgo(selectedFailover.observedAtMs)} ago` : ''}</b>
              </>
            ) : null}
            <span>model</span><b>{sel.model ?? '—'}</b>
            {sel.health ? (<><span>health</span><b>{sel.health}</b></>) : null}
            <span>speed</span><b>{runtimeHasSpeed(runtimeOf(sel)) ? speedOf(sel) : '—'}</b>
            <span>port</span><b>{sel.port || '—'}</b>
            {descriptionOf(sel) ? (<><span>description</span><b>{descriptionOf(sel)}</b></>) : null}
            <span>skills</span>
            <b>{chips(skillsOf(sel))}</b>
            <span>plugins</span><b>{chips(pluginsOf(sel))}</b>
            <span>mcp servers</span><b>{chips(mcpServersOf(sel))}</b>
            <span>delegates</span><b>{chips(delegatesOf(sel))}</b>
            <span>instructions</span><b>{instructionsOf(sel) ? <span className="ok-text">present</span> : <span className="muted">none</span>}</b>
            {isRemoteEndpoint(sel) ? (
              <>
                <span>endpoint</span><b className="mono small">{sel.public_endpoint_url ?? '—'}</b>
                <span>domain</span><b>{sel.customer_domain ?? sel.idchain_domain ?? '—'}</b>
                <span>last seen</span><b>{timeAgo(sel.last_seen)}</b>
                <span>failures</span><b>{sel.consecutive_failures ?? 0}</b>
              </>
            ) : null}
            <span>workdir</span><b className="mono small">{sel.workingDirectory ?? '—'}</b>
          </div>
        </section>
      ) : null}
    </>
  );
}
