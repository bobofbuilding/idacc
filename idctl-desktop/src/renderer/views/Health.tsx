import { useCallback, useEffect, useState } from 'react';
import { call, type FleetStore } from '../store.ts';
import type { UsageAgent, UsageModel, UsageReport, UsageWindow } from '../../../../idctl/src/api/client.ts';
import type { HeadroomPilotSettings } from '../../../../idctl/src/settings/schema.ts';
import { AgentTable } from './AgentTable.tsx';

type HeadroomStatus = {
  cli: { found: boolean; version?: string; error?: string };
  proxy: { url: string; reachable: boolean; httpStatus?: number; error?: string };
};
type ProbeTarget = { id?: string; name: string; team: string; status?: string };
type UsageRow = UsageAgent | UsageModel;
type HeadroomTone = 'ok' | 'warn' | 'muted';
type HeadroomReadiness = {
  tone: HeadroomTone;
  label: string;
  detail: string;
  checks: Array<{ label: string; value: string; tone: HeadroomTone }>;
};

const HEADROOM_ROUTE_LABEL: Record<HeadroomPilotSettings['mode'], string> = {
  off: 'Off',
  mcp: 'MCP tools only',
  proxy: 'Local proxy route',
  'mcp-and-proxy': 'MCP + proxy',
};

const HEADROOM_SAFETY_LABEL: Record<HeadroomPilotSettings['telemetry'], string> = {
  'verify-before-pilot': 'Verify build first',
  off: 'Telemetry off',
  on: 'Operator enabled',
};

/** Compact number: 1234 → "1.2k", 2_500_000 → "2.5M". */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function fmtTps(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n.toFixed(1);
}
function fmtPct(n: number): string {
  return `${clampInt(n, 0, 100)}%`;
}
function niceMax(v: number): number {
  const m = Math.max(v, 10);
  for (const c of [25, 50, 100, 200, 300, 500, 1000]) if (m <= c) return c;
  return Math.ceil(m / 500) * 500;
}
function ageLabel(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
function epochMs(value: number | null | undefined): number | null {
  if (!value || !Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
}
function totalTokens(row: UsageRow): number {
  return row.total ?? row.output ?? 0;
}
function rowName(row: UsageRow): string {
  return 'model' in row ? row.model : row.agent;
}
function topUsage<T extends UsageRow>(rows?: T[]): T | undefined {
  return [...(rows ?? [])].sort((a, b) => totalTokens(b) - totalTokens(a))[0];
}
function sortedUsage<T extends UsageRow>(rows?: T[]): T[] {
  return [...(rows ?? [])].sort((a, b) => totalTokens(b) - totalTokens(a));
}

/** Semicircular throughput gauge (SVG; fill grows left→right via dash offset). */
function Gauge({ value, max }: { value: number; max: number }) {
  const frac = max > 0 ? Math.max(0, Math.min(value / max, 1)) : 0;
  const path = 'M 18 84 A 72 72 0 0 1 162 84';
  return (
    <svg viewBox="0 0 180 98" className="gauge">
      <path d={path} className="gauge-track" pathLength={100} />
      <path d={path} className="gauge-fill" pathLength={100} strokeDasharray="100" strokeDashoffset={100 - frac * 100} />
      <text x="90" y="68" textAnchor="middle" className="gauge-value">{fmtTps(value)}</text>
      <text x="90" y="86" textAnchor="middle" className="gauge-unit">tok/s</text>
    </svg>
  );
}

function WindowCard({ title, w }: { title: string; w: UsageWindow }) {
  return (
    <div className="usage-card">
      <div className="usage-card-title">{title}</div>
      <div className="usage-stat"><b>{fmt(w.total)}</b><span className="muted small">tokens</span></div>
      <div className="usage-sub muted small">
        {w.count} {w.count === 1 ? 'query' : 'queries'} · {fmt(w.avgPerQuery)}/query · {fmtTps(w.avgTps)} tok/s avg
      </div>
    </div>
  );
}

function protectedCategoryLabel(category: string): string {
  const lower = category.toLowerCase();
  if (lower.includes('source code')) return 'code review';
  if (lower.includes('secrets') || lower.includes('auth')) return 'secrets/auth';
  if (lower.includes('instructions')) return 'instructions';
  if (lower.includes('validator')) return 'validator evidence';
  const cleaned = category.trim();
  return cleaned.length > 28 ? `${cleaned.slice(0, 25)}...` : cleaned;
}

function protectedCategorySummary(categories: string[]): string {
  const labels = categories.map(protectedCategoryLabel).filter(Boolean);
  const shown = labels.slice(0, 4).join(', ');
  const suffix = labels.length > 4 ? `, +${labels.length - 4} more` : '';
  const count = `${categories.length} protected ${categories.length === 1 ? 'category' : 'categories'}`;
  return shown ? `${count} (${shown}${suffix})` : count;
}
function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
function stateRootLabel(value?: string): string {
  const v = (value ?? '').trim();
  return v || '(unset)';
}
function normalizePilot(next: HeadroomPilotSettings): HeadroomPilotSettings {
  const mode = next.enabled ? next.mode : 'off';
  const root = (next.stateRoot ?? '').trim();
  return {
    ...next,
    mode,
    enabled: mode !== 'off',
    canaryPercent: clampInt(next.canaryPercent, 0, 100),
    holdoutPercent: clampInt(next.holdoutPercent, 0, 100),
    minContextTokens: clampInt(next.minContextTokens, 1000, 1_000_000),
    stateRoot: root || undefined,
  };
}
function pilotRouteLabel(pilot: HeadroomPilotSettings): string {
  return pilot.enabled ? HEADROOM_ROUTE_LABEL[pilot.mode] : HEADROOM_ROUTE_LABEL.off;
}
function pilotNeedsCli(pilot: HeadroomPilotSettings): boolean {
  return pilot.enabled && (pilot.mode === 'mcp' || pilot.mode === 'mcp-and-proxy');
}
function pilotNeedsProxy(pilot: HeadroomPilotSettings): boolean {
  return pilot.enabled && (pilot.mode === 'proxy' || pilot.mode === 'mcp-and-proxy');
}
function headroomReadiness(status: HeadroomStatus | null | undefined, pilot: HeadroomPilotSettings | null): HeadroomReadiness {
  const checks: HeadroomReadiness['checks'] = [
    {
      label: 'CLI',
      value: status === undefined ? 'checking' : status?.cli.found ? (status.cli.version || 'installed') : 'not found',
      tone: status?.cli.found ? 'ok' : status === undefined ? 'muted' : 'warn',
    },
    {
      label: 'Proxy',
      value: status === undefined ? 'checking' : status?.proxy.reachable ? `reachable${status.proxy.httpStatus ? ` HTTP ${status.proxy.httpStatus}` : ''}` : 'not reachable',
      tone: status?.proxy.reachable ? 'ok' : status === undefined ? 'muted' : 'warn',
    },
    {
      label: 'Safety',
      value: pilot ? HEADROOM_SAFETY_LABEL[pilot.telemetry] : 'policy unavailable',
      tone: pilot?.telemetry === 'on' ? 'ok' : pilot ? 'muted' : 'warn',
    },
  ];
  if (!pilot || !pilot.enabled || pilot.mode === 'off') {
    return {
      tone: 'muted',
      label: 'Direct route',
      detail: 'Pilot routing is off; agents keep using their configured model routes.',
      checks,
    };
  }
  if (!status) {
    return {
      tone: 'warn',
      label: 'Cannot verify Headroom',
      detail: 'Refresh Headroom status before relying on this pilot route.',
      checks,
    };
  }
  const missing: string[] = [];
  if (pilotNeedsCli(pilot) && !status.cli.found) missing.push('CLI');
  if (pilotNeedsProxy(pilot) && !status.proxy.reachable) missing.push('proxy');
  if (missing.length) {
    return {
      tone: 'warn',
      label: 'Pilot not ready',
      detail: `${pilotRouteLabel(pilot)} needs ${missing.join(' and ')} before canary routing should be trusted.`,
      checks,
    };
  }
  return {
    tone: 'ok',
    label: 'Pilot ready',
    detail: `${pilotRouteLabel(pilot)} can be used as a staged route with ${fmtPct(pilot.canaryPercent)} canary and ${fmtPct(pilot.holdoutPercent)} holdout.`,
    checks,
  };
}
function describePilotChanges(before: HeadroomPilotSettings, afterDraft: HeadroomPilotSettings): string[] {
  const after = normalizePilot(afterDraft);
  const rows: string[] = [];
  const push = (label: string, from: string | number, to: string | number) => {
    if (String(from) !== String(to)) rows.push(`${label}: ${from} -> ${to}`);
  };
  push('Route', pilotRouteLabel(before), pilotRouteLabel(after));
  push('Canary', `${before.canaryPercent}%`, `${after.canaryPercent}%`);
  push('Holdout', `${before.holdoutPercent}%`, `${after.holdoutPercent}%`);
  push('Min context', `${before.minContextTokens} tokens`, `${after.minContextTokens} tokens`);
  push('Workspace state', before.stateIsolation, after.stateIsolation);
  push('State root', stateRootLabel(before.stateRoot), stateRootLabel(after.stateRoot));
  push('Safety mode', HEADROOM_SAFETY_LABEL[before.telemetry], HEADROOM_SAFETY_LABEL[after.telemetry]);
  return rows;
}
function pilotStamp(pilot: HeadroomPilotSettings): string {
  return JSON.stringify(normalizePilot(pilot));
}
function probeLive(status?: string): boolean {
  const s = String(status || '').toLowerCase();
  return !!s && !/stop|offline|dead|exit|error|crash|down|disabled|sleep/.test(s);
}
function probeTargetStamp(targets: ProbeTarget[]): string {
  return targets
    .map((t) => `${t.team}:${t.id ?? ''}:${t.name}:${t.status ?? ''}`)
    .sort()
    .join('|');
}

function UsageList({ title, rows, empty }: { title: string; rows: UsageRow[]; empty: string }) {
  const shown = sortedUsage(rows).slice(0, 8);
  return (
    <div className="usage-card usage-list">
      <div className="usage-card-title">{title}</div>
      {shown.length ? shown.map((row) => (
        <div className="usage-agent-row" key={rowName(row)}>
          <span className="b mono">{rowName(row)}</span>
          <span className="muted small grow">{fmt(totalTokens(row))} tokens · {row.count}q</span>
          <span className="ok-text small" title="average output throughput rate">{fmtTps(row.avgTps)} tok/s</span>
        </div>
      )) : <span className="muted small">{empty}</span>}
    </div>
  );
}

function UsageSection({
  usage,
  usageAt,
  error,
  onRefresh,
}: {
  usage: UsageReport | null | undefined;
  usageAt: number;
  error: string | null;
  onRefresh: () => void;
}) {
  const gaugeVal = usage ? (usage.recent?.tps ?? usage.day.avgTps ?? 0) : 0;
  const gaugeMax = usage ? niceMax(Math.max(gaugeVal, usage.day.avgTps, usage.week.avgTps)) : 100;
  const localAgents = usage?.day.agents ?? [];
  const localModels = usage?.day.models ?? [];
  const topAgent = topUsage(localAgents);
  const topModel = topUsage(localModels);
  const recentAt = epochMs(usage?.recent?.at);
  const throughputLabel = usage?.recent?.tps != null ? 'Recent sample' : '24h average';

  return (
    <section className="card health-section">
      <div className="row-actions health-section-head">
        <h3 className="grow">Token throughput</h3>
        <span className="muted small" title="auto-refreshes every 15s and after probes">{usageAt ? `updated ${ageLabel(usageAt)}` : usage === undefined ? 'loading...' : ''}</span>
        <button className="btn small" onClick={onRefresh}>Refresh</button>
      </div>
      {usage === undefined ? (
        <p className="muted small">Loading local-model usage...</p>
      ) : usage === null ? (
        <p className="muted small">
          {error
            ? `Token usage refresh failed: ${error}`
            : <>Token usage is not available on this manager (no <span className="mono">/usage</span> route).</>}
        </p>
      ) : usage.week.count === 0 ? (
        <p className="muted small">
          No local-model activity recorded yet. Probe or message a local-model agent and Health will start tracking throughput. Cloud API runtimes are excluded.
        </p>
      ) : (
        <>
          <div className="health-metrics">
            <div className="health-metric primary">
              <span>{throughputLabel}</span>
              <b>{fmtTps(gaugeVal)} tok/s</b>
              <small>{usage.recent ? `${usage.recent.agent} · ${usage.recent.model}${recentAt ? ` · ${ageLabel(recentAt)}` : ''}` : 'fallback from 24h average'}</small>
            </div>
            <div className="health-metric">
              <span>24h tokens</span>
              <b>{fmt(usage.day.total)}</b>
              <small>{usage.day.count} turns · {fmt(usage.day.avgPerQuery)}/turn</small>
            </div>
            <div className="health-metric">
              <span>7d tokens</span>
              <b>{fmt(usage.week.total)}</b>
              <small>{usage.week.count} turns · {fmtTps(usage.week.avgTps)} tok/s avg</small>
            </div>
            <div className="health-metric">
              <span>Top spender</span>
              <b>{topAgent ? rowName(topAgent) : 'none'}</b>
              <small>{topAgent ? `${fmt(totalTokens(topAgent))} tokens` : 'no 24h agent data'}</small>
            </div>
            <div className="health-metric">
              <span>Top model</span>
              <b>{topModel ? rowName(topModel) : 'none'}</b>
              <small>{topModel ? `${fmt(totalTokens(topModel))} tokens` : 'no 24h model data'}</small>
            </div>
          </div>
          <div className="usage-grid">
            <div className="gauge-wrap">
              <Gauge value={gaugeVal} max={gaugeMax} />
              <div className="gauge-cap">throughput</div>
              <div className="muted small" style={{ textAlign: 'center' }}>
                24h avg {fmtTps(usage.day.avgTps)} · 7d avg {fmtTps(usage.week.avgTps)} tok/s
              </div>
            </div>
            <WindowCard title="Last 24 hours" w={usage.day} />
            <WindowCard title="Last 7 days" w={usage.week} />
          </div>
          <div className="usage-breakdown">
            <UsageList title="By model - 24h" rows={localModels} empty="No model breakdown from this manager yet." />
            <UsageList title="By agent - 24h" rows={localAgents} empty="No agent breakdown from this manager yet." />
          </div>
        </>
      )}
    </section>
  );
}

function HeadroomSection({
  headroom,
  headroomAt,
  pilot,
  draft,
  pilotDirty,
  pilotChanges,
  pilotSaving,
  onDraft,
  onApply,
  onRevert,
  onRefresh,
}: {
  headroom: HeadroomStatus | null | undefined;
  headroomAt: number;
  pilot: HeadroomPilotSettings | null | undefined;
  draft: HeadroomPilotSettings | null;
  pilotDirty: boolean;
  pilotChanges: string[];
  pilotSaving: boolean;
  onDraft: (partial: Partial<HeadroomPilotSettings>) => void;
  onApply: () => void;
  onRevert: () => void;
  onRefresh: () => void;
}) {
  const readiness = headroomReadiness(headroom, draft);
  const pilotRoute = draft?.enabled ? draft.mode : 'off';
  return (
    <section className="card health-section">
      <div className="row-actions health-section-head">
        <h3 className="grow">Headroom pilot</h3>
        <span className="muted small">{headroomAt ? `updated ${ageLabel(headroomAt)}` : headroom === undefined ? 'checking...' : ''}</span>
        {draft?.enabled ? <button className="btn small" disabled={pilotSaving} onClick={() => onDraft({ mode: 'off', enabled: false })}>Disable pilot</button> : null}
        {pilotDirty ? (
          <>
            <button className="btn small" disabled={pilotSaving} onClick={onRevert}>Revert</button>
            <button className="btn primary small" disabled={pilotSaving} onClick={onApply}>{pilotSaving ? 'Saving...' : 'Apply policy'}</button>
          </>
        ) : null}
        <button className="btn small" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="headroom-grid">
        <div className={`headroom-readiness ${readiness.tone}`}>
          <span className="usage-card-title">Pilot readiness</span>
          <b>{readiness.label}</b>
          <small>{readiness.detail}</small>
          <div className="headroom-checks">
            {readiness.checks.map((check) => (
              <span className={`headroom-check ${check.tone}`} key={check.label}>
                {check.label}: <b>{check.value}</b>
              </span>
            ))}
          </div>
        </div>
        <div>
          {headroom === undefined ? (
            <p className="muted small">Checking local Headroom status...</p>
          ) : headroom === null ? (
            <p className="muted small">Headroom status is unavailable in this build.</p>
          ) : (
            <div className="headroom-status-strip">
              <span>CLI <b className={headroom.cli.found ? 'ok-text' : 'warn-text'}>{headroom.cli.found ? (headroom.cli.version || 'installed') : 'not installed'}</b></span>
              <span>Proxy <b className={headroom.proxy.reachable ? 'ok-text' : 'muted'}>{headroom.proxy.reachable ? `reachable${headroom.proxy.httpStatus ? ` HTTP ${headroom.proxy.httpStatus}` : ''}` : 'direct fallback'}</b></span>
            </div>
          )}
          {pilot && draft ? (
            <>
              <div className="kv headroom-policy">
                <span>Route</span>
                <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    className="cell-select"
                    value={pilotRoute}
                    disabled={pilotSaving}
                    onChange={(e) => {
                      const mode = e.target.value as HeadroomPilotSettings['mode'];
                      onDraft({ mode, enabled: mode !== 'off' });
                    }}
                  >
                    <option value="off">off</option>
                    <option value="mcp">MCP tools only</option>
                    <option value="proxy">local proxy route</option>
                    <option value="mcp-and-proxy">MCP + proxy</option>
                  </select>
                  <span className={draft.enabled ? 'ok-text small' : 'muted small'}>
                    {draft.enabled ? HEADROOM_ROUTE_LABEL[draft.mode] : 'direct route'}
                  </span>
                </b>
                <span>Rollout</span>
                <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <label className="muted small">canary <input type="number" min={0} max={100} style={{ width: 58 }} value={draft.canaryPercent} disabled={pilotSaving} onChange={(e) => onDraft({ canaryPercent: Number(e.target.value) })} />%</label>
                  <label className="muted small">holdout <input type="number" min={0} max={100} style={{ width: 58 }} value={draft.holdoutPercent} disabled={pilotSaving} onChange={(e) => onDraft({ holdoutPercent: Number(e.target.value) })} />%</label>
                  <label className="muted small">min context <input type="number" min={1000} step={1000} style={{ width: 84 }} value={draft.minContextTokens} disabled={pilotSaving} onChange={(e) => onDraft({ minContextTokens: Number(e.target.value) })} /> tokens</label>
                </b>
                <span>State</span>
                <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                  <select
                    className="cell-select"
                    value={draft.stateIsolation}
                    disabled={pilotSaving}
                    onChange={(e) => onDraft({ stateIsolation: e.target.value as HeadroomPilotSettings['stateIsolation'] })}
                  >
                    <option value="per-agent">per agent</option>
                    <option value="per-team">per team</option>
                  </select>
                  <span className="muted small">{draft.stateIsolation === 'per-agent' ? 'separate state per agent' : 'shared within each team'}</span>
                </b>
                <span>Guardrails</span>
                <b className="muted small">
                  {protectedCategorySummary(draft.passthroughContent)} · {draft.validationGates.length} gates · direct fallback
                </b>
              </div>
              <details className="headroom-advanced">
                <summary>Advanced policy</summary>
                <div className="kv" style={{ gridTemplateColumns: '150px 1fr', gap: '7px 12px', marginTop: 10 }}>
                  <span>MCP route</span>
                  <b className="muted small">Capabilities &gt; MCP servers &gt; Headroom (context compression)</b>
                  <span>Raw proxy URL</span>
                  <b className="muted small mono">{headroom?.proxy.url ?? 'unavailable'}</b>
                  <span>Workspace state path</span>
                  <b>
                    <input
                      style={{ width: '100%' }}
                      placeholder="optional state root, e.g. ~/.headroom/idacc"
                      value={draft.stateRoot ?? ''}
                      disabled={pilotSaving}
                      onChange={(e) => onDraft({ stateRoot: e.target.value })}
                    />
                  </b>
                  <span>Safety mode</span>
                  <b className="row-actions" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                    <select
                      className="cell-select"
                      value={draft.telemetry}
                      disabled={pilotSaving}
                      style={{ minWidth: 150 }}
                      onChange={(e) => onDraft({ telemetry: e.target.value as HeadroomPilotSettings['telemetry'] })}
                    >
                      <option value="verify-before-pilot">verify build first</option>
                      <option value="off">force off</option>
                      <option value="on">operator enabled</option>
                    </select>
                    <span className="muted small">{HEADROOM_SAFETY_LABEL[draft.telemetry]}</span>
                  </b>
                  <span>Protected content</span>
                  <b className="headroom-trust-detail">
                    <span className="muted small">Protected content stays on direct routes unless a task explicitly opts in.</span>
                    <span className="chips">{draft.passthroughContent.map((x) => <span className="chip tag" key={x}>{x}</span>)}</span>
                    <span className="muted small">Validation gates: {draft.validationGates.join(' · ')}</span>
                  </b>
                </div>
              </details>
              {pilotDirty ? <p className="muted small">Unsaved pilot policy changes: {pilotChanges.length}</p> : null}
              {pilotSaving ? <p className="muted small">Saving pilot policy...</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function Health({ store, navigate }: { store: FleetStore; navigate?: (view: string) => void }) {
  const [probing, setProbing] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageReport | null | undefined>(undefined); // undefined = loading
  const [usageError, setUsageError] = useState<string | null>(null);
  const [headroom, setHeadroom] = useState<HeadroomStatus | null | undefined>(undefined);
  const [pilot, setPilot] = useState<HeadroomPilotSettings | null | undefined>(undefined);
  const [pilotDraft, setPilotDraft] = useState<HeadroomPilotSettings | null>(null);
  const [pilotSaving, setPilotSaving] = useState(false);
  const [usageAt, setUsageAt] = useState<number>(0); // when usage was last refreshed
  const [headroomAt, setHeadroomAt] = useState<number>(0);
  const [, setTick] = useState(0); // 1 Hz re-render so "updated Ns ago" stays live

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await call<UsageReport | null>('usage'));
      setUsageError(null);
      setUsageAt(Date.now());
    } catch (err) {
      setUsage(null);
      setUsageError(err instanceof Error ? err.message : String(err));
      setUsageAt(Date.now());
    }
  }, []);
  // Auto-refresh usage on open/manager reconnect and every 15s. Avoid tying this
  // to the 3s fleet poll; throughput is its own observability stream.
  useEffect(() => { void loadUsage(); }, [loadUsage, store.connection, store.managerUrl]);

  const loadHeadroom = useCallback(async () => {
    try {
      const [status, policy] = await Promise.all([
        call<HeadroomStatus>('headroom:status'),
        call<HeadroomPilotSettings>('headroom:pilot'),
      ]);
      setHeadroom(status);
      setPilot(policy);
      setPilotDraft(policy);
      setHeadroomAt(Date.now());
    } catch {
      setHeadroom(null);
      setPilot(null);
      setPilotDraft(null);
      setHeadroomAt(Date.now());
    }
  }, []);
  // Headroom policy is local settings, not fleet liveness. Refresh on open or
  // manager context changes, and manually from the panel; do not wipe staged edits
  // on the normal fleet poll.
  useEffect(() => { void loadHeadroom(); }, [loadHeadroom, store.connection, store.managerUrl]);

  useEffect(() => {
    const iv = setInterval(() => void loadUsage(), 15000);
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { clearInterval(iv); clearInterval(t); };
  }, [loadUsage]);

  // The fleet roster is the shared, live AgentTable below. Probing routes to the agent's
  // own team (holistic) or the active team — it exercises the dispatch path; the agent's
  // live status (in the roster) and the throughput gauge reflect the result.
  async function probe(which: 'all' | string, team?: string) {
    setProbing(which);
    try {
      await call(which === 'all' ? 'probeAll' : 'probeOne', ...(which === 'all' ? [] : [which, team]));
    } catch (err) {
      window.alert(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProbing(null);
      void loadUsage(); // refresh throughput after exercising agents
    }
  }
  async function currentProbeTargets(): Promise<ProbeTarget[]> {
    const groups = await call<Array<{ team: string; agents: ProbeTarget[] }>>('agents:allTeams').catch(() => null);
    const targets = groups
      ? groups.flatMap((g) => g.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, team: g.team })))
      : store.agents.map((a) => ({ id: a.id, name: a.name, status: a.status, team: store.team ?? 'default' }));
    return targets.filter((a) => probeLive(a.status));
  }
  async function probeAllVisible() {
    if (probing) return;
    setProbing('all');
    try {
      const targets = await currentProbeTargets();
      if (!targets.length) {
        window.alert('No running agents are available to probe. Use Health > show stopped to review stopped agents.');
        return;
      }
      const teams = [...new Set(targets.map((t) => t.team))].sort();
      const sample = targets.slice(0, 12).map((t) => `- ${t.team}/${t.name} (${t.status ?? 'unknown'})`);
      if (!window.confirm([
        `Probe ${targets.length} running agent${targets.length === 1 ? '' : 's'} across ${teams.length} team${teams.length === 1 ? '' : 's'}?`,
        '',
        ...sample,
        targets.length > sample.length ? `- ...and ${targets.length - sample.length} more` : '',
        '',
        'This exercises each current agent probe route and refreshes usage afterward. Stopped agents are skipped.',
      ].filter(Boolean).join('\n'))) return;
      const afterConfirm = await currentProbeTargets();
      if (probeTargetStamp(afterConfirm) !== probeTargetStamp(targets)) {
        window.alert('Probe all blocked: the running-agent set changed during confirmation. Health will refresh; review the current roster and try again.');
        store.refresh();
        return;
      }
      const results = await Promise.allSettled(afterConfirm.map((target) => call('probeOne', target.name, target.team)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) window.alert(`Probe completed with ${failed}/${afterConfirm.length} failed probe${failed === 1 ? '' : 's'}. Review the refreshed Health roster for details.`);
    } finally {
      setProbing(null);
      void loadUsage();
    }
  }
  function updatePilotDraft(partial: Partial<HeadroomPilotSettings>) {
    setPilotDraft((current) => (current ? { ...current, ...partial } : current));
  }
  async function applyPilotPolicy() {
    if (!pilot || !pilotDraft) return;
    const next = normalizePilot(pilotDraft);
    const changes = describePilotChanges(pilot, next);
    if (!changes.length) return;
    const reviewedStatus = await call<HeadroomStatus>('headroom:status').catch(() => headroom ?? null);
    setHeadroom(reviewedStatus);
    setHeadroomAt(Date.now());
    const readiness = headroomReadiness(reviewedStatus, next);
    const reviewedPilot = await call<HeadroomPilotSettings>('headroom:pilot').catch(() => null);
    if (!reviewedPilot) {
      window.alert('Could not verify the current Headroom pilot policy before applying. Refresh Health and try again.');
      return;
    }
    if (pilotStamp(reviewedPilot) !== pilotStamp(pilot)) {
      setPilot(reviewedPilot);
      setPilotDraft(reviewedPilot);
      window.alert('Headroom pilot policy changed since this page rendered. Health refreshed the current policy; review and stage the change again.');
      return;
    }
    const ok = window.confirm([
      'Apply Headroom pilot policy?',
      '',
      `Readiness: ${readiness.label}`,
      readiness.detail,
      '',
      'Changes:',
      ...changes.map((row) => `- ${row}`),
      '',
      'This stores local pilot policy and can affect future Headroom routing choices. It does not install Headroom, start the proxy, or mutate Brain facts.',
    ].join('\n'));
    if (!ok) return;
    const latestPilot = await call<HeadroomPilotSettings>('headroom:pilot').catch(() => null);
    if (!latestPilot) {
      window.alert('Could not verify the Headroom pilot policy after the review prompt. No policy was written.');
      return;
    }
    if (pilotStamp(latestPilot) !== pilotStamp(pilot)) {
      setPilot(latestPilot);
      setPilotDraft(latestPilot);
      window.alert('Headroom pilot policy changed after the review prompt. No policy was written; review the refreshed policy and try again.');
      return;
    }
    setPilotSaving(true);
    try {
      const saved = await call<HeadroomPilotSettings>('headroom:setPilot', next);
      setPilot(saved);
      setPilotDraft(saved);
    } catch (err) {
      window.alert(`Headroom pilot update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPilotSaving(false);
    }
  }
  const draft = pilotDraft ?? pilot ?? null;
  const pilotChanges = pilot && draft ? describePilotChanges(pilot, draft) : [];
  const pilotDirty = pilotChanges.length > 0;
  async function refreshHeadroom() {
    if (pilotDirty && !window.confirm('Discard unsaved Headroom pilot edits and refresh status?')) return;
    await loadHeadroom();
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Health &amp; Probes</h1>
        <button className="btn primary" disabled={!!probing} onClick={() => void probeAllVisible()}>
          {probing === 'all' ? 'Probing…' : 'Probe all'}
        </button>
      </header>

      <UsageSection usage={usage} usageAt={usageAt} error={usageError} onRefresh={() => void loadUsage()} />

      <HeadroomSection
        headroom={headroom}
        headroomAt={headroomAt}
        pilot={pilot}
        draft={draft}
        pilotDirty={pilotDirty}
        pilotChanges={pilotChanges}
        pilotSaving={pilotSaving}
        onDraft={updatePilotDraft}
        onApply={() => void applyPilotPolicy()}
        onRevert={() => setPilotDraft(pilot ?? null)}
        onRefresh={() => void refreshHeadroom()}
      />

      {/* The fleet roster is the shared AgentTable — runtime/model dropdowns + lifecycle
          actions + per-row Probe, live & holistic (all teams grouped in "All teams" view). */}
      <AgentTable store={store} onProbe={(a) => void probe(a.name, store.viewAll ? a.team : undefined)} probeBusy={probing} navigate={navigate} />
    </div>
  );
}
