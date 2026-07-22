#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  agentsForCapabilityScope,
  capabilityScopeUsesHierarchy,
} from '../src/renderer/views/capabilityScope.ts';

const agents = [
  { id: 'default-lead', name: 'lead', team: 'default' },
  { id: 'default-worker', name: 'coder', team: 'default' },
  { id: 'ops-lead', name: 'ops-lead', team: 'ops-team' },
  { id: 'ops-worker', name: 'maintainer', team: 'ops-team' },
  { id: 'research-lead', name: 'research-lead', team: 'research' },
  { id: 'research-worker', name: 'analyst', team: 'research' },
  { id: 'unknown-worker', name: 'orphan', team: 'unknown-team' },
];
const coordinators = { default: 'lead', 'ops-team': 'ops-lead', research: 'research-lead' };

assert.equal(capabilityScopeUsesHierarchy('workers'), true);
assert.deepEqual(
  agentsForCapabilityScope('workers', agents, agents.slice(0, 2), coordinators).map((agent) => agent.id),
  ['ops-worker', 'research-worker'],
  'worker scope must exclude default-team agents, team leads, and teams without a verified coordinator',
);
assert.deepEqual(
  agentsForCapabilityScope('leads', agents, agents.slice(0, 2), coordinators).map((agent) => agent.id),
  ['default-lead', 'ops-lead', 'research-lead'],
);

console.log('capability worker scope smoke: ok');
