/** Top navigation: the view tabs, with a live badge on Inbox. */

import { Box, Text } from 'ink';
import { theme } from '../app/theme.ts';
import type { ViewId } from '../app/views.ts';
import { VIEWS } from '../app/views.ts';

interface Props {
  active: ViewId;
  inboxCount: number;
}

export function NavBar({ active, inboxCount }: Props) {
  return (
    <Box flexWrap="wrap">
      <Text bold color={theme.accent}>
        idctl{' '}
      </Text>
      {VIEWS.map((v, i) => {
        const isActive = v.id === active;
        const key = v.shortcut ?? (v.id === 'settings' ? '0' : i < 9 ? String(i + 1) : 'Tab');
        const badge = v.id === 'inbox' && inboxCount > 0 ? `(${inboxCount})` : '';
        return (
          <Text key={v.id}>
            <Text color={isActive ? theme.accent : theme.dim} bold={isActive} inverse={isActive}>
              {' '}{key}:{v.short}{badge}{' '}
            </Text>
            <Text> </Text>
          </Text>
        );
      })}
    </Box>
  );
}
