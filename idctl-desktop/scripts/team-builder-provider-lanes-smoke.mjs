#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const teamsSource = readFileSync(new URL('../src/renderer/views/Teams.tsx', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../../idctl/src/settings/runtimeCatalog.ts', import.meta.url), 'utf8');

assert.match(teamsSource, /buildProviderModelLanes\(providers\)\.filter\(\(lane\) => lane\.selectable\)/);
assert.match(teamsSource, /optgroup label="Local provider lanes"/);
assert.match(teamsSource, /providerLanes\.map\(\(lane\) => lane\.id\)/);
assert.match(catalogSource, /p\.kind === 'ollama' && providerIsLocalRoute\(p\)/);
assert.match(catalogSource, /case 'lmstudio':[\s\S]*?return \[\];/);

console.log('team builder provider lanes smoke: ok');
