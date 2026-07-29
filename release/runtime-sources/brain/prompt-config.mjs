import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(ROOT, 'prompts');

function loadPrompt(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(join(PROMPT_DIR, file), 'utf8')) };
  } catch {
    return fallback;
  }
}

export const PROMPTS = {
  factTake: loadPrompt('fact-take-synthesis.json', {
    id: 'fact-take-synthesis',
    version: 'fact-take-synthesis.v1',
    instructions: [
      'Synthesize one durable operational take from Brain facts.',
      'Return compact JSON only: {"take":"..."}',
    ],
  }),
  edgeDescription: loadPrompt('edge-description.json', {
    id: 'edge-description',
    version: 'edge-description.v1',
    instructions: ['Describe deterministic entity relationships from cited text-unit evidence.'],
  }),
  communityReport: loadPrompt('community-report.json', {
    id: 'community-report',
    version: 'deterministic-v1',
    instructions: ['Summarize deterministic communities only from cited text units and facts.'],
  }),
  safetyReport: loadPrompt('safety-report.json', {
    id: 'safety-report',
    version: 'safety-report.v1',
    instructions: ['Summarize skill/provider risk from timeline and text-unit evidence.'],
  }),
  followUpQuestions: loadPrompt('follow-up-questions.json', {
    id: 'follow-up-questions',
    version: 'follow-up-questions.v1',
    instructions: ['Generate follow-up questions for retrieval and curation gaps.'],
  }),
};

export const PROMPT_VERSIONS = Object.fromEntries(
  Object.entries(PROMPTS).map(([key, prompt]) => [key, prompt.version]),
);

export function promptVersion(key) {
  return PROMPTS[key]?.version ?? `${key}.v1`;
}
