import { useMemo, useRef, useState, useEffect } from 'react';
import { call, resolveCoordinator, agentsLeadFirst, type FleetStore } from '../store.ts';
import type { ProjectEntry } from '../../../../idctl/src/settings/schema.ts';

type PickedFile = { path: string; name: string; size: number; isImage: boolean };
type SavedFile = { name: string; path: string; size: number; isImage: boolean };

interface Msg {
  id: number;
  role: 'you' | 'agent' | 'system';
  who: string;
  text: string;
  files?: { name: string; isImage: boolean }[];
  image?: { path: string; prompt: string; model: string };
  pending?: boolean;
}
interface Session {
  id: string;
  title: string;
  named?: boolean; // user has manually renamed → don't auto-title over it
  team: string;
  target: string;
  projectId?: string;
  messages: Msg[];
  createdAt: number;
  updatedAt: number;
}
type ChatSummary = { id: string; title: string; team: string; messageCount: number; updatedAt: number };
type ImageResult = { ok: boolean; path?: string; dataUrl?: string; model?: string; costUsd?: number; error?: string };

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

export function Chat({ store }: { store: FleetStore }) {
  const team = store.team ?? 'default';
  const defaultTarget = useMemo(
    () => resolveCoordinator(store.agents, store.coordinator) ?? 'lead',
    [store.agents, store.coordinator],
  );
  const orderedAgents = agentsLeadFirst(store.agents, store.coordinator);

  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [sessions, setSessions] = useState<ChatSummary[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  const [canImage, setCanImage] = useState(false); // an image-capable provider is configured
  const idRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef(''); // the currently-active session id (for late-arriving replies)
  const sessionRef = useRef<Session | null>(null); // mirror of the active session (to persist a gated empty chat)
  const deletedRef = useRef<Set<string>>(new Set()); // sessions deleted this run — drop their late writes

  const activeKey = `idctl.chat.session.${team}`;
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
    setSession(s);
    try { localStorage.setItem(activeKey, s.id); } catch { /* ignore */ }
  }

  async function refreshList() {
    setSessions(await call<ChatSummary[]>('chats:list', team).catch(() => []));
  }
  // Load projects, image models, the saved session list, and restore the active chat.
  useEffect(() => {
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
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [session?.messages]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  const msgs = session?.messages ?? [];
  const target = session && store.agents.some((a) => a.name === session.target) ? session.target : defaultTarget;
  const targetAgent = store.agents.find((a) => a.name === target);
  const focused = projects.find((p) => p.id === session?.projectId);
  const destDir = focused?.path || targetAgent?.workingDirectory || '';
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
    // Reflect immediately if that session is the one on screen.
    setSession((cur) => (cur && cur.id === sid
      ? { ...cur, messages: cur.messages.map((x) => (x.id === id ? { ...x, ...patchMsg } : x)), updatedAt: Date.now() }
      : cur));
    // Authoritative: patch the session's file. If it doesn't exist yet (an empty
    // chat wasn't cached) but it's the active one, persist the in-memory session
    // now that this update gives it real content.
    const s = await call<Session | null>('chats:get', sid).catch(() => null);
    if (deletedRef.current.has(sid)) return;
    const patchMsgs = (ms: Msg[]) => ms.map((x) => (x.id === id ? { ...x, ...patchMsg } : x));
    if (s) {
      s.messages = patchMsgs(s.messages);
      await call('chats:save', s).catch(() => {});
    } else if (sessionRef.current && sessionRef.current.id === sid) {
      const cur = sessionRef.current;
      await call('chats:save', { ...cur, messages: patchMsgs(cur.messages), updatedAt: Date.now() }).catch(() => {});
    }
    void refreshList();
  }

  function newChat() { const s = blankSession(); adoptSession(s); persist(s); }
  async function openChat(id: string) {
    if (id === session?.id) return;
    const s = await call<Session | null>('chats:get', id).catch(() => null);
    if (s) adoptSession(s);
  }
  async function deleteChat(id: string) {
    deletedRef.current.add(id); // drop any in-flight reply destined for this chat
    await call('chats:remove', id).catch(() => {});
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
    const s = await call<Session | null>('chats:get', sid).catch(() => null);
    if (s && !s.named && !deletedRef.current.has(sid)) { s.title = title; await call('chats:save', s).catch(() => {}); void refreshList(); }
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
    if ((!text && attachments.length === 0) || busy || !session) return;
    const sid = session.id;
    setBusy(true);
    try {
      let saved: SavedFile[] = [];
      if (attachments.length) {
        if (!destDir) { pushMsgs({ id: idRef.current++, role: 'system', who: '', text: '✗ Nowhere to put the files — focus a project or pick an agent with a workspace.' }); return; }
        const res = await call<{ ok: boolean; files: SavedFile[]; skipped?: string[]; error?: string }>('chat:saveFiles', destDir, attachments.map((a) => a.path)).catch(() => ({ ok: false, files: [] as SavedFile[], skipped: [] as string[], error: 'copy failed' }));
        if (!res.ok) { pushMsgs({ id: idRef.current++, role: 'system', who: '', text: `✗ Couldn't attach files: ${res.error ?? 'unknown error'}` }); return; }
        saved = res.files;
        if (res.skipped?.length) pushMsgs({ id: idRef.current++, role: 'system', who: '', text: `⚠ Couldn't attach ${res.skipped.length} file(s): ${res.skipped.join(', ')}` });
        if (saved.length === 0 && !text) return;
      }
      const message = compose(text, saved);
      const myId = idRef.current++;
      const replyId = idRef.current++;
      pushMsgs(
        { id: myId, role: 'you', who: 'you', text: text || '(files only)', files: saved.map((f) => ({ name: f.name, isImage: f.isImage })) },
        { id: replyId, role: 'agent', who: target, text: '', pending: true },
      );
      if (text) { autoTitle(text); void genTitle(sid, text); }
      setInput('');
      setAttachments([]);
      try {
        const reply = await call<string>('dispatch', `/ask ${target} ${qArg(message)}`);
        await resolveMsg(sid, replyId, { text: reply, pending: false });
      } catch (err) {
        await resolveMsg(sid, replyId, { role: 'system', text: `✗ ${err instanceof Error ? err.message : String(err)}`, pending: false });
      }
    } finally {
      setBusy(false);
    }
  }

  async function genImage() {
    const prompt = input.trim();
    if (!prompt || busy || !session) return;
    const sid = session.id;
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
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Chat</h1>
        <div className="row-actions" style={{ alignItems: 'center', gap: 8 }}>
          <select className="cell-select" value={session?.id ?? ''} onChange={(e) => void openChat(e.target.value)} title="Open a saved chat" style={{ maxWidth: 220 }}>
            {session && !sessions.some((s) => s.id === session.id) ? <option value={session.id}>{session.title || '(this chat)'}</option> : null}
            {sessions.map((s) => <option key={s.id} value={s.id}>{(s.title || '(untitled)')} · {fmtAge(s.updatedAt)}</option>)}
          </select>
          <button className="btn" disabled={busy} onClick={newChat}>＋ New</button>
        </div>
      </header>

      <div className="chat-bar">
        <input className="chat-title" value={session?.title ?? ''} placeholder="untitled chat — name it" disabled={busy} onChange={(e) => rename(e.target.value)} />
        <span className="muted small">focus</span>
        <select className="cell-select" value={session?.projectId ?? ''} disabled={busy} onChange={(e) => setFocus(e.target.value)} title="Scope this chat to a project (sent as context)">
          <option value="">(no project)</option>
          {focusedProjects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.status !== 'active' ? ` · ${p.status}` : ''}</option>)}
        </select>
        <span className="grow" />
        <span className="muted">→ {target}</span>
        {session ? <button className="btn icon-danger" disabled={busy} title="Delete this chat" onClick={() => void deleteChat(session.id)}>✕</button> : null}
      </div>
      {focused ? (
        <div className="chat-focus muted small">
          <b className="accent-text">◆ {focused.name}</b>
          {focused.path ? <span className="mono" title={focused.path}> · {focused.path}</span> : null}
          {focused.path ? <button className="link-btn" onClick={() => void call('project:openFolder', focused.path)}>open ↗</button> : null}
        </div>
      ) : null}

      <div className="cols chat-cols">
        <section className="card chat">
          <div className="messages">
            {msgs.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                {m.role !== 'system' ? <div className="msg-who">{m.role === 'you' ? 'you' : m.who}</div> : null}
                <div className="msg-body">{m.pending && !m.image ? <span className="spin">▌ {m.text || 'thinking…'}</span> : m.text}</div>
                {m.image ? <ChatImage path={m.image.path} /> : null}
                {m.files && m.files.length ? (
                  <div className="msg-files">{m.files.map((f) => <span key={f.name} className="file-chip" title={f.name}>{f.isImage ? '🖼' : '📄'} {f.name}</span>)}</div>
                ) : null}
              </div>
            ))}
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
            <button className="btn attach-btn" title={destDir ? 'Attach files' : 'Focus a project or pick an agent with a workspace to attach files'} disabled={busy || !destDir} onClick={() => void addAttachments()}>📎</button>
            <button className="btn attach-btn" title={canImage ? 'Generate an image from the box (model auto-picked from your prompt)' : 'Add an OpenRouter key in Settings → Inference to generate images'} disabled={busy || !canImage || !input.trim()} onClick={() => void genImage()}>🎨</button>
            <input
              className="composer-input"
              value={input}
              placeholder={focused ? `message ${target} about ${focused.name}…` : `message ${target}…`}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            />
            <button className="btn primary" disabled={busy || (!input.trim() && attachments.length === 0)} onClick={() => void send()}>{busy ? '…' : 'Send'}</button>
          </div>
          {canImage ? (
            <div className="muted small" style={{ marginTop: 6 }}>🎨 type a prompt and hit the button — the image model is auto-picked from your prompt (billed to OpenRouter)</div>
          ) : null}
        </section>

        <aside className="card targets">
          <h3>Address</h3>
          {orderedAgents.map((a) => (
            <div key={a.id} className={`target-row${a.name === target ? ' active' : ''}`}>
              <button className="target" onClick={() => setTarget(a.name)}>{a.name}</button>
              <button className={`star${a.name === store.coordinator ? ' on' : ''}`} title={a.name === store.coordinator ? 'team coordinator (lead)' : 'set as coordinator (lead)'} onClick={() => void store.setCoordinator(a.name)}>
                {a.name === store.coordinator ? '★' : '☆'}
              </button>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 8 }}>★ = coordinator. Chat defaults to it; name it anything.</p>
        </aside>
      </div>
    </div>
  );
}
