import { useCallback, useEffect, useState } from 'react';
import { useFleet, call, useSyncVersion } from './store.ts';
import { PromptProvider } from './components/prompt.tsx';
import { ToastProvider } from './components/toast.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { Teams } from './views/Teams.tsx';
import { Inbox } from './views/Inbox.tsx';
import { Tasks } from './views/Tasks.tsx';
import { Health } from './views/Health.tsx';
import { Identity } from './views/Identity.tsx';
import { Modules } from './views/Modules.tsx';
import { Projects } from './views/Projects.tsx';
import { ComputerUse } from './views/ComputerUse.tsx';
import { Settings } from './views/Settings.tsx';
import { Wiki, type ControlCenterWiki, type WikiPayload } from './views/Wiki.tsx';
import { CommandPalette } from './views/dashboard/CommandPalette.tsx';
import { ControlDrawer } from './views/dashboard/ControlDrawer.tsx';

type ViewId = 'dashboard' | 'inbox' | 'tasks' | 'projects' | 'health' | 'identity' | 'schedule' | 'teams' | 'modules' | 'computer' | 'settings' | 'wiki';
type TeamsFocus = 'route-hierarchy';

const DEFAULT_NAV: { id: ViewId; label: string; icon: string; order: number }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '▦', order: 10 },
  { id: 'inbox', label: 'Inbox', icon: '□', order: 20 },
  { id: 'tasks', label: 'Work', icon: '☑', order: 40 },
  { id: 'projects', label: 'Projects', icon: '◆', order: 50 },
  { id: 'health', label: 'Health', icon: '✚', order: 60 },
  { id: 'identity', label: 'Identity & Keys', icon: '⬡', order: 70 },
  { id: 'teams', label: 'HR Manager', icon: '⛌', order: 80 },
  { id: 'modules', label: 'Capabilities', icon: '◫', order: 90 },
  { id: 'computer', label: 'Computer Use', icon: '🖥', order: 100 },
  { id: 'settings', label: 'Settings', icon: '⚙', order: 110 },
  { id: 'wiki', label: 'Wiki', icon: '▤', order: 120 },
];
const IMPLEMENTED_VIEWS = new Set<ViewId>([...DEFAULT_NAV.map((n) => n.id), 'inbox', 'schedule']);

function isViewId(id: string | null | undefined): id is ViewId {
  return !!id && IMPLEMENTED_VIEWS.has(id as ViewId);
}

function navFromWiki(doc?: ControlCenterWiki | null): typeof DEFAULT_NAV {
  const defaults = new Map(DEFAULT_NAV.map((n) => [n.id, n]));
  const pages = doc?.pages ?? [];
  const nav = pages
    .filter((p) => isViewId(p.route) && p.nav?.visible !== false)
    .map((p) => {
      const id = p.route as ViewId;
      const base = defaults.get(id);
      return {
        id,
        label: p.nav?.label ?? base?.label ?? id,
        icon: p.nav?.icon ?? base?.icon ?? '•',
        order: p.nav?.order ?? base?.order ?? 999,
      };
    })
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return nav.length ? nav : DEFAULT_NAV;
}

interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  staged: boolean;
  checking: boolean;
  notes?: string;
  error?: string;
}

export function App() {
  const store = useFleet();
  const [view, setView] = useState<ViewId>(() => {
    // 'schedule' is a Tasks tab now (not in NAV) but still a valid deep-link target.
    const v = new URLSearchParams(window.location.search).get('view');
    if (isViewId(v)) return v;
    // Otherwise reopen on the view the user last had — e.g. after a self-update relaunch.
    let saved: string | null = null;
    try { saved = localStorage.getItem('idctl.view'); } catch { /* no storage */ }
    return isViewId(saved) ? saved : 'dashboard';
  });
  const [teamsFocus, setTeamsFocus] = useState<TeamsFocus | undefined>();
  useEffect(() => { try { localStorage.setItem('idctl.view', view); } catch { /* no storage */ } }, [view]);
  const [version, setVersion] = useState<string>('');
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [dismissed, setDismissed] = useState<string>(''); // latest version the user said "Later" to
  const [wiki, setWiki] = useState<WikiPayload | null>(null);
  const [wikiError, setWikiError] = useState<string>();
  const [wikiQuery, setWikiQuery] = useState('');
  const [wikiPageId, setWikiPageId] = useState('');
  const [questionCount, setQuestionCount] = useState(0);
  const inboxSyncVersion = useSyncVersion(['questions', 'inbox']);
  const nav = navFromWiki(wiki?.doc);
  // ⌘K command palette + right-side control drawer — the "drive everything" surface.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerPanel, setDrawerPanel] = useState<string | null>(null);
  const navigateTo = useCallback((target: string) => {
    if (target === 'teams:route') {
      setTeamsFocus('route-hierarchy');
      setView('teams');
      return;
    }
    if (isViewId(target)) {
      setTeamsFocus(undefined);
      setView(target);
    }
  }, []);
  const clearTeamsFocus = useCallback(() => setTeamsFocus(undefined), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    call<string>('app:version').then(setVersion).catch(() => {});
    call<UpdateStatus>('update:status').then(setUpdate).catch(() => {});
    call<UpdateStatus>('update:check').then(setUpdate).catch(() => {}); // kick a check on launch
    const idagents = (window as { idagents?: { onUpdateStatus?: (cb: (s: unknown) => void) => () => void } }).idagents;
    const off = idagents?.onUpdateStatus?.((s) => setUpdate(s as UpdateStatus));
    return () => off?.();
  }, []);

  useEffect(() => {
    let live = true;
    call<{ id: string }[]>('questions:list').then((qs) => { if (live) setQuestionCount(qs.length); }).catch(() => { if (live) setQuestionCount(0); });
    return () => { live = false; };
  }, [store.lastUpdated, inboxSyncVersion]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await call<WikiPayload>('wiki:get');
        if (!live) return;
        setWiki((prev) => (prev?.path === next.path && prev.mtimeMs === next.mtimeMs ? prev : next));
        setWikiError(undefined);
      } catch (err) {
        if (live) setWikiError(err instanceof Error ? err.message : String(err));
      } finally {
        if (live) timer = setTimeout(load, 1500);
      }
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, []);

  async function applyUpdate() {
    setApplying(true);
    try {
      await call('update:applyNow'); // app quits + relauncher swaps the bundle
    } catch {
      setApplying(false);
    }
  }

  return (
    <ToastProvider>
    <PromptProvider>
    <div className="app">
      <div className="titlebar">
        <span className="titlebar-name">ID Agents Control Center{version ? ` · v${version}` : ''}</span>
        <button className="cmdk-trigger" title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>⌘K</button>
      </div>
      <div className="body">
        <nav className="sidebar">
          {nav.map((n) => (
            <button
              key={n.id}
              className={`nav-item${view === n.id ? ' active' : ''}`}
              onClick={() => navigateTo(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              <span className="nav-label">{n.label}</span>
              {n.id === 'inbox' && store.inbox.length + questionCount > 0 ? (
                <span className="nav-badge" title={`${store.inbox.length + questionCount} pending inbox item${store.inbox.length + questionCount === 1 ? '' : 's'}`}>{store.inbox.length + questionCount}</span>
              ) : null}
              {n.id === 'dashboard' && store.chatUnread > 0 ? (
                <span className="nav-badge" title={`${store.chatUnread} chat${store.chatUnread === 1 ? '' : 's'} with new replies`}>{store.chatUnread}</span>
              ) : null}
            </button>
          ))}
          {update?.available && update.staged && dismissed !== update.latest ? (
            <div className="sb-update" title={`Update downloaded — restart to apply v${update.latest}`}>
              <div className="uv-line">⬆ <span className="uv-from">v{update.current}</span> → <span className="uv-to">v{update.latest}</span></div>
              <div className="uv-actions">
                <button className="btn primary uv-go" disabled={applying} onClick={() => void applyUpdate()}>{applying ? 'Updating…' : 'Restart & update'}</button>
                <button className="uv-x" title="Later" onClick={() => setDismissed(update.latest ?? '')}>✕</button>
              </div>
            </div>
          ) : null}
        </nav>

        <main className="content">
          <Router
            view={view}
            store={store}
            navigate={navigateTo}
            teamsFocus={teamsFocus}
            onTeamsFocusHandled={clearTeamsFocus}
            wiki={wiki}
            wikiError={wikiError}
            wikiQuery={wikiQuery}
            setWikiQuery={setWikiQuery}
            wikiPageId={wikiPageId}
            setWikiPageId={setWikiPageId}
          />
          <StatusBar store={store} />
        </main>
      </div>
      <CommandPalette
        store={store}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigateTo}
        openDrawer={(id) => setDrawerPanel(id)}
      />
      <ControlDrawer store={store} panel={drawerPanel} onClose={() => setDrawerPanel(null)} navigate={navigateTo} />
    </div>
    </PromptProvider>
    </ToastProvider>
  );
}

function Router({ view, store, navigate, teamsFocus, onTeamsFocusHandled, wiki, wikiError, wikiQuery, setWikiQuery, wikiPageId, setWikiPageId }: {
  view: ViewId;
  store: ReturnType<typeof useFleet>;
  navigate: (target: string) => void;
  teamsFocus?: TeamsFocus;
  onTeamsFocusHandled: () => void;
  wiki: WikiPayload | null;
  wikiError?: string;
  wikiQuery: string;
  setWikiQuery: (q: string) => void;
  wikiPageId: string;
  setWikiPageId: (id: string) => void;
}) {
  switch (view) {
    case 'dashboard':
      return <Dashboard store={store} />;
    case 'teams':
      return <Teams store={store} focus={teamsFocus} onFocusHandled={onTeamsFocusHandled} />;
    case 'inbox':
      return <Inbox store={store} />;
    case 'tasks':
      return <Tasks store={store} />;
    case 'health':
      return <Health store={store} navigate={navigate} />;
    case 'identity':
      return <Identity store={store} />;
    case 'schedule':
      return <Tasks store={store} initialTab="schedule" />;
    case 'modules':
      return <Modules store={store} />;
    case 'computer':
      return <ComputerUse store={store} />;
    case 'projects':
      return <Projects store={store} />;
    case 'settings':
      return <Settings store={store} navigate={navigate} />;
    case 'wiki':
      return <Wiki store={store} wiki={wiki} error={wikiError} query={wikiQuery} setQuery={setWikiQuery} pageId={wikiPageId} setPageId={setWikiPageId} />;
    default:
      return <Dashboard store={store} />;
  }
}

type TeamLeadInfo = { team: string; lead: string | null; activeCount: number; totalCount: number };

function StatusBar({ store }: { store: ReturnType<typeof useFleet> }) {
  const dot =
    store.connection === 'online' ? 'ok' : store.connection === 'offline' ? 'err' : 'warn';
  // Running/total agents per team — drives "active teams / active agents" in the bar.
  const [leads, setLeads] = useState<TeamLeadInfo[]>([]);
  const names = store.teams.map((t) => t.name).filter(Boolean).join(',');
  useEffect(() => {
    const list = names ? names.split(',') : [];
    if (!list.length) { setLeads([]); return; }
    let live = true;
    const load = () => call<TeamLeadInfo[]>('work:teamLeads', list).then((r) => { if (live) setLeads(r); }).catch(() => {});
    void load();
    const iv = setInterval(load, 20000); // refresh running counts every 20s
    return () => { live = false; clearInterval(iv); };
  }, [names, store.team]);

  const liveTeams = leads.filter((l) => l.activeCount > 0).length;
  const totalActive = leads.reduce((s, l) => s + l.activeCount, 0);

  return (
    <footer className="statusbar">
      <span className={`pill ${dot}`}>● {store.connection}</span>
      <span className="muted">{store.managerUrl || '—'}</span>
      <span className="sep">·</span>
      <span title="running agents across every team">{totalActive} agent{totalActive === 1 ? '' : 's'} active · {liveTeams} team{liveTeams === 1 ? '' : 's'} running</span>
      {store.connection === 'offline' && store.lastError ? (
        <span className="status-error">⚠ {store.lastError}</span>
      ) : null}
    </footer>
  );
}
