import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { Agent } from '../../../../idctl/src/api/types.ts';

/**
 * Computer Use (Phase 1): watch your Mac live, and let a blessed Claude/codex
 * agent SEE your screen and DRIVE the mouse + keyboard. Everything routes through
 * the in-app broker, which only acts while ARMED — the single switch that turns
 * the whole capability on and off — and only for agents you've blessed.
 */

type PermissionState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
type PermissionTone = 'ok' | 'warn' | 'bad';
interface Perms {
  screenRecording: PermissionState;
  accessibility: boolean;
  inputMonitoring: PermissionState;
  automation: { status: PermissionState; targets: string[] };
  tcc: { readable: boolean; error?: string };
  platform: string;
}
interface PendingAction { id: string; agent: string; action: string; preview: string; ts: number; expiresAt: number }
interface Status { armed: boolean; watching: boolean; port: number; url: string; lastAgent: string; actions: number; serverStaged: boolean; captureFailing: boolean; blessed: string[]; driverOk: boolean; accessibility: boolean; supervised: boolean; paused: boolean; pending: PendingAction[]; panicHotkey: boolean; available?: boolean; unavailableReason?: string }
interface FrameMsg { jpegBase64: string; width: number; height: number; ts: number; display?: { bounds: { width: number; height: number } } }
interface AuditEntry { ts: number; agent: string; action: string; detail: string; decision: 'executed' | 'blocked'; reason?: string }
type AttachedAgent = { id: string; name: string; team?: string; authority?: string };
type ComputerUseTarget = Agent & { team?: string };
type TeamAgentsGroup = { team: string; agents: Agent[] };
interface LegacyComputerUseAuthority { agent: string; currentAuthorities: string[]; tokenCount: number; source: string; note: string }
interface ManualPermissionReview { inputMonitoring?: boolean; automation?: boolean; updatedAt?: number }
type ComputerUseEventApi = {
  onComputerFrame?: (cb: (frame: unknown) => void) => () => void;
  onComputerPending?: (cb: (evt: unknown) => void) => () => void;
  onComputerPanic?: (cb: (evt: unknown) => void) => () => void;
};

const ACT_ICON: Record<string, string> = { screenshot: '📷', mouse_move: '➜', left_click: '🖱', right_click: '🖱', middle_click: '🖱', double_click: '🖱', left_click_drag: '✣', type: '⌨', key: '⌨', scroll: '↕' };
const MANUAL_PERMISSION_KEY = 'idacc.cu.manual-permissions.v1';

function agentRuntime(a: { runtime?: string; metadata?: { runtime?: string } }): string {
  return a.runtime ?? a.metadata?.runtime ?? '';
}
function mcpCapable(rt: string): boolean { return /claude|codex/i.test(rt); }
function sortedKey(values: string[]): string {
  return [...new Set(values.map(String).filter(Boolean))].sort().join('|');
}
function mcpKey(a: { metadata?: unknown }): string {
  const servers = (((a.metadata as any)?.mcpServers ?? []) as Record<string, unknown>[])
    .map((s) => JSON.stringify({ name: s.name, transport: s.transport, command: s.command, args: s.args ?? [], url: s.url ?? '', env: s.env ?? {}, headers: s.headers ?? {} }))
    .sort();
  return servers.join('|');
}
function computerUseAgentStamp(a: ComputerUseTarget, fallbackTeam: string): string {
  return JSON.stringify({
    id: a.id,
    name: a.name,
    team: a.team ?? fallbackTeam,
    runtime: agentRuntime(a) ?? '',
    status: a.status ?? '',
    health: a.health ?? '',
    mcp: mcpKey(a),
  });
}
function pendingStamp(p: PendingAction): string {
  return JSON.stringify({ id: p.id, agent: p.agent, action: p.action, preview: p.preview, ts: p.ts, expiresAt: p.expiresAt });
}
function permissionText(status: PermissionState | undefined): string {
  switch (status) {
    case 'granted': return 'Granted';
    case 'denied': return 'Denied';
    case 'restricted': return 'Restricted by macOS policy';
    case 'not-determined': return 'Not granted yet';
    case 'unknown': return 'Needs verification';
    default: return 'Checking...';
  }
}

function permissionTone(status: PermissionState | undefined): PermissionTone {
  if (!status) return 'warn';
  if (status === 'granted') return 'ok';
  if (status === 'unknown') return 'warn';
  return 'bad';
}

function loadManualPermissionReview(): ManualPermissionReview {
  try {
    const raw = localStorage.getItem(MANUAL_PERMISSION_KEY);
    return raw ? JSON.parse(raw) as ManualPermissionReview : {};
  } catch { return {}; }
}

function PermissionRow({
  tone,
  title,
  subtitle,
  detail,
  pane,
  showRelaunch,
  children,
  onRefresh,
}: {
  tone: PermissionTone;
  title: string;
  subtitle: string;
  detail: string;
  pane: 'screen' | 'accessibility' | 'input-monitoring' | 'automation';
  showRelaunch?: boolean;
  children?: ReactNode;
  onRefresh: () => void;
}) {
  const ok = tone === 'ok';
  return (
    <div className={`cu-perm ${tone}`}>
      <span className="cu-perm-dot" />
      <div className="cu-perm-body">
        <b>{title}</b> <span className="muted small">- {subtitle}</span>
        <div className="muted small">{detail}</div>
        {!ok ? (
          <div className="cu-perm-actions">
            <button className="btn" onClick={() => void call('cu:openPermission', pane)}>Open Settings ↗</button>
            {showRelaunch ? <button className="btn" onClick={() => void call('cu:relaunch')} title="A grant only takes effect after a restart">Relaunch</button> : null}
            <button className="btn" onClick={onRefresh}>Re-check</button>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function ComputerUse({ store }: { store: FleetStore }) {
  const [perms, setPerms] = useState<Perms | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [attached, setAttached] = useState<AttachedAgent[]>([]);
  const [frame, setFrame] = useState<string>('');
  const [frameMeta, setFrameMeta] = useState<FrameMsg | null>(null);
  const [selectedBlessIds, setSelectedBlessIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [legacyAuthority, setLegacyAuthority] = useState<LegacyComputerUseAuthority[]>([]);
  const [panicFlash, setPanicFlash] = useState(false);
  const [allowEmptyArm, setAllowEmptyArm] = useState(false);
  const [manualPerms, setManualPerms] = useState<ManualPermissionReview>(() => loadManualPermissionReview());
  const lastFrameAt = useRef(0);
  const resolvedRef = useRef<Set<string>>(new Set()); // approval ids the user already answered → never resurrect via a stale snapshot

  // Apply an incoming pending list, dropping ids the user already answered locally
  // (a 2.5s status snapshot can predate the broker processing the confirm).
  function applyPending(list: PendingAction[]) {
    const incoming = list ?? [];
    setPending(incoming.filter((p) => !resolvedRef.current.has(p.id)));
    // bound the set: keep only ids still racing (still present in the snapshot)
    if (resolvedRef.current.size) resolvedRef.current = new Set([...resolvedRef.current].filter((id) => incoming.some((p) => p.id === id)));
  }

  const activeTeam = store.team ?? 'default';
  const teamOf = (a: { team?: string }, fallbackTeam = activeTeam) => a.team ?? fallbackTeam;
  const authorityOf = (a: { name: string; team?: string; authority?: string }, fallbackTeam = activeTeam) => a.authority ?? `${teamOf(a, fallbackTeam)}:${a.name}`;
  const targetKey = (a: { id?: string; name: string; team?: string }, fallbackTeam = activeTeam) => `${teamOf(a, fallbackTeam)}:${a.id || a.name}`;
  const rosterTargets = (store.allAgents.length
    ? store.allAgents
    : store.agents.map((a) => ({ ...a, team: activeTeam })))
    .map((a) => ({ ...a, team: teamOf(a) })) as ComputerUseTarget[];
  const rosterTeamNames = [...new Set([activeTeam, ...rosterTargets.map((a) => teamOf(a))].filter(Boolean))];
  const rosterTeamKey = sortedKey(rosterTeamNames);
  const eligible = rosterTargets
    .filter((a) => mcpCapable(agentRuntime(a)))
    .filter((a, i, arr) => arr.findIndex((x) => targetKey(x) === targetKey(a)) === i);
  const availableBlessTargets = eligible.filter((a) => !attached.some((x) => authorityOf(x) === authorityOf(a)));
  const availableBlessKey = sortedKey(availableBlessTargets.map((a) => targetKey(a)));
  const selectedBlessTargets = selectedBlessIds
    .map((id) => availableBlessTargets.find((a) => targetKey(a) === id))
    .filter((a): a is ComputerUseTarget => !!a);
  const armed = !!status?.armed;
  const cuUnavailable = status?.available === false;
  const cuUnavailableReason = status?.unavailableReason ?? 'Computer Use requires the Electron desktop broker.';
  const srGranted = perms?.screenRecording === 'granted';
  const axGranted = perms?.accessibility === true;
  const imGranted = perms?.inputMonitoring === 'granted';
  const automationGranted = perms?.automation?.status === 'granted';
  const imManuallyVerified = !imGranted && perms?.platform === 'darwin' && perms?.inputMonitoring === 'unknown' && manualPerms.inputMonitoring === true;
  const automationManuallyVerified = !automationGranted && perms?.platform === 'darwin' && perms?.automation?.status === 'unknown' && manualPerms.automation === true;
  const recentlyActed = auditLog.length > 0 && Date.now() - auditLog[auditLog.length - 1].ts < 3500;
  const tccUnreadable = perms?.platform === 'darwin' && perms?.tcc?.readable === false
    && ((perms.inputMonitoring === 'unknown' && !manualPerms.inputMonitoring) || (perms.automation.status === 'unknown' && !manualPerms.automation));
  const imNeedsManualReview = perms?.platform === 'darwin' && perms?.inputMonitoring === 'unknown';
  const automationNeedsManualReview = perms?.platform === 'darwin' && perms?.automation?.status === 'unknown';
  const inputMonitoringDetail = imGranted
    ? 'Granted'
    : imManuallyVerified
      ? 'Verified in macOS Settings (manual)'
    : imNeedsManualReview
      ? 'Needs verification - macOS does not expose a reliable readback here. If IDACC is enabled in Privacy & Security > Input Monitoring, this is okay.'
      : permissionText(perms?.inputMonitoring);
  const automationDetail = automationGranted
    ? `Granted${perms?.automation.targets.length ? ` for ${perms.automation.targets.join(', ')}` : ''}`
    : automationManuallyVerified
      ? 'Verified in macOS Settings (manual; Automation is still per target app)'
    : automationNeedsManualReview
      ? 'Needs verification - Automation is granted per target app and may stay unknown until IDACC first controls that app.'
      : permissionText(perms?.automation?.status);
  const attachedStamp = (list: AttachedAgent[], fallbackTeam = activeTeam) => sortedKey((list ?? []).map((a) => `${a.id}:${authorityOf(a, fallbackTeam)}`));
  const describeAttached = (list: AttachedAgent[]) => list.length
    ? list.map((a) => `${a.team ?? activeTeam}/${a.name}`).join(', ')
    : 'no blessed agents';
  const describeTargets = (list: { name: string; team?: string }[]) => {
    const names = list.map((a) => `${a.team ?? activeTeam}/${a.name}`);
    return names.length > 6 ? `${names.slice(0, 6).join(', ')} + ${names.length - 6} more` : names.join(', ');
  };
  const emptyArmNeedsReview = !armed && srGranted && attached.length === 0;
  function setBlessSelected(id: string, selected: boolean) {
    setSelectedBlessIds((prev) => {
      const next = selected ? [...prev, id] : prev.filter((x) => x !== id);
      return [...new Set(next)];
    });
  }
  function eligibleByAuthority(authority: string): ComputerUseTarget | undefined {
    const sep = authority.indexOf(':');
    if (sep < 0) return undefined;
    const team = authority.slice(0, sep);
    const name = authority.slice(sep + 1);
    const found = eligible.find((a) => teamOf(a) === team && a.name === name);
    return found ? { ...found, team } : undefined;
  }
  async function copyLegacyAuthority(authority: string) {
    try {
      await navigator.clipboard.writeText(authority);
      setMsg(`Copied scoped authority ${authority}.`);
    } catch {
      setMsg(`Copy failed. Scoped authority: ${authority}`);
    }
  }
  function setManualPermission(key: 'inputMonitoring' | 'automation', value: boolean) {
    const next = { ...manualPerms, [key]: value, updatedAt: Date.now() };
    if (!value) delete next[key];
    setManualPerms(next);
    try { localStorage.setItem(MANUAL_PERMISSION_KEY, JSON.stringify(next)); } catch { /* local-only display hint */ }
    setMsg(value
      ? `${key === 'inputMonitoring' ? 'Input Monitoring' : 'Automation'} marked verified from macOS Settings.`
      : `${key === 'inputMonitoring' ? 'Input Monitoring' : 'Automation'} manual verification cleared.`);
  }
  async function fetchAttachedForTeams(teams = rosterTeamNames): Promise<AttachedAgent[]> {
    const scoped = await Promise.all([...new Set(teams.length ? teams : [activeTeam])].map(async (team) => {
      const list = await call<AttachedAgent[]>('cu:attached', team).catch(() => []);
      return (list ?? []).map((a) => ({ ...a, team: a.team ?? team }));
    }));
    return scoped.flat();
  }
  function teamsFromTargets(list: { team?: string }[]): string[] {
    return [...new Set(list.map((a) => teamOf(a)).filter(Boolean))];
  }
  function attachedForTeam(list: AttachedAgent[], team: string): AttachedAgent[] {
    return (list ?? []).filter((a) => teamOf(a) === team);
  }
  function attachedTeams(list: AttachedAgent[]): string[] {
    return teamsFromTargets(list);
  }
  async function armAttachedTeams(list: AttachedAgent[], fallbackTeams: string[]): Promise<void> {
    const teams = attachedTeams(list);
    const teamsToArm = teams.length ? teams : [...new Set(fallbackTeams.length ? fallbackTeams : [activeTeam])];
    for (const team of teamsToArm) {
      const scoped = attachedForTeam(list, team);
      await call('cu:arm', team, attachedStamp(scoped, team));
    }
  }

  async function refresh() {
    const authorityTargets = eligible.map((a) => ({ name: a.name, team: teamOf(a) }));
    const [p, s, at, au, legacy] = await Promise.all([
      call<Perms>('cu:permissions').catch(() => null),
      call<Status>('cu:status').catch(() => null),
      fetchAttachedForTeams(rosterTeamNames),
      call<AuditEntry[]>('cu:audit', 40).catch(() => []),
      call<LegacyComputerUseAuthority[]>('cu:legacyAuthority', authorityTargets).catch(() => []),
    ]);
    if (p) setPerms(p);
    if (s) { setStatus(s); applyPending(s.pending ?? []); }
    setAttached(at ?? []);
    setAuditLog(au ?? []);
    setLegacyAuthority(legacy ?? []);
  }

  async function panic() {
    try {
      await call('cu:panic');
      setFrame('');
      setFrameMeta(null);
      await refresh();
    } catch (e) {
      setMsg(`✗ couldn't panic-stop Computer Use: ${e instanceof Error ? e.message : e}`);
    }
  }
  async function toggleSupervised() {
    const rendered = status;
    try {
      const current = await call<Status>('cu:status');
      if (rendered && current.supervised !== rendered.supervised) {
        setStatus(current);
        applyPending(current.pending ?? []);
        setMsg('Safety mode changed since this page rendered. Refreshed; review the current mode before changing it.');
        return;
      }
      const next = current.supervised === false;
      if (!next && !window.confirm('Turn off approval for ordinary Computer Use actions?\n\nBlessed agents will be able to click and type without per-action approval. Risky actions still require approval.')) return;
      const afterPrompt = await call<Status>('cu:status');
      if (afterPrompt.supervised !== current.supervised) {
        setStatus(afterPrompt);
        applyPending(afterPrompt.pending ?? []);
        setMsg('Safety mode changed during confirmation. Refreshed; review the current mode before changing it.');
        return;
      }
      await call('cu:setSupervised', next);
    } catch (e) {
      setMsg(`✗ couldn't change mode: ${e instanceof Error ? e.message : e}`);
    } finally {
      await refresh();
    }
  }
  async function togglePause() {
    const renderedPaused = status?.paused;
    try {
      const current = await call<Status>('cu:status');
      if (renderedPaused !== undefined && current.paused !== renderedPaused) {
        setStatus(current);
        applyPending(current.pending ?? []);
        setMsg('Pause state changed since this page rendered. Refreshed; review the current state before changing it.');
        return;
      }
      await call('cu:pause', !current.paused);
    } catch (e) {
      setMsg(`✗ couldn't ${status?.paused ? 'resume' : 'pause'}: ${e instanceof Error ? e.message : e}`);
    } finally {
      await refresh();
    }
  }
  async function confirmPending(action: PendingAction, allow: boolean) {
    const current = await call<PendingAction[]>('cu:pending').catch(() => pending);
    const latest = current.find((p) => p.id === action.id);
    if (!latest) {
      resolvedRef.current.add(action.id);
      applyPending(current);
      setMsg('That Computer Use request was already resolved or expired. Refreshed pending approvals.');
      return;
    }
    if (pendingStamp(latest) !== pendingStamp(action)) {
      applyPending(current);
      setMsg('That Computer Use request changed since it rendered. Review the current approval prompt before deciding.');
      return;
    }
    const res = await call<{ ok: boolean }>('cu:confirm', action.id, allow).catch(() => ({ ok: false }));
    if (!res.ok) {
      const afterFail = await call<PendingAction[]>('cu:pending').catch(() => current);
      const stillPending = afterFail.some((p) => p.id === action.id);
      if (!stillPending) resolvedRef.current.add(action.id);
      applyPending(afterFail);
      setMsg(stillPending
        ? 'Computer Use approval was not accepted by the broker. Refreshed pending approvals; review before deciding again.'
        : 'That Computer Use request was already resolved or expired. Refreshed pending approvals.');
      return;
    }
    resolvedRef.current.add(action.id);
    setPending((ps) => ps.filter((p) => p.id !== action.id));
  }

  useEffect(() => {
    // Tell the broker the live pane is on screen, so the full-screen capture pump
    // ONLY runs while this view is mounted (navigating away stops it entirely).
    void call('cu:watch', true);
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    const eventApi = (window as { idagents?: ComputerUseEventApi }).idagents;
    const off = eventApi?.onComputerFrame?.((f) => {
      const fm = f as FrameMsg;
      if (!fm?.jpegBase64) return;
      lastFrameAt.current = Date.now();
      setFrame(`data:image/jpeg;base64,${fm.jpegBase64}`);
      setFrameMeta(fm);
    }) ?? (() => {});
    const offPending = eventApi?.onComputerPending?.((e) => { const ev = e as { pending?: PendingAction[] }; applyPending(ev?.pending ?? []); }) ?? (() => {});
    const offPanic = eventApi?.onComputerPanic?.(() => { setPanicFlash(true); setTimeout(() => setPanicFlash(false), 2500); void refresh(); }) ?? (() => {});
    return () => { clearInterval(t); off(); offPending(); offPanic(); void call('cu:watch', false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTeam, rosterTeamKey]);
  useEffect(() => {
    setSelectedBlessIds([]);
    setMsg('');
    setAllowEmptyArm(false);
  }, [activeTeam]);
  useEffect(() => {
    const available = new Set(availableBlessTargets.map((a) => targetKey(a)));
    setSelectedBlessIds((prev) => prev.filter((id) => available.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableBlessKey]);
  // Also pause the pump when the OS window is hidden/minimized.
  useEffect(() => {
    const onVis = () => { void call('cu:watch', document.visibilityState === 'visible'); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    if (armed || attached.length) setAllowEmptyArm(false);
  }, [armed, attached.length]);

  async function arm() {
    setBusy(true);
    setMsg('');
    try {
      // Bless = the agents that currently have the computer-use tool attached,
      // captured at arm. Re-arm to refresh after blessing/removing an agent.
      const [currentStatus, at] = await Promise.all([
        call<Status>('cu:status'),
        fetchAttachedForTeams(rosterTeamNames),
      ]);
      if (currentStatus.armed) {
        setStatus(currentStatus);
        applyPending(currentStatus.pending ?? []);
        setMsg('Computer Use is already armed. Refreshed the current broker state.');
        return;
      }
      if (!(at ?? []).length && !allowEmptyArm) {
        setAttached(at ?? []);
        setMsg('Review empty Computer Use arm first. No agent can drive until one is blessed and Computer Use is armed again.');
        return;
      }
      const beforeStamp = attachedStamp(at ?? []);
      const detail = at?.length
        ? `Agents: ${describeAttached(at)}`
        : 'No agents are blessed. This starts the live view for permission testing, but no agent can drive until one is blessed and armed.';
      if (!window.confirm(`Arm Computer Use now?\n\n${detail}\n\nOnly the current blessed list can request screenshots or input. Input actions still follow the approval mode shown on this page.`)) return;
      const [afterStatus, latestAttached] = await Promise.all([
        call<Status>('cu:status'),
        fetchAttachedForTeams(rosterTeamNames),
      ]);
      if (afterStatus.armed) {
        setStatus(afterStatus);
        applyPending(afterStatus.pending ?? []);
        setMsg('Computer Use was armed elsewhere while you were confirming. Refreshed the current state.');
        return;
      }
      if (attachedStamp(latestAttached ?? []) !== beforeStamp) {
        setAttached(latestAttached ?? []);
        setMsg('Blessed agents changed during confirmation. Refreshed; review Who can drive and press Arm again.');
        return;
      }
      await armAttachedTeams(latestAttached ?? [], [activeTeam]);
      setAllowEmptyArm(false);
      await refresh();
    } catch (e) {
      setMsg(`✗ couldn't arm Computer Use: ${e instanceof Error ? e.message : e}`);
      await refresh();
    } finally { setBusy(false); }
  }
  async function disarm() {
    try {
      await call('cu:disarm');
      setFrame('');
      setFrameMeta(null);
      await refresh();
    } catch (e) {
      setMsg(`✗ couldn't disarm: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function freshGroups(): Promise<TeamAgentsGroup[]> {
    return call<TeamAgentsGroup[]>('agents:allTeams', { force: true }).catch(() => []);
  }
  function findFreshTarget(groups: TeamAgentsGroup[], rendered: ComputerUseTarget): ComputerUseTarget | null {
    const expectedTeam = rendered.team ?? activeTeam;
    const agents = groups.find((g) => g.team === expectedTeam)?.agents ?? [];
    const found = agents.find((x) => x.id === rendered.id) ?? agents.find((x) => x.name === rendered.name);
    return found ? { ...found, team: expectedTeam } : null;
  }
  function findFreshTargetById(groups: TeamAgentsGroup[], rendered: { id: string; name: string; team?: string }): ComputerUseTarget | null {
    const expectedTeam = rendered.team ?? activeTeam;
    const agents = groups.find((g) => g.team === expectedTeam)?.agents ?? [];
    const found = agents.find((x) => x.id === rendered.id);
    return found ? { ...found, team: expectedTeam } : null;
  }
  function validateBlessTargets(groups: TeamAgentsGroup[], renderedTargets: ComputerUseTarget[], label: string): ComputerUseTarget[] | null {
    const currentTargets: ComputerUseTarget[] = [];
    for (const rendered of renderedTargets) {
      const team = rendered.team ?? activeTeam;
      const current = findFreshTarget(groups, { ...rendered, team });
      if (!current) {
        setMsg(`${label} blocked: ${team}/${rendered.name} is no longer in the current roster. Refreshed; review the target and try again.`);
        store.refresh();
        return null;
      }
      if (!mcpCapable(agentRuntime(current))) {
        setMsg(`${label} blocked: ${team}/${current.name} no longer supports MCP-backed Computer Use. Refreshed; review the target and try again.`);
        store.refresh();
        return null;
      }
      if (computerUseAgentStamp(current, team) !== computerUseAgentStamp({ ...rendered, team }, team)) {
        setMsg(`${label} blocked: ${team}/${rendered.name} changed since this page rendered. Refreshed; review the current row before changing Computer Use access.`);
        store.refresh();
        return null;
      }
      currentTargets.push(current);
    }
    return currentTargets;
  }
  function findAttached(list: AttachedAgent[], rendered: AttachedAgent): AttachedAgent | null {
    const team = rendered.team ?? activeTeam;
    return list.find((a) => a.id === rendered.id && teamOf(a) === team)
      ?? list.find((a) => authorityOf(a, team) === authorityOf(rendered, team))
      ?? list.find((a) => a.name === rendered.name && (a.team ?? activeTeam) === team)
      ?? null;
  }
  async function ensureFreshAttached(rendered: AttachedAgent, label: string): Promise<AttachedAgent | null> {
    const team = rendered.team ?? activeTeam;
    const latest = await call<AttachedAgent[]>('cu:attached', team);
    const current = findAttached(latest ?? [], { ...rendered, team });
    if (!current) {
      setAttached(await fetchAttachedForTeams(rosterTeamNames));
      setMsg(`${label} blocked: ${team}/${rendered.name} is no longer blessed. Refreshed Who can drive.`);
      return null;
    }
    const before = `${rendered.id}:${authorityOf({ ...rendered, team }, team)}`;
    const after = `${current.id}:${authorityOf(current, team)}`;
    if (before !== after) {
      setAttached(await fetchAttachedForTeams(rosterTeamNames));
      setMsg(`${label} blocked: ${team}/${rendered.name} changed authority since this page rendered. Refreshed; review Who can drive and try again.`);
      return null;
    }
    return current;
  }
  async function syncArmedBlessedForTeams(teams: string[]): Promise<boolean> {
    const currentStatus = await call<Status>('cu:status');
    if (!currentStatus.armed) return false;
    const scopedTeams = [...new Set(teams.length ? teams : [activeTeam])];
    for (const team of scopedTeams) {
      const latestAttached = (await call<AttachedAgent[]>('cu:attached', team)).map((a) => ({ ...a, team: a.team ?? team }));
      await call('cu:arm', team, attachedStamp(latestAttached ?? [], team));
    }
    return true;
  }

  async function blessMany(renderedTargets: ComputerUseTarget[]) {
    setBusy(true); setMsg('');
    const targets = renderedTargets
      .map((a) => ({ ...a, team: teamOf(a) }))
      .filter((a, i, arr) => arr.findIndex((x) => targetKey(x) === targetKey(a)) === i);
    try {
      if (!targets.length) {
        setMsg('Select one or more eligible agents to bless for Computer Use.');
        return;
      }
      const currentTargets = validateBlessTargets(await freshGroups(), targets, 'Bless');
      if (!currentTargets) return;
      const targetTeams = teamsFromTargets(currentTargets);
      const beforeAttached = await fetchAttachedForTeams(targetTeams);
      const attachable = currentTargets.filter((current) => !findAttached(beforeAttached ?? [], current));
      if (!attachable.length) {
        setAttached(await fetchAttachedForTeams(rosterTeamNames));
        setSelectedBlessIds([]);
        setMsg('Selected agents are already blessed for Computer Use. Refreshed Who can drive.');
        return;
      }
      const label = attachable.length === 1
        ? `${teamOf(attachable[0])}/${attachable[0].name}`
        : `${attachable.length} agents across ${teamsFromTargets(attachable).length} teams`;
      if (!window.confirm(`Bless ${label} for Computer Use?\n\nAgents: ${describeTargets(attachable)}\n\nThis attaches the local computer-use MCP server and rebuilds each selected agent so it can request screenshots and input while Computer Use is armed.`)) return;
      const afterConfirmTargets = validateBlessTargets(await freshGroups(), attachable, 'Bless');
      if (!afterConfirmTargets) return;
      const latestAttached = await fetchAttachedForTeams(teamsFromTargets(afterConfirmTargets));
      const stillAttachable = afterConfirmTargets.filter((current) => !findAttached(latestAttached ?? [], current));
      if (!stillAttachable.length) {
        setAttached(await fetchAttachedForTeams(rosterTeamNames));
        setSelectedBlessIds([]);
        setMsg('Selected agents were blessed while you were confirming. Refreshed Who can drive.');
        return;
      }
      const rebuildFailures: string[] = [];
      const attachFailures: string[] = [];
      let attachedCount = 0;
      for (const target of stillAttachable) {
        const team = teamOf(target);
        try {
          setMsg(`Attaching computer-use to ${team}/${target.name} (${attachedCount + 1}/${stillAttachable.length})...`);
          await call('cu:attach', target.id, target.name, team);      // throws on failure -> caught below (never silently "succeeds")
          attachedCount++;
          try {
            await call('rebuildAgent', target.name, team);       // the rebuild is what actually wires the tool
          } catch (e) {
            rebuildFailures.push(`${team}/${target.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } catch (e) {
          attachFailures.push(`${team}/${target.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const armedListRefreshed = await syncArmedBlessedForTeams(teamsFromTargets(stillAttachable)); // re-sync the live bless-list from the current attached list if already armed
      await refresh();
      setSelectedBlessIds((prev) => prev.filter((id) => !stillAttachable.some((a) => targetKey(a) === id)));
      if (attachFailures.length || rebuildFailures.length) {
        const parts = [
          attachedCount ? `attached ${attachedCount}/${stillAttachable.length}` : '',
          rebuildFailures.length ? `rebuild review needed for ${rebuildFailures.length}` : '',
          attachFailures.length ? `attach failed for ${attachFailures.length}` : '',
        ].filter(Boolean);
        setMsg(`⚠ Computer Use batch finished with review: ${parts.join('; ')}.`);
      } else {
        setMsg(`✅ Blessed ${stillAttachable.length} agent${stillAttachable.length === 1 ? '' : 's'} for Computer Use. ${armedListRefreshed ? 'The active armed list was refreshed.' : 'Arm Computer Use to capture this set.'}`);
      }
    } catch (e) {
      setMsg(`✗ Couldn't bless selected agents: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }
  async function unbless(a: AttachedAgent) {
    setBusy(true); setMsg('');
    const team = a.team ?? activeTeam;
    try {
      const current = await ensureFreshAttached({ ...a, team }, 'Remove');
      if (!current) return;
      if (!window.confirm(`Remove Computer Use from ${team}/${current.name}?\n\nThis detaches the local computer-use MCP server and rebuilds the agent if that exact agent is still in the current roster. If Computer Use is armed, its live blessed list will be refreshed afterward.`)) return;
      const afterConfirm = await ensureFreshAttached(current, 'Remove');
      if (!afterConfirm) return;
      const groups = await freshGroups();
      const exactAgent = findFreshTargetById(groups, { id: afterConfirm.id, name: afterConfirm.name, team });
      await call('cu:detach', afterConfirm.id, afterConfirm.name, team);
      if (exactAgent) await call('rebuildAgent', exactAgent.name, team).catch(() => {});
      await syncArmedBlessedForTeams([team]);
      await refresh();
      setMsg(exactAgent
        ? `Removed computer-use from ${team}/${afterConfirm.name}.`
        : `Removed stale Computer Use authority for ${team}/${afterConfirm.name}; skipped rebuild because that exact agent is no longer in the current roster.`);
    } catch (e) {
      setMsg(`✗ Couldn't remove from ${team}/${a.name}: ${e instanceof Error ? e.message : e}`);
    } finally { setBusy(false); }
  }

  const liveStale = frame && Date.now() - lastFrameAt.current > 4000;

  return (
    <div className="view cu-view">
      <header className="view-head">
        <h1>Computer Use</h1>
        <div className="row-actions" style={{ alignItems: 'center', gap: 10 }}>
          {armed ? (
            <>
              <button className={`btn ${status?.paused ? 'primary' : ''}`} onClick={() => void togglePause()} title="Block the agent's input without disarming">{status?.paused ? 'Resume' : 'Pause'}</button>
              {/* PANIC is the emergency stop — NEVER gated by `busy`, so a slow op (e.g. a rebuild) can't block it. */}
              <button className="btn cu-panic" onClick={() => void panic()} title={status?.panicHotkey ? 'Stop everything now (⌘⌥⇧P)' : 'Stop everything now'}>■ PANIC</button>
            </>
          ) : null}
          <span className={`cu-armpill ${armed ? 'on' : ''}`}>{armed ? (status?.paused ? '❚❚ paused' : '● ARMED') : '○ disarmed'}</span>
          {armed
            ? <button className="btn icon-danger" onClick={() => void disarm()}>Disarm</button>
            : <button
                className="btn primary"
                disabled={busy || cuUnavailable || !srGranted || (emptyArmNeedsReview && !allowEmptyArm)}
                title={cuUnavailable ? cuUnavailableReason : !srGranted ? 'Grant Screen Recording first' : emptyArmNeedsReview && !allowEmptyArm ? 'Review empty arm first' : ''}
                onClick={() => void arm()}
              >Arm</button>}
        </div>
      </header>

      {panicFlash ? <div className="cu-panic-flash">■ PANIC — Computer Use stopped</div> : null}

      {/* Approval prompts (supervised mode): the agent is blocked until you decide. */}
      {pending.length ? (
        <div className="cu-approvals">
          {pending.map((p) => (
            <div key={p.id} className="cu-approval">
              <span className="cu-approval-text"><b>{p.agent}</b> wants to <b>{p.preview}</b></span>
              <span className="grow" />
              {/* Approval is safety-critical — independent of `busy` so a rebuild can't stall it into the 60s auto-decline. */}
              <button className="btn primary" onClick={() => void confirmPending(p, true)}>Allow</button>
              <button className="btn icon-danger" onClick={() => void confirmPending(p, false)}>Deny</button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="cu-intro muted small">
        Let a blessed agent <b>see and drive</b> your Mac — mouse, keyboard, scrolling — and watch it live here.
        Nothing happens unless you <b>Arm</b> it; only agents you bless can act; and while it's driving, <b>move your
        own mouse or hit Disarm to take back control</b>. Every action is logged below.
      </div>
      {cuUnavailable ? <div className="cu-msg small">{cuUnavailableReason}</div> : null}
      {emptyArmNeedsReview ? (
        <div className="cu-empty-arm">
          <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={allowEmptyArm} onChange={(e) => setAllowEmptyArm(e.target.checked)} />
            Start live view with no blessed agents
          </label>
          <span className="muted small">Permission testing only; agents cannot drive.</span>
        </div>
      ) : null}

      <div className="cols cu-cols">
        {/* LEFT: the live pane */}
        <section className="card cu-stage">
          <h3>Live view <span className="muted small">· your primary display</span></h3>
          <div className="cu-screen">
            {!srGranted ? (
              <div className="cu-placeholder">
                <div className="cu-ph-title">Screen Recording permission needed</div>
                <div className="muted small">Grant <b>ID Agents Control Center</b> Screen Recording, then relaunch.</div>
              </div>
            ) : !armed ? (
              <div className="cu-placeholder"><div className="cu-ph-title">Press <b>Arm</b> to start the live view</div></div>
            ) : frame ? (
              <img className="cu-frame" src={frame} alt="live screen" />
            ) : status?.captureFailing ? (
              <div className="cu-placeholder">
                <div className="cu-ph-title">Couldn’t capture the screen</div>
                <div className="muted small">macOS reports the permission as granted but capture is empty — this usually needs a relaunch after granting.</div>
                <div className="cu-perm-actions" style={{ justifyContent: 'center', marginTop: 8 }}>
                  <button className="btn" onClick={() => void call('cu:openPermission', 'screen')}>Open Settings ↗</button>
                  <button className="btn" onClick={() => void call('cu:relaunch')}>Relaunch</button>
                </div>
              </div>
            ) : (
              <div className="cu-placeholder"><div className="cu-ph-title">Starting capture…</div></div>
            )}
            {liveStale ? <div className="cu-stale">live view paused</div> : null}
            {armed && recentlyActed ? <div className="cu-driving">● {status?.lastAgent || 'agent'} is driving — move your mouse or hit Disarm to take over</div> : null}
          </div>
          {frameMeta ? <div className="muted small cu-screen-meta">{frameMeta.display?.bounds.width}×{frameMeta.display?.bounds.height} pts · streaming</div> : null}
        </section>

        {/* RIGHT: permissions + bless + safety */}
        <aside className="cu-side">
          <section className="card">
            <h3>Permissions</h3>
            <PermissionRow
              tone={srGranted ? 'ok' : permissionTone(perms?.screenRecording)}
              title="Screen Recording"
              subtitle="to capture the screen"
              detail={srGranted ? 'Granted' : `${permissionText(perms?.screenRecording)} (${perms?.screenRecording ?? 'checking'})`}
              pane="screen"
              showRelaunch
              onRefresh={() => void refresh()}
            />
            <PermissionRow
              tone={axGranted ? 'ok' : perms ? 'bad' : 'warn'}
              title="Accessibility"
              subtitle="required for mouse + keyboard"
              detail={axGranted ? 'Granted' : 'Not granted - the agent can see the screen but cannot click or type until you grant this.'}
              pane="accessibility"
              showRelaunch
              onRefresh={() => void refresh()}
            >
              {status && !status.driverOk ? <div className="cu-msg small">⚠ native input module unavailable in this build</div> : null}
            </PermissionRow>
            <PermissionRow
              tone={imGranted || imManuallyVerified ? 'ok' : permissionTone(perms?.inputMonitoring)}
              title="Input Monitoring"
              subtitle="tracks keyboard-input authority prompts"
              detail={inputMonitoringDetail}
              pane="input-monitoring"
              onRefresh={() => void refresh()}
            >
              {imNeedsManualReview ? (
                <div className="cu-perm-actions">
                  <button className="btn" onClick={() => setManualPermission('inputMonitoring', !manualPerms.inputMonitoring)}>
                    {manualPerms.inputMonitoring ? 'Clear manual verification' : 'I verified this in macOS'}
                  </button>
                </div>
              ) : null}
            </PermissionRow>
            <PermissionRow
              tone={automationGranted || automationManuallyVerified ? 'ok' : permissionTone(perms?.automation?.status)}
              title="Automation"
              subtitle="lets IDACC control allowed apps when needed"
              detail={automationDetail}
              pane="automation"
              onRefresh={() => void refresh()}
            >
              {automationNeedsManualReview ? (
                <div className="cu-perm-actions">
                  <button className="btn" onClick={() => setManualPermission('automation', !manualPerms.automation)}>
                    {manualPerms.automation ? 'Clear manual verification' : 'I verified this in macOS'}
                  </button>
                </div>
              ) : null}
            </PermissionRow>
            {tccUnreadable ? (
              <div className="cu-msg small">
                macOS blocked direct inspection for Input Monitoring/Automation. Verify ID Agents Control Center in System Settings; Re-check may remain in review until macOS records a readable grant.
              </div>
            ) : null}
          </section>

          <section className="card">
            <h3>Who can drive</h3>
            <div className="muted small">Bless eligible agents synced from HR Manager. Each grant stays scoped to that agent's team.</div>
            <div className="cu-bless-add">
              <div className="cu-bless-list" aria-label="Agents available for Computer Use">
                {availableBlessTargets.length ? availableBlessTargets.map((a) => {
                  const key = targetKey(a);
                  const selected = selectedBlessIds.includes(key);
                  return (
                    <label key={key} className={`cu-bless-choice${selected ? ' selected' : ''}`}>
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={busy || cuUnavailable}
                        onChange={(e) => setBlessSelected(key, e.target.checked)}
                      />
                      <span className="cu-bless-choice-text">
                        <span className="cu-bless-choice-name">{teamOf(a)}/{a.name}</span>
                        <span className="muted small">{agentRuntime(a)} · {a.status ?? 'unknown'}</span>
                      </span>
                    </label>
                  );
                }) : (
                  <div className="muted small">All eligible agents are already blessed.</div>
                )}
              </div>
              <div className="cu-bless-actions">
                <button className="btn small" disabled={busy || cuUnavailable || !availableBlessTargets.length || selectedBlessTargets.length === availableBlessTargets.length} onClick={() => setSelectedBlessIds(availableBlessTargets.map((a) => targetKey(a)))}>Select all</button>
                <button className="btn small" disabled={busy || cuUnavailable || !selectedBlessTargets.length} onClick={() => setSelectedBlessIds([])}>Clear</button>
                <span className="muted small">{selectedBlessTargets.length} selected</span>
                <button className="btn primary" disabled={busy || cuUnavailable || !selectedBlessTargets.length} title={cuUnavailable ? cuUnavailableReason : undefined} onClick={() => void blessMany(selectedBlessTargets)}>
                  Bless selected
                </button>
              </div>
            </div>
            {attached.length ? (
              <div className="cu-blessed">
                {attached.map((a) => (
                  <div key={targetKey(a)} className="cu-blessed-row">
                    <span>🖥️ {a.team ?? activeTeam}/{a.name}</span>
                    <button className="btn icon-danger" disabled={busy || cuUnavailable} title={cuUnavailable ? cuUnavailableReason : undefined} onClick={() => void unbless(a)}>Remove</button>
                  </div>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 6 }}>No agents blessed yet.</div>}
            {legacyAuthority.length ? (
              <div className="cu-legacy small">
                <b>Legacy authority review</b>
                {legacyAuthority.map((row) => {
                  const firstAuthority = row.currentAuthorities[0] ?? '';
                  const target = row.currentAuthorities.map(eligibleByAuthority).find(Boolean);
                  const alreadyBlessed = target ? attached.some((a) => authorityOf(a, activeTeam) === authorityOf(target, activeTeam)) : false;
                  const selectedForBless = target ? selectedBlessIds.includes(targetKey(target)) : false;
                  return (
                    <div key={`${row.source}:${row.agent}`} className="cu-legacy-row">
                      <span className="muted">
                        {row.agent}: {row.tokenCount} old bare-name token{row.tokenCount === 1 ? '' : 's'} blocked by scoped arming{' -> '}{row.currentAuthorities.join(', ')}
                      </span>
                      <span className="legacy-review-actions">
                        {target ? (
                          <button className="btn small" disabled={busy || alreadyBlessed || selectedForBless} onClick={() => { setBlessSelected(targetKey(target), true); setMsg(`Selected ${target.team}/${target.name}. Use Bless selected to mint scoped Computer Use authority; old bare-name tokens remain blocked.`); }}>
                            {alreadyBlessed ? 'Already blessed' : selectedForBless ? 'Selected' : 'Select for bless'}
                          </button>
                        ) : null}
                        {firstAuthority ? (
                          <button className="btn small" disabled={busy} onClick={() => void copyLegacyAuthority(firstAuthority)}>
                            Copy scoped authority
                          </button>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {msg ? <div className="cu-msg small">{msg}</div> : null}
          </section>

          <section className="card cu-audit">
            <h3>Activity log <span className="muted small">· what the agent did</span></h3>
            {auditLog.length ? (
              <div className="cu-audit-list">
                {auditLog.slice().reverse().map((e, i) => (
                  <div key={`${e.ts}-${i}`} className={`cu-audit-row ${e.decision === 'blocked' ? 'blocked' : ''}`}>
                    <span className="cu-audit-ico">{ACT_ICON[e.action] ?? '•'}</span>
                    <span className="cu-audit-act">{e.action}</span>
                    <span className="cu-audit-detail muted">{e.detail || (e.decision === 'blocked' ? `blocked: ${e.reason}` : '')}</span>
                    <span className="cu-audit-agent muted small">{e.agent}</span>
                  </div>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 6 }}>No actions yet. Arm, then ask a blessed agent to screenshot and click something.</div>}
          </section>

          <section className="card cu-safety">
            <h3>Safety</h3>
            <label className="cu-mode-row">
              <input type="checkbox" checked={status?.supervised !== false} disabled={cuUnavailable} onChange={() => void toggleSupervised()} />
              <span>
                <b>Approve every action</b> <span className="muted small">(recommended)</span>
                <div className="muted small">{status?.supervised !== false
                  ? 'Every click & keystroke is held for your OK.'
                  : 'Auto-allowing ordinary actions — but still asking before risky ones (quit, empty Trash, dangerous commands).'}</div>
              </span>
            </label>
            <ul className="muted small">
              <li><b>Disarmed by default</b> — no screenshot or input until you Arm.</li>
              <li><b>Only blessed agents</b> can reach the controller; input also needs Accessibility.</li>
              <li><b>Pause</b> blocks the agent without disarming; <b>PANIC</b>{status?.panicHotkey ? ' (⌘⌥⇧P)' : ''} stops everything instantly.</li>
              <li>Screen content is treated as <b>data, never instructions</b>; every action is logged + keystrokes are recorded as a length only.</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
