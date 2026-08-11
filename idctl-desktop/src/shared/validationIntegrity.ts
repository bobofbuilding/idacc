import type { Task } from '../../../idctl/src/api/types.ts';

const ARTIFACT_KEYS = new Set([
  'artifact', 'artifacts', 'artifact_path', 'artifact_paths',
  'file', 'files', 'changed_files', 'modified_files',
  'test', 'tests', 'test_results', 'verification_results',
  'commit', 'commit_sha', 'revision', 'deployment_url',
]);

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !/^[{[]/.test(text)) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function hasStructuredArtifact(value: unknown, depth = 0): boolean {
  value = parsed(value);
  if (!value || depth > 5) return false;
  if (Array.isArray(value)) return value.some((item) => hasStructuredArtifact(item, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
    const present = Array.isArray(rawValue)
      ? rawValue.length > 0
      : typeof rawValue === 'string'
        ? rawValue.trim().length > 0
        : rawValue !== null && rawValue !== undefined && rawValue !== false;
    if (ARTIFACT_KEYS.has(key) && present) return true;
    if (hasStructuredArtifact(rawValue, depth + 1)) return true;
  }
  return false;
}

/** A Manager verdict is not repository proof unless structured artifact/test evidence was stored. */
export function hasRecordedArtifactEvidence(task: Task): boolean {
  return [task.validationDetail, task.outcomeDetail, task.completionEvidence]
    .some((value) => hasStructuredArtifact(value));
}

export function needsArtifactIntegrityCheck(task: Task): boolean {
  return task.status === 'done'
    && task.workflowState === 'validated'
    && !!String(task.projectId || '').trim()
    && !hasRecordedArtifactEvidence(task);
}
