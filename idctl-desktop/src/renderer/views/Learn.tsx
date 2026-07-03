import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import type {
  LearnMaterial,
  LearnMaterialKind,
  LearnPriority,
  LearnRecommendation,
  LearnReviewState,
} from '../../main/materialstore.ts';

type GoalStatus = 'draft' | 'active' | 'done' | 'archived';
type GoalPriority = 'primary' | 'secondary' | 'general';
interface Goal {
  id: string;
  title: string;
  idea: string;
  agent?: string;
  team: string;
  status: GoalStatus;
  priority?: GoalPriority;
  autopilot?: boolean;
  content: string;
  createdAt: number;
  updatedAt: number;
}
interface RecoverStaleResult { recovered: number; materials: LearnMaterial[] }
type CreatedTask = { ok: boolean; ref?: string; title?: string; error?: string };
type CreatePlanResult = { created: CreatedTask[]; dispatched: number; deferred: number };

const PRIORITIES: LearnPriority[] = ['urgent', 'high', 'normal'];
const KIND_LABEL: Record<LearnMaterialKind, string> = { github: 'GitHub', folder: 'Folder', site: 'Site', pdf: 'PDF' };
const STALE_PROCESSING_MS = 20 * 60 * 1000;
const STATUS_CLASS: Record<string, string> = {
  queued: 'st-paused',
  processing: 'st-active',
  ready: 'st-done',
  blocked: 'st-blocked',
  failed: 'st-blocked',
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function ago(ts: number): string {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function clip(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

function isStaleProcessing(m: LearnMaterial): boolean {
  return m.status === 'processing' && Date.now() - m.updatedAt > STALE_PROCESSING_MS;
}

function safeLearnTeam(team: string): string {
  const t = String(team || '').trim();
  return !t || t === 'public' ? 'default' : t;
}

function materialStageText(m: LearnMaterial): string {
  if (m.status === 'blocked' && (m.injectionWarnings?.length ?? 0) > 0) return 'review source trust';
  if (m.status === 'blocked') return 'review needed';
  if (m.status === 'queued' && m.processingTag === 'requeued after stale processing') return 'queued after recovery';
  if (m.status === 'ready') return 'ready for review';
  return m.processingTag || m.stage;
}

function blockedMaterialMessage(m: LearnMaterial): string {
  if ((m.injectionWarnings?.length ?? 0) > 0) {
    return 'This material contains instruction-like text. IDACC treated it as untrusted source content, kept the extracted summary/recommendations for review, and paused only this material before downstream routing.';
  }
  return 'This material has a review-gated recommendation. Review or dismiss the recommendation before using it to drive downstream automation.';
}

function sourceKind(source: string, picked: 'auto' | LearnMaterialKind): LearnMaterialKind | undefined {
  if (picked !== 'auto') return picked;
  try {
    const u = new URL(source);
    return /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i.test(u.hostname) ? 'github' : 'site';
  } catch {
    return undefined;
  }
}

export function Learn({ store }: { store: FleetStore }) {
  const syncVersion = useSyncVersion(['materials', 'work', 'brain', 'inbox']);
  const [materials, setMaterials] = useState<LearnMaterial[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'auto' | LearnMaterialKind>('auto');
  const [priority, setPriority] = useState<LearnPriority>('normal');
  const [pinTop, setPinTop] = useState(false);
  const [autoProcess, setAutoProcess] = useState(() => {
    try { return window.localStorage.getItem('idacc.learn.autoProcess') !== '0'; } catch { return true; }
  });
  const autoProcessInFlight = useRef(false);
  const coordinator = resolveCoordinator(store.agents, store.coordinator) ?? store.agents[0]?.name ?? '';

  async function reload() {
    const list = await call<LearnMaterial[]>('materials:list').catch(() => []);
    setMaterials(list);
    setSelectedId((cur) => (cur && list.some((m) => m.id === cur) ? cur : (list[0]?.id ?? '')));
  }

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [syncVersion, store.lastUpdated]);

  const selected = useMemo(() => materials.find((m) => m.id === selectedId) ?? materials[0] ?? null, [materials, selectedId]);
  const processing = materials.find((m) => m.status === 'processing');
  const staleProcessing = useMemo(() => materials.filter(isStaleProcessing), [materials]);
  const queuedCount = useMemo(() => materials.filter((m) => m.status === 'queued').length, [materials]);
  const context = {
    knownTeams: store.teams.map((t) => t.name).filter(Boolean),
    defaultTeam: store.team ?? 'default',
  };

  useEffect(() => {
    try { window.localStorage.setItem('idacc.learn.autoProcess', autoProcess ? '1' : '0'); } catch { /* ignore */ }
  }, [autoProcess]);

  useEffect(() => {
    if (!autoProcess || busy || queuedCount < 1 || staleProcessing.length > 0) return;
    if (processing && !isStaleProcessing(processing)) return;
    if (autoProcessInFlight.current) return;
    autoProcessInFlight.current = true;
    const timer = window.setTimeout(() => {
      void processNext(true).finally(() => { autoProcessInFlight.current = false; });
    }, 500);
    return () => {
      window.clearTimeout(timer);
      autoProcessInFlight.current = false;
    };
    // The queue runner intentionally keys off material state, not the processNext function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoProcess, busy, queuedCount, processing?.id, processing?.updatedAt, staleProcessing.length, syncVersion, store.lastUpdated]);

  async function addUrl() {
    const src = source.trim();
    if (!src) { setNote('add a source first'); return; }
    setBusy(true); setNote('');
    try {
      const material = await call<LearnMaterial>('materials:save', {
        title: title.trim() || undefined,
        source: src,
        kind: sourceKind(src, kind),
        priority,
        prioritized: pinTop,
      });
      setSource(''); setTitle(''); setSelectedId(material.id); setNote('material added');
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFolder() {
    setBusy(true); setNote('');
    try {
      const folder = await call<string | null>('materials:pickFolder');
      if (!folder) return;
      const material = await call<LearnMaterial>('materials:save', { source: folder, kind: 'folder', priority, prioritized: pinTop });
      setSelectedId(material.id); setNote('folder added');
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importPdfs() {
    setBusy(true); setNote('');
    try {
      const picked = await call<{ path: string }[]>('materials:pickFiles');
      if (!picked.length) return;
      const imported = await call<LearnMaterial[]>('materials:importFiles', picked.map((p) => p.path), { priority, prioritized: pinTop });
      setSelectedId(imported[0]?.id ?? selectedId);
      setNote(`${imported.length} material${imported.length === 1 ? '' : 's'} imported`);
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setMaterialPriority(m: LearnMaterial, p: LearnPriority, pinned = m.prioritized) {
    setBusy(true); setNote('');
    try {
      const updated = await call<LearnMaterial>('materials:priority', m.id, p, pinned);
      setSelectedId(updated.id);
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function processNext(auto = false) {
    if (processing && !isStaleProcessing(processing)) {
      if (!auto) {
        setSelectedId(processing.id);
        setNote('a material is already processing');
      }
      return;
    }
    setBusy(true); setNote(auto ? 'auto-processing next material...' : 'processing next material...');
    try {
      if (processing) await call<RecoverStaleResult>('materials:recoverStale').catch(() => null);
      const material = await call<LearnMaterial | null>('materials:processNext', context);
      setNote(material ? `${auto ? 'auto-processed' : 'processed'} ${material.title}` : 'queue is empty');
      if (material) setSelectedId(material.id);
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function processSelected() {
    if (!selected) return;
    if (processing && processing.id !== selected.id && !isStaleProcessing(processing)) { setSelectedId(processing.id); setNote('a material is already processing'); return; }
    setBusy(true); setNote(`processing ${selected.title}...`);
    try {
      if (selected.status === 'processing' && isStaleProcessing(selected)) {
        const recovered = await call<RecoverStaleResult>('materials:recoverStale');
        setNote(`recovered ${recovered.recovered} stale material${recovered.recovered === 1 ? '' : 's'}`);
        await reload();
        return;
      }
      const material = await call<LearnMaterial>('materials:process', selected.id, context);
      setNote(`processed ${material.title}`);
      setSelectedId(material.id);
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    if (!selected) return;
    if (!window.confirm(`Remove Learn material "${selected.title}"?`)) return;
    setBusy(true); setNote('');
    try {
      await call('materials:remove', selected.id);
      setSelectedId('');
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function recoverStale() {
    setBusy(true); setNote('recovering stale Learn processing state...');
    try {
      const recovered = await call<RecoverStaleResult>('materials:recoverStale');
      setMaterials(recovered.materials);
      setSelectedId((cur) => (cur && recovered.materials.some((m) => m.id === cur) ? cur : (recovered.materials[0]?.id ?? '')));
      setNote(`recovered ${recovered.recovered} stale material${recovered.recovered === 1 ? '' : 's'}`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function markRecommendation(rec: LearnRecommendation, state: LearnReviewState) {
    if (!selected) return;
    const updated = await call<LearnMaterial>('materials:markRecommendation', selected.id, rec.id, state);
    setSelectedId(updated.id);
    await reload();
  }

  async function acceptRecommendation(rec: LearnRecommendation) {
    if (!selected) return;
    const team = safeLearnTeam(rec.team || selected.classification?.routedTeams?.[0] || store.team || 'default');
    const now = Date.now();
    try {
      if (rec.type === 'question') {
        await call('questions:add', {
          question: rec.body || rec.title,
          options: rec.options?.length ? rec.options : ['Approve', 'Hold off'],
          agent: '',
          taskRef: `learn:${selected.id}`,
          taskTitle: selected.title,
          team,
          dedupeKey: `learn:${selected.id}:${rec.id}`,
        });
      } else if (rec.type === 'goal') {
        if (!window.confirm(`Create a draft goal from "${rec.title}"?`)) return;
        const goal: Goal = {
          id: newId('goal'),
          title: rec.title,
          idea: rec.body,
          agent: coordinator,
          team,
          status: 'draft',
          priority: 'general',
          autopilot: false,
          content: rec.body,
          createdAt: now,
          updatedAt: now,
        };
        await call('goals:save', goal);
      } else if (rec.type === 'task' || rec.type === 'feature') {
        const description = [
          rec.body || rec.title,
          '',
          `Source Learn material: ${selected.title}`,
          `Source type: ${selected.kind}`,
          rec.type === 'feature' ? 'Review as a proposed workflow/feature update before implementation.' : 'Review and execute as a queued task.',
        ].filter(Boolean).join('\n');
        const result = await call<CreatePlanResult>('work:createPlan', rec.title, [{
          title: rec.title,
          description,
          agent: coordinator,
          dependsOn: [],
        }], { dispatch: false, lane: 'todo', team, respectOwners: true });
        const ok = result.created?.filter((t) => t.ok) ?? [];
        if (!ok.length) {
          const err = result.created?.find((t) => t.error)?.error ?? 'manager did not create a task';
          throw new Error(`task creation failed: ${err}`);
        }
      }
      await markRecommendation(rec, 'accepted');
      setNote(rec.type === 'task' || rec.type === 'feature' ? `created queued task for ${rec.type} recommendation` : `accepted ${rec.type} recommendation`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack">
      <section className="card learn-intake">
        <div className="learn-intake-head">
          <div>
            <h3>Learn intake</h3>
            {note ? <div className="muted small">{note}</div> : null}
          </div>
          <label className="learn-auto small" title="When enabled, queued materials are processed one at a time. Review-gated or blocked materials still stop before downstream automation.">
            <input type="checkbox" checked={autoProcess} onChange={(e) => setAutoProcess(e.target.checked)} />
            <span>Auto-process queue</span>
            {queuedCount ? <span className="muted">({queuedCount})</span> : null}
          </label>
        </div>
        {staleProcessing.length ? (
          <div className="review-box" style={{ marginBottom: 10 }}>
            <div>
              <b>{staleProcessing.length} stale processing material{staleProcessing.length === 1 ? '' : 's'}</b>
              <div className="muted small">These rows were left in processing and are blocking the one-at-a-time Learn queue.</div>
            </div>
            <button className="btn primary" disabled={busy} onClick={() => void recoverStale()}>
              Recover queue
            </button>
          </div>
        ) : null}
        <div className="learn-intake-grid">
          <div className="learn-main-fields">
            <label className="learn-field learn-source">
              <span className="muted small">Source</span>
              <input value={source} disabled={busy} placeholder="GitHub URL, site URL, or use Folder/PDF import" onChange={(e) => setSource(e.target.value)} />
            </label>
            <label className="learn-field learn-title">
              <span className="muted small">Title</span>
              <input value={title} disabled={busy} placeholder="optional title" onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>
          <div className="learn-control-row">
            <label className="learn-field learn-kind">
              <span className="muted small">Type</span>
              <select className="cell-select" value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as 'auto' | LearnMaterialKind)}>
                <option value="auto">auto</option>
                <option value="github">GitHub</option>
                <option value="site">Site</option>
              </select>
            </label>
            <label className="learn-field learn-priority">
              <span className="muted small">Priority</span>
              <select className="cell-select" value={priority} disabled={busy} onChange={(e) => setPriority(e.target.value as LearnPriority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="learn-pin small">
              <input type="checkbox" checked={pinTop} disabled={busy} onChange={(e) => setPinTop(e.target.checked)} />
              <span>Prioritize</span>
            </label>
            <div className="learn-actions">
              <button className="btn primary" disabled={busy || !source.trim()} onClick={() => void addUrl()}>Add</button>
              <button className="btn" disabled={busy} onClick={() => void addFolder()}>Folder</button>
              <button className="btn" disabled={busy} onClick={() => void importPdfs()}>Import PDF</button>
              <button className="btn" disabled={busy} onClick={() => void processNext(false)}>{busy ? 'Working...' : 'Process next'}</button>
            </div>
          </div>
        </div>
      </section>

      <div className="split">
        <section className="card grow">
          <h3>Queue <span className="muted small">- {materials.length} material{materials.length === 1 ? '' : 's'}</span></h3>
          {materials.length ? (
            <table className="grid">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Priority</th>
                  <th>Stage</th>
                  <th>Route</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => (
                  <tr key={m.id} className={selected?.id === m.id ? 'sel' : ''} onClick={() => setSelectedId(m.id)}>
                    <td>
                      <b>{m.prioritized ? 'Top - ' : ''}{m.title}</b>
                      <div className="muted small">{KIND_LABEL[m.kind]} - {clip(m.source, 70)}</div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select className="cell-select small" value={m.priority} disabled={busy} onChange={(e) => void setMaterialPriority(m, e.target.value as LearnPriority)}>
                        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                      </select>{' '}
                      <button className="btn small" disabled={busy} title={m.prioritized ? 'Remove top priority pin' : 'Prioritize to top'} onClick={() => void setMaterialPriority(m, m.priority, !m.prioritized)}>{m.prioritized ? 'Unpin' : 'Top'}</button>
                    </td>
                    <td><span className={`status ${STATUS_CLASS[m.status] ?? ''}`}>{m.status}</span><div className="muted small">{materialStageText(m)}</div></td>
                    <td className="small">{m.classification?.routedTeams?.join(', ') || '-'}</td>
                    <td className="muted small" title={new Date(m.createdAt).toLocaleString()}>{ago(m.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted center pad">No Learn materials yet.</div>
          )}
        </section>

        <section className="card grow">
          <h3>Review <span className="muted small">{selected ? `- ${selected.title}` : ''}</span></h3>
          {selected ? (
            <div className="stack">
              <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary" disabled={busy || (selected.status === 'processing' && !isStaleProcessing(selected))} onClick={() => void processSelected()}>
                  {selected.status === 'processing' && isStaleProcessing(selected) ? 'Recover selected' : selected.status === 'queued' || selected.status === 'failed' ? 'Process selected' : selected.status === 'blocked' ? 'Reprocess after review' : 'Reprocess'}
                </button>
                <button className="btn" disabled={busy} onClick={() => void removeSelected()}>Remove</button>
                {selected.snapshotPath ? <span className="muted small">snapshot: {selected.snapshotPath}</span> : null}
              </div>
              {selected.status === 'blocked' ? (
                <div className="learn-review-callout">
                  <div>
                    <b>Blocked for review</b>
                    <div className="muted small">{blockedMaterialMessage(selected)}</div>
                    <div className="muted small">Other queued Learn materials can still process. Use the recommendation controls below to create review work, or reprocess after reviewing the source.</div>
                  </div>
                  <button className="btn" disabled={busy} onClick={() => void processNext()}>Process next queued</button>
                </div>
              ) : null}
              <div className="kv" style={{ gridTemplateColumns: '92px 1fr', gap: '6px 12px' }}>
                <span className="muted small">Status</span><b>{selected.status} / {materialStageText(selected)}</b>
                <span className="muted small">Topics</span><span>{selected.classification?.topics?.join(', ') || '-'}</span>
                <span className="muted small">Teams</span><span>{selected.classification?.routedTeams?.join(', ') || '-'}</span>
                <span className="muted small">Goals</span><span>{selected.activeGoalMatches?.length ? selected.activeGoalMatches.map((g) => `${g.priority ?? 'general'} · ${g.team}/${g.title}`).join(', ') : '-'}</span>
              </div>

              {selected.injectionWarnings?.length || selected.extractionWarnings?.length ? (
                <div className="status-error small">
                  {[...(selected.injectionWarnings ?? []), ...(selected.extractionWarnings ?? [])].slice(0, 8).map((w) => <div key={w}>{w}</div>)}
                </div>
              ) : null}

              {selected.summary ? (
                <pre className="plan-content" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{selected.summary}</pre>
              ) : null}
              {selected.comparison ? (
                <pre className="plan-content" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{selected.comparison}</pre>
              ) : null}

              <div>
                <h3>Recommendations</h3>
                {selected.recommendations?.length ? selected.recommendations.map((rec) => (
                  <RecommendationRow
                    key={rec.id}
                    rec={rec}
                    disabled={busy}
                    onAccept={() => void acceptRecommendation(rec)}
                    onDismiss={() => void markRecommendation(rec, 'dismissed')}
                  />
                )) : <div className="muted small">No recommendations yet.</div>}
              </div>

              {selected.routing?.length ? (
                <div>
                  <h3>Routing</h3>
                  {selected.routing.map((r) => (
                    <div className="small" key={`${r.team}-${r.lead ?? r.status}`}>
                      <b>{r.team}</b> - {r.status}{r.lead ? ` via ${r.lead}` : ''}{r.queryId ? ` - ${r.queryId}` : ''}{r.detail ? ` - ${r.detail}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}

              <div>
                <h3>Progress</h3>
                {(selected.progress ?? []).slice().reverse().slice(0, 12).map((p) => (
                  <div className="small" key={`${p.at}-${p.stage}-${p.note}`}>
                    <span className="muted">{new Date(p.at).toLocaleTimeString()} - {p.stage} - </span>{p.note}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="muted center pad">Select a material.</div>
          )}
        </section>
      </div>
    </div>
  );
}

function RecommendationRow({ rec, disabled, onAccept, onDismiss }: {
  rec: LearnRecommendation;
  disabled: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const stateClass = rec.reviewState === 'accepted' ? 'st-done' : rec.reviewState === 'dismissed' ? 'st-blocked' : rec.blocking ? 'st-blocked' : 'st-paused';
  return (
    <div className="inbox-row">
      <div className="row-actions" style={{ justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div className="inbox-from">{rec.type}{rec.team ? ` - ${rec.team}` : ''}</div>
          <div className="inbox-msg b">{rec.title}</div>
        </div>
        <span className={`status ${stateClass}`}>{rec.reviewState}{rec.blocking ? ' / blocks' : ''}</span>
      </div>
      <div className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{rec.body}</div>
      {rec.options?.length ? <div className="muted small" style={{ marginTop: 6 }}>{rec.options.join(' / ')}</div> : null}
      <div className="row-actions" style={{ marginTop: 8, gap: 6 }}>
        <button className="btn small primary" disabled={disabled || rec.reviewState !== 'draft'} onClick={onAccept}>Accept</button>
        <button className="btn small" disabled={disabled || rec.reviewState !== 'draft'} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
