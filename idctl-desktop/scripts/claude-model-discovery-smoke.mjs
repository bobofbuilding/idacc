#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeCliModels } from '../src/main/claudeModels.ts';

const home = mkdtempSync(join(tmpdir(), 'idacc-claude-models-'));
try {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    additionalModelOptionsCache: [{ value: 'claude-fable-5[1m]' }],
    clientDataCacheSlots: { active: { model: 'claude-opus-4-8' } },
    oauthAccount: { accessToken: 'must-not-be-read-as-a-model' },
  }));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'sonnet',
    modelOverrides: { 'claude-sonnet-4-6': 'vendor-deployment' },
    env: { ANTHROPIC_CUSTOM_MODEL_OPTION: 'claude-team-router' },
  }));

  const discovered = discoverClaudeCliModels({
    home,
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5' },
    managedSettingsPaths: [],
  });
  for (const model of ['default', 'best', 'opus', 'sonnet', 'haiku', 'opusplan', 'claude-fable-5[1m]', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-team-router']) {
    assert.ok(discovered.models.includes(model), `expected ${model}`);
  }
  assert.ok(!discovered.models.some((model) => /token|secret/i.test(model)));

  const managedPath = join(home, 'managed-settings.json');
  writeFileSync(managedPath, JSON.stringify({ availableModels: ['sonnet', 'haiku'] }));
  const restricted = discoverClaudeCliModels({ home, env: {}, managedSettingsPaths: [managedPath] });
  assert.deepEqual(restricted.models, ['default', 'sonnet', 'haiku']);
  assert.equal(restricted.restricted, true);

  writeFileSync(managedPath, JSON.stringify({ availableModels: [] }));
  const defaultOnly = discoverClaudeCliModels({ home, env: {}, managedSettingsPaths: [managedPath] });
  assert.deepEqual(defaultOnly.models, ['default']);

  const noLongContext = discoverClaudeCliModels({
    home,
    env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
    managedSettingsPaths: [],
  });
  assert.ok(!noLongContext.models.some((model) => model.endsWith('[1m]')));
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('claude model discovery smoke: ok');
