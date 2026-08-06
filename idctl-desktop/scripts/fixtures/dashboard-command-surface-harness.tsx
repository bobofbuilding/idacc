// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  setTransport,
  type FleetStore,
  type Transport,
} from '../../src/renderer/store.ts';
import { CommandPalette } from '../../src/renderer/views/dashboard/CommandPalette.tsx';
import { CommandReceipts } from '../../src/renderer/views/dashboard/CommandReceipts.tsx';
import { ControlDrawer } from '../../src/renderer/views/dashboard/ControlDrawer.tsx';
import type { CommandEnvironment } from '../../src/renderer/dashboard/commandRuntime.ts';

interface HarnessState {
  calls: Array<{ method: string; args: unknown[] }>;
  navigations: string[];
  refreshes: number;
  completeProbe: (() => void) | null;
}

declare global {
  interface Window {
    __dashboardHarness: HarnessState;
  }
}

try { localStorage.clear(); } catch { /* file-origin storage can be unavailable on hardened runners */ }

const harness: HarnessState = {
  calls: [],
  navigations: [],
  refreshes: 0,
  completeProbe: null,
};
window.__dashboardHarness = harness;
window.confirm = () => true;

const transport: Transport = async (method, args) => {
  harness.calls.push({ method, args });
  if (method === 'probeAll') {
    return new Promise((resolve) => {
      harness.completeProbe = () => {
        harness.completeProbe = null;
        resolve({ ok: true, result: { dispatched: 1 } });
      };
    });
  }
  if (method === 'projects:list' || method === 'tasks:allTeams') return { ok: true, result: [] };
  if (method === 'remote') return { ok: true, result: { ok: true, reply: 'accepted' } };
  return { ok: true, result: null };
};
setTransport(transport);

const store = {
  connection: 'online',
  managerUrl: 'http://127.0.0.1:4242',
  team: 'default',
  coordinator: 'lead',
  agents: [{ id: 'lead', name: 'lead', status: 'online' }],
  teams: [{ name: 'default' }],
  events: [],
  inbox: [],
  chatUnread: 0,
  viewAll: true,
  allAgents: [{ id: 'lead', name: 'lead', team: 'default', status: 'online' }],
  refresh: () => { harness.refreshes += 1; },
  refreshChatUnread: async () => {},
  setTeam: async () => {},
} as unknown as FleetStore;

const commandEnvironment: CommandEnvironment = {
  online: true,
  features: [
    'observability',
    'manager-controls',
    'runtime-preflight',
    'agent-config',
    'team-config',
    'library',
    'brain-context',
    'brain-control',
    'control-events',
    'control-state',
    'stalled-sweep',
  ],
};

function Harness() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerPanel, setDrawerPanel] = useState<string | null>(null);
  const navigate = (view: string) => { harness.navigations.push(view); };
  return (
    <main>
      <button id="open-palette" onClick={() => setPaletteOpen(true)}>Open palette</button>
      <button id="open-project-drawer" onClick={() => setDrawerPanel('project-driver')}>Open project drawer</button>
      <button id="open-quick-drawer" onClick={() => setDrawerPanel('quick')}>Open quick drawer</button>
      <CommandPalette
        store={store}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        navigate={navigate}
        openDrawer={setDrawerPanel}
        commandEnvironment={commandEnvironment}
      />
      <ControlDrawer
        store={store}
        panel={drawerPanel}
        onClose={() => setDrawerPanel(null)}
        navigate={navigate}
        commandEnvironment={commandEnvironment}
      />
      <CommandReceipts store={store} navigate={navigate} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
