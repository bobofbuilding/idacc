import { resolveCoordinator, type FleetStore } from '../store.ts';
import { Chat } from './Chat.tsx';

/**
 * Dashboard = talk to your lead + watch the fleet. The main panel is a chat locked to the
 * team's lead/coordinator (no agent picker — that's what HR Manager and the full Chat page
 * are for), beside a slim, live activity feed of recent fleet events.
 */

function ago(ts?: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function str(x: unknown): string { return typeof x === 'string' ? x : ''; }
function agentLabel(idOrName: string, byId: Map<string, string>): string {
  if (!idOrName) return '';
  return byId.get(idOrName) ?? (/^agent_\d+_/.test(idOrName) ? '@' + idOrName.replace(/^agent_\d+_/, '') : idOrName);
}
const QUERY_VERB: Record<string, string> = {
  dispatched: 'was asked', received: 'received a query', processing: 'is thinking',
  delivered: 'replied', done: 'finished', complete: 'finished', completed: 'finished',
  failed: 'failed', timeout: 'timed out', cancelled: 'was cancelled', queued: 'queued a query',
};
function clip(s: string, n: number): string { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
function previewOf(d: Record<string, unknown>): string {
  return str(d.message_preview) || str(d.preview) || str(d.message) || str(d.text) || str(d.title) || str(d.note);
}
function replyKind(preview: string): string {
  const p = preview.toLowerCase();
  if (!preview) return '';
  if (/^ready\b/.test(p) || p === 'ok' || p === 'ack') return 'heartbeat';
  if (/\b(error|failed|exception|cannot|denied|timeout)\b/.test(p)) return 'error';
  if (/```|function|const |class |def |import |\bSELECT\b/.test(preview)) return 'code';
  if (/\?$/.test(preview.trim())) return 'question';
  return 'message';
}
function describe(e: { topic: string; actor?: string; data?: Record<string, unknown> }, name: (id: string) => string): string {
  const d = e.data ?? {};
  const who = name(str(d.agent) || str(e.actor) || str(d.from) || str(d.name));
  const t = e.topic;
  if (t.startsWith('query:')) {
    const st = str(d.status) || t.split(':')[1] || '';
    const verb = QUERY_VERB[st] || (st ? `query ${st}` : 'query');
    const preview = previewOf(d);
    const head = who ? `${who} ${verb}` : verb;
    if (preview) { const kind = replyKind(preview); return `${head}${kind ? ` · ${kind}` : ''} · “${clip(preview, 80)}”`; }
    return head;
  }
  if (t.startsWith('task:')) return [who, clip(previewOf(d) || str(d.status) || t.split(':')[1], 90)].filter(Boolean).join(' — ');
  if (t.startsWith('agent:')) return [who, t.split(':')[1]].filter(Boolean).join(' ');
  if (t.startsWith('checkin')) return [name(str(d.delegate)) || who, clip(str(d.title), 80)].filter(Boolean).join(' — ');
  if (/relay|delegat|ask|deleg/.test(t)) { const to = name(str(d.to) || str(d.target) || str(d.delegate)); return [who, to].filter(Boolean).join(' → '); }
  const detail = previewOf(d) || str(d.status);
  return [who, clip(detail, 90)].filter(Boolean).join(' · ') || t;
}
function topicClass(t: string): string {
  if (/online|delivered|done|complete/.test(t)) return 'ok';
  if (/offline|fail|expired|error/.test(t)) return 'err';
  if (/due|pending/.test(t)) return 'warn';
  return 'accent';
}

export function Dashboard({ store }: { store: FleetStore }) {
  const lead = resolveCoordinator(store.agents, store.coordinator) ?? 'lead';
  // Recent, detailed activity for the active team (live cursor — newest first).
  const agentById = new Map(store.agents.map((a) => [a.id, a.name] as const));
  const resolveAgent = (id: string) => agentLabel(id, agentById);
  const events = store.events;

  return (
    <div className="view">
      <header className="view-head">
        <h1>Dashboard</h1>
        <span className="muted">talking to <b>{lead}</b> · {store.team ?? 'default'}</span>
      </header>

      <div className="cols dash-top">
        {/* Lead chat: a chat locked to the team lead, no agent picker (Chat renders its own card). */}
        <div className="grow" style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Chat store={store} embedded lockTarget={lead} />
        </div>

        <aside className="card feed" style={{ maxWidth: 360 }}>
          <h3>Activity <span className="muted small">· {store.team ?? 'default'}{events.length ? ` (${events.length})` : ''}</span></h3>
          <div className="feed-list">
            {[...events].reverse().slice(0, 80).map((e) => (
              <div className="feed-row" key={e.seq} title={e.topic}>
                <span className={`topic ${topicClass(e.topic)}`}>{e.topic.split(':')[0]}</span>
                <span className="desc">{describe(e, resolveAgent)}</span>
                {e.timestamp ? <span className="muted t">{ago(e.timestamp)}</span> : null}
              </div>
            ))}
            {events.length === 0 ? <div className="muted">waiting for events…</div> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
