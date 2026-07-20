import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'idacc-command-surface-'));
try {
  const outfile = join(dir, 'commands.mjs');
  await build({
    entryPoints: [new URL('../src/renderer/dashboard/commands.ts', import.meta.url).pathname],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const { buildCommands, filterCommands } = await import(`file://${outfile}?v=${Date.now()}`);
  const commands = buildCommands({ allAgents: [], refresh() {} });
  for (const [query, id] of [['register project', 'projects.sync'], ['promote', 'org.sync'], ['dispatch', 'work.dispatch']]) {
    assert.equal(filterCommands(commands, query)[0]?.id, id, `dashboard command search failed for ${query}`);
  }
  const intentOutfile = join(dir, 'chat-intents.mjs');
  await build({
    entryPoints: [new URL('../src/renderer/dashboard/chatIntents.ts', import.meta.url).pathname],
    outfile: intentOutfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const { parseChatControlIntent } = await import(`file://${intentOutfile}?v=${Date.now()}`);
  const intentStore = { allAgents: [{ name: 'research-lead', team: 'research' }] };
  assert.equal(parseChatControlIntent('/dispatch "Audit evidence" to research', intentStore)?.commandId, 'work.dispatch');
  assert.match(parseChatControlIntent('/dispatch Audit evidence to research', intentStore)?.summary ?? '', /research\/research-lead.*Audit evidence/);
  assert.equal(parseChatControlIntent('/project new "Alpha" for engineering-team', intentStore)?.commandId, 'projects.sync');
  assert.match(parseChatControlIntent('/project new Alpha for engineering-team', intentStore)?.summary ?? '', /Alpha.*engineering-team/);
  assert.equal(parseChatControlIntent('/promote-lead research-lead for research', intentStore)?.commandId, 'org.sync');
  assert.equal(parseChatControlIntent('/ask lead keep chatting normally', intentStore), null);

  const drawerSource = await readFile(new URL('../src/renderer/views/dashboard/ControlDrawer.tsx', import.meta.url), 'utf8');
  assert.match(drawerSource, /aria-modal="true"/, 'control drawer must expose modal semantics');
  assert.match(drawerSource, /event\.key === 'Escape'/, 'control drawer must close with Escape');
  assert.match(drawerSource, /returnFocusRef\.current\?\.focus\(\)/, 'control drawer must restore trigger focus');
  assert.match(drawerSource, /event\.key !== 'Tab'/, 'control drawer must contain keyboard focus');
  console.log('[dashboard-command-surface-smoke] OK');
} finally {
  await rm(dir, { recursive: true, force: true });
}
