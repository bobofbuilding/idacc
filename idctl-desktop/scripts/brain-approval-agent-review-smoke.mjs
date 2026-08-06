import assert from 'node:assert/strict';
import {
  brainApprovalAutomationEligibility,
  brainApprovalReviewConsensus,
  parseBrainApprovalReview,
  selectBrainApprovalReviewers,
} from '../src/main/brainApprovalAutomation.ts';

const safe = {
  id: 1515,
  kind: 'skill.publish',
  subject: 'url-summarize',
  risk_level: 'medium',
  payload: {
    definition: { name: 'url-summarize', description: 'Summarize a source URL with citations.' },
    source_ids: ['source:12'],
  },
};

assert.deepEqual(brainApprovalAutomationEligibility(safe), {
  eligible: true,
  reason: 'safe_skill_publication_review',
});
assert.equal(brainApprovalAutomationEligibility({ ...safe, risk_level: 'high' }).eligible, false);
assert.equal(brainApprovalAutomationEligibility({
  ...safe,
  payload: { definition: { name: 'wallet-withdraw', description: 'Withdraw wallet funds.' } },
}).eligible, false);
assert.equal(brainApprovalAutomationEligibility({
  ...safe,
  subject: 'wallet-withdraw',
  payload: {},
}).eligible, false);

const parsed = parseBrainApprovalReview('```json\n{"decision":"approved","confidence":0.91,"reason":"Evidence and scope verified.","evidence_ids":["source:12"]}\n```');
assert.deepEqual(parsed, {
  decision: 'approve',
  confidence: 0.91,
  reason: 'Evidence and scope verified.',
  evidenceIds: ['source:12'],
});

const reviewers = selectBrainApprovalReviewers([
  { team: 'default', agent: 'coder', specialty: 'implementation' },
  { team: 'research', agent: 'research-lead', specialty: 'evidence' },
  { team: 'capabilities', agent: 'skills-lead', specialty: 'skill-domain' },
  { team: 'default', agent: 'researcher', specialty: 'evidence' },
]);
assert.deepEqual(reviewers.slice(0, 3).map((row) => `${row.team}/${row.agent}`), [
  'default/researcher',
  'default/coder',
  'capabilities/skills-lead',
]);

const approve = { decision: 'approve', confidence: 0.9, reason: 'valid', evidenceIds: ['source:12'] };
assert.equal(brainApprovalReviewConsensus([approve, approve], 2).action, 'approve');
assert.equal(brainApprovalReviewConsensus([
  approve,
  { decision: 'repair', confidence: 0.8, reason: 'scope missing', evidenceIds: ['source:12'] },
], 2).action, 'repair');
assert.equal(brainApprovalReviewConsensus([
  approve,
  { decision: 'reject', confidence: 0.9, reason: 'duplicate', evidenceIds: ['source:12'] },
  { decision: 'escalate', confidence: 0.9, reason: 'conflict', evidenceIds: ['source:12'] },
], 3).action, 'escalate');

console.log('brain approval agent review smoke: ok');
