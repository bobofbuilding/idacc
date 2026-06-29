import { useEffect, useMemo, useRef, useState } from 'react';
import { call, resolveCoordinator, useSyncVersion, type FleetStore } from '../store.ts';
import { useToast } from '../components/toast.tsx';
import type { ProjectEntry, ProjectStatus } from '../../../../idctl/src/settings/schema.ts';

const STATUSES: ProjectStatus[] = ['active', 'paused', 'blocked', 'done'];
const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'active', paused: 'paused', blocked: 'blocked', done: 'done' };
const STATUS_CLASS: Record<ProjectStatus, string> = { active: 'st-active', paused: 'st-paused', blocked: 'st-blocked', done: 'st-done' };
type AutoCommitMode = 'off' | 'task' | 'plan';
const AUTO_COMMIT_LABEL: Record<AutoCommitMode, string> = { off: 'off', task: 'any task done', plan: 'plan validation' };
const GIT_ACTIONS = [
  { id: 'fetch', label: '⤓ Fetch', title: 'git fetch --all --prune — download new commits/branches from GitHub WITHOUT changing your files or branch' },
  { id: 'pull', label: '⇩ Pull', title: 'Resilient pull: fetch + fast-forward to GitHub. Self-heals a stranded repo — if your branch is an orphaned/merged-and-deleted PR branch, it switches back to the default branch and fast-forwards. Never force-pushes or auto-merges.' },
  { id: 'status', label: '◔ Status', title: 'git status -sb — current branch + which files are modified / staged / untracked' },
  { id: 'log', label: '☰ Log', title: 'git log --oneline -15 — the 15 most recent commits' },
  { id: 'diff', label: '± Diff', title: 'git diff --stat — files changed (with +/- line counts) since your last commit' },
] as const;

/** Git state of a project folder (computed in the main process). */
type GitInfo = {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  upstreamUrl?: string;
  isFork?: boolean;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  compareRef?: string;
  upstreamGone?: boolean; // tracking branch deleted on the remote (orphaned) — Pull self-heals
  error?: string;
};
type Readme = { found: boolean; name?: string; description?: string };
type TaskLite = { shortId?: string; uuid?: string; title: string; status: string; teamName?: string };
/** GitHub repo metadata (from the main process via the GitHub API). */
type GithubMeta = { ok: boolean; name?: string; description?: string; topics?: string[]; language?: string; isPrivate?: boolean; error?: string };
type CloneResult = { ok: boolean; path?: string; name?: string; error?: string };
type ProjectDiff = { ok: boolean; stat: string; diff: string; untracked: string[]; error?: string };

function newId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
function splitList(s: string): string[] {
  return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}
const BLANK = { name: '', status: 'active' as ProjectStatus, description: '', team: '', tags: '', links: '', path: '', notes: '' };

/** Compact git status: branch + ahead/behind/fork + dirty. */
function GitStatus({ g }: { g?: GitInfo }) {
  if (!g) return <span className="muted small">checking…</span>;
  if (!g.isRepo) return <span className="muted small" title={g.error}>📁 folder (not a git repo)</span>;
  let label = 'up to date';
  let cls = 'ok-text';
  if (g.ahead == null || g.behind == null) { label = 'fetch to compare'; cls = 'muted'; }
  else if (g.ahead && g.behind) { label = `${g.ahead} ahead · ${g.behind} behind`; cls = 'warn-text'; }
  else if (g.behind) { label = `${g.behind} behind`; cls = 'warn-text'; }
  else if (g.ahead) { label = g.isFork ? `customized · ${g.ahead} ahead of upstream` : `${g.ahead} ahead`; cls = 'accent-text'; }
  else { label = g.isFork ? 'fork · in sync with upstream' : 'up to date'; cls = 'ok-text'; }
  return (
    <span className="git-badge">
      <span className="mono muted">⎇ {g.branch || '—'}</span>
      {g.isFork ? <span className="chip tag" title={`fork — upstream: ${g.upstreamUrl}`}>fork</span> : null}
      <span className={`small ${cls}`} title={g.compareRef ? `vs ${g.compareRef}` : undefined}>{label}</span>
      {g.upstreamGone ? <span className="warn-text small" title={`This branch's remote was deleted (e.g. a merged PR branch). Click ⇩ Pull — it auto-heals: switches back to the default branch and fast-forwards.`}>⚠ orphaned branch · Pull to heal</span> : null}
      {g.dirty ? <span className="warn-text small" title="uncommitted local changes">● uncommitted</span> : null}
    </span>
  );
}

function gitSummary(g: GitInfo | null | undefined): string[] {
  if (!g) return ['Git: not checked yet'];
  if (!g.isRepo) return [`Git: not a repository${g.error ? ` (${g.error})` : ''}`];
  const sync = g.ahead == null || g.behind == null
    ? 'fetch needed to compare'
    : g.ahead && g.behind
      ? `${g.ahead} ahead, ${g.behind} behind`
      : g.ahead
        ? `${g.ahead} ahead`
        : g.behind
          ? `${g.behind} behind`
          : 'up to date';
  return [
    `Branch: ${g.branch || '(unknown)'}`,
    `Remote: ${g.remoteUrl || '(none)'}`,
    `Compare: ${g.compareRef || '(unknown)'} - ${sync}`,
    `Working tree: ${g.dirty ? 'uncommitted changes' : 'clean'}`,
    ...(g.upstreamGone ? ['Warning: tracking branch is gone; pull may switch back to the default branch if this branch was already merged.'] : []),
  ];
}

function diffSummary(d: ProjectDiff | null | undefined): string[] {
  if (!d) return ['Diff: unavailable'];
  if (!d.ok) return [`Diff: unavailable${d.error ? ` (${d.error})` : ''}`];
  const lines = ['Files changed:', d.stat.trim() || '(none tracked)'];
  if (d.untracked.length) {
    const shown = d.untracked.slice(0, 12);
    lines.push(`Untracked: ${shown.join(', ')}${d.untracked.length > shown.length ? `, ...and ${d.untracked.length - shown.length} more` : ''}`);
  } else {
    lines.push('Untracked: none');
  }
  return lines;
}
function autoCommitBlockers(g: GitInfo | null | undefined, d: ProjectDiff | null | undefined): string[] {
  const out: string[] = [];
  if (!g) out.push('git status unavailable');
  else if (!g.isRepo) out.push('not a git repository');
  else {
    if (!g.remoteUrl) out.push('no remote is linked');
    if (g.upstreamGone) out.push('tracking branch is gone');
    if (g.ahead == null || g.behind == null) out.push('fetch/compare state is unknown');
    else {
      if (g.behind > 0) out.push(`${g.behind} behind remote`);
      if (g.ahead > 0) out.push(`${g.ahead} unpushed local commit${g.ahead === 1 ? '' : 's'}`);
    }
  }
  if (!d) out.push('diff unavailable');
  else if (!d.ok) out.push(`diff unavailable${d.error ? ` (${d.error})` : ''}`);
  else if (!d.stat && !d.diff && !d.untracked.length) out.push('no working changes');
  return out;
}
function autoCommitMode(p: ProjectEntry): AutoCommitMode {
  return p.autoCommit === 'task' || p.autoCommit === 'plan' ? p.autoCommit : 'off';
}
function projectStamp(p: ProjectEntry): string {
  return JSON.stringify({
    id: p.id,
    name: p.name,
    status: p.status,
    description: p.description ?? '',
    team: p.team ?? '',
    tags: p.tags ?? [],
    links: p.links ?? [],
    path: p.path ?? '',
    notes: p.notes ?? '',
    autoCommit: p.autoCommit ?? 'off',
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
  });
}
const normProjectKey = (s?: string) => (s || '').trim().replace(/\/+$/, '').toLowerCase();
function duplicateKeyOf(p: ProjectEntry): string {
  return normProjectKey(p.path) || normProjectKey((p.links ?? [])[0]) || `name:${normProjectKey(p.name)}`;
}
function duplicateProjectGroups(list: ProjectEntry[]): ProjectEntry[][] {
  const groups = new Map<string, ProjectEntry[]>();
  for (const p of list) {
    const k = duplicateKeyOf(p);
    if (!k) continue;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
function duplicateGroupsStamp(groups: ProjectEntry[][]): string {
  return groups.map((g) => g.map(projectStamp).sort().join('|')).sort().join('\n');
}
function uniqStrings(arr: string[]): string[] {
  return arr.filter((v, i, a) => v && a.indexOf(v) === i);
}

export function Projects({ store }: { store: FleetStore }) {
  const syncVersion = useSyncVersion(['projects', 'dashboard', 'brain']);
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [gitMap, setGitMap] = useState<Record<string, GitInfo>>({});
  const [gitOut, setGitOut] = useState<Record<string, { action: string; output: string }>>({});
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectStatus | 'all'>('all');
  const [editing, setEditing] = useState<string | null>(null); // project id, 'new', or null
  const [editBaseline, setEditBaseline] = useState<ProjectEntry | null>(null);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [ghOpen, setGhOpen] = useState(false);
  const [ghUrl, setGhUrl] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [ghMode, setGhMode] = useState<'clone' | 'fork'>('clone'); // Add-from-GitHub: clone vs fork & clone
  const [commitFor, setCommitFor] = useState<string | null>(null); // project whose AI commit composer is open
  const [commitMsg, setCommitMsg] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [repoFor, setRepoFor] = useState<string | null>(null);    // project whose "create GitHub repo" form is open
  const [repoName, setRepoName] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [linkFor, setLinkFor] = useState<string | null>(null);    // project whose "link existing repo" form is open
  const [linkUrl, setLinkUrl] = useState('');
  const [automationFor, setAutomationFor] = useState<string | null>(null);

  const lead = resolveCoordinator(store.agents, store.coordinator);
  // New projects default to the DEFAULT team, which delegates git work to the
  // responsible agent (git-manager). Falls back to the first team if absent.
  const defaultTeamName = useMemo(() => (store.teams.some((t) => t.name === 'default') ? 'default' : (store.teams[0]?.name ?? '')), [store.teams]);
  // Resolve a team's lead/coordinator (who owns + delegates the commit).
  const teamLeadOf = (team?: string) => resolveCoordinator(store.allAgents.filter((a) => a.team === (team || defaultTeamName)), undefined) || 'lead';
  // Per-project checkpoint state: completed-task refs seen so far (baseline) + last
  // auto-commit time (throttle). A ref so the 45s watcher doesn't trigger re-renders.
  const autoSeenRef = useRef<Record<string, { seen: Set<string>; lastFire: number }>>({});
  // How many duplicate entries exist (same folder, or same primary repo) — drives the
  // "Combine duplicates" button. Each group of N counts N-1 extras.
  const dupCount = useMemo(() => {
    return duplicateProjectGroups(projects).reduce((n, g) => n + g.length - 1, 0);
  }, [projects]);

  // Checkpoint auto-commit watcher: poll every team's tasks; when a NEW matching
  // completion appears for an auto-enabled project AND its repo is dirty, request a
  // commit. Baselines on first sight (existing done-tasks don't fire); throttled 10m.
  useEffect(() => {
    const autos = projects.filter((p) => p.path && p.team && (p.autoCommit === 'task' || p.autoCommit === 'plan'));
    for (const id of Object.keys(autoSeenRef.current)) if (!autos.some((p) => p.id === id)) delete autoSeenRef.current[id];
    if (!autos.length) return;
    let alive = true;
    const tick = async () => {
      const all = await call<TaskLite[]>('tasks:allTeams').catch(() => [] as TaskLite[]);
      if (!alive || !all.length) return;
      for (const p of autos) {
        const done = all.filter((t) => t.teamName === p.team && /done|complete/i.test(t.status));
        const matched = p.autoCommit === 'plan' ? done.filter((t) => /validat|verif|\bplan\b|review|approv|sign.?off/i.test(t.title)) : done;
        const refs = new Set(matched.map((t) => t.shortId || t.uuid || t.title));
        const st = autoSeenRef.current[p.id];
        if (!st) { autoSeenRef.current[p.id] = { seen: refs, lastFire: 0 }; continue; } // baseline only
        const fresh = [...refs].filter((r) => !st.seen.has(r));
        st.seen = refs;
        if (!fresh.length || Date.now() - st.lastFire < 10 * 60 * 1000) continue; // nothing new / throttled
        const g = await call<GitInfo>('project:git', p.path!).catch(() => null);
        if (!g?.dirty) continue; // nothing to commit
        st.lastFire = Date.now();
        void autoCommitNow(p, fresh[0], p.autoCommit as 'task' | 'plan');
      }
    };
    void tick();
    const iv = setInterval(tick, 45000);
    return () => { alive = false; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  async function loadGit(list: ProjectEntry[]) {
    const withPath = list.filter((p) => p.path);
    const pairs = await Promise.all(
      withPath.map(async (p) => [p.id, await call<GitInfo>('project:git', p.path).catch(() => ({ isRepo: false }) as GitInfo)] as const),
    );
    setGitMap(Object.fromEntries(pairs));
  }
  function replaceProjects(list: ProjectEntry[]) {
    setProjects(list);
    void loadGit(list);
  }
  async function freshProjects(): Promise<ProjectEntry[]> {
    return call<ProjectEntry[]>('projects:list');
  }
  async function ensureProjectFresh(p: ProjectEntry, action: string, opts: { quiet?: boolean } = {}): Promise<ProjectEntry | null> {
    const list = await freshProjects().catch(() => null);
    if (!list) {
      const msg = `Could not verify "${p.name}" before ${action}. Refresh Projects and try again.`;
      setNote(msg);
      if (!opts.quiet) window.alert(msg);
      return null;
    }
    const current = list.find((x) => x.id === p.id);
    if (!current) {
      replaceProjects(list);
      const msg = `"${p.name}" no longer exists. Projects has been refreshed.`;
      setNote(msg);
      if (!opts.quiet) window.alert(msg);
      return null;
    }
    if (projectStamp(current) !== projectStamp(p)) {
      replaceProjects(list);
      const msg = `"${p.name}" changed before ${action}. Projects has been refreshed; review the latest row before writing.`;
      setNote(msg);
      if (!opts.quiet) window.alert(msg);
      return null;
    }
    return current;
  }
  async function currentProject(id: string): Promise<{ current: ProjectEntry | null; list: ProjectEntry[] } | null> {
    const list = await freshProjects().catch(() => null);
    if (!list) return null;
    return { current: list.find((p) => p.id === id) ?? null, list };
  }
  async function load() {
    const list = await call<ProjectEntry[]>('projects:list').catch(() => []);
    replaceProjects(list);
    const r = await call<string | null>('projects:detectRoot').catch(() => null);
    setRoot(r);
    if (list.length === 0 && r) setNote(`workspace found at ${r} - review, then Sync workspace to track projects`);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [syncVersion]);

  type SyncResult = { ok: boolean; root: string | null; added: number; adopted: number; total: number; error?: string };
  /** Scan the workspace projects folder and merge each subfolder into the tracker. */
  async function doSync(rootArg?: string, silent = false) {
    setSyncing(true);
    if (!silent) setNote('syncing from workspace…');
    try {
      const res = await call<SyncResult>('projects:syncRoot', rootArg).catch((): SyncResult => ({ ok: false, root: null, added: 0, adopted: 0, total: 0, error: 'sync failed' }));
      if (res.root) setRoot(res.root);
      if (!res.ok) { setNote(res.error ? `sync: ${res.error}` : 'no projects folder found'); return; }
      const list = await call<ProjectEntry[]>('projects:list').catch(() => []);
      replaceProjects(list);
      const parts: string[] = [];
      if (res.added) parts.push(`${res.added} added`);
      if (res.adopted) parts.push(`${res.adopted} linked`);
      setNote(parts.length ? `synced from workspace — ${parts.join(', ')} ✓` : 'workspace already in sync ✓');
    } finally {
      setSyncing(false);
    }
  }
  /** Point the tracker at a different projects folder, then sync it. */
  async function changeRoot() {
    const p = await call<string | null>('project:pickFolder').catch(() => null);
    if (!p) return;
    await doSync(p);
  }

  const shown = useMemo(
    () => projects.filter((p) => filter === 'all' || p.status === filter).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [projects, filter],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: projects.length };
    for (const s of STATUSES) c[s] = projects.filter((p) => p.status === s).length;
    return c;
  }, [projects]);

  function openNew() { setForm({ ...BLANK, team: defaultTeamName }); setEditBaseline(null); setEditing('new'); setNote(''); }
  function openEdit(p: ProjectEntry) {
    setForm({ name: p.name, status: p.status, description: p.description ?? '', team: p.team ?? '', tags: (p.tags ?? []).join(', '), links: (p.links ?? []).join('\n'), path: p.path ?? '', notes: p.notes ?? '' });
    setEditBaseline(p);
    setEditing(p.id); setNote('');
  }
  /** Pick a folder and pre-fill name/description from its README. */
  async function browse() {
    const p = await call<string | null>('project:pickFolder').catch(() => null);
    if (!p) return;
    const r = await call<Readme>('project:readme', p).catch((): Readme => ({ found: false }));
    setForm((f) => ({ ...f, path: p, name: f.name.trim() || r?.name || '', description: f.description.trim() || r?.description || '' }));
    if (r?.found) setNote('folder + README read ✓');
  }
  async function readReadme() {
    const r = await call<Readme>('project:readme', form.path.trim()).catch((): Readme => ({ found: false }));
    if (r?.found) { setForm((f) => ({ ...f, name: r.name || f.name, description: r.description || f.description })); setNote('name/description filled from README ✓'); }
    else setNote('no README found in that folder');
  }
  /** Top-level: import a folder straight into a new-project form. */
  async function importFolder() {
    const p = await call<string | null>('project:pickFolder').catch(() => null);
    if (!p) return;
    const r = await call<Readme>('project:readme', p).catch((): Readme => ({ found: false }));
    setForm({ ...BLANK, team: defaultTeamName, path: p, name: r?.name || '', description: r?.description || '' });
    setEditBaseline(null);
    setEditing('new');
    setNote(r?.found ? 'imported folder — README read; review and Save' : 'imported folder (no README found)');
  }
  /** One-step "Add from GitHub": clone the repo, then auto-fill name/desc/tags. */
  async function addFromGithub() {
    const url = ghUrl.trim();
    if (!url) { setNote('paste a GitHub repo URL'); return; }
    if (!/github\.com[/:][^/\s]+\/[^/\s]+/i.test(url)) { setNote('that doesn’t look like a GitHub repo URL'); return; }
    setBusy(true);
    try {
      setNote('choose where to clone it…');
      const parent = await call<string | null>('project:pickFolder', root ?? undefined).catch(() => null);
      if (!parent) { setNote('cancelled'); return; }
      setNote(ghMode === 'fork' ? 'forking on GitHub + cloning your fork…' : 'cloning… (large repos take a moment)');
      const c = ghMode === 'fork'
        ? await call<CloneResult & { slug?: string }>('project:fork', url, parent)
        : await call<CloneResult>('project:cloneGithub', url, parent);
      if (!c.ok || !c.path) { setNote(`${ghMode === 'fork' ? 'fork' : 'clone'} failed: ${c.error ?? 'unknown error'}`); return; }
      const forkSlug = (c as { slug?: string }).slug;
      const [meta, readme] = await Promise.all([
        call<GithubMeta>('project:githubMeta', url).catch((): GithubMeta => ({ ok: false })),
        call<Readme>('project:readme', c.path).catch((): Readme => ({ found: false })),
      ]);
      const tags = [...(meta.language ? [meta.language] : []), ...(meta.topics ?? []), ...(ghMode === 'fork' ? ['fork'] : [])];
      setForm({
        ...BLANK,
        team: defaultTeamName,
        name: meta.name || readme.name || c.name || '',
        description: meta.description || readme.description || '',
        tags: tags.join(', '),
        path: c.path,
        // For a fork, link the fork (origin) first, then the upstream we cloned from.
        links: ghMode === 'fork' && forkSlug
          ? `${forkSlug}\n${url.replace(/^https?:\/\//i, '').replace(/\.git$/i, '')}`
          : url.replace(/^https?:\/\//i, '').replace(/\.git$/i, ''),
      });
      setGhOpen(false); setGhUrl('');
      setEditBaseline(null);
      setEditing('new');
      const src = meta.ok && meta.description ? 'GitHub' : readme.found ? 'README' : 'folder';
      setNote(ghMode === 'fork'
        ? `forked → ${forkSlug ?? c.name} ✓ (upstream wired); review & Save`
        : `cloned ${c.name} ✓ — auto-filled from ${src}; review & Save${lead ? ' (or “Refine with lead”)' : ''}`);
    } finally {
      setBusy(false);
    }
  }
  /** Route description/tags through the team lead (it can use its GitHub tools). */
  async function refineWithLead() {
    const slug = form.links.split(/[,\n]/)[0]?.trim() || form.name.trim();
    if (!slug) { setNote('need a repo or name to summarize'); return; }
    if (!lead) { setNote('no team lead online to route through'); return; }
    setBusy(true);
    setNote(`asking ${lead} to summarize…`);
    try {
      const ask = `Summarize the GitHub repo ${slug} for a project tracker. Use your GitHub tools to look it up if needed. Reply with ONLY a JSON object and nothing else: {"description":"<one concise sentence>","tags":["tag1","tag2","tag3"]}. Tags lowercase, 3-6 of them.`;
      const reply = await call<string>('dispatch', `/ask ${lead} ${ask}`).catch(() => '');
      const m = String(reply).match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const o = JSON.parse(m[0]) as { description?: unknown; tags?: unknown };
          const desc = typeof o.description === 'string' ? o.description.trim() : '';
          const tags = Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim()).filter(Boolean) : [];
          if (desc || tags.length) {
            setForm((f) => ({ ...f, description: desc || f.description, tags: tags.length ? tags.join(', ') : f.tags }));
            setNote(`refined by ${lead} ✓ — review & Save`);
            return;
          }
        } catch { /* unparseable — fall through */ }
      }
      setNote(`${lead} reply wasn’t usable — kept current values`);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const name = form.name.trim();
    if (!name) { setNote('name required'); return; }
    setBusy(true);
    try {
      const now = Date.now();
      const baseline = editing && editing !== 'new' ? editBaseline ?? projects.find((p) => p.id === editing) : undefined;
      const fresh = baseline ? await ensureProjectFresh(baseline, 'saving') : null;
      if (baseline && !fresh) return;
      const entry: ProjectEntry = {
        id: fresh?.id ?? newId(),
        name,
        status: form.status,
        description: form.description.trim() || undefined,
        team: form.team.trim() || undefined,
        tags: splitList(form.tags),
        links: splitList(form.links),
        path: form.path.trim() || undefined,
        notes: form.notes.trim() || undefined,
        autoCommit: fresh?.autoCommit,
        createdAt: fresh?.createdAt ?? now,
        updatedAt: now,
      };
      const list = await call<ProjectEntry[]>('projects:save', entry);
      replaceProjects(list);
      setEditing(null);
      setEditBaseline(null);
      setNote(`saved ${name} ✓`);
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(p: ProjectEntry, status: ProjectStatus) {
    const fresh = await ensureProjectFresh(p, 'changing status');
    if (!fresh) return;
    const list = await call<ProjectEntry[]>('projects:save', { ...fresh, status, updatedAt: Date.now() });
    replaceProjects(list);
  }
  async function remove(p: ProjectEntry) {
    setBusy(true);
    try {
      const fresh = await ensureProjectFresh(p, 'deleting');
      if (!fresh) return;
      replaceProjects(await call<ProjectEntry[]>('projects:remove', fresh.id));
      setConfirmDel(null);
      setNote('deleted ✓');
    } finally {
      setBusy(false);
    }
  }
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  // Publish a change: the project's owning team (default) owns the task and delegates the
  // creds) rather than committing from here. This is the standard "request for change" flow.
  async function submitCommit(p: ProjectEntry, desc: string, opts: { confirm?: boolean; quietStale?: boolean } = {}) {
    if (!desc.trim()) { setNote('describe the change (or use ✨ Draft with AI)'); return; }
    const fresh = await ensureProjectFresh(p, 'committing and pushing', { quiet: opts.quietStale });
    if (!fresh) {
      if (opts.quietStale) toast({ kind: 'info', text: `Commit skipped because "${p.name}" changed before the write. Review Projects and retry.`, durationMs: 10000 });
      return;
    }
    if (!fresh.path) { setNote('this project has no local folder to commit'); return; }
    const shouldConfirm = opts.confirm ?? true;
    if (shouldConfirm) {
      const [g, d] = await Promise.all([
        call<GitInfo>('project:git', fresh.path).catch(() => null),
        call<ProjectDiff>('project:diff', fresh.path).catch(() => null),
      ]);
      if (d?.ok && !d.stat && !d.diff && !d.untracked.length) {
        setNote(`nothing to commit for ${fresh.name}`);
        return;
      }
      const subject = desc.trim().split('\n').find(Boolean) ?? '(empty message)';
      const preview = [
        `Commit and push changes for "${fresh.name}"?`,
        '',
        `Folder: ${fresh.path}`,
        ...gitSummary(g),
        '',
        ...diffSummary(d),
        '',
        `Commit message: ${subject}`,
        '',
        'This stages all non-ignored changes, creates a commit with the reviewed message, and pushes the current branch when possible.',
      ].join('\n');
      if (!window.confirm(preview)) return;
    }
    // Commit & push DIRECTLY from the app (reliable) instead of delegating to an agent that may
    // mark the task "done" without the commit ever landing. .gitignore keeps secrets out; the
    // backend self-heals the branch + pulls before committing.
    const t = toast({ kind: 'progress', text: `Committing & pushing “${fresh.name}”…` });
    try {
      const r = await call<{ ok: boolean; output: string; committed: boolean; pushed: boolean }>('project:commit', fresh.path, desc.trim());
      if (!r.ok) { t.update({ kind: 'error', text: `Commit failed: ${r.output}` }); return; }
      if (!r.committed) t.update({ kind: 'info', text: `Nothing to commit — “${fresh.name}” is already clean` });
      else if (r.pushed) t.update({ kind: 'success', text: `Committed & pushed “${fresh.name}” ✓` });
      else t.update({ kind: 'info', text: `Committed “${fresh.name}” locally — ${r.output}` });
      setCommitFor(null); setCommitMsg('');
      const latest = await currentProject(fresh.id);
      if (latest) replaceProjects(latest.list);
    } catch (e) {
      t.update({ kind: 'error', text: `Commit failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // AI assistance: read the project's working diff and have the team lead draft a
  // commit message (subject + bullets), pre-filling the composer for review.
  async function draftCommit(p: ProjectEntry) {
    if (!p.path) return;
    if (!lead) { setNote('no team lead online to draft with'); return; }
    setDrafting(true);
    try {
      const fresh = await ensureProjectFresh(p, 'drafting commit');
      if (!fresh?.path) return;
      const d = await call<{ ok: boolean; stat: string; diff: string; untracked: string[]; error?: string }>('project:diff', fresh.path).catch(() => null);
      if (!d || !d.ok) { setNote(`couldn't read the diff: ${d?.error ?? 'unknown'}`); return; }
      if (!d.stat && !d.diff && !d.untracked.length) { setNote('no working changes to summarize'); return; }
      const ask = `Draft a git commit message for the project "${fresh.name}". Working changes below.\n\nFiles changed (git diff --stat):\n${d.stat || '(none tracked)'}\n\nUntracked files: ${d.untracked.join(', ') || 'none'}\n\nDiff:\n${d.diff || '(no tracked changes)'}\n\nReply with ONLY the commit message: a concise imperative subject line (≤72 chars), then a blank line, then 1-4 short bullet points. No code fences, no preamble.`;
      const reply = await call<string>('dispatch', `/ask ${lead} ${q(ask)}`).catch(() => '');
      const clean = String(reply || '').replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
      if (!clean) { setNote(`${lead} didn't return a draft — write one manually`); return; }
      setCommitMsg(clean);
      setNote(`drafted by ${lead} — review & request`);
    } finally {
      setDrafting(false);
    }
  }
  // Create a GitHub repo for a folder-only project and connect it as origin (SSH).
  async function createRepo(p: ProjectEntry) {
    if (!p.path) return;
    setBusy(true);
    let t: ReturnType<typeof toast> | null = null;
    try {
      const fresh = await ensureProjectFresh(p, 'creating a GitHub repo');
      if (!fresh?.path) return;
      const name = (repoName || fresh.name || '').trim();
      if (!name) { setNote('enter a repo name'); return; }
      t = toast({ kind: 'progress', text: `Creating GitHub repo “${name}”…` });
      const r = await call<{ ok: boolean; slug?: string; htmlUrl?: string; error?: string }>('project:createRepo', fresh.path, { name, description: fresh.description || undefined, private: repoPrivate });
      if (!r.ok) { t.update({ kind: 'error', text: `Create repo failed: ${r.error}` }); setNote(`create repo failed: ${r.error}`); return; }
      const latest = await currentProject(fresh.id);
      if (!latest) { t.update({ kind: 'info', text: `Created ${r.slug} ✓ — refresh Projects to attach the repo link.` }); return; }
      if (!latest.current) {
        replaceProjects(latest.list);
        t.update({ kind: 'info', text: `Created ${r.slug} ✓, but the project row was removed before metadata could be saved.` });
        return;
      }
      const links = uniqStrings([r.slug ?? '', ...((latest.current.links ?? []) as string[])]);
      const list = await call<ProjectEntry[]>('projects:save', { ...latest.current, links, updatedAt: Date.now() });
      replaceProjects(list);
      t.update({ kind: 'success', text: `Created ${r.slug} ✓ — origin connected. Use ⤴ Request commit to push your files.` });
      setRepoFor(null); setRepoName('');
      setCommitFor(latest.current.id); setCommitMsg(''); // open the composer so they can push content right away
    } catch (e) {
      t?.update({ kind: 'error', text: `Create repo failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }
  // Link a folder-only project to an EXISTING GitHub repo: connect origin + fetch.
  async function linkRepo(p: ProjectEntry) {
    if (!p.path) return;
    const url = linkUrl.trim();
    if (!/github\.com[/:][^/\s]+\/[^/\s]+/i.test(url)) { setNote('paste an existing GitHub repo URL'); return; }
    setBusy(true);
    let t: ReturnType<typeof toast> | null = null;
    try {
      const fresh = await ensureProjectFresh(p, 'linking a GitHub repo');
      if (!fresh?.path) return;
      t = toast({ kind: 'progress', text: `Linking “${fresh.name}” to ${url}…` });
      const r = await call<{ ok: boolean; slug?: string; remoteUrl?: string; error?: string }>('project:linkRepo', fresh.path, url);
      if (!r.ok) { t.update({ kind: 'error', text: `Link failed: ${r.error}` }); setNote(`link failed: ${r.error}`); return; }
      const link = (r.slug ? `github.com/${r.slug}` : url.replace(/^https?:\/\//i, '').replace(/\.git$/i, ''));
      const latest = await currentProject(fresh.id);
      if (!latest) { t.update({ kind: 'info', text: `Linked ${r.slug} ✓ — refresh Projects to attach the repo link.` }); return; }
      if (!latest.current) {
        replaceProjects(latest.list);
        t.update({ kind: 'info', text: `Linked ${r.slug} ✓, but the project row was removed before metadata could be saved.` });
        return;
      }
      const links = uniqStrings([link, ...((latest.current.links ?? []) as string[])]);
      const list = await call<ProjectEntry[]>('projects:save', { ...latest.current, links, updatedAt: Date.now() });
      replaceProjects(list);
      t.update({ kind: 'success', text: `Linked ${r.slug} ✓ — origin connected + fetched. Pull to sync, then ⤴ Request commit.` });
      setLinkFor(null); setLinkUrl('');
    } catch (e) {
      t?.update({ kind: 'error', text: `Link failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }
  // Combine duplicate projects: group entries that point at the SAME folder (or same
  // primary repo link), keep the richest one, merge the others' metadata in, drop them.
  async function combineDuplicates() {
    const firstList = await freshProjects().catch(() => null);
    if (!firstList) {
      setNote('could not verify duplicate projects; refresh and try again');
      return;
    }
    replaceProjects(firstList);
    const dups = duplicateProjectGroups(firstList);
    if (!dups.length) { setNote('no duplicate projects found (same folder or repo)'); return; }
    const total = dups.reduce((n, g) => n + g.length - 1, 0);
    const expectedStamp = duplicateGroupsStamp(dups);
    const previewGroups = dups.slice(0, 5).map((g) => `- ${g.map((p) => p.name).join(' + ')}`);
    const more = dups.length > previewGroups.length ? [`- ...and ${dups.length - previewGroups.length} more group(s)`] : [];
    if (!window.confirm([
      `Combine ${dups.length} duplicate group(s) — merge ${total} extra entr${total === 1 ? 'y' : 'ies'} into their primary and remove the duplicates?`,
      '',
      ...previewGroups,
      ...more,
      '',
      'Folders are left untouched. The duplicate set will be checked again before writing.',
    ].join('\n'))) return;
    setBusy(true);
    const t = toast({ kind: 'progress', text: `Combining ${total} duplicate${total === 1 ? '' : 's'}…` });
    try {
      const latestList = await freshProjects();
      const latestDups = duplicateProjectGroups(latestList);
      if (duplicateGroupsStamp(latestDups) !== expectedStamp) {
        replaceProjects(latestList);
        t.update({ kind: 'info', text: 'Duplicate set changed before combine. Projects refreshed; review and try again.' });
        return;
      }
      const score = (p: ProjectEntry) => (p.path ? 4 : 0) + (p.description ? 2 : 0) + (p.team ? 1 : 0) + (p.links ?? []).length + (p.tags ?? []).length + (p.notes ? 1 : 0);
      let list = latestList;
      for (const g of latestDups) {
        const keep = [...g].sort((a, b) => score(b) - score(a) || (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
        const drop = g.filter((p) => p.id !== keep.id);
        const merged: ProjectEntry = {
          ...keep,
          description: keep.description || drop.find((d) => d.description)?.description || '',
          team: keep.team || drop.find((d) => d.team)?.team,
          path: keep.path || drop.find((d) => d.path)?.path,
          tags: uniqStrings([...(keep.tags ?? []), ...drop.flatMap((d) => d.tags ?? [])]),
          links: uniqStrings([...(keep.links ?? []), ...drop.flatMap((d) => d.links ?? [])]),
          notes: [keep.notes, ...drop.map((d) => d.notes)].filter(Boolean).join('\n').trim() || undefined,
          updatedAt: Date.now(),
        };
        list = await call<ProjectEntry[]>('projects:save', merged);
        for (const d of drop) list = await call<ProjectEntry[]>('projects:remove', d.id);
      }
      replaceProjects(list);
      t.update({ kind: 'success', text: `Combined ${total} duplicate${total === 1 ? '' : 's'} ✓` });
    } catch (e) {
      t.update({ kind: 'error', text: `Combine failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  }
  // Set a project's checkpoint auto-commit mode; resets its baseline so we don't
  // immediately fire on tasks that were already complete.
  async function setAutoCommitMode(p: ProjectEntry, val: AutoCommitMode) {
    const fresh = await ensureProjectFresh(p, 'changing auto-commit');
    if (!fresh) return;
    if (val !== 'off' && val !== (fresh.autoCommit ?? 'off')) {
      const trigger = val === 'plan' ? 'plan-validation tasks' : 'any completed task';
      if (!window.confirm(`Enable auto-commit for "${fresh.name}" on ${trigger}?\n\nWhen matching tasks complete and this repo is dirty, IDACC can draft a message, commit all non-ignored changes, and push only when the branch is exactly in sync with its remote. If the repo is ahead, behind, orphaned, missing a remote, or missing compare data, the background checkpoint is skipped for review. Keep this on only for repos where background checkpoints are expected.`)) return;
    }
    const list = await call<ProjectEntry[]>('projects:save', { ...fresh, autoCommit: val, updatedAt: Date.now() }).catch(() => projects);
    replaceProjects(list);
    delete autoSeenRef.current[fresh.id]; // re-baseline on the next watcher tick
    setNote(val === 'off' ? `auto-commit off for ${fresh.name}` : `auto-commit on (${val === 'plan' ? 'plan validation' : 'any task'}) for ${fresh.name} — needs a team + uncommitted changes`);
  }
  // Fire a checkpoint commit: AI-draft a message from the diff (best-effort), then
  // route the commit & push via the owning team → git-manager (normal request flow).
  async function autoCommitNow(p: ProjectEntry, triggerRef: string, kind: Exclude<AutoCommitMode, 'off'>) {
    const fresh = await ensureProjectFresh(p, 'auto-commit checkpoint', { quiet: true });
    if (!fresh?.path) {
      toast({ kind: 'info', text: `Auto-commit skipped for “${p.name}”: project changed before the checkpoint.`, durationMs: 10000 });
      return;
    }
    const [g, d] = await Promise.all([
      call<GitInfo>('project:git', fresh.path).catch(() => null),
      call<ProjectDiff>('project:diff', fresh.path).catch(() => null),
    ]);
    const blockers = autoCommitBlockers(g, d);
    if (blockers.length) {
      toast({
        kind: 'info',
        text: `Auto-commit skipped for “${fresh.name}” after task ${triggerRef}: ${blockers.join('; ')}. Use Projects to review and request the commit manually.`,
        durationMs: 12000,
      });
      return;
    }
    let msg = '';
    try {
      if (d?.ok && lead && (d.stat || d.diff || d.untracked.length)) {
        const ask = `Draft a git commit message for the project "${fresh.name}". Files (git diff --stat):\n${d.stat || '(none)'}\n\nUntracked: ${d.untracked.join(', ') || 'none'}\n\nDiff:\n${d.diff || '(no tracked changes)'}\n\nReply with ONLY the commit message: a concise imperative subject (≤72 chars), blank line, then 1-4 bullets. No code fences.`;
        const reply = await call<string>('dispatch', `/ask ${lead} ${q(ask)}`).catch(() => '');
        msg = String(reply || '').replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
      }
    } catch { /* fall back to a generic message */ }
    if (!msg) msg = `Checkpoint commit for ${fresh.name}.`;
    msg = `${msg}\n\n(auto-commit checkpoint — triggered by completed ${kind === 'plan' ? 'plan-validation ' : ''}task ${triggerRef})`;
    toast({ kind: 'info', text: `⟳ Auto-commit checkpoint for “${fresh.name}” (task ${triggerRef} done) → ${fresh.team || defaultTeamName} delegates to git-manager` });
    await submitCommit(fresh, msg, { confirm: false, quietStale: true });
  }

  async function runGit(p: ProjectEntry, action: string) {
    if (!p.path) return;
    const fresh = await ensureProjectFresh(p, `running git ${action}`);
    if (!fresh?.path) return;
    if (action === 'pull') {
      const [g, d] = await Promise.all([
        call<GitInfo>('project:git', fresh.path).catch(() => null),
        call<ProjectDiff>('project:diff', fresh.path).catch(() => null),
      ]);
      const preview = [
        `Pull latest changes for "${fresh.name}"?`,
        '',
        `Folder: ${fresh.path}`,
        ...gitSummary(g),
        '',
        ...diffSummary(d),
        '',
        'This fetches and fast-forwards when safe. It never force-pushes or discards work, but it can change files in the folder.',
      ].join('\n');
      if (!window.confirm(preview)) return;
    }
    setGitBusy(`${fresh.id}:${action}`);
    setGitOut((o) => ({ ...o, [fresh.id]: { action, output: `$ git ${action}…` } }));
    try {
      const r = await call<{ ok: boolean; output: string }>('project:gitRun', fresh.path, action);
      setGitOut((o) => ({ ...o, [fresh.id]: { action, output: r.output } }));
      const g = await call<GitInfo>('project:git', fresh.path).catch(() => null);
      if (g) setGitMap((m) => ({ ...m, [fresh.id]: g }));
    } finally {
      setGitBusy(null);
    }
  }
  async function openProjectFolder(p: ProjectEntry) {
    if (!p.path) return;
    const fresh = await ensureProjectFresh(p, 'opening folder');
    if (fresh?.path) void call('project:openFolder', fresh.path);
  }

  /** The new/edit form body — rendered at the top for a new project, or inline
   *  inside the card being edited so editing happens where you are. */
  function projectForm() {
    return (
      <>
        <h3>{editing === 'new' ? 'New project' : 'Edit project'}</h3>
        <div className="kv" style={{ gridTemplateColumns: '110px 1fr', gap: '8px 12px' }}>
          <span>name *</span>
          <b><input style={{ width: 320 }} placeholder="e.g. SkillMesh mainnet" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></b>
          <span>folder</span>
          <b style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input style={{ flex: 1, minWidth: 220 }} className="mono" placeholder="/path/to/project — enables git tracking + README import" value={form.path} onChange={(e) => setForm((f) => ({ ...f, path: e.target.value }))} />
            <button className="btn small" onClick={() => void browse()}>Browse…</button>
            {form.path.trim() ? <button className="btn small" onClick={() => void readReadme()}>Read README</button> : null}
          </b>
          <span>status</span>
          <b>
            <select className="cell-select" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as ProjectStatus }))}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </b>
          <span>description</span>
          <b><textarea style={{ width: '100%', minHeight: 44 }} placeholder="one-line summary / goal" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} /></b>
          <span>team</span>
          <b>
            <select className="cell-select" value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}>
              <option value="">(none)</option>
              {store.teams.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          </b>
          <span>tags</span>
          <b><input style={{ width: '100%' }} placeholder="comma-separated" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} /></b>
          <span>links</span>
          <b><textarea style={{ width: '100%', minHeight: 40 }} placeholder="one URL per line (repo, dashboard, docs…)" value={form.links} onChange={(e) => setForm((f) => ({ ...f, links: e.target.value }))} /></b>
          <span>notes</span>
          <b><textarea style={{ width: '100%', minHeight: 60 }} placeholder="freeform notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></b>
        </div>
        <div className="row-actions" style={{ marginTop: 10 }}>
          {lead && (form.links.trim() || form.name.trim()) ? (
            <button className="btn" disabled={busy} title={`Have ${lead} write a cleaner description + tags`} onClick={() => void refineWithLead()}>✨ Refine with lead</button>
          ) : null}
          <span className="grow" />
          <button className="btn" disabled={busy} onClick={() => { setEditing(null); setEditBaseline(null); }}>Cancel</button>
          <button className="btn primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>Save</button>
        </div>
      </>
    );
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Projects</h1>
        <div className="row-actions">
          <button className="btn" disabled={busy || syncing} title={root ? `Scan ${root} and track each subfolder` : 'Find the id-agents workspace projects folder and track its subfolders'} onClick={() => void doSync()}>{syncing ? 'Syncing…' : '⟳ Sync workspace'}</button>
          {dupCount > 0 ? <button className="btn" disabled={busy} title="Merge projects that point at the same folder or repo into one (folders left untouched)" onClick={() => void combineDuplicates()}>⧉ Combine duplicates ({dupCount})</button> : null}
          <button className="btn" disabled={busy} onClick={() => { setGhOpen((v) => !v); setNote(''); }}>{ghOpen ? '− Cancel' : '⤓ Add from GitHub'}</button>
          <button className="btn" disabled={busy} onClick={() => void importFolder()}>Import folder…</button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              if (editing === 'new') {
                setEditing(null);
                setEditBaseline(null);
              } else {
                openNew();
              }
            }}
          >
            {editing === 'new' ? '− Cancel' : '+ New project'}
          </button>
        </div>
      </header>

      <div className="projects-root muted small">
        {root ? (
          <>workspace: <span className="mono" title={root}>{root}</span> · <button className="link-btn" disabled={busy || syncing} onClick={() => void changeRoot()}>change…</button></>
        ) : (
          <>No workspace projects folder detected. <button className="link-btn" disabled={busy || syncing} onClick={() => void changeRoot()}>Choose a folder…</button> to auto-track its subfolders.</>
        )}
      </div>

      {ghOpen ? (
        <section className="card gh-add">
          <h3>Add from GitHub</h3>
          <div className="row-actions" style={{ gap: 6, marginBottom: 6 }}>
            <button className={`btn small${ghMode === 'clone' ? ' primary' : ''}`} disabled={busy} onClick={() => setGhMode('clone')}>Clone</button>
            <button className={`btn small${ghMode === 'fork' ? ' primary' : ''}`} disabled={busy} onClick={() => setGhMode('fork')}>Fork &amp; clone</button>
          </div>
          <p className="muted small">{ghMode === 'fork'
            ? 'Forks the repo to your GitHub account, clones your fork into a folder you pick, and wires the original as `upstream`. Auto-fills name/description/tags. Needs a GitHub token (Capabilities → github MCP).'
            : 'Clones the repo into a folder you pick, then auto-fills name, description, and tags. You review before saving.'}</p>
          <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ flex: 1, minWidth: 320 }}
              className="mono"
              placeholder="https://github.com/owner/repo"
              value={ghUrl}
              disabled={busy}
              autoFocus
              onChange={(e) => setGhUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addFromGithub(); }}
            />
            <button className="btn primary" disabled={busy || !ghUrl.trim()} onClick={() => void addFromGithub()}>{busy ? (ghMode === 'fork' ? 'Forking…' : 'Cloning…') : (ghMode === 'fork' ? 'Fork & add' : 'Clone & add')}</button>
          </div>
        </section>
      ) : null}

      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
        {(['all', ...STATUSES] as const).map((s) => (
          <button key={s} className={`chip${filter === s ? ' on' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'all' : STATUS_LABEL[s]} {counts[s] ?? 0}
          </button>
        ))}
        {note ? <span className="muted small grow" style={{ textAlign: 'right' }}>{note}</span> : null}
      </div>

      {editing === 'new' ? <section className="card">{projectForm()}</section> : null}

      <div className="skill-catalog">
        {shown.map((p) => {
          const g = gitMap[p.id];
          const out = gitOut[p.id];
          if (editing === p.id) {
            // Edit in place — the form replaces this card's body so you stay put.
            return <div className="skill-card editing" key={p.id}>{projectForm()}</div>;
          }
          return (
            <div className="skill-card" key={p.id}>
              <div className="skill-card-head">
                <span className={`st-badge ${STATUS_CLASS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                <span className="b">{p.name}</span>
                {p.team ? <span className="muted small">· {p.team}</span> : null}
                <span className="grow" />
                <select className="cell-select small" value={p.status} disabled={busy} onChange={(e) => void setStatus(p, e.target.value as ProjectStatus)} title="Change status">
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button className="btn" disabled={busy} onClick={() => openEdit(p)}>Edit</button>
                {confirmDel === p.id ? (
                  <>
                    <button className="btn icon-danger" disabled={busy} onClick={() => void remove(p)}>Delete?</button>
                    <button className="btn" disabled={busy} onClick={() => setConfirmDel(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn icon-danger" disabled={busy} title="Delete project (folder is left untouched)" onClick={() => setConfirmDel(p.id)}>✕</button>
                )}
              </div>
              {p.description ? <p className="muted small skill-desc">{p.description}</p> : null}

              {p.path ? (
                <div className="project-git">
                  <div className="row-actions" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <GitStatus g={g} />
                    <span className="grow" />
                    {g && !g.remoteUrl ? (<>
                      <button className="btn small" title="Connect this folder to a GitHub repo that ALREADY exists — sets it as origin (SSH) and fetches" onClick={() => { setLinkFor(linkFor === p.id ? null : p.id); setLinkUrl((p.links ?? []).find((l) => /github\.com/i.test(l)) ?? ''); setRepoFor(null); setNote(''); }}>{linkFor === p.id ? '− Cancel' : '🔗 Link existing repo'}</button>
                      <button className="btn small" title="Create a NEW GitHub repo for this folder and connect it as origin (SSH)" onClick={() => { setRepoFor(repoFor === p.id ? null : p.id); setRepoName(p.name || ''); setLinkFor(null); setNote(''); }}>{repoFor === p.id ? '− Cancel' : '＋ Create GitHub repo'}</button>
                    </>) : null}
                    <button className="btn small primary" title="Commit & push this project's changes — optionally let AI draft the message (the owning team delegates the push to git-manager)" onClick={() => { setCommitFor(commitFor === p.id ? null : p.id); setCommitMsg(''); setNote(''); }}>{commitFor === p.id ? '− Cancel' : '⤴ Request commit'}</button>
                    <button className="btn small" title="Open folder" onClick={() => void openProjectFolder(p)}>open ↗</button>
                  </div>
                  <div className="muted small mono project-path" title={p.path}>{p.path}</div>
                  <div className="project-automation-summary muted small"
                    title={p.team
                      ? `Checkpoint commits: team ${p.team}; branch must be exactly in sync with its remote.`
                      : 'Set a team on this project before enabling checkpoint auto-commit.'}>
                    <span className={`chip tag${autoCommitMode(p) !== 'off' ? ' on' : ''}`}>Auto-commit: {AUTO_COMMIT_LABEL[autoCommitMode(p)]}</span>
                    {!p.team ? <span className="muted">(needs team)</span> : null}
                    <button className="btn small" disabled={busy} onClick={() => setAutomationFor(automationFor === p.id ? null : p.id)}>
                      {automationFor === p.id ? 'Close automation' : 'Automation'}
                    </button>
                  </div>

                  {automationFor === p.id ? (
                    <div className="project-automation-panel">
                      <span className="muted small">Checkpoint mode</span>
                      <select
                        className="cell-select small"
                        value={autoCommitMode(p)}
                        disabled={busy || !p.team}
                        onChange={(e) => void setAutoCommitMode(p, e.target.value as AutoCommitMode)}
                      >
                        <option value="off">off</option>
                        <option value="task">on any task done</option>
                        <option value="plan">on plan validation</option>
                      </select>
                      {!p.team ? <span className="warn-text small">Team required</span> : null}
                    </div>
                  ) : null}

                  {linkFor === p.id ? (
                    <div className="row-actions" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: 8 }}>
                      <span className="muted small">existing repo</span>
                      <input className="mono" style={{ flex: 1, minWidth: 280 }} value={linkUrl} disabled={busy} placeholder="https://github.com/owner/repo" onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void linkRepo(p); }} />
                      <span className="grow" />
                      <button className="btn small primary" disabled={busy || !linkUrl.trim()} onClick={() => void linkRepo(p)}>{busy ? 'Linking…' : 'Link & fetch'}</button>
                    </div>
                  ) : null}

                  {repoFor === p.id ? (
                    <div className="row-actions" style={{ gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: 8 }}>
                      <span className="muted small">new repo</span>
                      <input className="mono" style={{ flex: '0 1 220px' }} value={repoName} disabled={busy} placeholder="repo-name" onChange={(e) => setRepoName(e.target.value)} />
                      <label className="small" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <input type="checkbox" checked={repoPrivate} disabled={busy} onChange={(e) => setRepoPrivate(e.target.checked)} /> private
                      </label>
                      <span className="grow" />
                      <button className="btn small primary" disabled={busy || !repoName.trim()} onClick={() => void createRepo(p)}>{busy ? 'Creating…' : 'Create & connect'}</button>
                    </div>
                  ) : null}

                  {commitFor === p.id ? (
                    <div style={{ marginTop: 6, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div className="row-actions" style={{ gap: 6, alignItems: 'center' }}>
                        <span className="muted small">commit message / change notes</span>
                        <span className="grow" />
                        <button className="btn small" disabled={drafting || !lead} title={lead ? `Let ${lead} read the working diff and draft a commit message` : 'no team lead online to draft with'} onClick={() => void draftCommit(p)}>{drafting ? '✨ Drafting…' : '✨ Draft with AI'}</button>
                      </div>
                      <textarea style={{ width: '100%', minHeight: 80 }} value={commitMsg} placeholder="Describe the change, or click “✨ Draft with AI” to summarize the working diff." onChange={(e) => setCommitMsg(e.target.value)} />
                      <div className="row-actions" style={{ gap: 6 }}>
                        <span className="grow" />
                        <button className="btn small primary" disabled={!commitMsg.trim()} onClick={() => void submitCommit(p, commitMsg)}>⤴ Request commit &amp; push</button>
                      </div>
                    </div>
                  ) : null}

                  {g?.isRepo ? (
                    <div className="row-actions" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      {GIT_ACTIONS.map((act) => (
                        <button key={act.id} className="btn small" title={act.title} disabled={gitBusy === `${p.id}:${act.id}`} onClick={() => void runGit(p, act.id)}>
                          {gitBusy === `${p.id}:${act.id}` ? '…' : act.label}
                        </button>
                      ))}
                      {g.remoteUrl ? <a className="ext-link small" href={g.remoteUrl.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto' }}>remote ↗</a> : null}
                    </div>
                  ) : null}
                  {out ? <pre className="git-out">{out.output}</pre> : null}
                </div>
              ) : null}

              {(p.tags ?? []).length > 0 ? (
                <div className="chips skill-tags">{(p.tags ?? []).map((t) => <span className="chip" key={t}>{t}</span>)}</div>
              ) : null}
              {(p.links ?? []).length > 0 ? (
                <div className="chips" style={{ marginTop: 8 }}>
                  {(p.links ?? []).map((l) => (
                    <a className="ext-link small" key={l} href={/^https?:\/\//i.test(l) ? l : `https://${l}`} target="_blank" rel="noreferrer">{l.replace(/^https?:\/\//i, '')}</a>
                  ))}
                </div>
              ) : null}
              {p.notes ? <p className="muted small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{p.notes}</p> : null}
            </div>
          );
        })}
        {projects.length === 0 ? (
          <p className="muted center pad">No projects yet. <b>Import folder…</b> to pull one in from disk, or <b>+ New project</b> to add manually.</p>
        ) : shown.length === 0 ? (
          <p className="muted center pad">No projects with status “{filter}”.</p>
        ) : null}
      </div>
    </div>
  );
}
