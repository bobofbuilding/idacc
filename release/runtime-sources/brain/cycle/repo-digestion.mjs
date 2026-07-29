import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { brainGet, brainPost } from '../brain-client.mjs';
import { createLearningTask } from '../learning-policy.mjs';

export function cycleRepoPaths() {
  let explicit = [];
  const encoded = process.env.BRAIN_CYCLE_REPO_PATHS_JSON?.trim();
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded);
      if (Array.isArray(parsed)) {
        explicit = parsed
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean);
      }
    } catch {
      // Invalid supervisor/operator input fails closed instead of falling back
      // to the immutable Brain runtime directory.
      explicit = [];
    }
  } else {
    explicit = String(process.env.BRAIN_CYCLE_REPO_PATHS ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  const paths = explicit;

  if (process.env.BRAIN_CYCLE_DIGEST_WORKSPACE_REPOS === '1') {
    const workspaceProjects = process.env.ID_WORKSPACE_DIR
      ? join(process.env.ID_WORKSPACE_DIR, 'projects')
      : '';
    try {
      if (workspaceProjects && existsSync(workspaceProjects)) {
        for (const entry of readdirSync(workspaceProjects, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const path = join(workspaceProjects, entry.name);
          if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory())) paths.push(path);
        }
      }
    } catch {
      // Workspace discovery is best-effort; explicitly registered paths remain.
    }
  }

  return [...new Set(paths.map(path => resolve(path)))].slice(
    0,
    Math.max(1, Number(process.env.BRAIN_CYCLE_REPO_DIGEST_LIMIT ?? 12)),
  );
}

function openLearningTaskExists(db, { kind, subject }) {
  const row = db.prepare(`
    SELECT id FROM learning_tasks
    WHERE kind=? AND subject=? AND status NOT IN ('completed','cancelled')
    LIMIT 1
  `).get(kind, subject);
  return Boolean(row);
}

export async function digestConfiguredRepos(db) {
  if (process.env.BRAIN_CYCLE_REPO_DIGEST !== '1') {
    return { digested: [], refresh_tasks: [], skipped: ['disabled'] };
  }
  const configuredPaths = cycleRepoPaths();
  if (!configuredPaths.length) {
    return { digested: [], refresh_tasks: [], skipped: ['no-explicit-repositories'] };
  }

  const timeoutMs = Number(process.env.BRAIN_CYCLE_REPO_DIGEST_TIMEOUT_MS ?? 120_000);
  const previous = await brainGet('/repos?limit=200', { strict: false, timeoutMs });
  const previousById = new Map((previous.data?.repos ?? []).map(repo => [repo.id, repo]));
  const previousByPath = new Map((previous.data?.repos ?? [])
    .filter(repo => repo.data?.path)
    .map(repo => [resolve(repo.data.path), repo]));
  const digested = [];
  const refreshTasks = [];
  const skipped = [];

  for (const path of configuredPaths) {
    const previousRepoForPath = previousByPath.get(resolve(path));
    const response = await brainPost('/repos/digest', {
      path,
      project: process.env.BRAIN_CYCLE_REPO_PROJECT ?? '',
      source: 'brain-cycle',
      previousHead: previousRepoForPath?.data?.head ?? '',
      maxFiles: Number(process.env.BRAIN_CYCLE_REPO_MAX_FILES ?? 300),
      maxSourceFiles: Number(process.env.BRAIN_CYCLE_REPO_SOURCE_FILES ?? 12),
      processConfig: {
        chunk_size: Number(process.env.BRAIN_CYCLE_REPO_CHUNK_SIZE ?? 6000),
        chunk_overlap: Number(process.env.BRAIN_CYCLE_REPO_CHUNK_OVERLAP ?? 250),
      },
    }, { strict: false, timeoutMs });
    if (!response.data?.ok) {
      skipped.push({ path, error: response.data?.error ?? 'digest failed' });
      continue;
    }
    const repo = response.data.repo;
    digested.push({
      id: repo.id,
      path: repo.path,
      head: repo.head,
      dirty: repo.dirty,
      manifests: repo.manifests?.map(m => m.path) ?? [],
      file_text_units: response.data.fileTextUnitIds?.length ?? 0,
      symbols: response.data.symbols?.length ?? 0,
      changed_files: repo.changedFiles?.length ?? 0,
      changed_risk: repo.changedRisk ?? 'low',
      diff_snippets: repo.diffSnippets?.length ?? 0,
      entity_links: response.data.entityLinkCount ?? 0,
    });
    const previousHead = previousById.get(repo.id)?.data?.head;
    const currentHead = repo.head;
    const subject = `entity:${repo.id}`;
    if (previousHead && currentHead && previousHead !== currentHead && !openLearningTaskExists(db, { kind: 'source.refresh', subject })) {
      const taskId = createLearningTask(db, {
        kind: 'source.refresh',
        subject,
        priority: 20,
        evidenceIds: { repo_id: repo.id, source_ids: [subject], previous_head: previousHead, current_head: currentHead },
        payload: {
          source_ids: [subject],
          repo_id: repo.id,
          path: repo.path,
          previous_head: previousHead,
          current_head: currentHead,
          changed_files: repo.changedFiles ?? [],
          changed_manifests: repo.changedManifests ?? [],
          changed_file_summaries: repo.changedFileSummaries ?? [],
          changed_risk: repo.changedRisk ?? 'low',
          changed_summary: repo.changedSummary ?? '',
          diff_snippets: repo.diffSnippets ?? [],
          suggested_action: 'refresh repo-derived context after HEAD changed',
        },
      });
      refreshTasks.push({
        id: taskId,
        repo_id: repo.id,
        source_id: subject,
        previous_head: previousHead,
        current_head: currentHead,
        changed_files: repo.changedFiles ?? [],
        changed_manifests: repo.changedManifests ?? [],
        changed_file_summaries: repo.changedFileSummaries ?? [],
        changed_risk: repo.changedRisk ?? 'low',
        diff_snippets: repo.diffSnippets ?? [],
      });
    }
  }

  return { digested, refresh_tasks: refreshTasks, skipped };
}
