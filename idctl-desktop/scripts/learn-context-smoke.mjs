import assert from 'node:assert/strict';
import { buildLearnProcessContext } from '../src/shared/learnContext.ts';

assert.deepEqual(
  buildLearnProcessContext(),
  { defaultTeam: 'default', knownTeams: ['default'] },
);

assert.deepEqual(
  buildLearnProcessContext(
    { defaultTeam: 'research', knownTeams: ['default', 'research', 'engineering-team'] },
    ['research', 'public', 'engineering-team', 'onchain-execution'],
  ),
  {
    defaultTeam: 'research',
    knownTeams: ['research', 'default', 'engineering-team', 'public', 'onchain-execution'],
  },
);

assert.deepEqual(
  buildLearnProcessContext(
    { defaultTeam: '  ', knownTeams: [' default ', '', 'skillmesh'] },
    ['skillmesh', 'ops-team'],
  ),
  {
    defaultTeam: 'default',
    knownTeams: ['default', 'skillmesh', 'ops-team'],
  },
);
