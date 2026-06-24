import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { call, agentsLeadFirst, resolveCoordinator, type FleetStore } from '../store.ts';
import { offerableRuntimes } from '../../../../idctl/src/settings/runtimeCatalog.ts';
import { AgentTable } from './AgentTable.tsx';
import type { ConfigEntry, DeployPreflight, DesignedTeam, LibrarySkillEntry, McpServerSpec, TeamTemplate } from '../../../../idctl/src/api/client.ts';
import type { OnboardPlan, OnboardResult } from '../../../../idctl/src/api/onboard.ts';
import { MCP_CATALOG, buildFromCatalog } from '../../../../idctl/src/settings/mcpCatalog.ts';
import { parseTeamSpec, slugName, isReservedName } from '../../../../idctl/src/api/teamSpec.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';
import { TeamGraph, type GraphSelection } from './TeamGraph.tsx';

type ProviderRow = { kind: string; enabled?: boolean; keySource?: string; lastSync?: { status?: string } };

type RelayMode = 'permissive' | 'all' | 'select' | 'none';
/** Status of a post-build wiring step (coordinator/relay) in the Team Builder. */
type PostStat = 'running' | 'ok' | 'failed';
type TeamSource =
  | { kind: 'default'; name: 'default' }
  | { kind: 'template'; name: string }
  | { kind: 'config'; name: string };

const HB_INTERVALS = [
  { label: '5 min', s: 300 },
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '6 hours', s: 21600 },
  { label: '24 hours', s: 86400 },
];
function runtimeLabel(r: string): string {
  return r.replace('claude-code-', 'claude-').replace('claude-agent-sdk', 'claude-sdk').replace('-cli', '');
}

function modeOf(delegates: string[] | null): RelayMode {
  if (delegates === null) return 'permissive';
  if (delegates.includes('*')) return 'all';
  if (delegates.length === 0) return 'none';
  return 'select';
}

// Stable identity for a delegates_to value so we can detect unsaved changes.
function relayKey(d: string[] | null): string {
  if (d === null) return 'permissive';
  if (d.length === 0) return 'none';
  return [...d].sort().join(',');
}

// Human-readable summary of a persisted delegates_to value.
function describeRelay(d: string[] | null): string {
  if (d === null) return 'permissive — any team';
  if (d.includes('*')) return 'all teams';
  if (d.length === 0) return 'blocked — no teams';
  return d.join(', ');
}

/** Shared reliability + task-hygiene guidance appended to every coordinator
 *  directive (the generic preset and the roster-aware one the builder generates). */
const COORDINATION_TAIL = `RELIABILITY — how to delegate:
- STRONGLY PREFER synchronous **/talk-to** (pattern 1 in the inter-agent skill). It blocks until the teammate replies and the MANAGER handles the wait, so you get the result inline and reliably.
- For a sub-task that belongs to ANOTHER team, hand it to that team's lead with **/ask <team>/<lead>** (subject to your team's relay policy). If a team isn't reachable, say so — don't silently absorb its work.
- Do NOT hand-roll a long polling loop against a teammate's /news after an async /news-to — that is fragile and can hang for a long time if the teammate doesn't wake. If you find yourself looping on /news waiting for a delegate, STOP and use /talk-to instead.
- Use async /news-to (trigger:true) ONLY for genuine fire-and-forget where you do NOT need the result inline. If you must parallelize, prefer a few sequential /talk-to calls over a fragile async fan-out.

Keep the task board clean: for synchronous /talk-to delegations do NOT attach a tracked manager task (omit the \`task\` field) — you get the reply inline, so a tracked task would just linger unclosed. Only attach a tracked task for async handoffs you will collect later, and mark it done when you do.

Compressing, decomposing, delegating, and summarizing — NOT doing the work yourself — is your primary job as the lead. Do the work yourself only for trivial one-liners, or when delegation would clearly be slower with no benefit (and say so in one line).`;

/** Ready-made "act as the team coordinator" directive (generic coder/researcher
 *  teammates) — used by the Agent-instructions card's "Coordinator preset" button. */
const COORDINATOR_PRESET = `## Team coordination (you are the lead)

You are this team's COORDINATOR. Your job is NOT to do the work yourself — it is to COMPRESS, BREAK UP, DELEGATE, and SUMMARIZE. You have specialist teammates — by default **coder** (implementation, code, file changes, running commands) and **researcher** (research, analysis, documentation, investigation) — and you can hand work to OTHER teams' leads too.

For any NON-TRIVIAL request, work in this order, and narrate each step as you go:

1. **Compress** — distill the request to its essential intent, deliverable, and hard constraints; strip the noise. State it back in 1-2 lines so the scope is unambiguous before any work starts.
2. **Break it up** — decompose the compressed request into the smallest independent sub-tasks. For each, name the ONE owner best suited to it, and keep it self-contained (include only the context that owner needs).
3. **Delegate** — hand each sub-task to its owner: a teammate on your team (implementation/code → **coder**, research/analysis/docs → **researcher**) via the **inter-agent** skill, or another team's lead via **/ask <team>/<lead>** when the work is in that team's domain. Prefer a few focused, sequential hand-offs over one giant one.
4. **Summarize step by step** — as EACH delegate replies, compress its result to 1-3 lines and post that running update immediately; don't wait for everything to finish. Keep a visible tally of what's done, what's pending, and any blockers.
5. **Close out** — assemble the step summaries into one coherent answer, stating who did what.

${COORDINATION_TAIL}`;

/** Roster-aware coordinator directive — names the ACTUAL teammates created in the
 *  batch so the lead delegates to agents that exist (falls back to the generic
 *  coder/researcher preset when there are no teammates). */
function coordinatorPresetFor(teammates: { name: string; role: string }[]): string {
  if (!teammates.length) return COORDINATOR_PRESET;
  const inline = teammates.map((t) => `**${t.name}**${t.role ? ` (${t.role})` : ''}`).join(', ');
  const bullets = teammates.map((t) => `   - **${t.name}**${t.role ? ` — ${t.role}` : ''}`).join('\n');
  return `## Team coordination (you are the lead)

You are this team's COORDINATOR. Your job is NOT to do the work yourself — it is to COMPRESS, BREAK UP, DELEGATE, and SUMMARIZE. Your specialist teammates are: ${inline}. You can also hand work to OTHER teams' leads when it belongs to their domain.

For any NON-TRIVIAL request, work in this order, and narrate each step as you go:

1. **Compress** — distill the request to its essential intent, deliverable, and hard constraints; strip the noise. State it back in 1-2 lines so the scope is unambiguous before any work starts.
2. **Break it up** — decompose into the smallest independent sub-tasks; for each, pick the ONE owner best suited to it and keep it self-contained.
3. **Delegate** — hand each sub-task to its owner via the **inter-agent** skill (or **/ask <team>/<lead>** for another team's domain):
${bullets}
4. **Summarize step by step** — as EACH delegate replies, compress its result to 1-3 lines and post that running update immediately; don't wait for everything to finish. Track what's done, pending, and blocked.
5. **Close out** — assemble the step summaries into one coherent answer, stating who did what.

${COORDINATION_TAIL}`;
}

export function Teams({ store }: { store: FleetStore }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>('');
  const [createOpen, setCreateOpen] = useState(false);
  // The unified AI Team Builder. null = closed; a string = open with that target
  // team preselected ('' opens in new-team mode).
  const [builderTeam, setBuilderTeam] = useState<string | null>(null);

  // HR pillars as tabs + the live structure graph.
  const [tab, setTab] = useState<'structure' | 'build' | 'manage' | 'route'>('structure');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [graphGroups, setGraphGroups] = useState<{ team: string; agents: Agent[] }[]>([]);
  useEffect(() => {
    // Prefer the store's live all-teams poll (holistic view) so the graph reacts in lock-step
    // with the rest of the app; fall back to a direct fetch when that isn't populated.
    if (store.allAgents.length) {
      const byTeam: Record<string, Agent[]> = {};
      for (const a of store.allAgents) (byTeam[a.team ?? '—'] ??= []).push(a);
      setGraphGroups(Object.entries(byTeam).map(([team, agents]) => ({ team, agents })));
      return;
    }
    call<{ team: string; agents: Agent[] }[]>('agents:allTeams').then(setGraphGroups).catch(() => setGraphGroups([]));
  }, [store.lastUpdated, store.allAgents]);

  // Cross-team relay policy (delegates_to) for the active team.
  const activeTeam = store.team ?? 'default';
  const [delegates, setDelegates] = useState<string[] | null>(null);
  const [savedDelegates, setSavedDelegates] = useState<string[] | null>(null); // last persisted value
  const [mode, setMode] = useState<RelayMode>('permissive');
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayMsg, setRelayMsg] = useState<string>(''); // inline feedback next to Save
  const otherTeams = store.teams.map((t) => t.name).filter((n) => n !== activeTeam);

  // Per-agent instructions (system-prompt addendum) — e.g. make the lead coordinate.
  const coordName = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';
  const [instrAgent, setInstrAgent] = useState('');
  const [instrText, setInstrText] = useState('');
  const [instrSaved, setInstrSaved] = useState('');
  const [instrBusy, setInstrBusy] = useState(false);
  const [instrMsg, setInstrMsg] = useState('');
  const instrTarget = instrAgent && store.agents.some((a) => a.name === instrAgent) ? instrAgent : coordName;
  async function loadInstr(agent: string) {
    if (!agent) { setInstrText(''); setInstrSaved(''); return; }
    const t = await call<string>('agent:getInstructions', agent).catch(() => '');
    setInstrText(t); setInstrSaved(t);
  }
  useEffect(() => { void loadInstr(instrTarget); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [instrTarget, store.team]);
  async function saveInstr(team?: string) {
    if (!instrTarget) return;
    setInstrBusy(true); setInstrMsg('saving…');
    try {
      // `team` scopes the write to the selected agent's team (Structure panel), so a
      // pending active-team switch can't redirect it; omitted ⇒ the active team.
      const r = await call<{ ok: boolean; needsRebuild?: boolean }>('agent:setInstructions', instrTarget, instrText, team);
      setInstrSaved(instrText);
      setInstrMsg(r.needsRebuild ? `saved ✓ — rebuilding ${instrTarget}…` : 'saved ✓');
      // Rebuild so the new instructions land in the agent's system prompt now.
      await call('rebuildAgent', instrTarget, team).catch(() => {});
      setInstrMsg(instrText.trim() ? `saved ✓ — ${instrTarget} rebuilt; it now follows these instructions` : `cleared ✓ — ${instrTarget} rebuilt`);
    } catch (e) {
      setInstrMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setInstrBusy(false); }
  }

  /** AI-assist: turn the current text (a rough brief, or empty) into a polished
   *  operating directive for the targeted agent. Review, then Save & rebuild. */
  async function aiDraftInstr() {
    if (!instrTarget) return;
    const brief = instrText.trim();
    setInstrBusy(true); setInstrMsg('asking AI to draft…');
    try {
      const meta =
        'Write a concise operating directive (a system-prompt addendum, 2-6 sentences, ' +
        'imperative voice, NO preamble, NO markdown headers, NO code fences) for an AI agent named "' + instrTarget + '"' +
        (brief ? ' whose goal is: ' + brief : ' — infer a sensible role from its name') +
        '. Output ONLY the directive text.';
      const txt = await call<string>('ai:draft', meta);
      setInstrText(txt.trim());
      setInstrMsg('drafted ✓ — review, then Save & rebuild');
    } catch (e) {
      setInstrMsg(`AI draft failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setInstrBusy(false); }
  }

  /** A node (or team title) was clicked in the structure graph: select it, focus
   *  that team, and point the instructions editor at the chosen agent. */
  function onGraphSelect(sel: GraphSelection) {
    if (sel.kind === 'agent') {
      setSelectedKey(`agent:${sel.team}:${sel.agent.name}`);
      if (sel.team !== activeTeam) void store.setTeam(sel.team);
      setInstrAgent(sel.agent.name);
    } else {
      setSelectedKey(`team:${sel.team}`);
      if (sel.team !== activeTeam) void store.setTeam(sel.team);
    }
  }
  // The agent currently selected in the graph (for the structure-tab side panel).
  const selectedAgent = (() => {
    if (!selectedKey?.startsWith('agent:')) return null;
    const rest = selectedKey.slice('agent:'.length);
    const sep = rest.indexOf(':');
    const team = rest.slice(0, sep); const name = rest.slice(sep + 1);
    const a = graphGroups.find((g) => g.team === team)?.agents.find((x) => x.name === name);
    return a ? { team, agent: a, reassignTargets: store.teams.map((t) => t.name).filter((n) => n !== team) } : null;
  })();

  async function loadRelay() {
    try {
      const cfg = await call<{ delegates_to: string[] | null }>('teamConfig', activeTeam);
      setDelegates(cfg.delegates_to);
      setSavedDelegates(cfg.delegates_to);
      setMode(modeOf(cfg.delegates_to));
      setRelayMsg('');
    } catch {
      setDelegates(null);
      setSavedDelegates(null);
      setMode('permissive');
    }
  }
  useEffect(() => {
    void loadRelay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, store.teams.length]);

  function pickMode(m: RelayMode) {
    setRelayMsg('');
    setMode(m);
    if (m === 'permissive') setDelegates(null);
    else if (m === 'all') setDelegates(['*']);
    else if (m === 'none') setDelegates([]);
    else setDelegates((d) => (d && !d.includes('*') ? d : [])); // keep existing selection
  }
  function toggleTeam(name: string) {
    setRelayMsg('');
    setDelegates((d) => {
      const cur = d && !d.includes('*') ? d : [];
      return cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    });
  }
  // The payload that would be persisted for the current selection, and whether it differs from what's saved.
  const relayPayload: string[] | null = mode === 'permissive' ? null : delegates ?? [];
  const relayDirty = relayKey(relayPayload) !== relayKey(savedDelegates);
  async function saveRelay() {
    setRelayBusy(true);
    setRelayMsg('saving…');
    try {
      const r = await call<{ delegates_to: string[] | null }>('setTeamDelegates', activeTeam, relayPayload);
      setDelegates(r.delegates_to);
      setSavedDelegates(r.delegates_to);
      setMode(modeOf(r.delegates_to));
      setRelayMsg(`saved ✓ (${describeRelay(r.delegates_to)})`);
    } catch (err) {
      setRelayMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRelayBusy(false);
    }
  }

  // Catalogs for the Onboard modal (runtimes/models, library skills, providers).
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({});
  const [skillCatalog, setSkillCatalog] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);

  useEffect(() => {
    call<Record<string, string[]>>('runtime:models').then(setModelCatalog).catch(() => setModelCatalog({}));
    call<LibrarySkillEntry[]>('librarySkills').then((s) => setSkillCatalog(s.map((x) => x.name))).catch(() => setSkillCatalog([]));
    call<ProviderRow[]>('providers:list').then(setProviders).catch(() => setProviders([]));
  }, [store.lastUpdated]);


  // Per-agent relay overrides (an individual agent can be granted/denied
  // cross-team delegation independently of its team's policy).
  const [agentEditing, setAgentEditing] = useState<string | null>(null);
  const [agentSel, setAgentSel] = useState<string[]>([]);
  async function applyAgent(id: string, delegates: string[] | null, label: string) {
    setBusy(true);
    setMsg(`${label}…`);
    try {
      await call('setAgentDelegates', id, delegates);
      store.refresh();
      setMsg(`${label} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Reassign a local agent to a different team (manager rebuilds it there).
  async function moveAgentToTeam(agentId: string, agentName: string, toTeam: string) {
    if (!toTeam || toTeam === activeTeam) return;
    if (!window.confirm(`Move agent "${agentName}" from "${activeTeam}" to "${toTeam}"?\n\nIt will be rebuilt under the new team and leave ${activeTeam}.`)) return;
    setBusy(true);
    setMsg(`moving ${agentName} → ${toTeam}…`);
    try {
      const r = await call<{ rebuilt?: boolean; warning?: string }>('agent:move', agentId, toTeam);
      store.refresh();
      setMsg(r?.warning ? `moved ${agentName} → ${toTeam} (⚠ ${r.warning})` : `moved ${agentName} → ${toTeam} ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  // Delete an EMPTY team. The manager refuses `default` and any team with agents.
  async function removeTeam(name: string) {
    if (!window.confirm(`Delete team "${name}"?\n\nIt has no agents. This can't be undone.`)) return;
    setBusy(true);
    setMsg(`deleting team ${name}…`);
    try {
      await call('team:delete', name);
      if (name === store.team) await store.setTeam('default');
      store.refresh();
      setMsg(`team ${name} deleted ✓`);
    } catch (err) {
      setMsg(`failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }
  function pickAgentMode(a: { id: string; name: string; metadata?: unknown }, m: RelayMode) {
    if (m === 'select') {
      const cur = (a.metadata as { delegates_to?: unknown })?.delegates_to;
      setAgentSel(Array.isArray(cur) && !cur.includes('*') ? (cur as string[]) : []);
      setAgentEditing(a.id);
    } else {
      setAgentEditing(null);
      void applyAgent(a.id, m === 'permissive' ? null : m === 'all' ? ['*'] : [], `${a.name} relay`);
    }
  }
  function toggleAgentTeam(name: string) {
    setAgentSel((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));
  }
  // Lead hierarchy (#10): the primary coordinator across teams.
  const [hier, setHier] = useState<{ primary: { team: string; agent: string } | null; coordinators: Record<string, string> }>({ primary: null, coordinators: {} });
  async function loadHier() {
    setHier(await call<typeof hier>('coordinator:hierarchy').catch(() => ({ primary: null, coordinators: {} })));
  }
  useEffect(() => { void loadHier(); }, [activeTeam, store.lastUpdated]);
  async function makePrimary() {
    const agent = store.coordinator ?? store.agents.find((a) => /^(lead|manager)$/i.test(a.name))?.name;
    if (!agent) return;
    await call('coordinator:setPrimary', store.team ?? 'default', agent);
    await loadHier();
  }
  /** Set (or change) a team's coordinator — the lead the rest of the team reports to. */
  async function setTeamCoordinator(team: string, agent: string) {
    if (!agent) return;
    await call('coordinator:set', team, agent).catch(() => {});
    await loadHier();
    store.refresh();
  }
  /** Promote a specific team's coordinator to the primary cross-team lead. */
  async function makePrimaryFor(team: string, agent: string) {
    if (!agent) return;
    await call('coordinator:setPrimary', team, agent).catch(() => {});
    await loadHier();
  }

  // Whole-team lifecycle (start / stop / probe / rebuild every agent in a team).
  const [teamOpBusy, setTeamOpBusy] = useState(false);
  const [teamOpMsg, setTeamOpMsg] = useState('');
  const [pendingTeamOp, setPendingTeamOp] = useState<string | null>(null); // 2-step confirm for stop/rebuild
  async function runTeamOp(team: string, op: 'start' | 'stop' | 'probe' | 'rebuild') {
    setPendingTeamOp(null); setTeamOpBusy(true); setTeamOpMsg(`${op} ${team}…`);
    try {
      if (op === 'probe') {
        const p = await call<{ team: string; probed: number; passed: number; failed: number }>('team:probe', team);
        setTeamOpMsg(`probe ${team}: ${p.passed}/${p.probed} healthy${p.failed ? ` · ${p.failed} failed` : ''}`);
      } else {
        const r = await call<{ total: number; done: string[]; failed: { name: string; error: string }[] }>('team:lifecycle', team, op);
        setTeamOpMsg(r.failed.length
          ? `${op} ${team}: ${r.done.length}/${r.total} ✓ · ${r.failed.length} failed (${r.failed.map((f) => f.name).join(', ')})`
          : `${op} ${team}: ${r.done.length}/${r.total} agents ✓`);
      }
      store.refresh();
    } catch (e) {
      setTeamOpMsg(`${op} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setTeamOpBusy(false); }
  }

  return (
    <div className="view modules">
      <header className="view-head">
        <h1>HR Manager</h1>
      </header>
      <div className="tabs">
        {([['structure', 'Structure'], ['build', 'Build'], ['manage', 'Manage'], ['route', 'Route']] as const).map(([k, lbl]) => (
          <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{lbl}</button>
        ))}
      </div>
      {builderTeam !== null ? (
        <TeamBuilder
          team={builderTeam}
          existingTeams={store.teams.map((t) => t.name)}
          providers={providers}
          modelCatalog={modelCatalog}
          skillCatalog={skillCatalog}
          onClose={() => setBuilderTeam(null)}
          onBusy={setBusy}
          onMessage={setMsg}
          onDone={(createdTeam) => { if (createdTeam) void store.setTeam(createdTeam); store.refresh(); }}
        />
      ) : null}
      {createOpen ? (
        <CreateTeamModal
          existingTeams={store.teams.map((t) => t.name)}
          onClose={() => setCreateOpen(false)}
          onBusy={setBusy}
          onMessage={setMsg}
          onCreated={async (name) => {
            await store.setTeam(name);
            store.refresh();
          }}
        />
      ) : null}

      {tab === 'structure' ? (
        <section className="card">
          <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Team structure — live</h3>
            <button className="btn" disabled={busy} onClick={() => void makePrimary()} title="Make the active team's coordinator the top of the cross-team hierarchy">
              ⭑ Make “{activeTeam}” the primary lead
            </button>
          </div>
          <p className="muted small" style={{ marginTop: -2 }}>
            Click an agent or team to select it, then edit its goals/instructions, runtime &amp; routing below.
          </p>
          <TeamGraph
            groups={graphGroups}
            hier={hier}
            leadOf={(t, ag) => hier.coordinators[t] ?? resolveCoordinator(ag, undefined) ?? ag[0]?.name}
            selectedKey={selectedKey}
            onSelect={onGraphSelect}
          />
          {selectedAgent ? (
            <div className="card" style={{ marginTop: 10, background: 'var(--bg-2)' }}>
              <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h4 style={{ margin: 0 }}>{selectedAgent.agent.name}{' '}
                  <span className="muted small">· {selectedAgent.team} · {runtimeLabel(selectedAgent.agent.runtime ?? '')} · {selectedAgent.agent.status}</span>
                </h4>
                <span className="row-actions" style={{ gap: 6 }}>
                  <select className="cell-select" disabled={busy || selectedAgent.reassignTargets.length === 0} value="" title="Reassign to another team"
                    onChange={(e) => { const to = e.target.value; e.currentTarget.value = ''; if (to) void moveAgentToTeam(selectedAgent!.agent.id, selectedAgent!.agent.name, to); }}>
                    <option value="">{selectedAgent.reassignTargets.length === 0 ? 'no other teams' : 'reassign to…'}</option>
                    {selectedAgent.reassignTargets.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button className="btn small" disabled={busy} onClick={() => setTab('route')}>⇄ Routing</button>
                  <button className="btn small" disabled={busy} onClick={() => void call('rebuildAgent', selectedAgent!.agent.name, selectedAgent!.team).then(() => setMsg(`rebuilding ${selectedAgent!.agent.name}…`)).catch(() => {})}>Rebuild</button>
                </span>
              </div>
              <div className="muted small" style={{ margin: '8px 0 4px' }}>goals &amp; instructions — appended to this agent’s system prompt</div>
              <div className="row-actions" style={{ gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <button className="btn small" disabled={instrBusy} onClick={() => setInstrText(COORDINATOR_PRESET)}>Coordinator preset</button>
                <button className="btn small" disabled={instrBusy} onClick={() => void aiDraftInstr()}>✦ AI draft</button>
                {instrText.trim() ? <button className="btn small" disabled={instrBusy} onClick={() => setInstrText('')}>Clear</button> : null}
                <span className="grow" />
                {instrMsg ? <span className={`small ${/failed/.test(instrMsg) ? 'status-error' : 'ok-text'}`}>{instrMsg}</span> : null}
                <button className="btn primary small" disabled={instrBusy || instrText === instrSaved} onClick={() => void saveInstr(selectedAgent!.team)}>{instrBusy ? '…' : 'Save & rebuild'}</button>
              </div>
              <textarea style={{ width: '100%', minHeight: 100, fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12 }}
                placeholder={`Goals / instructions for ${instrTarget} — type a brief and hit ✦ AI draft, or write your own.`}
                value={instrText} disabled={instrBusy} onChange={(e) => setInstrText(e.target.value)} />
            </div>
          ) : selectedKey?.startsWith('team:') ? (
            <div className="card" style={{ marginTop: 10, background: 'var(--bg-2)' }}>
              <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ margin: 0 }}>{activeTeam} <span className="muted small">· {store.agents.length} agents</span></h4>
                <span className="row-actions" style={{ gap: 6 }}>
                  <button className="btn small primary" onClick={() => setBuilderTeam(activeTeam)}>✦ Build / add agents</button>
                  <button className="btn small" onClick={() => setTab('route')}>⇄ Relay</button>
                </span>
              </div>
              <div className="row-actions" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="muted small">whole team:</span>
                <button className="btn small" disabled={teamOpBusy} title={`Start every agent in ${activeTeam}`} onClick={() => void runTeamOp(activeTeam, 'start')}>▶ Start all</button>
                <button className={`btn small${pendingTeamOp === 'stop' ? ' danger' : ''}`} disabled={teamOpBusy}
                  title={`Stop every agent in ${activeTeam}`}
                  onClick={() => (pendingTeamOp === 'stop' ? void runTeamOp(activeTeam, 'stop') : setPendingTeamOp('stop'))}>
                  {pendingTeamOp === 'stop' ? '⚠ confirm — stop all' : '■ Stop all'}
                </button>
                <button className="btn small" disabled={teamOpBusy} title={`Health-probe ${activeTeam}`} onClick={() => void runTeamOp(activeTeam, 'probe')}>◇ Probe</button>
                <button className={`btn small${pendingTeamOp === 'rebuild' ? ' danger' : ''}`} disabled={teamOpBusy}
                  title={`Rebuild (restart) every agent in ${activeTeam}`}
                  onClick={() => (pendingTeamOp === 'rebuild' ? void runTeamOp(activeTeam, 'rebuild') : setPendingTeamOp('rebuild'))}>
                  {pendingTeamOp === 'rebuild' ? '⚠ confirm — rebuild all' : '↻ Rebuild all'}
                </button>
                {teamOpBusy ? <span className="muted small">working…</span> : teamOpMsg ? <span className={`small ${/fail/.test(teamOpMsg) ? 'status-error' : 'ok-text'}`}>{teamOpMsg}</span> : null}
              </div>
              <p className="muted small" style={{ marginTop: 6 }}>Click an agent in the graph to edit its goals &amp; instructions. The team’s goals live on its lead (the ⭑ coordinator).</p>
            </div>
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>Select an agent or team in the graph to manage it.</p>
          )}
        </section>
      ) : null}

      {tab === 'structure' ? <AgentTable store={store} /> : null}

      {tab === 'manage' ? (
      <section className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>Team</th>
              <th>Agents</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {store.teams.map((t) => (
              <tr key={t.id} className={t.name === store.team ? 'sel' : ''}>
                <td className="b">{t.name === store.team ? '● ' : ''}{t.name}</td>
                <td className="muted">{t.agentCount}</td>
                <td>
                  {t.name !== store.team ? (
                    <button className="btn" disabled={busy} onClick={() => void store.setTeam(t.name)}>
                      Switch
                    </button>
                  ) : (
                    <span className="muted">active</span>
                  )}{' '}
                  <button className="btn" disabled={busy} title={`Open ${t.name}'s team actions (start/stop/probe/rebuild)`}
                    onClick={() => { setSelectedKey(`team:${t.name}`); if (t.name !== store.team) void store.setTeam(t.name); }}>
                    Manage
                  </button>
                  {t.name !== 'default' && Number(t.agentCount) === 0 ? (
                    <button className="btn" disabled={busy} style={{ marginLeft: 6, color: 'var(--danger, #e5534b)' }} title={`Delete the empty "${t.name}" team`} onClick={() => void removeTeam(t.name)}>
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      ) : null}

      {tab === 'build' ? (
      <section className="card">
        <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>Build &amp; add agents</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Create a team from a template, design a brand-new team with AI, or add agents to <b>{activeTeam}</b> — describe what you need and AI builds the roster (per-agent runtime, model &amp; skills).
            </p>
          </div>
          <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" disabled={busy} onClick={() => setCreateOpen(true)} title="Create a team from a library template or saved server config">+ From template</button>
            <button className="btn" disabled={busy} onClick={() => setBuilderTeam('')} title="Describe a brand-new team in plain English (or paste a spec) and let AI design + build the whole roster">✦ Build a team</button>
            <button className="btn primary" disabled={busy} onClick={() => setBuilderTeam(activeTeam)} title={`Add agents to ${activeTeam}`}>✦ Build / add agents</button>
          </div>
        </div>
      </section>
      ) : null}

      {tab === 'route' ? (
      <section className="card">
        <h3>Cross-team relay — {activeTeam}</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Which teams <b>{activeTeam}</b>'s agents may delegate to (relay work via <span className="mono">/ask &lt;team&gt;/&lt;agent&gt;</span>).
          Unset = permissive (any team).
        </p>
        <div className="relay-modes">
          {([
            ['permissive', 'Any team (default)'],
            ['all', 'All teams (*)'],
            ['select', 'Only selected teams'],
            ['none', 'Blocked (none)'],
          ] as [RelayMode, string][]).map(([m, label]) => (
            <label key={m} className={`relay-mode${mode === m ? ' active' : ''}`}>
              <input type="radio" name="relay-mode" checked={mode === m} onChange={() => pickMode(m)} /> {label}
            </label>
          ))}
        </div>
        {mode === 'select' ? (
          <div className="chips" style={{ marginTop: 10 }}>
            {otherTeams.length === 0 ? (
              <span className="muted small">No other teams to relay to yet.</span>
            ) : (
              otherTeams.map((n) => {
                const on = (delegates ?? []).includes(n);
                return (
                  <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleTeam(n)}>
                    {on ? '✓ ' : ''}{n}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <span className="muted small grow">
            saved: <span className="mono">{describeRelay(savedDelegates)}</span>
            {relayDirty ? <span className="warn-text" style={{ marginLeft: 8 }}>● unsaved changes</span> : null}
          </span>
          {relayMsg ? (
            <span className={`small${relayMsg.startsWith('failed') ? ' status-error' : ' ok-text'}`} style={{ marginRight: 10 }}>
              {relayMsg}
            </span>
          ) : null}
          <button className="btn primary" disabled={relayBusy || !relayDirty} onClick={() => void saveRelay()}>
            {relayBusy ? 'Saving…' : 'Save relay policy'}
          </button>
        </div>

        <h3 style={{ marginTop: 18 }}>Per-agent overrides</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Override the team policy for an individual agent — e.g. let one agent relay to other teams even when the team is restricted (or block a single agent). Applies immediately.
        </p>
        {store.agents.length === 0 ? (
          <p className="muted small">No agents in {activeTeam}.</p>
        ) : (
          agentsLeadFirst(store.agents, store.coordinator).map((a) => {
            const pol = (a.metadata as { delegates_to?: unknown })?.delegates_to;
            const m = agentEditing === a.id ? 'select' : modeOf(Array.isArray(pol) ? (pol as string[]) : null);
            const label =
              m === 'permissive' ? 'inherits team' : m === 'all' ? 'any team' : m === 'none' ? 'blocked' : Array.isArray(pol) ? pol.join(', ') : '';
            return (
              <div key={a.id} className="kv" style={{ gridTemplateColumns: '130px 1fr', gap: '4px 12px', marginBottom: 10 }}>
                <span className="b">{a.name}</span>
                <span>
                  <select className="cell-select" disabled={busy} value={m} onChange={(e) => pickAgentMode(a, e.target.value as RelayMode)}>
                    <option value="permissive">Inherit team</option>
                    <option value="all">Any team (*)</option>
                    <option value="select">Selected teams…</option>
                    <option value="none">Blocked (none)</option>
                  </select>
                  <span className="muted small" style={{ marginLeft: 8 }}>{label}</span>
                  {agentEditing === a.id ? (
                    <div className="chips" style={{ marginTop: 6 }}>
                      {otherTeams.length === 0 ? (
                        <span className="muted small">No other teams.</span>
                      ) : (
                        otherTeams.map((n) => {
                          const on = agentSel.includes(n);
                          return (
                            <button key={n} className={`chip${on ? ' on' : ''}`} onClick={() => toggleAgentTeam(n)}>
                              {on ? '✓ ' : ''}{n}
                            </button>
                          );
                        })
                      )}
                      <button className="btn" disabled={busy} onClick={() => { void applyAgent(a.id, agentSel, `${a.name} relay`); setAgentEditing(null); }}>
                        Save
                      </button>
                      <button className="btn" onClick={() => setAgentEditing(null)}>Cancel</button>
                    </div>
                  ) : null}
                </span>
                <span>team</span>
                <span>
                  <select
                    className="cell-select"
                    disabled={busy || otherTeams.length === 0}
                    value=""
                    title={otherTeams.length === 0 ? 'No other teams to move to' : `Reassign ${a.name} to another team (rebuilds it there)`}
                    onChange={(e) => { const to = e.target.value; e.currentTarget.value = ''; void moveAgentToTeam(a.id, a.name, to); }}
                  >
                    <option value="">{otherTeams.length === 0 ? 'no other teams' : 'reassign to…'}</option>
                    {otherTeams.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </span>
              </div>
            );
          })
        )}
      </section>
      ) : null}

      {tab === 'manage' ? (
      <section className="card">
        <h3>Agent instructions — coordination &amp; behavior</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          A persistent directive added to an agent’s system prompt. Use <b>Coordinator preset</b> on your <b>lead</b> so it <b>compresses</b> each request, <b>breaks it up</b>, <b>delegates</b> the pieces to its teammates (or another team’s lead), and <b>summarizes results step by step</b> — instead of doing everything itself. Survives rebuilds; takes effect after the rebuild this triggers.
        </p>
        <div className="row-actions" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span className="muted small">agent</span>
          <select className="cell-select" value={instrTarget} disabled={instrBusy} onChange={(e) => setInstrAgent(e.target.value)}>
            {store.agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
          <button className="btn small" disabled={instrBusy} onClick={() => setInstrText(COORDINATOR_PRESET)}>Coordinator preset</button>
          <button className="btn small" disabled={instrBusy} onClick={() => void aiDraftInstr()}>✦ AI draft</button>
          {instrText.trim() ? <button className="btn small" disabled={instrBusy} onClick={() => setInstrText('')}>Clear</button> : null}
          <span className="grow" />
          {instrMsg ? <span className={`small ${/failed/.test(instrMsg) ? 'status-error' : 'ok-text'}`}>{instrMsg}</span> : null}
          <button className="btn primary small" disabled={instrBusy || instrText === instrSaved} onClick={() => void saveInstr()}>{instrBusy ? '…' : 'Save & rebuild'}</button>
        </div>
        <textarea
          style={{ width: '100%', minHeight: 120, fontFamily: 'var(--mono, ui-monospace, monospace)', fontSize: 12 }}
          placeholder={`Custom instructions for ${instrTarget || 'this agent'} — or click “Coordinator preset”. Leave empty for none.`}
          value={instrText}
          disabled={instrBusy}
          onChange={(e) => setInstrText(e.target.value)}
        />
      </section>
      ) : null}

      {tab === 'route' ? (
      <section className="card">
        <h3>Lead hierarchy &amp; coordinators</h3>
        <p className="muted small" style={{ marginTop: -4 }}>
          Each team has a <b>coordinator</b> (its lead); one is the <b>primary</b> across teams — it delegates to each
          team's coordinator, which delegates to its workers. Pick a coordinator for any team, or promote one to primary.
        </p>
        <div className="kv" style={{ gridTemplateColumns: 'minmax(120px,1fr) 220px 120px', gap: '6px 12px', alignItems: 'center' }}>
          <span className="muted small">team</span>
          <span className="muted small">coordinator</span>
          <span className="muted small">primary lead</span>
          {store.teams.map((t) => {
            const ags = graphGroups.find((g) => g.team === t.name)?.agents ?? [];
            const coord = hier.coordinators[t.name] || (hier.primary?.team === t.name ? hier.primary.agent : '');
            const isPrimary = !!hier.primary && hier.primary.team === t.name;
            return (
              <Fragment key={t.id}>
                <span className="b">{isPrimary ? '⭑ ' : ''}{t.name} <span className="muted small">· {ags.length}</span></span>
                <select className="cell-select" disabled={busy || ags.length === 0} value={ags.some((a) => a.name === coord) ? coord : ''}
                  onChange={(e) => void setTeamCoordinator(t.name, e.target.value)}>
                  <option value="">{ags.length ? 'no coordinator — choose…' : 'no agents'}</option>
                  {ags.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
                {isPrimary ? (
                  <span className="ok-text small">⭑ primary</span>
                ) : (
                  <button className="btn small" disabled={busy || !coord}
                    title={coord ? `Make ${t.name}/${coord} the primary cross-team lead` : 'Set a coordinator first'}
                    onClick={() => void makePrimaryFor(t.name, coord)}>make primary</button>
                )}
              </Fragment>
            );
          })}
        </div>
        {!hier.primary ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            No primary lead yet — promote one team's coordinator to delegate across teams (via <code>/ask &lt;team&gt;/&lt;agent&gt;</code>).
          </p>
        ) : null}
      </section>
      ) : null}

      {msg ? <p className="muted">{msg}</p> : null}
    </div>
  );
}

function CreateTeamModal({
  existingTeams,
  onClose,
  onBusy,
  onMessage,
  onCreated,
}: {
  existingTeams: string[];
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onMessage: (msg: string) => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [source, setSource] = useState<TeamSource>({ kind: 'default', name: 'default' });
  const [name, setName] = useState('');
  const [loadingSources, setLoadingSources] = useState(true);
  const [preflight, setPreflight] = useState<DeployPreflight | null>(null);
  const [preflightStatus, setPreflightStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const clean = cleanTeamName(name);
  const collides = Boolean(clean && existingTeams.includes(clean));
  const canCreate = Boolean(clean) && !running;

  useEffect(() => {
    let alive = true;
    setLoadingSources(true);
    Promise.all([
      call<TeamTemplate[]>('libraryTeams').catch(() => [] as TeamTemplate[]),
      call<ConfigEntry[]>('configs').catch(() => [] as ConfigEntry[]),
    ]).then(([teamTemplates, serverConfigs]) => {
      if (!alive) return;
      setTemplates(teamTemplates);
      setConfigs(serverConfigs.filter((cfg) => cfg.name !== 'default'));
    }).finally(() => {
      if (alive) setLoadingSources(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!clean) {
      setPreflight(null);
      setPreflightStatus('');
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setPreflightStatus('checking preflight...');
      setPreflight(null);
      call<DeployPreflight | undefined>('team:preflight', clean)
        .then((pf) => {
          if (!alive) return;
          setPreflight(pf ?? null);
          setPreflightStatus(pf ? '' : 'preflight unavailable');
        })
        .catch(() => {
          if (!alive) return;
          setPreflight(null);
          setPreflightStatus('preflight unavailable');
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [clean, source.kind, source.name]);

  function pickSource(next: TeamSource) {
    setSource(next);
    setError('');
    if (next.kind === 'config') setName(next.name);
  }

  async function create() {
    if (!clean) {
      setError('Team name is required.');
      return;
    }
    setRunning(true);
    onBusy(true);
    setError('');
    onMessage(source.kind === 'template' ? `installing ${source.name} as ${clean}...` : `creating ${clean}...`);
    try {
      if (source.kind === 'template') {
        await call('team:install', source.name, clean);
        onMessage(`deploying ${clean} from ${source.name}...`);
      } else {
        onMessage(source.kind === 'config' ? `deploying ${clean} from server config...` : `deploying ${clean} from default template...`);
      }
      await call('deployTeam', clean);
      await onCreated(clean);
      onMessage(`created ${clean} ✓`);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onMessage(`failed: ${msg}`);
    } finally {
      setRunning(false);
      onBusy(false);
    }
  }

  const selectedTemplate = source.kind === 'template' ? templates.find((t) => t.name === source.name) : undefined;
  const selectedConfig = source.kind === 'config' ? configs.find((c) => c.name === source.name) : undefined;

  return (
    <div className="modal-overlay" onMouseDown={() => (running ? undefined : onClose())}>
      <div className="modal onboard-modal create-team-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Create team</div>
        <div className="create-team-layout">
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>source</div>
            <div className="source-list">
              <button className={`source-option${source.kind === 'default' ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'default', name: 'default' })}>
                <b>Default template</b>
                <span>Fresh team from the manager default config.</span>
              </button>
              {templates.map((t) => (
                <button key={t.name} className={`source-option${source.kind === 'template' && source.name === t.name ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'template', name: t.name })}>
                  <b>{t.name}</b>
                  <span>{describeTemplate(t)}</span>
                </button>
              ))}
              {configs.map((c) => (
                <button key={c.name} className={`source-option${source.kind === 'config' && source.name === c.name ? ' active' : ''}`} disabled={running} onClick={() => pickSource({ kind: 'config', name: c.name })}>
                  <b>{c.name}</b>
                  <span>{describeConfig(c)}</span>
                </button>
              ))}
              {!loadingSources && templates.length === 0 ? <p className="muted small">No library team templates available; default creation is available.</p> : null}
              {loadingSources ? <p className="muted small">Loading templates...</p> : null}
            </div>
          </div>
          <div>
            <label className="create-field">
              <span>team name</span>
              <input
                autoFocus
                placeholder="lowercase, e.g. research"
                value={name}
                disabled={running}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                onBlur={() => setName(cleanTeamName(name))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) void create();
                  else if (e.key === 'Escape' && !running) onClose();
                }}
              />
            </label>
            {name && name !== clean ? <p className="muted small">Will create as <span className="mono">{clean}</span>.</p> : null}
            {collides ? <p className="warn-text small">A team named <span className="mono">{clean}</span> already exists; deploy may recreate or overwrite it.</p> : null}
            {source.kind === 'template' && selectedTemplate ? <p className="muted small">Template: {describeTemplate(selectedTemplate)}</p> : null}
            {source.kind === 'config' && selectedConfig ? <p className="muted small">Server config: {describeConfig(selectedConfig)}</p> : null}
            <div className="preflight-box">
              <div className="row-actions" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <b>Preflight</b>
                {preflightStatus ? <span className="muted small">{preflightStatus}</span> : null}
              </div>
              {preflight?.agents?.length ? (
                <div className="preflight-agents">
                  {preflight.agents.map((agent) => (
                    <div key={agent.name} className="preflight-agent">
                      <span className="b">{agent.name}</span>
                      <span className="muted small">{agent.runtime || 'default runtime'}{agent.model ? ` · ${agent.model}` : ''}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">
                  {clean ? 'Preview will appear when the manager supports deploy dry-run.' : 'Enter a team name to preview created agents.'}
                </p>
              )}
              {preflight?.configPath ? <p className="muted small mono">{preflight.configPath}</p> : null}
            </div>
            {error ? <p className="status-error small">{error}</p> : null}
          </div>
        </div>
        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={running} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!canCreate} onClick={() => void create()}>
            {running ? 'Creating...' : 'Create team'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The unified AI Team Builder — one flow that replaces the old "Import from spec"
 * and "Onboard agents" modals. Describe a team in plain English (or paste a spec),
 * let AI (or a deterministic parse) draft the roster with a per-agent runtime,
 * model and skills, review/edit it, then build every agent in one pass via
 * `onboard:run` (which carries each agent's persona). After the agents land it can
 * auto-wire coordination (make the ★ lead the primary coordinator + apply the
 * delegate-to-teammates preset) and the new team's cross-team relay policy.
 */
function TeamBuilder({
  team,
  existingTeams,
  providers,
  modelCatalog,
  skillCatalog,
  onClose,
  onBusy,
  onMessage,
  onDone,
}: {
  team: string;
  existingTeams: string[];
  providers: ProviderRow[];
  modelCatalog: Record<string, string[]>;
  skillCatalog: string[];
  onClose: () => void;
  onBusy: (b: boolean) => void;
  onMessage: (m: string) => void;
  onDone: (createdTeam?: string) => void;
}) {
  const runtimes = useMemo(() => offerableRuntimes(providers), [providers]);
  const initialRuntime = runtimes[0] ?? 'claude-code-cli';
  type Row = { name: string; runtime: string; model: string; role: string; description: string; skills: string[]; lead: boolean; open: boolean };
  const blankRow = (): Row => ({ name: '', runtime: initialRuntime, model: '', role: '', description: '', skills: [], lead: false, open: false });
  // Map a parsed/AI-designed agent onto a builder row, sanitizing the AI's runtime/
  // model/skill picks against what's actually available.
  const toRow = (a: { name: string; role: string; description: string; runtime?: string; model?: string; skills?: string[]; lead?: boolean }): Row => {
    const runtime = a.runtime && runtimes.includes(a.runtime) ? a.runtime : initialRuntime;
    return {
      name: a.name,
      runtime,
      model: a.model && (modelCatalog[runtime] ?? []).includes(a.model) ? a.model : '',
      role: a.role,
      description: a.description,
      skills: (a.skills ?? []).filter((s) => skillCatalog.includes(s)),
      lead: Boolean(a.lead),
      open: false,
    };
  };

  // ---- target team (existing or new) ----
  const teamOptions = useMemo(() => existingTeams.filter(Boolean), [existingTeams]);
  const [teamSel, setTeamSel] = useState<string>(team && existingTeams.includes(team) ? team : '__new__');
  const [newTeam, setNewTeam] = useState(team && !existingTeams.includes(team) ? cleanTeamName(team) : '');
  const [teamTouched, setTeamTouched] = useState(false);
  const usingNewTeam = teamSel === '__new__';
  const targetTeam = usingNewTeam ? cleanTeamName(newTeam) : teamSel;
  const teamExists = existingTeams.includes(targetTeam);

  // ---- spec / AI design ----
  const [spec, setSpec] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  // Once the roster is hand-edited or AI-designed, stop letting the live spec parse
  // overwrite it (so manual curation isn't silently discarded mid-edit).
  const [rowsDirty, setRowsDirty] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0); // seconds the AI design call has been running
  const aiRun = useRef(0); // bumps to invalidate a stale/cancelled design wait

  // ---- options applied to every agent ----
  const [mcp, setMcp] = useState('');
  const [heartbeat, setHeartbeat] = useState(false);
  const [hbInterval, setHbInterval] = useState(3600);
  const [wallet, setWallet] = useState(false);
  const [probeAfter, setProbeAfter] = useState(true);

  // ---- coordination + relay ----
  const [coordinate, setCoordinate] = useState(true);
  const [relayMode, setRelayMode] = useState<RelayMode>('permissive');
  const [relaySel, setRelaySel] = useState<string[]>([]);
  const relayTargets = existingTeams.filter((n) => n !== targetTeam);

  // ---- build progress ----
  type ResultEntry = { name: string; team: string; plan: OnboardPlan; result?: OnboardResult; error?: string; running?: boolean };
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [post, setPost] = useState<{ coord?: PostStat; coordErr?: string; leadName?: string; relay?: PostStat; relayErr?: string }>({});

  const mcpChoices = MCP_CATALOG.filter((entry) => !(entry.inputs ?? []).some((input) => input.required && !input.default));
  const named = rows.map((r) => ({ ...r, slug: slugName(r.name) })).filter((r) => r.slug);
  const reserved = [...new Set(named.filter((r) => isReservedName(r.slug)).map((r) => r.slug))];
  const dupes = [...new Set(named.map((r) => r.slug).filter((s, i, a) => a.indexOf(s) !== i))];
  const locked = building || aiBusy;
  const canBuild = !locked && Boolean(targetTeam) && !isReservedName(targetTeam) && named.length > 0 && reserved.length === 0 && dupes.length === 0;

  // Live deterministic parse as the user types a spec — until they hand-edit or AI runs.
  useEffect(() => {
    if (rowsDirty) return;
    if (!spec.trim()) { setRows([blankRow()]); return; }
    const parsed = parseTeamSpec(spec);
    setRows(parsed.agents.length ? parsed.agents.map(toRow) : [blankRow()]);
    // Only adopt the spec's team name when we're building a NEW team — never
    // hijack an "add agents to <existing team>" session.
    if (parsed.team && !teamTouched && teamSel === '__new__') setNewTeam((p) => p || parsed.team || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  // Tick an elapsed counter while the AI design call is in flight (progress feedback).
  useEffect(() => {
    if (!aiBusy) return;
    const t = setInterval(() => setAiElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [aiBusy]);

  async function aiDesign() {
    if (!spec.trim()) return;
    const runId = ++aiRun.current;
    setAiElapsed(0); setAiBusy(true); setError('');
    onMessage('asking AI to design the team…');
    try {
      const r = await call<DesignedTeam>('team:designAI', spec, { runtimes, models: modelCatalog, skills: skillCatalog });
      if (aiRun.current !== runId) return; // stopped or superseded — ignore the late reply
      if (r?.agents?.length) {
        const mapped = r.agents.map(toRow);
        if (!mapped.some((m) => m.lead)) mapped[0].lead = true;
        setRows(mapped); setRowsDirty(true);
      }
      if (r?.team && !teamTouched && teamSel === '__new__') setNewTeam((p) => p || r.team || '');
      onMessage(`AI designed ${r?.agents?.length ?? 0} agent(s)`);
    } catch (e) {
      if (aiRun.current === runId) setError(`AI design failed: ${e instanceof Error ? e.message : String(e)} — keeping the current roster.`);
    } finally { if (aiRun.current === runId) setAiBusy(false); }
  }
  // Soft-cancel: stop blocking the UI on a slow design. The agent query may still
  // finish server-side, but its now-stale reply is ignored (guarded by aiRun).
  function stopAi() {
    aiRun.current++;
    setAiBusy(false);
    onMessage('stopped waiting for the AI design (it may still finish on the agent).');
  }

  function updateRow(i: number, patch: Partial<Row>) { setRowsDirty(true); setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }
  function addRow() { setRowsDirty(true); setRows((rs) => [...rs, blankRow()]); }
  function removeRow(i: number) { setRowsDirty(true); setRows((rs) => (rs.length <= 1 ? rs : rs.filter((_, j) => j !== i))); }
  function setLead(i: number) { setRowsDirty(true); setRows((rs) => rs.map((r, j) => ({ ...r, lead: j === i }))); }
  function toggleRowSkill(i: number, name: string) {
    setRowsDirty(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, skills: r.skills.includes(name) ? r.skills.filter((x) => x !== name) : [...r.skills, name] } : r)));
  }
  function pickTeam(v: string) { setTeamTouched(true); setTeamSel(v); }

  const relayPayload: string[] | null =
    relayMode === 'all' ? ['*'] : relayMode === 'none' ? [] : relayMode === 'select' ? relaySel : null;

  function planFor(r: Row): OnboardPlan {
    return {
      name: slugName(r.name),
      team: targetTeam,
      runtime: r.runtime || undefined,
      model: r.model || undefined,
      role: r.role.trim() || undefined,
      description: r.description.trim() || undefined,
      skills: r.skills.length ? r.skills : undefined,
      wallet,
      heartbeatSeconds: heartbeat ? hbInterval : undefined,
      mcpServers: mcpFromChoice(mcp),
      probeAfter,
    };
  }

  async function build() {
    if (!targetTeam) { setError('Choose or name a team.'); return; }
    if (isReservedName(targetTeam)) { setError(`“${targetTeam}” is a reserved word — choose another team name.`); return; }
    if (reserved.length) { setError(`Reserved agent name(s): ${reserved.join(', ')} — rename.`); return; }
    if (dupes.length) { setError(`Duplicate agent name(s): ${dupes.join(', ')}.`); return; }
    const batch = named;
    if (!batch.length) { setError('Add at least one named agent.'); return; }
    setBuilding(true); onBusy(true); setError(''); setPost({});
    onMessage(`building ${batch.length} agent(s) into ${targetTeam}…`);
    // Freeze a plan per agent so a later "retry" re-runs the exact same spec.
    const plans = batch.map(planFor);
    setResults(batch.map((r, i) => ({ name: r.slug, team: targetTeam, plan: plans[i] })));
    let anyOk = false;
    // Sequential — the manager serializes local-model spawns anyway, and it keeps
    // the per-agent status readable as each one lands.
    for (let i = 0; i < batch.length; i++) {
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: true } : x)));
      try {
        const res = await call<OnboardResult>('onboard:run', plans[i]);
        if (res.ok) anyOk = true;
        setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, result: res } : x)));
      } catch (err) {
        setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, error: err instanceof Error ? err.message : String(err) } : x)));
      }
    }
    // Auto-coordination: promote the ★ lead to primary coordinator + apply the preset.
    const leadRow = batch.find((r) => r.lead) ?? batch[0];
    if (anyOk && coordinate && leadRow) {
      const leadName = leadRow.slug;
      // Tell the lead to delegate to the teammates that were ACTUALLY created.
      const teammates = batch.filter((r) => r.slug !== leadName).map((r) => ({ name: r.slug, role: r.role.trim() }));
      const preset = coordinatorPresetFor(teammates);
      setPost((p) => ({ ...p, coord: 'running', leadName }));
      try {
        await call('coordinator:setPrimary', targetTeam, leadName);
        await call('agent:setInstructions', leadName, preset, targetTeam);
        await call('rebuildAgent', leadName, targetTeam).catch(() => {});
        setPost((p) => ({ ...p, coord: 'ok', leadName }));
      } catch (e) { setPost((p) => ({ ...p, coord: 'failed', coordErr: e instanceof Error ? e.message : String(e) })); }
    }
    // Cross-team relay policy — only when the user changed it away from permissive.
    if (anyOk && relayMode !== 'permissive') {
      setPost((p) => ({ ...p, relay: 'running' }));
      try {
        await call('setTeamDelegates', targetTeam, relayPayload);
        setPost((p) => ({ ...p, relay: 'ok' }));
      } catch (e) { setPost((p) => ({ ...p, relay: 'failed', relayErr: e instanceof Error ? e.message : String(e) })); }
    }
    setBuilding(false); onBusy(false);
    if (anyOk) { onMessage(`built into ${targetTeam} ✓`); onDone(targetTeam); }
    else onMessage(`build failed — no agents created in ${targetTeam}`);
  }

  // Re-run one agent that failed. If it spawned but a later step failed, retry just
  // those steps (onboard:run retry mode); otherwise re-onboard the agent from scratch.
  async function runRetry(i: number, entry: ResultEntry) {
    if (entry.running) return;
    const failedKeys = (entry.result?.steps ?? []).filter((s) => s.status === 'failed').map((s) => s.key);
    const retry = entry.result?.agentId && failedKeys.length ? { agentId: entry.result.agentId, stepKeys: failedKeys } : undefined;
    setBuilding(true); onBusy(true);
    setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: true, error: undefined } : x)));
    try {
      const res = await call<OnboardResult>('onboard:run', { ...entry.plan, retry });
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, result: res, error: undefined } : x)));
      if (res.ok) onDone(targetTeam);
    } catch (err) {
      setResults((rs) => rs.map((x, j) => (j === i ? { ...x, running: false, error: err instanceof Error ? err.message : String(err) } : x)));
    } finally { setBuilding(false); onBusy(false); }
  }
  const isFailed = (e: ResultEntry) => !e.running && (Boolean(e.error) || Boolean(e.result?.steps.some((s) => s.status === 'failed')));
  async function retryFailed() {
    // Snapshot the failed entries now (their plans are stable) and retry sequentially.
    for (const { e, i } of results.map((e, i) => ({ e, i })).filter(({ e }) => isFailed(e))) await runRetry(i, e);
  }
  const failedCount = results.filter(isFailed).length;

  const postMark = (s?: PostStat) => (s === 'ok' ? '✓' : s === 'failed' ? '✗' : '…');
  const postCls = (s?: PostStat) => (s === 'ok' ? 'ok' : s === 'failed' ? 'failed' : 'running');

  return (
    <div className="modal-overlay" onMouseDown={() => (locked ? undefined : onClose())}>
      <div className="modal onboard-modal create-team-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Build a team</div>
        <div className="create-team-layout">
          {/* LEFT: describe + batch options + coordination/relay */}
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>describe the team you want — or paste a spec</div>
            <textarea
              autoFocus
              style={{ width: '100%', minHeight: 150, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
              placeholder={'e.g. A team to build and maintain our Next.js app — a lead coordinator, a coder for implementation, and a researcher for docs & investigation.'}
              value={spec}
              disabled={locked}
              onChange={(e) => { setSpec(e.target.value); setError(''); }}
            />
            <div className="row-actions" style={{ marginTop: 6, justifyContent: 'space-between', alignItems: 'center' }}>
              <span>
                <button className="btn small" disabled={!spec.trim() || locked} onClick={() => void aiDesign()}>
                  {aiBusy ? `Designing… ${aiElapsed}s` : '✦ Build with AI'}
                </button>
                {aiBusy ? <button className="btn small" style={{ marginLeft: 6 }} onClick={stopAi}>Stop</button> : null}
              </span>
              <span className="muted small">{named.length} agent{named.length === 1 ? '' : 's'}</span>
            </div>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>applied to every agent</div>
            <div className="kv" style={{ gridTemplateColumns: '90px 1fr', gap: '8px 10px', alignItems: 'center' }}>
              <span>MCP</span>
              <select className="cell-select" disabled={locked} value={mcp} onChange={(e) => setMcp(e.target.value)} style={{ maxWidth: 260 }}>
                <option value="">none</option>
                {mcpChoices.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
              </select>
              <span>heartbeat</span>
              <span>
                <input type="checkbox" checked={heartbeat} disabled={locked} onChange={(e) => setHeartbeat(e.target.checked)} />{' '}
                <select className="cell-select" disabled={locked || !heartbeat} value={hbInterval} onChange={(e) => setHbInterval(Number(e.target.value))}>
                  {HB_INTERVALS.map((iv) => <option key={iv.s} value={iv.s}>{iv.label}</option>)}
                </select>
              </span>
              <span />
              <span className="muted small">
                <label><input type="checkbox" checked={wallet} disabled={locked} onChange={(e) => setWallet(e.target.checked)} /> OWS wallet</label>
                <label style={{ marginLeft: 14 }}><input type="checkbox" checked={probeAfter} disabled={locked} onChange={(e) => setProbeAfter(e.target.checked)} /> probe after</label>
              </span>
            </div>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>coordination</div>
            <label className="muted small" style={{ display: 'block' }}>
              <input type="checkbox" checked={coordinate} disabled={locked} onChange={(e) => setCoordinate(e.target.checked)} />{' '}
              Make the ★ lead the primary coordinator and apply the delegate-to-teammates preset
            </label>

            <div className="muted small" style={{ margin: '14px 0 4px' }}>cross-team relay for <span className="mono">{targetTeam || '…'}</span></div>
            <div className="relay-modes">
              {([
                ['permissive', 'Any team'],
                ['all', 'All (*)'],
                ['select', 'Selected'],
                ['none', 'None'],
              ] as [RelayMode, string][]).map(([m, label]) => (
                <label key={m} className={`relay-mode${relayMode === m ? ' active' : ''}`}>
                  <input type="radio" name="builder-relay" checked={relayMode === m} disabled={locked} onChange={() => setRelayMode(m)} /> {label}
                </label>
              ))}
            </div>
            {relayMode === 'select' ? (
              <div className="chips" style={{ marginTop: 8 }}>
                {relayTargets.length === 0 ? <span className="muted small">No other teams.</span> :
                  relayTargets.map((n) => {
                    const on = relaySel.includes(n);
                    return (
                      <button key={n} className={`chip${on ? ' on' : ''}`} disabled={locked} onClick={() => setRelaySel((s) => s.includes(n) ? s.filter((x) => x !== n) : [...s, n])}>
                        {on ? '✓ ' : ''}{n}
                      </button>
                    );
                  })}
              </div>
            ) : null}
          </div>

          {/* RIGHT: target team + editable roster */}
          <div>
            <div className="kv" style={{ gridTemplateColumns: '70px 1fr', gap: '8px 10px', alignItems: 'center' }}>
              <span>team</span>
              <span>
                <select className="cell-select" disabled={locked} value={teamSel} onChange={(e) => pickTeam(e.target.value)}>
                  {teamOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                  <option value="__new__">＋ new team…</option>
                </select>
                {usingNewTeam ? (
                  <input
                    style={{ marginLeft: 8, width: 180 }}
                    placeholder="new team name"
                    value={newTeam}
                    disabled={locked}
                    onChange={(e) => { setTeamTouched(true); setNewTeam(e.target.value); }}
                    onBlur={() => setNewTeam(cleanTeamName(newTeam))}
                  />
                ) : null}
              </span>
            </div>
            {usingNewTeam && newTeam && targetTeam !== newTeam ? <p className="muted small">Will create as <span className="mono">{targetTeam}</span>.</p> : null}
            {usingNewTeam && isReservedName(targetTeam) ? <p className="status-error small"><span className="mono">{targetTeam}</span> is a reserved word — choose another team name.</p> : null}
            {usingNewTeam && teamExists ? <p className="warn-text small">Team <span className="mono">{targetTeam}</span> exists — these agents will be added to it.</p> : null}

            <div className="row-actions" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 6px' }}>
              <span className="muted small">roster — ★ marks the lead; ▸ for persona &amp; skills</span>
              <button className="btn small" disabled={locked} onClick={addRow}>＋ add agent</button>
            </div>
            <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((r, i) => {
                const rowReserved = isReservedName(slugName(r.name));
                return (
                  <div key={i} style={{ border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: '6px 6px 8px' }}>
                    <div className="kv" style={{ gridTemplateColumns: '26px 1.2fr 1fr 1fr 24px 24px', gap: 6, alignItems: 'center' }}>
                      <button className={`chip${r.lead ? ' on' : ''}`} title={r.lead ? 'lead' : 'make lead'} disabled={locked} onClick={() => setLead(i)} style={{ padding: '2px 6px' }}>★</button>
                      <input
                        className="mono"
                        style={{ fontSize: 12, ...(rowReserved ? { borderColor: 'var(--danger, #e5484d)' } : {}) }}
                        placeholder="name"
                        value={r.name}
                        disabled={locked}
                        title={rowReserved ? 'reserved word — rename' : undefined}
                        onChange={(e) => updateRow(i, { name: e.target.value })}
                        onBlur={(e) => updateRow(i, { name: slugName(e.target.value) })}
                      />
                      <select className="cell-select" style={{ fontSize: 12 }} disabled={locked} value={r.runtime} onChange={(e) => updateRow(i, { runtime: e.target.value, model: '' })}>
                        {runtimes.map((rt) => <option key={rt} value={rt}>{runtimeLabel(rt)}</option>)}
                      </select>
                      <select className="cell-select" style={{ fontSize: 12 }} disabled={locked} value={r.model} onChange={(e) => updateRow(i, { model: e.target.value })}>
                        <option value="">(default model)</option>
                        {(modelCatalog[r.runtime] ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <button className="uv-x" title={r.open ? 'collapse' : 'persona & skills'} disabled={locked} onClick={() => updateRow(i, { open: !r.open })}>{r.open ? '▾' : '▸'}</button>
                      <button className="uv-x" title="Remove" disabled={locked || rows.length <= 1} onClick={() => removeRow(i)}>✕</button>
                    </div>
                    <input style={{ fontSize: 12, width: '100%', marginTop: 4 }} placeholder="role (one line)" value={r.role} disabled={locked} maxLength={200} onChange={(e) => updateRow(i, { role: e.target.value })} />
                    {r.open ? (
                      <>
                        <textarea
                          style={{ width: '100%', marginTop: 4, fontSize: 11, minHeight: 46, fontFamily: 'inherit', resize: 'vertical' }}
                          placeholder="description / persona — becomes this agent’s operating instructions"
                          value={r.description}
                          disabled={locked}
                          maxLength={2000}
                          onChange={(e) => updateRow(i, { description: e.target.value })}
                        />
                        <div className="chips" style={{ marginTop: 4 }}>
                          {skillCatalog.length === 0 ? <span className="muted small">no library skills</span> :
                            skillCatalog.map((s) => (
                              <button key={s} className={`chip${r.skills.includes(s) ? ' on' : ''}`} disabled={locked} onClick={() => toggleRowSkill(i, s)}>
                                {r.skills.includes(s) ? '✓ ' : ''}{s}
                              </button>
                            ))}
                        </div>
                      </>
                    ) : (r.skills.length || r.description.trim()) ? (
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {r.skills.length ? `skills: ${r.skills.join(', ')}` : ''}
                        {r.skills.length && r.description.trim() ? ' · ' : ''}
                        {r.description.trim() ? 'persona set' : ''}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {reserved.length ? <p className="status-error small">Reserved name(s): <span className="mono">{reserved.join(', ')}</span> — rename.</p> : null}
            {dupes.length ? <p className="status-error small">Duplicate name(s): <span className="mono">{dupes.join(', ')}</span>.</p> : null}
            {error ? <p className="status-error small">{error}</p> : null}
          </div>
        </div>

        {results.length ? (
          <div className="onboard-checklist" style={{ marginTop: 12 }}>
            {results.map((r, i) => {
              const failed = Boolean(r.error) || Boolean(r.result?.steps.some((s) => s.status === 'failed'));
              const mark = r.running ? '…' : r.error ? '✗' : r.result?.ok ? '✓' : failed ? '!' : '·';
              const detail = r.error ? r.error
                : r.result ? (r.result.ok ? `built into ${r.team}` : (r.result.steps.filter((s) => s.status === 'failed').map((s) => `${s.label}: ${s.error || 'failed'}`).join('; ') || 'finished with issues'))
                : (r.running ? 'building…' : 'queued');
              const cls = r.error || failed ? 'failed' : r.result?.ok ? 'ok' : r.running ? 'running' : 'pending';
              return (
                <div key={r.name} className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr) auto' }}>
                  <span className={`step-dot ${cls}`}>{mark}</span>
                  <span className="step-label mono">{r.name}</span>
                  <span className={`small ${r.error || failed ? 'status-error' : 'muted'}`}>{detail}</span>
                  {failed ? (
                    <button className="btn small" disabled={building} title="Retry this agent" onClick={() => void runRetry(i, r)}>↻ retry</button>
                  ) : <span />}
                </div>
              );
            })}
            {post.coord ? (
              <div className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr)' }}>
                <span className={`step-dot ${postCls(post.coord)}`}>{postMark(post.coord)}</span>
                <span className="step-label mono">coordinator</span>
                <span className={`small ${post.coord === 'failed' ? 'status-error' : 'muted'}`}>{post.coord === 'failed' ? post.coordErr : `${post.leadName ?? 'lead'} → primary coordinator + preset`}</span>
              </div>
            ) : null}
            {post.relay ? (
              <div className="onboard-step" style={{ gridTemplateColumns: '26px minmax(140px, 1fr) minmax(0, 2fr)' }}>
                <span className={`step-dot ${postCls(post.relay)}`}>{postMark(post.relay)}</span>
                <span className="step-label mono">relay</span>
                <span className={`small ${post.relay === 'failed' ? 'status-error' : 'muted'}`}>{post.relay === 'failed' ? post.relayErr : describeRelay(relayPayload)}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="row-actions" style={{ marginTop: 14 }}>
          <button className="btn" disabled={building} onClick={onClose}>Close</button>
          {failedCount > 0 ? (
            <button className="btn" disabled={building} onClick={() => void retryFailed()}>↻ Retry failed ({failedCount})</button>
          ) : null}
          <button className="btn primary" disabled={!canBuild} onClick={() => void build()}>
            {building ? 'Building…'
              : teamExists ? `Add ${named.length} agent${named.length === 1 ? '' : 's'} to ${targetTeam || '…'}`
              : `Build ${targetTeam || 'team'} + ${named.length} agent${named.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function cleanTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function countAgents(agents?: number | unknown[]): number | undefined {
  return typeof agents === 'number' ? agents : Array.isArray(agents) ? agents.length : undefined;
}

function describeTemplate(template: TeamTemplate): string {
  const count = countAgents(template.agents);
  return template.description ?? `library template${count != null ? ` · ${count} agents` : ''}`;
}

function describeConfig(config: ConfigEntry): string {
  const count = countAgents(config.agents);
  return `${config.description ?? 'server config'}${count != null ? ` · ${count} agents` : ''}`;
}

function mcpFromChoice(id: string): McpServerSpec[] | undefined {
  if (!id) return undefined;
  const entry = MCP_CATALOG.find((item) => item.id === id);
  if (!entry || entry.inputs?.some((input) => input.required && !input.default)) return undefined;
  const profile = buildFromCatalog(entry, entry.id, {});
  const { enabled: _enabled, ...server } = profile;
  return [server];
}

