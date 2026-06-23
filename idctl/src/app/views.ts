/** The canonical list of views — drives the nav bar and number-key routing. */

export type ViewId =
  | 'dash'
  | 'chat'
  | 'onboard'
  | 'inbox'
  | 'tasks'
  | 'health'
  | 'onchain'
  | 'sched'
  | 'config'
  | 'all'
  | 'settings';

export interface ViewDef {
  id: ViewId;
  label: string;
  /** Compact label for the nav bar. */
  short: string;
  shortcut?: string;
}

export const VIEWS: ViewDef[] = [
  { id: 'dash', label: 'Dashboard', short: 'Dash' },
  { id: 'chat', label: 'Chat', short: 'Chat' },
  { id: 'onboard', label: 'Onboard agent', short: 'New', shortcut: 'n' },
  { id: 'inbox', label: 'Inbox', short: 'Inbox' },
  { id: 'tasks', label: 'Tasks', short: 'Tasks' },
  { id: 'health', label: 'Health', short: 'Health' },
  { id: 'onchain', label: 'Identity & Keys', short: 'Keys' },
  { id: 'sched', label: 'Schedule', short: 'Sched' },
  { id: 'config', label: 'Config', short: 'Config' },
  { id: 'all', label: 'All Teams', short: 'Teams' },
  { id: 'settings', label: 'Settings', short: 'Settings' },
];

export function viewAtIndex(i: number): ViewId | undefined {
  return VIEWS[i]?.id;
}
