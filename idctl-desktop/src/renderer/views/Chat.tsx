import { useMemo, useRef, useState, useEffect } from 'react';
import { call, resolveCoordinator, agentsLeadFirst, type FleetStore } from '../store.ts';
import type { ProjectEntry } from '../../../../idctl/src/settings/schema.ts';
import type { ManagerEvent, ActivityStep } from '../../../../idctl/src/api/types.ts';

type PickedFile = { path: string; name: string; size: number; isImage: boolean };
type SavedFile = { name: string; path: string; size: number; isImage: boolean };

interface Msg {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  queryId?: string;
  files?: { name: string; path?: string; isImage: boolean }[];
  image?: { path: string; prompt: string; model: string };
  trace?: string[];        // the agent's OWN behind-the-scenes steps (background tasks) captured with this reply
  delegations?: string[];  // work farmed out to other agents while this reply ran
  reasoning?: string;      // one-line summary of what produced this reply (shown in the dropdown summary)
  pending?: boolean;
}
interface Inflight { queryId: string; replyId: number; target: string; startedAt: number; plan?: { request: boolean; text: string } }
interface Session {
  id: string;
  title: string;
  named?: boolean; // user has manually renamed → don't auto-title over it
  unread?: boolean; // an agent reply landed that the user hasn't viewed (drives the Chat nav badge)
  inflight?: Inflight | null; // an in-flight dispatch awaiting a reply (persisted → resumable)
  team: string;
  target: string;
  projectId?: string;
  messages: Msg[];
  createdAt: number;
  updatedAt: number;
}
type ChatSummary = { id: string; title: string; team: string; messageCount: number; updatedAt: number; unread?: boolean };
type ImageResult = { ok: boolean; path?: string; dataUrl?: string; model?: string; costUsd?: number; error?: string };
type QueryPoll = { status?: string; text?: string; error?: string };

/** Quote a free-text message as ONE token for the manager's tokenizer (matches client.ts qArg). */
function qArg(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
function hasReplyContent(m?: Pick<Msg, 'text' | 'image'>): boolean {
  return !!(m && (m.image || (m.text && m.text.trim())));
}
function isRecoverableFailureText(text?: string): boolean {
  return /^\s*✗\s*(failed|agent failed|query failed|query expired|expired)\b/i.test(String(text || ''));
}
function terminalQueryText(q: QueryPoll): string {
  const detail = q.error || q.text || q.status || 'failed';
  return `✗ ${detail}`;
}
function isRecoverableFailedMsg(m: Msg): boolean {
  return !!m.queryId && isRecoverableFailureText(m.text);
}

// Free, local image-vs-chat routing for the unified composer. Conservative —
// defaults to chat unless the prompt clearly asks for a generated image (so we
// never spend on image generation by accident). `/image …` forces it.
const IMG_CMD = /^\/(image|img|draw|art)\s+/i;
const IMG_NOUNS = '(image|picture|pic|photo|photograph|logo|icon|illustration|artwork|art|drawing|painting|poster|banner|graphic|portrait|scene|wallpaper|avatar|mockup|render|sketch)';
function isImageRequest(text: string): boolean {
  if (IMG_CMD.test(text)) return true;
  const verbNoun = new RegExp(`\\b(draw|sketch|paint|render|generate|create|make|design|produce|show me|give me)\\b[^.?!\\n]{0,40}\\b${IMG_NOUNS}\\b`, 'i');
  const nounOf = new RegExp(`\\b(an?|the)\\s+${IMG_NOUNS}\\s+of\\b`, 'i');
  return verbNoun.test(text) || nounOf.test(text) || /\b(image|picture|photo) of\b/i.test(text);
}
function stripImageCmd(text: string): string { return text.replace(IMG_CMD, '').trim(); }

// Plan-request routing: when a chat message clearly asks for a plan, the reply
// is also saved to the Work › Plans tab. Conservative — needs an action verb +
// "plan", an explicit "<kind> plan"/"plan out"/"roadmap", or the `/plan …` form.
const PLAN_CMD = /^\/plan\s+/i;
function isPlanRequest(text: string): boolean {
  if (PLAN_CMD.test(text)) return true;
  if (/\bplan\s+out\b/i.test(text) || /\broadmap\b/i.test(text)) return true;
  if (/\b(implementation|project|migration|rollout|action|step[- ]by[- ]step|build|release|test|testing|deployment|launch|onboarding|game|product)\s+plan\b/i.test(text)) return true;
  if (/\b(make|create|draft|write|build|design|put together|come up with|generate|prepare|lay out|outline|propose)\b[^.?!\n]{0,30}\bplan\b/i.test(text)) return true;
  if (/\b(give|show)\s+me\b[^.?!\n]{0,30}\bplan\b/i.test(text)) return true;
  return false;
}
function stripPlanCmd(text: string): string { return text.replace(PLAN_CMD, '').trim(); }
function newPlanId(): string { return `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }

const CHAT_CONTEXT_CHAR_BUDGET = 60_000;
const CHAT_CONTEXT_MESSAGE_LIMIT = 80;
const CHAT_MESSAGE_CHAR_BUDGET = 12_000;

function normalizeTranscriptText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}
function transcriptLine(m: Msg): string | null {
  if (m.pending && !m.text.trim() && !m.image) return null;
  const text = normalizeTranscriptText(m.text || '');
  const image = m.image ? `[generated image: ${m.image.prompt || m.image.path}]` : '';
  const files = (m.files || [])
    .map((f) => `- ${f.name}${f.path ? ` (${f.path})` : ''}${f.isImage ? ' [image]' : ''}`)
    .join('\n');
  const body = [text, image, files ? `Attached files:\n${files}` : ''].filter(Boolean).join('\n\n');
  if (!body) return null;
  if (m.role === 'system' && /^New chat\./i.test(body)) return null;
  const who = m.role === 'you' ? 'user' : m.role === 'agent' ? `agent${m.who ? `:${m.who}` : ''}` : 'system';
  return `${who}:\n${clip(body, CHAT_MESSAGE_CHAR_BUDGET)}`;
}
function buildChatScopedPrompt(session: Session, target: string, currentMessage: string): string {
  const prior = (session.messages || [])
    .slice(-CHAT_CONTEXT_MESSAGE_LIMIT)
    .map(transcriptLine)
    .filter((x): x is string => !!x);
  prior.push(`user:\n${normalizeTranscriptText(currentMessage) || '(files only)'}`);

  const kept: string[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const line = prior[i];
    const cost = line.length + 2;
    if (kept.length && used + cost > CHAT_CONTEXT_CHAR_BUDGET) break;
    kept.unshift(line);
    used += cost;
  }
  const omitted = prior.length - kept.length;
  const transcript = `${omitted ? `[${omitted} older chat message(s) omitted by local context budget]\n\n` : ''}${kept.join('\n\n---\n\n')}`;

  return [
    'IDACC CHAT-SCOPED REQUEST',
    '',
    `Chat id: ${session.id}`,
    `Chat title: ${session.title || '(untitled)'}`,
    `Team: ${session.team}`,
    `Target agent: ${target}`,
    session.projectId ? `Project focus id: ${session.projectId}` : '',
    '',
    'Context rule: answer this request using only the transcript below, the explicitly attached files/paths named in it, and any project focus stated in the transcript. Do not continue or rely on other Dashboard chats, other agent conversations, old runtime memory, or unrelated manager/task context unless it is quoted in this transcript.',
    '',
    'Transcript:',
    transcript,
    '',
    'Respond to the newest user message at the end of the transcript.',
  ].filter(Boolean).join('\n');
}

// ---- Live "behind the scenes" feed -----------------------------------------
// Turn raw manager events (seq > sinceSeq) into short, plain-English lines so a
// running dispatch shows what the fleet is doing — including work farmed out to
// other agents in parallel. Mirrors the Dashboard activity formatter, trimmed.
const QUERY_VERB: Record<string, string> = {
  dispatched: 'was asked', received: 'received the query', processing: 'is thinking',
  delivered: 'replied', done: 'finished', complete: 'finished', completed: 'finished',
  failed: 'failed', timeout: 'timed out', cancelled: 'was cancelled', queued: 'queued the query',
};
function sstr(x: unknown): string { return typeof x === 'string' ? x : ''; }
function previewOf(d: Record<string, unknown>): string {
  return sstr(d.message_preview) || sstr(d.preview) || sstr(d.message) || sstr(d.text) || sstr(d.title) || sstr(d.note);
}
export interface TraceLine { seq: number; line: string; cls: 'accent' | 'ok' | 'err'; at: number }
// `sinceTs` is a wall-clock floor (the dispatch start). The store stamps LIVE
// events with arrival time but leaves the historical replay batch unstamped, so
// requiring a timestamp >= sinceTs keeps an empty/low-seq buffer from flooding
// the feed with history (and prevents that history from being persisted).
function traceLines(events: ManagerEvent[], sinceSeq: number, sinceTs: number, byId: Map<string, string>): TraceLine[] {
  const name = (id: string) => (id ? byId.get(id) ?? (/^agent_\d+_/.test(id) ? '@' + id.replace(/^agent_\d+_/, '') : id) : '');
  const out: TraceLine[] = [];
  for (const e of events) {
    if (!e || e.seq <= sinceSeq || (e.timestamp ?? 0) < sinceTs) continue;
    const t = e.topic || '';
    const d = e.data ?? {};
    const who = name(sstr(d.agent) || sstr(e.actor) || sstr(d.from) || sstr(d.name));
    let line = '';
    let cls: TraceLine['cls'] = 'accent';
    if (t.startsWith('query:')) {
      const st = sstr(d.status) || t.split(':')[1] || '';
      const verb = QUERY_VERB[st] || (st ? `query ${st}` : 'query');
      const pv = previewOf(d);
      line = `${who ? who + ' ' : ''}${verb}${pv ? ` · “${clip(pv, 80)}”` : ''}`;
      cls = /fail|expired|error|timeout|cancel/.test(st) ? 'err' : /deliver|done|complete/.test(st) ? 'ok' : 'accent';
    } else if (t.startsWith('task:')) {
      line = [who, clip(previewOf(d) || sstr(d.status) || t.split(':')[1], 90)].filter(Boolean).join(' — ');
    } else if (/relay|delegat|deleg|\bask\b/.test(t)) {
      const to = name(sstr(d.to) || sstr(d.target) || sstr(d.delegate));
      line = [who, to].filter(Boolean).join(' → ');
    } else if (t.startsWith('agent:')) {
      line = [who, t.split(':')[1]].filter(Boolean).join(' ');
    } else continue; // skip noise (snapshots, heartbeat housekeeping, etc.)
    if (line.trim()) out.push({ seq: e.seq, line: line.trim(), cls, at: e.timestamp ?? 0 });
  }
  return out.slice(-8);
}
// Icon per activity kind for the inline "what the agent is doing" stream.
const KIND_ICON: Record<string, string> = {
  file: '📝', read: '📖', run: '▶', search: '🔍', web: '🌐', delegate: '🤝', plan: '🧩', error: '⚠', tool: '🔧',
};
function actIcon(kind: string): string { return KIND_ICON[kind] || '🔧'; }
function actLine(a: ActivityStep): string { return `${whenTime(a.at)} ${actIcon(a.kind)} ${a.summary}`.trim(); }
/** Clock time (HH:MM:SS) for an activity/trace row — the "when" of each step. */
function whenTime(at?: number): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

function newSessionId(): string { return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function fmtAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'now'; if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}

/** Cached image rendered as a data URL (CSP blocks file://). */
function ChatImage({ path }: { path: string }) {
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    call<{ ok: boolean; dataUrl?: string; error?: string }>('image:read', path)
      .then((r) => { if (alive) (r.ok && r.dataUrl ? setUrl(r.dataUrl) : setErr(r.error || 'failed')); })
      .catch(() => { if (alive) setErr('read failed'); });
    return () => { alive = false; };
  }, [path]);
  if (err) return <div className="muted small">⚠ image unavailable ({err})</div>;
  if (!url) return <div className="muted small">loading image…</div>;
  return <img className="chat-img" src={url} alt="generated" />;
}

export function Chat({ store, embedded = false, lockTarget, teamOverride, navigate }: { store: FleetStore; embedded?: boolean; lockTarget?: string; teamOverride?: string; navigate?: (view: string) => void }) {
  // teamOverride pins this chat to a specific team (independent of the global
  // active team) — its agents, lead, sessions and dispatch all scope to it.
  const team = teamOverride ?? store.team ?? 'default';
  const teamAgents = useMemo(
    () => (teamOverride ? store.allAgents.filter((a) => a.team === teamOverride) : store.agents),
    [teamOverride, store.allAgents, store.agents],
  );
  const teamCoordinator = teamOverride ? undefined : store.coordinator;
  const defaultTarget = useMemo(
    () => resolveCoordinator(teamAgents, teamCoordinator) ?? 'lead',
    [teamAgents, teamCoordinator],
  );
  const orderedAgents = agentsLeadFirst(teamAgents, teamCoordinator);

  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [sessions, setSessions] = useState<ChatSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  const [canImage, setCanImage] = useState(false); // an image-capable provider is configured
  // Live "behind the scenes" feed for the in-flight dispatch (elapsed + fleet activity).
  const [running, setRunning] = useState<{ sid: string; replyId: number; startedAt: number; sinceSeq: number; target: string; queryId: string } | null>(null);
  const [activitySteps, setActivitySteps] = useState<ActivityStep[]>([]); // the agent's live tool/file steps
  const activitySinceRef = useRef(0); // activity ring cursor for this dispatch
  const [, setTick] = useState(0); // 1 Hz re-render so the elapsed timer ticks
  const idRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null); // the scrollable messages container
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);                // user is following the bottom (auto-scroll on) vs scrolled up to read
  const programmaticScrollRef = useRef(false);  // ignore scroll events caused by our own bottom-pinning
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sessionIdRef = useRef(''); // the currently-active session id (for late-arriving replies)
  const sessionRef = useRef<Session | null>(null); // mirror of the active session (to persist a gated empty chat)
  const deletedRef = useRef<Set<string>>(new Set()); // sessions deleted this run — drop their late writes
  const storeEventsRef = useRef(store.events); // fresh manager events for a background dispatch's trace
  const aliveRef = useRef(true); // false once unmounted (Chat view not on screen) → late replies count as unread
  const sendingRef = useRef(false); // synchronous single-flight latch: true from send() entry until inflight is committed
  const activePollsRef = useRef<Set<string>>(new Set()); // queryIds currently being polled (dedup resume)
  const recoveryPollsRef = useRef<Set<string>>(new Set()); // stale failed bubbles already being checked
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  /** Clear a session's unread flag (the user is now viewing it) + refresh the
   *  badge and the session list (so the dropdown's ● clears too). */
  function markRead(sid: string) {
    void call('chats:markRead', sid).then(() => { void store.refreshChatUnread(); void refreshList(); }).catch(() => {});
  }

  // Resolve agent ids → readable names for the live activity feed.
  const agentNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of store.agents) { if (a.id) m.set(a.id, a.name); m.set(a.name, a.name); }
    return m;
  }, [store.agents]);
  // Behind-the-scenes activity for the running dispatch (events after it started).
  // Floor timestamps a hair before startedAt to tolerate stamp/poll ordering.
  const liveTrace = useMemo(
    () => (running ? traceLines(store.events, running.sinceSeq, running.startedAt - 1500, agentNameById) : []),
    [running, store.events, agentNameById],
  );
  useEffect(() => { storeEventsRef.current = store.events; }, [store.events]);
  // The live-feed UI is DERIVED from the viewed session's persisted inflight, so
  // it's correct after navigation/switch/restart regardless of which poll loop
  // is delivering. Re-floors the activity feed + re-spins the reply bubble — but
  // only while the reply is still empty (a delivered reply with stale inflight on
  // disk must NOT be re-spun; adoptSession clears that case before we get here).
  useEffect(() => {
    const inf = session?.inflight;
    const reply = inf ? session?.messages.find((x) => x.id === inf.replyId) : undefined;
    const alreadyDelivered = !!(reply && hasReplyContent(reply) && !isRecoverableFailureText(reply.text));
    if (inf?.queryId && session && !alreadyDelivered) {
      const sinceSeq = store.events.reduce((mx, e) => Math.max(mx, e?.seq ?? 0), 0);
      setRunning({ sid: session.id, replyId: inf.replyId, startedAt: inf.startedAt, target: inf.target, queryId: inf.queryId, sinceSeq });
      activitySinceRef.current = -1;
      setActivitySteps([]);
      setSession((cur) => (cur && cur.id === session.id && cur.inflight?.queryId === inf.queryId
        ? { ...cur, messages: cur.messages.map((x) => (x.id === inf.replyId && !x.pending ? { ...x, pending: true } : x)) }
        : cur));
    } else {
      setRunning(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.inflight?.queryId, session?.id]);
  // Tick once a second while a dispatch is running so the elapsed time updates.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  // While a dispatch runs, poll the target agent's live tool/file activity and
  // stream it inline (Claude-app style). Cursor was floored at dispatch start.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const poll = async () => {
      const since = activitySinceRef.current;
      const r = await call<{ items: ActivityStep[]; next_seq: number }>('activity:get', running.target, Math.max(0, since), team, running.queryId).catch(() => null);
      if (!alive || !r) return;
      if (since < 0) { activitySinceRef.current = r.next_seq ?? 0; return; } // first poll floors the cursor — skip any pre-dispatch backlog
      if (Array.isArray(r.items) && r.items.length) {
        activitySinceRef.current = r.items[r.items.length - 1].seq;
        setActivitySteps((prev) => [...prev, ...r.items].slice(-60));
      } else if (typeof r.next_seq === 'number' && r.next_seq < activitySinceRef.current) {
        // The activity ring is BEHIND our cursor — the manager restarted and reset
        // its in-memory ring below where we were polling, so since=N returns nothing
        // forever and the live "what the agent is doing" feed freezes. Resync to the
        // new tail so the agent's ongoing steps stream again.
        activitySinceRef.current = r.next_seq;
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 1200);
    return () => { alive = false; clearInterval(t); };
  }, [running]);

  const activeKey = `idctl.chat.session.${team}`;
  const draftKey = (sid: string) => `idctl.chat.draft.${sid}`;
  const attachKey = (sid: string) => `idctl.chat.attach.${sid}`;
  function readDraft(sid: string): string {
    try { return localStorage.getItem(draftKey(sid)) ?? ''; } catch { return ''; }
  }
  function readDraftAttachments(sid: string): PickedFile[] {
    try {
      const raw = JSON.parse(localStorage.getItem(attachKey(sid)) ?? '[]') as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((x) => {
        if (!x || typeof x !== 'object') return [];
        const f = x as Partial<PickedFile>;
        return typeof f.path === 'string' && typeof f.name === 'string' && typeof f.size === 'number' && typeof f.isImage === 'boolean'
          ? [{ path: f.path, name: f.name, size: f.size, isImage: f.isImage }]
          : [];
      });
    } catch { return []; }
  }
  function blankSession(): Session {
    // Auto-named so it's never "untitled"; the first message refines it and the
    // user can rename anytime (which locks it via `named`).
    const stamp = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { id: newSessionId(), title: `New chat · ${stamp}`, named: false, team, target: defaultTarget, projectId: '', createdAt: Date.now(), updatedAt: Date.now(),
      messages: [{ id: 0, role: 'system', who: '', text: 'New chat. Pick an agent, optionally focus a project, attach files, or generate an image — then Send.' }] };
  }
  function adoptSession(s: Session) {
    // Monotonic, never reset — ids stay unique across sessions so a late reply
    // can never land on an unrelated message that happens to share a small int.
    idRef.current = Math.max(idRef.current, ...s.messages.map((m) => m.id), 0) + 1;
    sessionIdRef.current = s.id;
    // Viewing it clears unread — in memory (so a later save doesn't re-flag it)
    // and on disk (the badge reads the file).
    setSession(s.unread ? { ...s, unread: false } : s);
    setInput(readDraft(s.id));
    setAttachments(readDraftAttachments(s.id));
    if (s.unread) markRead(s.id);
    try { localStorage.setItem(activeKey, s.id); } catch { /* ignore */ }
    // Resume an in-flight dispatch for this session (survives navigation / app
    // restart). The live-feed UI (`running`) is derived from session.inflight by
    // an effect; here we only (re)attach the poll loop — pollInflight dedups per
    // queryId, so re-adopting the same session won't spawn a second loop.
    setBusy(false);
    void recoverStaleFailedMessages(s);
    resumeOrClearInflight(s);
  }

  /** (Re)attach the poll loop for a session's persisted inflight — but if the
   *  reply already landed (a delivered reply with stale inflight, e.g. the app
   *  was killed between writing the reply and clearing inflight), drop the stale
   *  inflight instead of re-polling a terminal query and overwriting a real reply. */
  function resumeOrClearInflight(s: Session) {
    const inf = s.inflight;
    if (!inf?.queryId) return;
    const reply = s.messages.find((x) => x.id === inf.replyId);
    const delivered = !!(reply && hasReplyContent(reply) && !isRecoverableFailureText(reply.text));
    if (delivered) {
      void call('chats:patch', s.id, { inflight: null }).catch(() => {});
      setSession((cur) => (cur && cur.id === s.id ? { ...cur, inflight: null } : cur));
    } else {
      void pollInflight(s.id, inf);
    }
  }

  async function recoverStaleFailedMessages(s: Session) {
    const candidates = s.messages.filter(isRecoverableFailedMsg);
    for (const m of candidates) {
      const queryId = m.queryId;
      if (!queryId) continue;
      const key = `${s.id}:${m.id}:${queryId}`;
      if (recoveryPollsRef.current.has(key) || activePollsRef.current.has(queryId)) continue;
      recoveryPollsRef.current.add(key);
      try {
        const q = await call<QueryPoll>('query:poll', queryId, 0, s.team).catch(() => null);
        if (q?.status !== 'delivered') continue;
        await resolveMsg(s.id, m.id, {
          role: 'agent',
          who: m.who || s.target,
          text: q.text || '(empty reply)',
          pending: false,
          queryId,
        });
        if (s.inflight?.queryId === queryId) {
          await call('chats:patch', s.id, { inflight: null }).catch(() => {});
          setSession((cur) => (cur && cur.id === s.id ? { ...cur, inflight: null } : cur));
        }
      } finally {
        recoveryPollsRef.current.delete(key);
      }
    }
  }

  async function recoverSavedFailedChats(list: ChatSummary[]) {
    for (const item of list) {
      if (deletedRef.current.has(item.id)) continue;
      const s = await call<Session | null>('chats:get', item.id).catch(() => null);
      if (s) await recoverStaleFailedMessages(s);
    }
  }

  async function refreshList() {
    setSessions(await call<ChatSummary[]>('chats:list', team).catch(() => []));
  }
  // Load projects, image models, the saved session list, and restore the active chat.
  useEffect(() => {
    // Forget the previous team's open session id immediately, so a late reply
    // for it can never be judged "seen" against the team we just switched to.
    sessionIdRef.current = '';
    void call<ProjectEntry[]>('projects:list').then(setProjects).catch(() => {});
    void call<string[]>('image:models').then((m) => setCanImage(m.length > 0)).catch(() => {});
    let alive = true;
    (async () => {
      const list = await call<ChatSummary[]>('chats:list', team).catch(() => []);
      if (!alive) return;
      setSessions(list);
      let id = '';
      try { id = localStorage.getItem(activeKey) ?? ''; } catch { /* ignore */ }
      const existing = id ? await call<Session | null>('chats:get', id).catch(() => null) : null;
      if (!alive) return;
      if (existing) adoptSession(existing);
      else if (list[0]) {
        // Remembered chat is gone — fall back to the most recent, not a blank.
        const recent = await call<Session | null>('chats:get', list[0].id).catch(() => null);
        if (alive) adoptSession(recent ?? blankSession());
      } else adoptSession(blankSession());
      // Resume EVERY chat with a persisted inflight — not just the one we adopted
      // — so a reply to a backgrounded chat still lands (with an unread badge)
      // after an app restart. Keyed by sid; pollInflight dedups per queryId, so
      // the adopted session isn't double-polled. A stale (already-delivered)
      // inflight is just cleared, never re-polled.
      const pending = await call<Array<{ id: string; inflight: Inflight; delivered: boolean }>>('chats:inflight', team).catch(() => []);
      if (!alive) return;
      for (const p of pending) {
        if (deletedRef.current.has(p.id) || !p.inflight?.queryId) continue;
        if (p.delivered) { void call('chats:patch', p.id, { inflight: null }).catch(() => {}); continue; }
        void pollInflight(p.id, p.inflight);
      }
      void recoverSavedFailedChats(list);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  function scrollToBottom(smooth = true) {
    const el = listRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) window.clearTimeout(programmaticScrollTimerRef.current);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, smooth ? 250 : 0);
  }
  // Stay pinned to the latest as new content arrives — including the live
  // activity feed + trace that stream in while an agent works — UNLESS the user
  // has scrolled up to read (then we don't yank them back down).
  useEffect(() => { if (stickRef.current) scrollToBottom(!running); }, [session?.messages, activitySteps, liveTrace, running, attachments]);
  // Jump straight to the bottom (no animation) when the open chat changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { stickRef.current = true; scrollToBottom(false); }, [session?.id]);
  useEffect(() => () => {
    if (programmaticScrollTimerRef.current !== null) window.clearTimeout(programmaticScrollTimerRef.current);
  }, []);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    try {
      if (input) localStorage.setItem(draftKey(sid), input);
      else localStorage.removeItem(draftKey(sid));
    } catch { /* ignore */ }
  }, [input, session?.id]);
  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    try {
      if (attachments.length) localStorage.setItem(attachKey(sid), JSON.stringify(attachments.map((f) => ({ path: f.path, name: f.name, size: f.size, isImage: f.isImage }))));
      else localStorage.removeItem(attachKey(sid));
    } catch { /* ignore */ }
  }, [attachments, session?.id]);

  const msgs = session?.messages ?? [];
  const target = lockTarget ?? (session && teamAgents.some((a) => a.name === session.target) ? session.target : defaultTarget);
  const targetAgent = teamAgents.find((a) => a.name === target);
  const focused = projects.find((p) => p.id === session?.projectId);
  const destDir = focused?.path || targetAgent?.workingDirectory || '';
  const inflight = !!session?.inflight?.queryId; // the viewed chat is awaiting a reply → lock the composer

  const focusedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || a.name.localeCompare(b.name)),
    [projects],
  );

  /** Persist the active session + refresh the list. */
  function persist(next: Session) {
    next.updatedAt = Date.now();
    setSession(next);
    void call('chats:save', next).then(refreshList).catch(() => {});
  }
  function patch(fn: (s: Session) => Session) {
    setSession((cur) => { if (!cur) return cur; const next = fn({ ...cur }); next.updatedAt = Date.now(); void call('chats:save', next).then(refreshList).catch(() => {}); return next; });
  }
  function pushMsgs(...m: Msg[]) { patch((s) => ({ ...s, messages: [...s.messages, ...m] })); }
  /** Apply a late update (agent reply / generated image) to the message in
   *  session `sid` — even if the user has since switched to another chat. Drops
   *  it if that chat was deleted; the file is authoritative so nothing is lost. */
  async function resolveMsg(sid: string, id: number, patchMsg: Partial<Msg>) {
    if (deletedRef.current.has(sid)) return;
    // A reply is "seen" only if the Chat view is on screen AND this is the open
    // session; otherwise it lands as unread so the nav badge surfaces it.
    const seen = aliveRef.current && sessionIdRef.current === sid;
    // Reflect immediately if that session is the one on screen.
    setSession((cur) => (cur && cur.id === sid
      ? { ...cur, messages: cur.messages.map((x) => (x.id === id ? { ...x, ...patchMsg } : x)), unread: false, updatedAt: Date.now() }
      : cur));
    // Authoritative + atomic: patch only this message + unread on the file
    // (main-side read-merge-write) so a concurrent title-gen / system-notice
    // write can't clobber the reply. If the file doesn't exist yet (an empty
    // chat wasn't cached) but it's the active one, persist the in-memory session.
    const r = await call<{ ok: boolean }>('chats:patch', sid, { patchMessage: { id, patch: patchMsg }, unread: !seen }).catch(() => ({ ok: false }));
    if (!r.ok && !deletedRef.current.has(sid) && sessionRef.current && sessionRef.current.id === sid) {
      const cur = sessionRef.current;
      const patched = { ...cur, messages: cur.messages.map((x) => (x.id === id ? { ...x, ...patchMsg } : x)), unread: !seen, updatedAt: Date.now() };
      await call('chats:save', patched).catch(() => {});
    }
    if (!seen) void store.refreshChatUnread(); // surface the new unread on the badge (no poll-loop restart)
    void refreshList();
  }

  /** Append a system line to session `sid` even after a chat switch. Atomic
   *  main-side append so it can't clobber a concurrent reply/title write. */
  async function appendSystem(sid: string, text: string) {
    const m: Msg = { id: idRef.current++, role: 'system', who: '', text };
    if (sessionRef.current?.id === sid) { pushMsgs(m); return; }
    if (deletedRef.current.has(sid)) return;
    await call('chats:patch', sid, { appendMessage: m }).catch(() => {});
    void refreshList();
  }
  /** Save a chat reply as a Plan (Work › Plans). Returns the plan title, or '' on failure. */
  async function savePlanFromChat(request: string, content: string, agent: string): Promise<string> {
    const now = Date.now();
    const title = clip(stripPlanCmd(request).replace(/\s+/g, ' ').trim(), 60) || 'Plan from chat';
    const plan = {
      id: newPlanId(), title, request, agent, team, status: 'draft' as const,
      content, version: 1,
      revisions: [{ version: 1, at: now, note: `From chat: ${clip(stripPlanCmd(request), 80)}`, content }],
      createdAt: now, updatedAt: now,
    };
    try { await call('plans:save', plan); return title; } catch { return ''; }
  }

  const TRANSIENT = /fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|socket hang up|network|ENOTFOUND|EAI_AGAIN|terminated|other side closed|\b50[234]\b|agent failed|not running|unavailable|\bstarting\b|rebuild/i;
  /** Start a dispatch (POST /remote) with auto-retry for TRANSIENT failures.
   *  Returns a queryId to poll (or an inline reply for manager-local commands). */
  async function startDispatchWithRetry(cmd: string, replyId: number, convId: string): Promise<{ queryId?: string; inline?: string }> {
    const MAX = 3;
    let lastErr = '';
    for (let attempt = 1; attempt <= MAX; attempt++) {
      try {
        // convId (this chat's session id) isolates the agent conversation per chat.
        // team pins the dispatch to this chat's team (independent of the global team).
        return await call<{ queryId?: string; inline?: string }>('dispatch:start', cmd, convId, team);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        if (attempt < MAX && TRANSIENT.test(lastErr)) {
          setSession((cur) => (cur && cur.id === sessionIdRef.current
            ? { ...cur, messages: cur.messages.map((x) => (x.id === replyId ? { ...x, text: `reconnecting — the agent may be restarting… (${attempt}/${MAX - 1})` } : x)) }
            : cur));
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw e;
      }
    }
    throw new Error(lastErr);
  }

  /** Compact "what the agent did" trace: THIS dispatch's own polled activity steps
   *  (per-dispatch buffer, floored at start — not the viewed session's shared feed)
   *  plus delegations seen on the manager event log since it started. The activity
   *  steps are now queryId-filtered (`activity:get` passes inf.queryId), so even two
   *  concurrent dispatches to the same agent get exact per-dispatch attribution.
   *  The manager EVENT log (delegation lines) still carries agent+time but no
   *  queryId, so those remain a best-effort, time-windowed annotation — never
   *  load-bearing (the reply itself is queryId-keyed). */
  function buildTrace(steps: ActivityStep[], startedAt: number): { steps: string[]; delegations: string[] } {
    // The agent's OWN behind-the-scenes work (background tasks). Delegate-kind
    // steps are pulled out into their own strand below, not mixed in here.
    const own = steps.filter((s) => s.kind !== 'delegate').map(actLine).slice(-14);
    // Work farmed out to others: delegate-kind activity + delegation/relay lines
    // seen on the manager event log since this dispatch started (best-effort,
    // time-windowed — the reply itself stays queryId-keyed).
    const delegSteps = steps.filter((s) => s.kind === 'delegate').map(actLine);
    const delegEvents = traceLines(storeEventsRef.current, 0, startedAt - 1500, agentNameById)
      .filter((t) => / → |delegated|replied/.test(t.line)).slice(-4).map((t) => `${whenTime(t.at)} ${t.line}`.trim());
    return { steps: own, delegations: [...delegSteps, ...delegEvents].slice(-8) };
  }
  /** Always-available one-line summary of what produced a reply, rolled up from
   *  its own steps + delegations — the deterministic fallback shown in the
   *  dropdown summary when the local-Ollama paraphrase is unavailable. */
  function deterministicReason(own: string[], delegations: string[]): string {
    const parts: string[] = [];
    if (own.length) parts.push(`${own.length} background step${own.length === 1 ? '' : 's'}`);
    if (delegations.length) parts.push(`delegated ${delegations.length}×`);
    return parts.join(' · ');
  }

  /** Deliver a terminal result to session `sid` (KEYED BY sid → always the right
   *  chat file; resolveMsg marks it unread when not being viewed), clear the
   *  inflight, and run the plan-save on a successful reply. */
  async function deliverInflight(sid: string, inf: Inflight, patch: Partial<Msg>, isReply = false) {
    await resolveMsg(sid, inf.replyId, { queryId: inf.queryId, ...patch, pending: false });
    await call('chats:patch', sid, { inflight: null }).catch(() => {});
    setSession((cur) => (cur && cur.id === sid ? { ...cur, inflight: null } : cur));
    // Plan context rides on the inflight record (not a closure arg), so the
    // auto-save still runs when the reply lands via a resume/restart poll.
    if (isReply && inf.plan?.request) {
      const real = (patch.text || '').trim();
      if (real.length >= 24 && real !== '(empty reply)' && real !== '(no reply)' && !real.startsWith('✗')) {
        const t = await savePlanFromChat(inf.plan.text, real, inf.target);
        await appendSystem(sid, t ? `📋 Saved to Plans → “${t}” (Work › Plans tab)` : '⚠ Couldn’t save this to Plans.');
      }
    }
  }

  async function confirmRecoverableTerminal(inf: Inflight, first: QueryPoll): Promise<QueryPoll | null> {
    let last: QueryPoll = first;
    for (const wait of [0, 2, 2]) {
      const q = await call<QueryPoll>('query:poll', inf.queryId, wait, team).catch(() => null);
      if (!q?.status) return null;
      last = q;
      if (q.status === 'delivered') return q;
      if (q.status === 'pending' || q.status === 'processing') return null;
    }
    return last;
  }

  /** Poll an in-flight query until terminal, delivering the reply into session
   *  `sid`. Keyed by sid, so it lands in the right chat (with an unread badge)
   *  even if you've switched chats. Keeps polling while the Chat view is mounted;
   *  on a page switch it stops (the inflight is persisted) and resumes on return
   *  or app restart. De-duped per queryId so a resume never double-polls. The
   *  live-feed UI is derived separately from the viewed session's inflight. */
  async function pollInflight(sid: string, inf: Inflight) {
    if (activePollsRef.current.has(inf.queryId)) return; // already polling this query
    activePollsRef.current.add(inf.queryId);
    const PERMANENT = /not found|404|no such|unknown query|invalid query|\bgone\b/i;
    // While the manager is REACHABLE it guarantees a terminal status (delivered or,
    // at its own expiry, expired) — so we never abandon a still-running query on the
    // success path; we defer to the manager's decision (works for any configured
    // expiry). If the manager is UNREACHABLE we DON'T give up or poison the reply
    // (that would drop the queryId — the only handle — and the reply could never be
    // recovered); we keep the inflight persisted, post ONE soft notice, and keep
    // polling, so it delivers when the manager returns (or on a later reopen/restart).
    const UNREACHABLE_WARN_MS = 60 * 1000;
    let unreachableSince = 0;
    let warnedUnreachable = false;
    // This dispatch's OWN activity buffer (NOT the shared viewed-session refs), so
    // the trace we persist is this agent's steps even when another chat is on screen.
    let actCursor = -1; // -1 → floor on first poll (skip pre-dispatch backlog)
    const actSteps: ActivityStep[] = [];
    const pollActivity = async () => {
      const r = await call<{ items: ActivityStep[]; next_seq: number }>('activity:get', inf.target, Math.max(0, actCursor), team, inf.queryId).catch(() => null);
      if (!r) return;
      if (actCursor < 0) { actCursor = r.next_seq ?? 0; return; }
      if (Array.isArray(r.items) && r.items.length) {
        actCursor = r.items[r.items.length - 1].seq;
        actSteps.push(...r.items);
        if (actSteps.length > 80) actSteps.splice(0, actSteps.length - 80);
      }
    };
    try {
      await pollActivity(); // floor this dispatch's activity cursor at start
      while (aliveRef.current && !deletedRef.current.has(sid)) {
        let q: QueryPoll | null = null;
        try {
          q = await call<QueryPoll>('query:poll', inf.queryId, 8, team);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (PERMANENT.test(msg)) { // the query no longer exists (manager reset / lost) — terminal, don't spin
            await deliverInflight(sid, inf, { role: 'system', text: '✗ this reply is no longer available (the query was lost). Please resend.' });
            return;
          }
          // Manager unreachable (network/restart). A blip just keeps polling; after a
          // sustained outage post ONE soft notice (no reply overwrite, inflight kept)
          // and keep polling so it delivers when the manager returns.
          if (!unreachableSince) unreachableSince = Date.now();
          if (!warnedUnreachable && Date.now() - unreachableSince > UNREACHABLE_WARN_MS) {
            warnedUnreachable = true;
            await appendSystem(sid, '⚠ Can’t reach the manager right now — still waiting; the reply will appear here when it’s back.');
          }
          await new Promise((r) => setTimeout(r, 2500)); continue; // transient → keep polling
        }
        unreachableSince = 0; warnedUnreachable = false; // a successful poll resets the outage tracking
        if (deletedRef.current.has(sid)) return;
        await pollActivity(); // keep this dispatch's own trace fresh
        if (q?.status === 'delivered') {
          const { steps: own, delegations } = buildTrace(actSteps, inf.startedAt);
          const text = q.text || '(empty reply)';
          // Deliver immediately with a deterministic reasoning rollup (never empty),
          // then best-effort UPGRADE the summary to a free local-Ollama paraphrase
          // of the reply — same path the title gen uses; leaves the rollup if Ollama
          // is unavailable. Fired async so the reply isn't delayed by inference.
          await deliverInflight(sid, inf, {
            text,
            trace: own.length ? own : undefined,
            delegations: delegations.length ? delegations : undefined,
            reasoning: deterministicReason(own, delegations) || undefined,
          }, true);
          void call<string>('chat:genReason', text)
            .then((r) => { if (r && r.trim()) void resolveMsg(sid, inf.replyId, { reasoning: clip(r.trim(), 100) }); })
            .catch(() => {});
          return;
        }
        if (q?.status === 'failed' || q?.status === 'expired') {
          await resolveMsg(sid, inf.replyId, { queryId: inf.queryId, text: `${terminalQueryText(q)} Checking for a final reply…`, pending: true });
          const confirmed = await confirmRecoverableTerminal(inf, q);
          if (!confirmed) { await new Promise((r) => setTimeout(r, 1500)); continue; }
          if (confirmed.status === 'delivered') {
            const { steps: own, delegations } = buildTrace(actSteps, inf.startedAt);
            const text = confirmed.text || '(empty reply)';
            await deliverInflight(sid, inf, {
              text,
              trace: own.length ? own : undefined,
              delegations: delegations.length ? delegations : undefined,
              reasoning: deterministicReason(own, delegations) || undefined,
            }, true);
            void call<string>('chat:genReason', text)
              .then((r) => { if (r && r.trim()) void resolveMsg(sid, inf.replyId, { reasoning: clip(r.trim(), 100) }); })
              .catch(() => {});
            return;
          }
          if (confirmed.status === 'pending' || confirmed.status === 'processing') {
            await new Promise((r) => setTimeout(r, 1500)); continue;
          }
          await deliverInflight(sid, inf, { role: 'system', text: terminalQueryText(confirmed) });
          return;
        }
        if (q?.status === 'cancelled') {
          await deliverInflight(sid, inf, { role: 'system', text: `✗ ${q.error || q.status}` });
          return;
        }
        if (!q?.status) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        // pending/processing → the manager is alive and still working; query:poll
        // already long-polled ~8s, so just loop. We defer to the manager's terminal
        // status (it will deliver, or expire the query) rather than abandoning it.
      }
    } finally {
      activePollsRef.current.delete(inf.queryId);
    }
  }

  /** Start a resumable dispatch: kick the query, persist it on the session, then
   *  poll. Errors before a query is created surface immediately. */
  async function beginDispatch(sid: string, replyId: number, target: string, scopedMessage: string, planCtx: { planRequest: boolean; planText: string }) {
    let start: { queryId?: string; inline?: string };
    try {
      start = await startDispatchWithRetry(`/ask ${target} ${qArg(scopedMessage)}`, replyId, sid);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const friendly = TRANSIENT.test(raw)
        ? `✗ couldn’t reach ${target} — it may be restarting or the manager is offline. Try again in a moment. (${raw})`
        : `✗ ${raw}`;
      await resolveMsg(sid, replyId, { role: 'system', text: friendly, pending: false });
      setBusy(false);
      return;
    }
    if (!start.queryId) {
      await resolveMsg(sid, replyId, { text: start.inline || '(no reply)', pending: false });
      setBusy(false);
      return;
    }
    // Carry the plan context ON the inflight so the auto-save still runs when the
    // reply lands via a resume/restart poll (which has no closure to the request).
    const inf: Inflight = { queryId: start.queryId, replyId, target, startedAt: Date.now(),
      plan: planCtx.planRequest ? { request: true, text: planCtx.planText } : undefined };
    // Commit the inflight to STATE first so the derived composer lock (`inflight`)
    // is continuously held — only THEN release `busy`, leaving no window where both
    // are false and a second send could slip through. Persist + poll after.
    setSession((cur) => (cur && cur.id === sid
      ? { ...cur, inflight: inf, messages: cur.messages.map((x) => (x.id === replyId ? { ...x, queryId: inf.queryId } : x)) }
      : cur));
    setBusy(false);
    await call('chats:patch', sid, { inflight: inf, patchMessage: { id: replyId, patch: { queryId: inf.queryId } } }).catch(() => {});
    void pollInflight(sid, inf);
  }

  function newChat() { const s = blankSession(); adoptSession(s); persist(s); }
  async function openChat(id: string) {
    if (id === session?.id) return;
    const s = await call<Session | null>('chats:get', id).catch(() => null);
    if (s) adoptSession(s);
  }
  async function deleteChat(id: string) {
    const which = sessions.find((s) => s.id === id)?.title || session?.title || 'this chat';
    if (!window.confirm(`Delete “${which}”? This can't be undone.`)) return;
    deletedRef.current.add(id); // drop any in-flight reply destined for this chat
    try { localStorage.removeItem(draftKey(id)); localStorage.removeItem(attachKey(id)); } catch { /* ignore */ }
    await call('chats:remove', id).catch(() => {});
    void store.refreshChatUnread(); // removing an unread chat must drop the badge now
    const list = await call<ChatSummary[]>('chats:list', team).catch(() => []);
    setSessions(list);
    if (id === session?.id) {
      if (list[0]) await openChat(list[0].id);
      else { const s = blankSession(); adoptSession(s); persist(s); }
    }
  }
  function setTarget(name: string) { patch((s) => ({ ...s, target: name })); }
  function setFocus(pid: string) { patch((s) => ({ ...s, projectId: pid })); }
  function rename(title: string) { patch((s) => ({ ...s, title, named: true })); }
  function autoTitle(text: string) {
    // Immediate fallback name from the first message — unless the user has renamed it.
    patch((s) => (s.named ? s : { ...s, title: clip(text.replace(/\s+/g, ' '), 48) }));
  }
  /** Apply a generated title to session `sid` even after a chat switch; never
   *  overrides a user rename, and persists to the file (or in-memory if not yet cached). */
  async function applyAutoTitle(sid: string, title: string) {
    if (!title || deletedRef.current.has(sid)) return;
    setSession((cur) => (cur && cur.id === sid && !cur.named ? { ...cur, title } : cur));
    // Atomic main-side: sets the title only if not user-named, without bumping
    // updatedAt (no reorder) and without clobbering a concurrent reply write.
    await call('chats:patch', sid, { autoTitle: title, touch: false }).catch(() => {});
    void refreshList();
  }
  /** Generate a concise title from the opening message (local Ollama; best-effort). */
  async function genTitle(sid: string, text: string) {
    const t = await call<string>('chat:genTitle', text).catch(() => '');
    if (t && t.trim()) await applyAutoTitle(sid, t.trim());
  }

  async function addAttachments() {
    const got = await call<PickedFile[]>('chat:pickFiles').catch(() => [] as PickedFile[]);
    if (got.length) setAttachments((a) => [...a, ...got.filter((g) => !a.some((x) => x.path === g.path))]);
  }
  function removeAttachment(path: string) { setAttachments((a) => a.filter((f) => f.path !== path)); }

  /** Read a pasted/dropped blob as base64 and stage it as an attachment (it then
   *  rides the normal saveFiles pipeline on Send). */
  async function attachBlob(f: File) {
    const isImg = (f.type || '').startsWith('image/');
    const ext = isImg ? '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace('x-icon', 'ico')) : '';
    const name = f.name || `pasted-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}${ext}`;
    try {
      const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(f); });
      const b64 = dataUrl.split(',')[1] || '';
      if (!b64) return;
      const saved = await call<PickedFile | { error: string }>('chat:savePasted', name, b64).catch(() => null);
      if (saved && 'path' in saved) setAttachments((a) => (a.some((x) => x.path === saved.path) ? a : [...a, saved]));
      else pushMsgs({ id: idRef.current++, role: 'system', who: '', text: `✗ Couldn't attach ${clip(name, 40)}: ${(saved as { error?: string } | null)?.error ?? 'failed'}` });
    } catch { /* skip a blob we can't read */ }
  }
  /** Clipboard paste: stage any image/file blobs as attachments; plain text
   *  paste falls through to the input unchanged. */
  async function onPaste(e: React.ClipboardEvent) {
    const dt = e.clipboardData;
    if (!dt || busy || session?.inflight) return;
    const files: File[] = [...Array.from(dt.files || [])];
    if (!files.length) for (const it of Array.from(dt.items || [])) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
    if (!files.length) return; // no blobs → let the normal text paste happen
    e.preventDefault();
    for (const f of files) await attachBlob(f);
  }

  function compose(text: string, saved: SavedFile[]): string {
    const parts: string[] = [];
    if (focused) {
      const repo = (focused.links ?? []).find((l) => /github\.com/i.test(l));
      parts.push(`[Focus: project "${focused.name}"${focused.path ? ` at ${focused.path}` : ''}${repo ? ` — repo ${repo}` : ''}]`);
    }
    if (text) parts.push(text);
    if (saved.length) parts.push(`[I attached ${saved.length} file(s); read them at these paths:\n${saved.map((f) => `- ${f.path}${f.isImage ? ' (image)' : ''}`).join('\n')}]`);
    return parts.join('\n\n');
  }

  async function send() {
    const text = input.trim();
    // sendingRef is a SYNCHRONOUS latch: it closes the gap between setBusy(true)
    // and the inflight being committed, where state-based guards could both read
    // false within one render and let a fast second Enter/Send double-dispatch.
    if ((!text && attachments.length === 0) || busy || sendingRef.current || !session || !!session.inflight) return;
    // Unified composer: a clear image request (with no file attachments) generates
    // an image; everything else goes to the agent. Decision is free + local.
    if (text && !attachments.length && canImage && isImageRequest(text)) {
      sendingRef.current = true; // latch BEFORE the async image gen (image:generate can bill a provider) — genImage releases it
      void genImage(stripImageCmd(text));
      return;
    }
    const sid = session.id;
    sendingRef.current = true;
    stickRef.current = true; // sending re-engages auto-scroll so you follow your message + the reply
    setBusy(true);
    try {
      // 1. Save attachments (if any). On failure, surface + stop.
      let saved: SavedFile[] = [];
      if (attachments.length) {
        if (!destDir) { pushMsgs({ id: idRef.current++, role: 'system', who: '', text: '✗ Nowhere to put the files — focus a project or pick an agent with a workspace.' }); setBusy(false); return; }
        const res = await call<{ ok: boolean; files: SavedFile[]; skipped?: string[]; error?: string }>('chat:saveFiles', destDir, attachments.map((a) => a.path)).catch(() => ({ ok: false, files: [] as SavedFile[], skipped: [] as string[], error: 'copy failed' }));
        if (!res.ok) { pushMsgs({ id: idRef.current++, role: 'system', who: '', text: `✗ Couldn't attach files: ${res.error ?? 'unknown error'}` }); setBusy(false); return; }
        saved = res.files;
        if (res.skipped?.length) pushMsgs({ id: idRef.current++, role: 'system', who: '', text: `⚠ Couldn't attach ${res.skipped.length} file(s): ${res.skipped.join(', ')}` });
        if (saved.length === 0 && !text) { setBusy(false); return; }
      }
      const message = compose(text, saved);
      const scopedMessage = buildChatScopedPrompt(session, target, message);
      const planRequest = !!text && isPlanRequest(text);
      const myId = idRef.current++;
      const replyId = idRef.current++;
      pushMsgs(
        { id: myId, role: 'you', who: 'you', text: text || '(files only)', files: saved.map((f) => ({ name: f.name, path: f.path, isImage: f.isImage })) },
        { id: replyId, role: 'agent', who: target, text: '', pending: true },
      );
      if (text) { autoTitle(text); void genTitle(sid, text); }
      setInput('');
      setAttachments([]);
      // 2. Hand off to the resumable dispatch — it kicks the query, commits it to
      // session.inflight (which drives the UI), and polls until a reply lands.
      await beginDispatch(sid, replyId, target, scopedMessage, { planRequest, planText: text });
    } finally {
      sendingRef.current = false; // inflight is now committed (or the send errored out)
    }
  }

  async function genImage(promptArg?: string) {
    const prompt = (promptArg ?? input).trim();
    // send() set sendingRef before routing here; release it on any exit so the
    // composer doesn't stay latched. (genImage is only ever called from send().)
    if (!prompt || busy || !session || !!session.inflight) { sendingRef.current = false; return; }
    const sid = session.id;
    stickRef.current = true; // generating re-engages auto-scroll
    setBusy(true);
    const genId = idRef.current++;
    pushMsgs({ id: genId, role: 'system', who: '', text: `🎨 generating image — "${clip(prompt, 60)}"…`, pending: true });
    autoTitle(prompt);
    void genTitle(sid, prompt);
    setInput('');
    try {
      // No model arg — the main process auto-routes the image model from the prompt.
      const res = await call<ImageResult>('image:generate', prompt).catch((): ImageResult => ({ ok: false, error: 'request failed' }));
      if (!res.ok || !res.path) { await resolveMsg(sid, genId, { text: `✗ image failed: ${res.error ?? 'unknown error'}`, pending: false }); return; }
      const cost = typeof res.costUsd === 'number' ? ` · $${res.costUsd.toFixed(3)}` : '';
      await resolveMsg(sid, genId, { role: 'agent', who: res.model || 'image', text: `🎨 ${prompt}${cost}`, image: { path: res.path, prompt, model: res.model || 'image' }, pending: false });
    } finally {
      setBusy(false);
      sendingRef.current = false; // release the single-flight latch send() set for this image gen
    }
  }

  // Shared dropdowns reused by both layouts.
  const selectChat = (
    <select className="cell-select" value={session?.id ?? ''} disabled={busy} onChange={(e) => void openChat(e.target.value)} title="Open a saved chat" style={{ maxWidth: 200 }}>
      {session && !sessions.some((s) => s.id === session.id) ? <option value={session.id}>{session.title || '(this chat)'}</option> : null}
      {sessions.map((s) => <option key={s.id} value={s.id}>{s.unread ? '● ' : ''}{(s.title || '(untitled)')} · {fmtAge(s.updatedAt)}</option>)}
    </select>
  );
  const focusSelect = (
    <select className="cell-select" value={session?.projectId ?? ''} disabled={busy} onChange={(e) => setFocus(e.target.value)} title="Scope this chat to a project (sent as context)">
      <option value="">(no project)</option>
      {focusedProjects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== 'active' ? ` · ${p.status}` : ''}</option>)}
    </select>
  );

  return (
    <div className={embedded ? 'chat-embedded' : 'view'} style={embedded ? { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, minHeight: 0 } : undefined}>
      {embedded ? (
        // One control row, in order: New · select chat · focus · chat name.
        <div className="chat-bar" style={{ marginBottom: 6 }}>
          <button className="btn" disabled={busy} onClick={newChat}>＋ New</button>
          {selectChat}
          <span className="muted small">focus</span>
          {focusSelect}
          <input className="chat-title grow" value={session?.title ?? ''} placeholder="chat name" disabled={busy} onChange={(e) => rename(e.target.value)} />
          {session ? <button className="btn icon-danger" disabled={busy} title="Delete this chat" onClick={() => void deleteChat(session.id)}>✕</button> : null}
        </div>
      ) : (
        <>
          <header className="view-head">
            <h1>Chat</h1>
            <div className="row-actions" style={{ alignItems: 'center', gap: 8 }}>
              {selectChat}
              <button className="btn" disabled={busy} onClick={newChat}>＋ New</button>
            </div>
          </header>
          <div className="chat-bar">
            <input className="chat-title" value={session?.title ?? ''} placeholder="untitled chat — name it" disabled={busy} onChange={(e) => rename(e.target.value)} />
            <span className="muted small">focus</span>
            {focusSelect}
            <span className="grow" />
            <span className="muted">→ {target}</span>
            {session ? <button className="btn icon-danger" disabled={busy} title="Delete this chat" onClick={() => void deleteChat(session.id)}>✕</button> : null}
          </div>
        </>
      )}
      {focused ? (
        <div className="chat-focus muted small">
          <b className="accent-text">◆ {focused.name}</b>
          {focused.path ? <span className="mono" title={focused.path}> · {focused.path}</span> : null}
          {focused.path ? <button className="link-btn" onClick={() => void call('project:openFolder', focused.path)}>open ↗</button> : null}
        </div>
      ) : null}

      <div className={embedded ? '' : 'cols chat-cols'} style={embedded ? { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } : undefined}>
        <section className="card chat" style={embedded ? { flex: 1, minHeight: 0 } : undefined}>
          <div
            className="messages"
            ref={listRef}
            onScroll={() => {
              if (programmaticScrollRef.current) return;
              const el = listRef.current;
              // Only re-engage auto-scroll when the user is genuinely at the bottom.
              // Small tolerance (24px) absorbs sub-pixel rounding + smooth-scroll settle;
              // anything more would yank the user down while they're scrolled up reading.
              if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {msgs.map((m) => {
              // Scope to the viewed session: between a chat switch and the derive
              // effect updating `running`, a stale running from another session must
              // not spin a same-id message here.
              const live = running && running.sid === session?.id && running.replyId === m.id;
              const elapsed = live ? Math.max(0, Math.floor((Date.now() - running.startedAt) / 1000)) : 0;
              return (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role !== 'system' ? <div className="msg-who">{m.role === 'you' ? 'you' : m.who}</div> : null}
                <div className="msg-body">{m.pending && !m.image ? <span className="spin">▌ {m.text || (live ? `${m.who} working… ${elapsed}s` : 'thinking…')}</span> : m.text}</div>
                {/* Live "what the agent is doing" feed while this reply is running:
                    the agent's OWN steps (background tasks) and, as a distinct
                    strand, any work farmed out to other agents (delegations). */}
                {live && (activitySteps.length || liveTrace.length) ? (() => {
                  const own = activitySteps.filter((a) => a.kind !== 'delegate');
                  const delegSteps = activitySteps.filter((a) => a.kind === 'delegate');
                  const hasDeleg = delegSteps.length || liveTrace.length;
                  return (
                  <div className="chat-trace">
                    {hasDeleg ? <div className="chat-trace-head muted small">🤝 delegated · live</div> : null}
                    {delegSteps.map((a) => <div key={`d${a.seq}`} className="chat-trace-row act-accent"><span className="chat-trace-when">{whenTime(a.at)}</span>{actIcon(a.kind)} {a.summary}</div>)}
                    {liveTrace.map((t) => <div key={`e${t.seq}`} className={`chat-trace-row trace-${t.cls}`}><span className="chat-trace-when">{whenTime(t.at)}</span>{t.line}</div>)}
                    {own.length ? <div className="chat-trace-head muted small">working · live</div> : null}
                    {own.map((a) => <div key={`a${a.seq}`} className={`chat-trace-row act-${a.kind === 'error' ? 'err' : 'accent'}`}><span className="chat-trace-when">{whenTime(a.at)}</span>{actIcon(a.kind)} {a.summary}</div>)}
                  </div>
                  );
                })() : null}
                {/* Captured behind-the-scenes detail, persisted with a finished
                    reply: the <summary> carries the one-line reasoning; expanding
                    shows farmed-out work (delegations) then the agent's own
                    background-task steps. */}
                {!m.pending && (m.trace?.length || m.delegations?.length || m.reasoning) ? (
                  <details className="chat-trace done">
                    <summary className="muted small">behind the scenes{m.reasoning ? ` — ${m.reasoning}` : m.trace?.length ? ` · ${m.trace.length} background step${m.trace.length === 1 ? '' : 's'}` : ''}</summary>
                    {m.delegations?.length ? (
                      <>
                        <div className="chat-trace-head muted small">🤝 delegated</div>
                        {m.delegations.map((line, i) => <div key={`d${i}`} className="chat-trace-row">{line}</div>)}
                      </>
                    ) : null}
                    {m.trace?.length ? (
                      <>
                        {m.delegations?.length ? <div className="chat-trace-head muted small">background tasks</div> : null}
                        {m.trace.map((line, i) => <div key={`s${i}`} className="chat-trace-row">{line}</div>)}
                      </>
                    ) : null}
                  </details>
                ) : null}
                {m.image ? <ChatImage path={m.image.path} /> : null}
                {m.files && m.files.length ? (
                  <div className="msg-files">{m.files.map((f) => <span key={f.name} className="file-chip" title={f.name}>{f.isImage ? '🖼' : '📄'} {f.name}</span>)}</div>
                ) : null}
              </div>
              );
            })}
            <div ref={endRef} />
          </div>

          {attachments.length ? (
            <div className="attach-row">
              {attachments.map((f) => (
                <span key={f.path} className="file-chip" title={`${f.path} · ${fmtBytes(f.size)}`}>
                  {f.isImage ? '🖼' : '📄'} {f.name} <span className="muted">{fmtBytes(f.size)}</span>
                  <button className="file-x" title="Remove" onClick={() => removeAttachment(f.path)}>✕</button>
                </span>
              ))}
              <span className="muted small" style={{ alignSelf: 'center' }}>→ {focused ? `${focused.name}/uploads` : 'agent workspace'}</span>
            </div>
          ) : null}

          <div className="composer">
            <button className="btn attach-btn" title={destDir ? 'Attach files (or paste an image/file into the message)' : 'Focus a project or pick an agent with a workspace to attach files'} disabled={busy || inflight || !destDir} onClick={() => void addAttachments()}>📎</button>
            <textarea
              ref={textareaRef}
              className="composer-input"
              rows={1}
              value={input}
              placeholder={inflight ? `waiting for ${session?.inflight?.target ?? target}…` : focused ? `message ${target} about ${focused.name}…` : `message ${target}…`}
              disabled={busy || inflight}
              spellCheck
              autoCorrect="on"
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => void onPaste(e)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            />
            <button className="btn primary" disabled={busy || inflight || (!input.trim() && attachments.length === 0)} onClick={() => void send()}>{busy || inflight ? '…' : 'Send'}</button>
          </div>
        </section>

        {!embedded ? (
        <aside className="card targets">
          <h3>Address</h3>
          {orderedAgents.map((a) => (
            <div key={a.id} className={`target-row${a.name === target ? ' active' : ''}`}>
              <button className="target" onClick={() => setTarget(a.name)}>{a.name}</button>
              <span className={`star readonly${a.name === store.coordinator ? ' on' : ''}`} title={a.name === store.coordinator ? 'team coordinator (lead)' : 'Coordinator changes live in HR Manager'}>
                {a.name === store.coordinator ? '★' : ''}
              </span>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 8 }}>★ = coordinator. Change leads in HR Manager.</p>
          {navigate ? <button className="btn small" type="button" onClick={() => navigate('teams:route')}>Open HR Manage</button> : null}
        </aside>
        ) : null}
      </div>
    </div>
  );
}
