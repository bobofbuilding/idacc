/**
 * App — the TUI shell. Owns: which view is active, the help/team overlays,
 * global keybindings, and the input-capture gate that lets a focused text
 * field temporarily own the keyboard. Views themselves live in ../views.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Config } from '../config.ts';
import { ManagerClient } from '../api/client.ts';
import { useManager } from '../store/useManager.ts';
import { useUpdate } from '../update/useUpdate.ts';
import { loadSettings, addKnownTeam } from '../settings/store.ts';
import { resolveConfigPath } from '../settings/paths.ts';
import { AppContext } from './context.ts';
import { theme } from './theme.ts';
import { VIEWS, viewAtIndex, type ViewId } from './views.ts';
import { NavBar } from '../components/NavBar.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { Select } from '../components/Select.tsx';

import { DashboardView } from '../views/DashboardView.tsx';
import { ChatView } from '../views/ChatView.tsx';
import { OnboardView } from '../views/OnboardView.tsx';
import { InboxView } from '../views/InboxView.tsx';
import { TasksView } from '../views/TasksView.tsx';
import { HealthView } from '../views/HealthView.tsx';
import { OnchainView } from '../views/OnchainView.tsx';
import { ScheduleView } from '../views/ScheduleView.tsx';
import { ConfigView } from '../views/ConfigView.tsx';
import { AllTeamsView } from '../views/AllTeamsView.tsx';
import { SettingsView } from '../views/SettingsView.tsx';

type Overlay = 'none' | 'help' | 'team';

export function App({ config }: { config: Config }) {
  const { exit } = useApp();
  const client0 = useMemo(() => new ManagerClient(config), [config]);
  const store = useManager(client0);

  const [view, setView] = useState<ViewId>('dash');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [capture, setCapture] = useState(false);
  const [flash, setFlash] = useState<{ msg: string; kind: string } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();

  const doFlash = useCallback((msg: string, kind: 'info' | 'ok' | 'err' = 'info') => {
    setFlash({ msg, kind });
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  }, []);

  const ctx = useMemo(
    () => ({ store, setCapture, flash: doFlash, goto: setView, exit }),
    [store, doFlash, exit],
  );

  // Background self-update check → status-bar banner + one-shot toast.
  const updateCfg = useMemo(() => loadSettings(resolveConfigPath()).update, []);
  const upd = useUpdate({
    repo: updateCfg?.updateRepo,
    manifestUrl: updateCfg?.updateManifestUrl,
    intervalHours: updateCfg?.checkIntervalHours ?? 12,
    autoStage: updateCfg?.autoUpgrade ?? true,
    enabled: true,
  });
  const announced = useRef(false);
  useEffect(() => {
    if (upd.available && !announced.current) {
      announced.current = true;
      doFlash(`update available: v${upd.available.version} — see status bar`, 'info');
    }
  }, [upd.available, doFlash]);

  // Global keys. Disabled while a text field is capturing input or an overlay
  // is up (overlays handle their own keys).
  useInput(
    (input, key) => {
      if ((key.ctrl && input === 'c') || input === 'q') {
        exit();
        return;
      }
      if (input === '?') {
        setOverlay('help');
        return;
      }
      if (input === 't') {
        setOverlay('team');
        return;
      }
      if (input === 'r') {
        store.refresh();
        doFlash('refreshing…', 'info');
        return;
      }
      if (input === 'n') {
        setView('onboard');
        return;
      }
      if (key.tab && key.shift) {
        cycle(-1);
        return;
      }
      if (key.tab) {
        cycle(1);
        return;
      }
      // 1-9 map to the first nine numeric views; 0 always opens Settings.
      if (input === '0') {
        const id = VIEWS.find((v) => v.id === 'settings')?.id;
        if (id) setView(id);
        return;
      }
      const n = Number(input);
      if (Number.isInteger(n) && n >= 1 && n <= Math.min(9, VIEWS.length)) {
        const id = viewAtIndex(n - 1);
        if (id) setView(id);
      }
    },
    { isActive: overlay === 'none' && !capture },
  );

  const cycle = (dir: number) => {
    const i = VIEWS.findIndex((v) => v.id === view);
    const next = (i + dir + VIEWS.length) % VIEWS.length;
    setView(VIEWS[next].id);
  };

  const flashHint =
    flash != null
      ? undefined // flash shown inline below instead of as hint
      : undefined;

  return (
    <AppContext.Provider value={ctx}>
      <Box flexDirection="column" paddingX={1}>
        <NavBar active={view} inboxCount={store.inbox.length} />
        <Box
          flexDirection="column"
          marginTop={1}
          minHeight={16}
          borderStyle="round"
          borderColor={theme.dim}
          paddingX={1}
        >
          <ActiveView view={view} />
        </Box>

        {flash ? (
          <Text
            color={flash.kind === 'err' ? theme.err : flash.kind === 'ok' ? theme.ok : theme.accent}
          >
            {flash.msg}
          </Text>
        ) : null}

        <StatusBar
          connection={store.connection}
          managerUrl={store.client.managerUrl}
          team={store.team}
          agentCount={store.agents.length}
          lastUpdated={store.lastUpdated}
          error={store.lastError}
          hint={flashHint}
          update={upd.available ? { version: upd.available.version, staged: upd.staged } : undefined}
        />

        {overlay === 'help' ? <HelpOverlay onClose={() => setOverlay('none')} /> : null}
        {overlay === 'team' ? (
          <TeamOverlay
            store={store}
            onClose={() => setOverlay('none')}
          />
        ) : null}
      </Box>
    </AppContext.Provider>
  );
}

function ActiveView({ view }: { view: ViewId }) {
  switch (view) {
    case 'dash':
      return <DashboardView />;
    case 'chat':
      return <ChatView />;
    case 'onboard':
      return <OnboardView />;
    case 'inbox':
      return <InboxView />;
    case 'tasks':
      return <TasksView />;
    case 'health':
      return <HealthView />;
    case 'onchain':
      return <OnchainView />;
    case 'sched':
      return <ScheduleView />;
    case 'config':
      return <ConfigView />;
    case 'all':
      return <AllTeamsView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <Text>unknown view</Text>;
  }
}

function HelpOverlay({ onClose }: { onClose: () => void }) {
  useInput(() => onClose());
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={theme.accent}>
        idctl — keys
      </Text>
      <Text>
        <Text color={theme.accent}>1-9 / Tab</Text> switch view · <Text color={theme.accent}>n</Text> onboard ·{' '}
        <Text color={theme.accent}>r</Text> refresh · <Text color={theme.accent}>t</Text> team ·{' '}
        <Text color={theme.accent}>q</Text> quit
      </Text>
      <Text color={theme.dim}>All Teams (9): cross-team health · Enter opens a team in the Dashboard</Text>
      <Text color={theme.dim}>Settings (0): m managers · p providers (probe) · a assign a model to an agent</Text>
      <Text color={theme.dim}>Dashboard: ↑↓ pick agent · Enter actions (start/stop/model/delete)</Text>
      <Text color={theme.dim}>Chat: type to the manager · Enter send · @name to target an agent</Text>
      <Text color={theme.dim}>Inbox: ↑↓ pick · Enter answer the manager's question</Text>
      <Text color={theme.dim}>Tasks: n new · a assign · c claim · d done</Text>
      <Text color={theme.dim}>Health: p probe all · Enter probe one · Config: s sync · D deploy</Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>press any key to close</Text>
      </Box>
    </Box>
  );
}

function TeamOverlay({
  store,
  onClose,
}: {
  store: ReturnType<typeof useManager>;
  onClose: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Re-read each open so newly added teams appear; null/[] disables filtering.
  const known = useMemo(() => loadSettings(resolveConfigPath()).knownTeams ?? null, []);

  useInput((input, key) => {
    if (key.escape) onClose();
    else if (input === 'a') setShowAll((s) => !s);
  });

  const filtering = known != null && known.length > 0 && !showAll;
  const visible = filtering
    ? store.teams.filter((t) => known.includes(t.name) || t.name === store.team)
    : store.teams;

  const items = visible.map((t) => ({
    key: t.id,
    label: t.name,
    value: t.name,
    hint: `${t.agentCount} agents${known && !known.includes(t.name) ? ' · +add' : ''}`,
    color: t.name === store.team ? theme.accent : undefined,
  }));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1} width={44}>
      <Text bold color={theme.accent}>
        switch team {filtering ? <Text color={theme.dim}>(known only)</Text> : <Text color={theme.dim}>(all)</Text>}
      </Text>
      <Select
        items={items}
        emptyText="(no teams)"
        onSelect={(it) => {
          // Picking a not-yet-known team (from "show all") adds it to the allowlist.
          if (known != null && !known.includes(it.value)) addKnownTeam(it.value);
          store.setTeam(it.value);
          onClose();
        }}
      />
      <Text color={theme.dim}>Enter switch · a {showAll ? 'known only' : 'show all (+add)'} · Esc cancel</Text>
    </Box>
  );
}
