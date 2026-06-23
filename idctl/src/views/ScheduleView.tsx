/**
 * ScheduleView — recurring work: supervision check-ins (auto-attached watches
 * on delegated tasks) and per-agent heartbeats. Heartbeats toggle via
 * `/heartbeat <agent> enable|disable`; check-ins are read from /checkins.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useAppCtx } from '../app/context.ts';
import { Select, type SelectItem } from '../components/Select.tsx';
import { theme, ago, statusColor } from '../app/theme.ts';
import type { CheckIn } from '../api/client.ts';
import type { Agent } from '../api/types.ts';

export function ScheduleView() {
  const { store, flash } = useAppCtx();
  const [checkins, setCheckins] = useState<CheckIn[]>([]);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);

  const agents = store.agents;
  const selected = agents[Math.min(cursor, agents.length - 1)];

  useEffect(() => {
    let alive = true;
    store.client
      .checkins()
      .then((c) => alive && setCheckins(c))
      .catch(() => alive && setCheckins([]));
    return () => {
      alive = false;
    };
  }, [store.client, store.lastUpdated]);

  async function toggleHeartbeat() {
    if (!selected || busy) return;
    const on = selected.metadata?.heartbeat === true;
    setBusy(true);
    try {
      await store.client.remote(`/heartbeat ${selected.name} ${on ? 'disable' : 'enable'}`);
      flash(`heartbeat ${selected.name} ${on ? 'off' : 'on'} ✓`, 'ok');
      store.refresh();
    } catch (err) {
      flash(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  const items: SelectItem<Agent>[] = agents.map((a) => ({
    key: a.id,
    label: a.name.padEnd(12).slice(0, 12),
    value: a,
    color: a.metadata?.heartbeat ? theme.ok : theme.dim,
    hint: a.metadata?.heartbeat ? '♥ heartbeat on' : '· heartbeat off',
  }));

  return (
    <Box flexDirection="column">
      <Box>
        <Box flexDirection="column" width="45%" marginRight={2}>
          <Text bold color={theme.accent}>
            Heartbeats
          </Text>
          <Select
            items={items}
            index={cursor}
            onIndexChange={setCursor}
            onSelect={toggleHeartbeat}
            emptyText="(no agents)"
            maxVisible={10}
          />
          <Text color={theme.dim}>{busy ? '… toggling' : 'Enter toggle heartbeat'}</Text>
        </Box>
        <Box flexDirection="column" width="55%">
          <Text bold color={theme.accentAlt}>
            Check-ins ({checkins.length})
          </Text>
          {checkins.length === 0 ? (
            <Text color={theme.dim}>(no active supervision check-ins)</Text>
          ) : (
            checkins.slice(0, 9).map((c, i) => (
              <Text key={String(c.id ?? i)}>
                <Text color={statusColor(c.status)}>●</Text>{' '}
                <Text>{c.linkedTask?.title ?? c.linkedTask?.name ?? c.owner ?? String(c.id ?? 'check-in')}</Text>
                <Text color={theme.dim}>
                  {c.owner ? ` → ${c.owner}` : ''}
                  {c.nextFireAt ? ` · due ${ago(c.nextFireAt)}` : ''}
                </Text>
              </Text>
            ))
          )}
        </Box>
      </Box>
    </Box>
  );
}
