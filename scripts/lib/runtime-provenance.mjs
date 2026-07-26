import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  dirname,
  isAbsolute,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { spawnSync } from 'node:child_process';

export const RUNTIME_LOCK_SCHEMA_VERSION = 1;
export const RUNTIME_MANIFEST_SCHEMA_VERSION = 2;
export const COMPONENT_NAMES = ['manager', 'brain'];

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function readJson(path, label = path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

export function validateRuntimeLock(lock) {
  const errors = [];
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    return ['runtime lock must be a JSON object'];
  }
  if (lock.schemaVersion !== RUNTIME_LOCK_SCHEMA_VERSION) {
    errors.push(`runtime lock schemaVersion must be ${RUNTIME_LOCK_SCHEMA_VERSION}`);
  }
  if (!lock.components || typeof lock.components !== 'object' || Array.isArray(lock.components)) {
    errors.push('runtime lock components must be an object');
    return errors;
  }
  for (const name of COMPONENT_NAMES) {
    const component = lock.components[name];
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      errors.push(`runtime lock is missing components.${name}`);
      continue;
    }
    if (typeof component.repository !== 'string' || !component.repository.trim()) {
      errors.push(`components.${name}.repository must be a non-empty string`);
    }
    if (!HEX_40.test(component.commit || '')) {
      errors.push(`components.${name}.commit must be a full lowercase 40-character Git commit`);
    }
    if (!HEX_40.test(component.tree || '')) {
      errors.push(`components.${name}.tree must be a full lowercase 40-character Git tree`);
    }
    if (typeof component.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(component.version)) {
      errors.push(`components.${name}.version must be semver`);
    }
    if (!HEX_64.test(component.packageLockSha256 || '')) {
      errors.push(`components.${name}.packageLockSha256 must be a lowercase SHA-256`);
    }
    if (typeof component.entrypoint !== 'string' || !component.entrypoint || component.entrypoint.startsWith('/') || component.entrypoint.includes('..')) {
      errors.push(`components.${name}.entrypoint must be a safe relative path`);
    }
    if (typeof component.serviceId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(component.serviceId)) {
      errors.push(`components.${name}.serviceId must be a stable lowercase service id`);
    }
  }
  const extras = Object.keys(lock.components).filter((name) => !COMPONENT_NAMES.includes(name));
  if (extras.length) errors.push(`runtime lock has unsupported component(s): ${extras.join(', ')}`);
  return errors;
}

function runGit(source, args, { encoding = 'utf8', allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: source,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed in ${source}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export function canonicalRepository(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git$/i, '').replace(/^\/+/, '')}`.toLowerCase();
  try {
    const url = new URL(raw);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')}`.toLowerCase();
  } catch {
    return raw.replace(/\.git$/i, '').toLowerCase();
  }
}

export function inspectComponentSource(name, component, source, { requireClean = true } = {}) {
  const errors = [];
  const inside = runGit(source, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') {
    return { errors: [`${name} source is not a Git working tree: ${source}`] };
  }

  const head = String(runGit(source, ['rev-parse', 'HEAD']).stdout).trim();
  if (head !== component.commit) {
    errors.push(`${name} HEAD ${head} does not match locked commit ${component.commit}`);
  }

  const treeResult = runGit(source, ['rev-parse', `${component.commit}^{tree}`], { allowFailure: true });
  const tree = treeResult.status === 0 ? String(treeResult.stdout).trim() : '';
  if (!tree) errors.push(`${name} locked commit ${component.commit} is not available locally`);
  else if (tree !== component.tree) errors.push(`${name} tree ${tree} does not match locked tree ${component.tree}`);

  const originResult = runGit(source, ['config', '--get', 'remote.origin.url'], { allowFailure: true });
  const origin = originResult.status === 0 ? String(originResult.stdout).trim() : '';
  if (!origin) {
    errors.push(`${name} source has no remote.origin.url`);
  } else if (canonicalRepository(origin) !== canonicalRepository(component.repository)) {
    errors.push(`${name} origin ${origin} does not match locked repository ${component.repository}`);
  }

  if (requireClean) {
    const status = String(runGit(source, ['status', '--porcelain=v1', '--untracked-files=all']).stdout).trim();
    if (status) {
      const preview = status.split(/\r?\n/).slice(0, 5).join('; ');
      errors.push(`${name} source is not clean${preview ? `: ${preview}` : ''}`);
    }
  }

  const packageLockResult = runGit(source, ['show', `${component.commit}:package-lock.json`], {
    encoding: null,
    allowFailure: true,
  });
  const packageLockSha256 = packageLockResult.status === 0 ? sha256(packageLockResult.stdout) : '';
  if (!packageLockSha256) {
    errors.push(`${name} locked commit has no package-lock.json`);
  } else if (packageLockSha256 !== component.packageLockSha256) {
    errors.push(`${name} package-lock.json SHA-256 ${packageLockSha256} does not match ${component.packageLockSha256}`);
  }

  const packageResult = runGit(source, ['show', `${component.commit}:package.json`], { allowFailure: true });
  let version = '';
  if (packageResult.status !== 0) {
    errors.push(`${name} locked commit has no package.json`);
  } else {
    try {
      version = JSON.parse(String(packageResult.stdout)).version || '';
    } catch {
      errors.push(`${name} package.json at ${component.commit} is invalid JSON`);
    }
    if (version !== component.version) {
      errors.push(`${name} package version ${version || '(missing)'} does not match locked version ${component.version}`);
    }
  }

  return {
    errors,
    name,
    source,
    repository: component.repository,
    origin,
    commit: head,
    tree,
    version,
    packageLockSha256,
  };
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function safeRuntimeManifestPath(value) {
  if (
    typeof value !== 'string'
    || !value
    || value === 'manifest.json'
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) return '';
  return value;
}

export function isContainedRuntimeManifestSymlink(linkPath, target) {
  if (
    !safeRuntimeManifestPath(linkPath)
    || typeof target !== 'string'
    || !target
    || posix.isAbsolute(target)
    || target.includes('\\')
    || target.includes('\0')
    || /^[A-Za-z]:/.test(target)
  ) return false;
  const destination = posix.normalize(posix.join(posix.dirname(linkPath), target));
  return Boolean(
    destination
    && destination !== '..'
    && !destination.startsWith('../')
    && !posix.isAbsolute(destination)
  );
}

export function isContainedRuntimeSymlink(root, linkPath, target) {
  if (!target || isAbsolute(target)) return false;
  const destination = resolve(dirname(linkPath), target);
  const relativeTarget = relative(resolve(root), destination);
  return (
    relativeTarget !== '..'
    && !relativeTarget.startsWith(`..${sep}`)
    && !isAbsolute(relativeTarget)
  );
}

function walk(root, current, records) {
  const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = `${current}${sep}${entry.name}`;
    const rel = portablePath(root, path);
    if (rel === 'manifest.json') continue;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      walk(root, path, records);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (!isContainedRuntimeSymlink(root, path, target)) {
        throw new Error(`runtime contains an unsafe symlink: ${rel} -> ${target}`);
      }
      records.push({
        path: rel,
        type: 'symlink',
        size: Buffer.byteLength(target),
        sha256: sha256(`symlink\0${target}`),
        target,
      });
      continue;
    }
    if (!stat.isFile()) throw new Error(`runtime contains an unsupported filesystem entry: ${rel}`);
    records.push({
      path: rel,
      type: 'file',
      size: stat.size,
      sha256: sha256File(path),
    });
  }
}

export function collectFileRecords(root) {
  const records = [];
  walk(root, root, records);
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

function canonicalRecord(record, path = record.path) {
  return JSON.stringify({
    path,
    type: record.type,
    size: record.size,
    sha256: record.sha256,
    ...(record.type === 'symlink' ? { target: record.target } : {}),
  });
}

export function fileTreeHash(records, prefix = '') {
  const normalizedPrefix = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
  const selected = records
    .filter((record) => !normalizedPrefix || record.path.startsWith(normalizedPrefix))
    .map((record) => canonicalRecord(
      record,
      normalizedPrefix ? record.path.slice(normalizedPrefix.length) : record.path,
    ))
    .join('\n');
  return sha256(selected ? `${selected}\n` : '');
}

export function verifyRuntimeManifest(runtimeRoot, manifest, runtimeLock) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['runtime manifest must be a JSON object'];
  }
  if (manifest.schemaVersion !== RUNTIME_MANIFEST_SCHEMA_VERSION) {
    errors.push(`runtime manifest schemaVersion must be ${RUNTIME_MANIFEST_SCHEMA_VERSION}`);
  }
  if (
    !Array.isArray(manifest.files)
    || manifest.files.length < 1
    || manifest.files.length > 100_000
  ) {
    errors.push('runtime manifest files must be a bounded non-empty array');
    return errors;
  }
  const expectedRecords = [];
  const seenPaths = new Set();
  for (const [index, record] of manifest.files.entries()) {
    const path = record && typeof record === 'object'
      ? safeRuntimeManifestPath(record.path)
      : '';
    const type = record?.type;
    const target = type === 'symlink' ? record?.target : undefined;
    const valid = Boolean(
      path
      && (type === 'file' || type === 'symlink')
      && Number.isSafeInteger(record?.size)
      && record.size >= 0
      && HEX_64.test(record?.sha256 || '')
      && (
        type === 'symlink'
          ? isContainedRuntimeManifestSymlink(path, target)
          : record.target === undefined
      )
    );
    if (!valid) {
      errors.push(`runtime manifest files[${index}] is invalid`);
      continue;
    }
    if (seenPaths.has(path)) {
      errors.push(`runtime manifest contains duplicate file ${path}`);
      continue;
    }
    seenPaths.add(path);
    expectedRecords.push(record);
  }

  let actual = [];
  try {
    actual = collectFileRecords(runtimeRoot);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return errors;
  }
  const expectedLines = expectedRecords.map((record) => canonicalRecord(record));
  const actualLines = actual.map((record) => canonicalRecord(record));
  const expectedSet = new Set(expectedLines);
  const actualSet = new Set(actualLines);
  for (const line of expectedLines) {
    if (!actualSet.has(line)) errors.push(`runtime file is missing or changed: ${JSON.parse(line).path}`);
  }
  for (const line of actualLines) {
    if (!expectedSet.has(line)) errors.push(`runtime has an unmanifested file or change: ${JSON.parse(line).path}`);
  }

  const aggregate = fileTreeHash(actual);
  if (manifest.trees?.runtime !== aggregate) {
    errors.push(`runtime tree hash ${aggregate} does not match manifest ${manifest.trees?.runtime || '(missing)'}`);
  }
  for (const name of COMPONENT_NAMES) {
    const tree = fileTreeHash(actual, name);
    if (manifest.trees?.[name] !== tree) {
      errors.push(`${name} runtime tree hash ${tree} does not match manifest ${manifest.trees?.[name] || '(missing)'}`);
    }
    const locked = runtimeLock?.components?.[name];
    const recorded = manifest.components?.[name];
    if (locked) {
      for (const field of ['repository', 'commit', 'tree', 'version', 'packageLockSha256', 'entrypoint', 'serviceId']) {
        if (recorded?.[field] !== locked[field]) {
          errors.push(`manifest components.${name}.${field} does not match runtime lock`);
        }
      }
    }
  }
  return [...new Set(errors)];
}
