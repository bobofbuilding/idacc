import assert from 'node:assert/strict';
import { agentModelProfile, recommendAgentModel } from './agentModelPolicy.ts';

const codex = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

assert.equal(recommendAgentModel({ runtime: 'codex', models: codex, name: 'engineering-lead' }), 'gpt-5.6-sol');
assert.equal(recommendAgentModel({ runtime: 'codex', models: codex, name: 'researcher' }), 'gpt-5.6-sol');
assert.equal(recommendAgentModel({ runtime: 'codex', models: codex, name: 'backend-engineer' }), 'gpt-5.6-terra');
assert.equal(recommendAgentModel({ runtime: 'codex', models: codex, name: 'monitor' }), 'gpt-5.6-luna');

assert.equal(recommendAgentModel({ runtime: 'claude-code-cli', models: ['claude-sonnet-5', 'claude-opus-4.6', 'claude-haiku-4.5'], name: 'architect' }), 'claude-opus-4.6');
assert.equal(recommendAgentModel({ runtime: 'antigravity', models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite'], name: 'frontend-engineer' }), 'gemini-3-flash');
assert.equal(recommendAgentModel({ runtime: 'antigravity', models: ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite'], name: 'content-moderator' }), 'gemini-3-flash-lite');
assert.equal(recommendAgentModel({ runtime: 'provider:lmstudio', models: ['local-only'], name: 'researcher' }), 'local-only');
assert.equal(recommendAgentModel({ runtime: 'codex', models: [], name: 'lead' }), '');

assert.equal(agentModelProfile({ name: 'lead', lead: true }), 'frontier');
assert.equal(agentModelProfile({ name: 'ordinary-worker', role: 'implementation engineer' }), 'balanced');
assert.equal(agentModelProfile({ name: 'ordinary-worker', description: 'Monitors service health' }), 'fast');

console.log('agent model policy tests passed');
