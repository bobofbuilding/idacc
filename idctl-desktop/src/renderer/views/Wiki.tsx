import type { FleetStore } from '../store.ts';

export interface WikiNav {
  label?: string;
  icon?: string;
  order?: number;
  visible?: boolean;
}

export interface WikiEntry {
  id?: string;
  label?: string;
  type?: string;
  description?: string;
  optionsSource?: string;
  routesInto?: string[];
  [key: string]: unknown;
}

export interface WikiPage {
  id: string;
  route?: string;
  component?: string;
  nav?: WikiNav;
  sourceFiles?: string[];
  purpose?: string;
  scope?: string;
  tabs?: WikiEntry[];
  tiles?: WikiEntry[];
  fields?: WikiEntry[];
  dropdowns?: WikiEntry[];
  controls?: WikiEntry[];
  displays?: WikiEntry[];
  routing?: Record<string, unknown>;
  notes?: string[];
  [key: string]: unknown;
}

export interface ControlCenterWiki {
  schemaVersion?: number;
  updated?: string;
  title?: string;
  description?: string;
  editContract?: Record<string, unknown>;
  global?: Record<string, unknown>;
  pages?: WikiPage[];
}

export interface WikiPayload {
  path: string;
  mtimeMs: number;
  loadedAt: number;
  doc: ControlCenterWiki;
}

const SECTIONS: { key: keyof WikiPage; label: string }[] = [
  { key: 'tabs', label: 'Tabs' },
  { key: 'tiles', label: 'Tiles' },
  { key: 'fields', label: 'Text Fields' },
  { key: 'dropdowns', label: 'Dropdowns' },
  { key: 'controls', label: 'Controls' },
  { key: 'displays', label: 'Displays' },
];

export function Wiki({ wiki, error, query, setQuery, pageId, setPageId }: {
  store: FleetStore;
  wiki: WikiPayload | null;
  error?: string;
  query: string;
  setQuery: (q: string) => void;
  pageId: string;
  setPageId: (id: string) => void;
}) {
  const doc = wiki?.doc;
  const pages = doc?.pages ?? [];
  const filtered = pages.filter((p) => matches(p, query));
  const selected = filtered.find((p) => p.id === pageId) ?? filtered[0] ?? pages.find((p) => p.id === pageId) ?? pages[0];

  return (
    <div className="view wiki-view">
      <header className="view-head">
        <div>
          <h1>{doc?.title ?? 'Control Center Wiki'}</h1>
          <p className="muted small wiki-head-copy">{doc?.description ?? 'Editable UI schematic.'}</p>
        </div>
        <div className="wiki-meta">
          <span className="chip">schema v{doc?.schemaVersion ?? '?'}</span>
          {doc?.updated ? <span className="chip">updated {doc.updated}</span> : null}
        </div>
      </header>

      {error ? <div className="card wiki-error">Wiki load error: {error}</div> : null}

      <section className="card wiki-source">
        <div>
          <h3>Source</h3>
          <div className="mono small wiki-path">{wiki?.path ?? 'loading...'}</div>
        </div>
        <div className="small muted">
          {wiki ? `modified ${new Date(wiki.mtimeMs).toLocaleString()} · reloaded ${new Date(wiki.loadedAt).toLocaleTimeString()}` : 'polling for local edits'}
        </div>
      </section>

      <section className="wiki-shell">
        <aside className="card wiki-index">
          <div className="wiki-filter">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages, controls, routes"
            />
          </div>
          <div className="wiki-page-list">
            {filtered.map((p) => (
              <button
                key={p.id}
                className={`wiki-page-btn${selected?.id === p.id ? ' active' : ''}`}
                onClick={() => setPageId(p.id)}
              >
                <span>{p.nav?.icon ?? '▤'}</span>
                <span>{p.nav?.label ?? p.id}</span>
                {p.route ? <code>{p.route}</code> : null}
              </button>
            ))}
            {!filtered.length ? <p className="muted small">No matching wiki entries.</p> : null}
          </div>
        </aside>

        <main className="wiki-detail">
          {selected ? <PageDetail page={selected} /> : <div className="card">No wiki pages found.</div>}
          {doc?.global ? <GlobalDetail global={doc.global} /> : null}
          {doc?.editContract ? <ObjectCard title="Edit Contract" obj={doc.editContract} /> : null}
        </main>
      </section>
    </div>
  );
}

function PageDetail({ page }: { page: WikiPage }) {
  return (
    <section className="card wiki-page-detail">
      <div className="wiki-page-title">
        <div>
          <h2>{page.nav?.label ?? page.id}</h2>
          <p className="muted small">
            route <code>{page.route ?? 'none'}</code>
            {page.component ? <> · component <code>{page.component}</code></> : null}
          </p>
        </div>
        <span className="wiki-icon">{page.nav?.icon ?? '▤'}</span>
      </div>

      {page.purpose ? <p>{page.purpose}</p> : null}
      {page.scope ? <p className="muted">{page.scope}</p> : null}

      {page.sourceFiles?.length ? (
        <div className="wiki-block">
          <h3>Source Files</h3>
          <div className="wiki-chip-list">{page.sourceFiles.map((s) => <code key={s}>{s}</code>)}</div>
        </div>
      ) : null}

      {SECTIONS.map(({ key, label }) => (
        <EntrySection key={String(key)} title={label} entries={(page[key] as WikiEntry[] | undefined) ?? []} />
      ))}

      {page.routing ? <ObjectCard title="Routing" obj={page.routing} /> : null}

      {page.notes?.length ? (
        <div className="wiki-block">
          <h3>Notes</h3>
          <ul className="wiki-notes">{page.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function EntrySection({ title, entries }: { title: string; entries: WikiEntry[] }) {
  if (!entries.length) return null;
  return (
    <div className="wiki-block">
      <h3>{title}</h3>
      <div className="wiki-entry-grid">
        {entries.map((entry, i) => <EntryCard key={`${entry.id ?? entry.label ?? title}-${i}`} entry={entry} />)}
      </div>
    </div>
  );
}

function EntryCard({ entry }: { entry: WikiEntry }) {
  return (
    <article className="wiki-entry">
      <div className="wiki-entry-head">
        <strong>{entry.label ?? entry.id ?? 'item'}</strong>
        {entry.type ? <span className="chip">{entry.type}</span> : null}
      </div>
      {entry.id ? <div className="mono small muted">{entry.id}</div> : null}
      {entry.description ? <p>{entry.description}</p> : null}
      {entry.optionsSource ? <p className="small muted">Options: <code>{entry.optionsSource}</code></p> : null}
      {entry.routesInto?.length ? <RouteChips routes={entry.routesInto} /> : null}
      {SECTIONS.map(({ key, label }) => (
        <EntrySection key={String(key)} title={label} entries={(entry[key] as WikiEntry[] | undefined) ?? []} />
      ))}
    </article>
  );
}

function GlobalDetail({ global }: { global: Record<string, unknown> }) {
  return (
    <section className="card">
      <h3>Global Routing</h3>
      {'shell' in global ? <p>{String(global.shell)}</p> : null}
      {'state' in global ? <p className="muted">{String(global.state)}</p> : null}
      <ObjectRows obj={global} skip={new Set(['shell', 'state'])} />
    </section>
  );
}

function ObjectCard({ title, obj }: { title: string; obj: Record<string, unknown> }) {
  return (
    <div className="wiki-block">
      <h3>{title}</h3>
      <ObjectRows obj={obj} />
    </div>
  );
}

function ObjectRows({ obj, skip = new Set<string>() }: { obj: Record<string, unknown>; skip?: Set<string> }) {
  return (
    <div className="wiki-object">
      {Object.entries(obj).filter(([k]) => !skip.has(k)).map(([key, value]) => (
        <div className="wiki-object-row" key={key}>
          <div className="wiki-object-key">{key}</div>
          <div className="wiki-object-value">{renderValue(value)}</div>
        </div>
      ))}
    </div>
  );
}

function RouteChips({ routes }: { routes: string[] }) {
  return <div className="wiki-chip-list">{routes.map((r) => <code key={r}>{r}</code>)}</div>;
}

function renderValue(value: unknown): JSX.Element {
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'string')) return <RouteChips routes={value as string[]} />;
    return (
      <div className="wiki-nested-list">
        {value.map((v, i) => <div key={i}>{renderValue(v)}</div>)}
      </div>
    );
  }
  if (value && typeof value === 'object') return <ObjectRows obj={value as Record<string, unknown>} />;
  return <span>{value == null ? '—' : String(value)}</span>;
}

function matches(page: WikiPage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return JSON.stringify(page).toLowerCase().includes(q);
}
