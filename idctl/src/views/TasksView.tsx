/**
 * TasksView — the shared task list across the team (GET via /remote `/task`).
 * Hotkeys mutate through the same command surface the CLI uses:
 *   n new (title)   c claim (to manager)   a assign <agent>   d done   x delete
 * Tasks are shown newest-first with a colour-coded status.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, statusColor, ago, truncate } from '../app/theme.ts';
import type { Task } from '../api/types.ts';

type Mode = 'list' | 'new' | 'assign';
const RECENT_DONE_TASK_LIMIT = 25;

function ref(t: Task): string {
  return t.shortId ?? t.name ?? t.uuid ?? t.title;
}

export function TasksView() {
  const { store, setCapture, flash } = useAppCtx();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const selected = tasks[Math.min(cursor, tasks.length - 1)];

  async function reload() {
    try {
      const [todo, doing, done] = await Promise.all([
        store.client.tasksByStatus('todo').catch(() => [] as Task[]),
        store.client.tasksByStatus('doing').catch(() => [] as Task[]),
        store.client.tasksByStatus('done', { limit: RECENT_DONE_TASK_LIMIT }).catch(() => [] as Task[]),
      ]);
      const t = [...todo, ...doing, ...done];
      setTasks([...t].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
      setLoaded(true);
    } catch (err) {
      flash(`tasks: ${err instanceof Error ? err.message : String(err)}`, 'err');
      setLoaded(true);
    }
  }

  // Reload on mount and whenever the team/connection ticks.
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.client, store.lastUpdated]);

  useEffect(() => {
    setCapture(mode !== 'list');
    return () => setCapture(false);
  }, [mode, setCapture]);

  async function run(label: string, cmd: string) {
    setBusy(true);
    try {
      await store.client.remote(cmd);
      flash(`${label} ✓`, 'ok');
      await reload();
    } catch (err) {
      flash(`${label} failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(false);
      setMode('list');
    }
  }

  // List-mode hotkeys (Select owns arrows/enter; we own the letters).
  useInput(
    (input, _key) => {
      if (busy) return;
      if (input === 'n') {
        setText('');
        setMode('new');
      } else if (selected && input === 'c') {
        run(`claim ${ref(selected)}`, `/task ${ref(selected)} claim`);
      } else if (selected && input === 'd') {
        run(`done ${ref(selected)}`, `/task ${ref(selected)} complete`);
      } else if (selected && input === 'a') {
        setText('');
        setMode('assign');
      }
    },
    { isActive: mode === 'list' && !busy },
  );

  useInput(
    (_i, key) => {
      if (key.escape) setMode('list');
    },
    { isActive: mode !== 'list' && !busy },
  );

  if (mode === 'new') {
    return (
      <Prompt
        label="New task title:"
        value={text}
        onChange={setText}
        onSubmit={(v) => (v.trim() ? run('new task', `/task add ${v.trim()}`) : setMode('list'))}
        busy={busy}
      />
    );
  }
  if (mode === 'assign' && selected) {
    return (
      <Prompt
        label={`Assign "${truncate(selected.title, 30)}" to agent:`}
        value={text}
        onChange={setText}
        onSubmit={(v) => (v.trim() ? run('assign', `/task ${ref(selected)} assign ${v.trim()}`) : setMode('list'))}
        busy={busy}
      />
    );
  }

  const items: SelectItem<Task>[] = tasks.map((t) => ({
    key: ref(t),
    label: truncate(t.title, 46),
    value: t,
    color: statusColor(t.status),
    hint: `${t.status}${t.ownerName ? ` · ${t.ownerName}` : ''} · ${ago(t.createdAt)}`,
  }));

  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Tasks <Text color={theme.dim}>· {tasks.length}</Text>
      </Text>
      <Box marginTop={1}>
        <Select
          items={items}
          index={cursor}
          onIndexChange={setCursor}
          emptyText={loaded ? '(no tasks — press n to create one)' : 'loading…'}
          maxVisible={10}
        />
      </Box>
      <Text color={theme.dim}>{busy ? '… working' : 'n new · c claim · a assign · d done · ↑↓ select'}</Text>
    </Box>
  );
}

function Prompt({
  label,
  value,
  onChange,
  onSubmit,
  busy,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Box>
        <Text color={theme.accent}>❯ </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <Text color={theme.dim}>{busy ? '… working' : 'Enter confirm · Esc cancel'}</Text>
    </Box>
  );
}
