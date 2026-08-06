import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { inspectConsumerTextEntry } from './consumer-payload-policy.mjs';

export const RUNTIME_SOURCE_CAPSULE_SCHEMA_VERSION = 1;
export const RUNTIME_SOURCE_UPSTREAM_MAPPING = 'publisher-asserted-private-source-audit';

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const FILE_MODES = new Set(['100644', '100755']);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_CAPSULE_FILES = 4_096;
const MAX_CAPSULE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_BRAIN_CAPSULE_PATH = /^(?:seeds(?:\/|$)|operator-tools\/(?!refresh-source-embeddings\.mjs$)|(?:bittrees[^/]*|ingest-bittrees|skill-loop-[^/]*|sync-onchain|demand-proof|quota-watch|projects-sync)\.(?:c?m?js|sh)$|(?:control-center|launchd|output|plans|test|docs|electron)(?:\/|$))/i;

function digest(algorithm, input) {
  return createHash(algorithm).update(input).digest('hex');
}

function sha256(input) {
  return digest('sha256', input);
}

function gitObjectSha1(type, input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return digest(
    'sha1',
    Buffer.concat([
      Buffer.from(`${type} ${bytes.length}\0`, 'utf8'),
      bytes,
    ]),
  );
}

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalFileRecord(record) {
  return JSON.stringify({
    path: record.path,
    mode: record.mode,
    size: record.size,
    sha256: record.sha256,
    gitBlobSha1: record.gitBlobSha1,
  });
}

export function runtimeSourceCapsuleTreeSha256(files) {
  const lines = [...files]
    .sort((left, right) => lexicalCompare(left.path, right.path))
    .map(canonicalFileRecord)
    .join('\n');
  return sha256(lines ? `${lines}\n` : '');
}

function safePortablePath(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value === '') return true;
  if (
    typeof value !== 'string'
    || !value
    || value.length > 1_024
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value !== value.normalize('NFC')
  ) {
    return false;
  }
  const parts = value.split('/');
  if (parts.some((part) => !safePortablePart(part))) return false;
  return parts.join('/') === value;
}

function safePortablePart(value) {
  return Boolean(
    value
    && value !== '.'
    && value !== '..'
    && Buffer.byteLength(value, 'utf8') <= 255
    && /^[A-Za-z0-9._+-]+$/u.test(value)
    && !/[\x00-\x1f<>:"/\\|?*]/u.test(value)
    && !/[ .]$/u.test(value)
    && !WINDOWS_DEVICE_NAME.test(value)
  );
}

function casefoldKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function validatePortablePathCollisions(paths, label, errors) {
  const seen = new Map();
  const allPaths = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      allPaths.add(parts.slice(0, index).join('/'));
    }
  }
  for (const path of [...allPaths].sort(lexicalCompare)) {
    const key = casefoldKey(path);
    const previous = seen.get(key);
    if (previous && previous !== path) {
      errors.push(
        `${label} has a case-folded NFC path collision: ${previous} and ${path}`,
      );
    } else {
      seen.set(key, path);
    }
  }
}

function readRegularFile(path, label, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  const noFollow = Number(fsConstants.O_NOFOLLOW || 0);
  const descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`${label} is not a regular file`);
    if (opened.size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    if (
      typeof before.dev === 'number'
      && typeof before.ino === 'number'
      && (before.dev !== opened.dev || before.ino !== opened.ino)
    ) {
      throw new Error(`${label} changed while it was being inspected`);
    }
    return {
      bytes: readFileSync(descriptor),
      stat: opened,
    };
  } finally {
    closeSync(descriptor);
  }
}

function pathIsContained(boundary, path) {
  const rel = relative(boundary, path);
  return Boolean(
    rel === ''
    || (
      rel !== '..'
      && !rel.startsWith(`..${sep}`)
      && !isAbsolute(rel)
    )
  );
}

function commonParent(left, right) {
  let boundary = dirname(left);
  while (!pathIsContained(boundary, right)) {
    const parent = dirname(boundary);
    if (parent === boundary) return boundary;
    boundary = parent;
  }
  return boundary;
}

function validateContainmentPath(boundary, path, label, errors) {
  if (!pathIsContained(boundary, path)) {
    errors.push(`${label} resolves outside capsule containment root ${boundary}`);
    return;
  }
  const rel = relative(boundary, path);
  let cursor = boundary;
  const segments = rel ? rel.split(sep) : [];
  for (const segment of ['', ...segments]) {
    if (segment) cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        errors.push(`${label} traverses a symbolic link: ${cursor}`);
      }
    } catch (error) {
      errors.push(
        `${label} containment path cannot be inspected at ${cursor}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function inspectCapsuleDirectory(root, errors, componentName) {
  const records = [];
  const directories = [];
  let fileCount = 0;
  let totalBytes = 0;
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    errors.push(
      `capsule directory cannot be inspected at ${root}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { records, directories };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    errors.push(`capsule root is not a regular directory: ${root}`);
    return { records, directories };
  }

  function walk(current, prefix) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true })
        .sort((left, right) => lexicalCompare(left.name, right.name));
    } catch (error) {
      errors.push(
        `capsule directory cannot be read at ${prefix || '.'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    for (const entry of entries) {
      const portable = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (!safePortablePath(portable)) {
        errors.push(`capsule contains an unsafe portable path: ${portable}`);
      }
      let stat;
      try {
        stat = lstatSync(path);
      } catch (error) {
        errors.push(
          `capsule path cannot be inspected: ${portable}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (stat.isSymbolicLink()) {
        errors.push(`capsule contains a symbolic link: ${portable}`);
        continue;
      }
      if (stat.isDirectory()) {
        directories.push(portable);
        walk(path, portable);
        continue;
      }
      if (!stat.isFile()) {
        errors.push(`capsule contains a non-regular filesystem entry: ${portable}`);
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_CAPSULE_FILES) {
        errors.push(
          `capsule contains more than ${MAX_CAPSULE_FILES} regular files`,
        );
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        errors.push(
          `capsule file exceeds the ${MAX_FILE_BYTES}-byte limit: ${portable}`,
        );
        continue;
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_CAPSULE_BYTES) {
        errors.push(
          `capsule exceeds the ${MAX_CAPSULE_BYTES}-byte aggregate limit`,
        );
        continue;
      }
      try {
        const inspected = readRegularFile(
          path,
          `capsule file ${portable}`,
          { maxBytes: MAX_FILE_BYTES },
        );
        if (
          componentName === 'brain'
          && FORBIDDEN_BRAIN_CAPSULE_PATH.test(portable)
        ) {
          errors.push(`forbidden Brain consumer capsule path: ${portable}`);
        }
        errors.push(
          ...inspectConsumerTextEntry(
            `${componentName}/${portable}`,
            inspected.bytes,
            { runtimePolicy: true },
          ).map((error) => `consumer payload policy: ${error}`),
        );
        records.push({
          path: portable,
          size: inspected.bytes.length,
          sha256: sha256(inspected.bytes),
          gitBlobSha1: gitObjectSha1('blob', inspected.bytes),
          executable: Boolean(inspected.stat.mode & 0o111),
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  walk(root, '');
  for (const directory of directories) {
    if (!records.some((record) => record.path.startsWith(`${directory}/`))) {
      errors.push(`capsule contains an unmanifestable empty directory: ${directory}`);
    }
  }
  validatePortablePathCollisions(
    [...records.map((record) => record.path), ...directories],
    'capsule',
    errors,
  );
  return { records, directories };
}

function validateManifestFiles(manifest, errors) {
  if (
    !Array.isArray(manifest.files)
    || manifest.files.length < 1
    || manifest.files.length > MAX_CAPSULE_FILES
  ) {
    errors.push(
      `capsule manifest files must be a non-empty array of at most ${MAX_CAPSULE_FILES} records`,
    );
    return [];
  }
  const files = [];
  const seenPaths = new Set();
  let totalBytes = 0;
  for (const [index, candidate] of manifest.files.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push(`capsule manifest files[${index}] must be an object`);
      continue;
    }
    const allowedFields = new Set([
      'path',
      'mode',
      'size',
      'sha256',
      'gitBlobSha1',
    ]);
    const extraFields = Object.keys(candidate)
      .filter((field) => !allowedFields.has(field));
    if (extraFields.length) {
      errors.push(
        `capsule manifest files[${index}] has unsupported field(s): ${
          extraFields.join(', ')
        }`,
      );
    }
    if (!safePortablePath(candidate.path)) {
      errors.push(`capsule manifest files[${index}].path is unsafe`);
      continue;
    }
    if (seenPaths.has(candidate.path)) {
      errors.push(`capsule manifest has a duplicate path: ${candidate.path}`);
      continue;
    }
    seenPaths.add(candidate.path);
    if (!FILE_MODES.has(candidate.mode)) {
      errors.push(
        `capsule manifest ${candidate.path} has unsupported mode ${candidate.mode}`,
      );
    }
    if (
      !Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || candidate.size > MAX_FILE_BYTES
    ) {
      errors.push(`capsule manifest ${candidate.path} has an invalid size`);
    } else {
      totalBytes += candidate.size;
    }
    if (!HEX_64.test(candidate.sha256 || '')) {
      errors.push(`capsule manifest ${candidate.path} has an invalid SHA-256`);
    }
    if (!HEX_40.test(candidate.gitBlobSha1 || '')) {
      errors.push(`capsule manifest ${candidate.path} has an invalid Git blob SHA-1`);
    }
    files.push({
      path: candidate.path,
      mode: candidate.mode,
      size: candidate.size,
      sha256: candidate.sha256,
      gitBlobSha1: candidate.gitBlobSha1,
    });
  }
  if (totalBytes > MAX_CAPSULE_BYTES) {
    errors.push(
      `capsule manifest exceeds the ${MAX_CAPSULE_BYTES}-byte aggregate limit`,
    );
  }
  const canonicalOrder = [...files]
    .sort((left, right) => lexicalCompare(left.path, right.path));
  if (
    files.length === canonicalOrder.length
    && files.some((record, index) => record.path !== canonicalOrder[index].path)
  ) {
    errors.push('capsule manifest files are not in canonical path order');
  }
  validatePortablePathCollisions(
    files.map((record) => record.path),
    'capsule manifest',
    errors,
  );
  return files;
}

function validatePackageMetadata(root, files, component, errors) {
  const byPath = new Map(files.map((record) => [record.path, record]));
  for (const required of ['package.json', 'package-lock.json', component.entrypoint]) {
    if (!byPath.has(required)) {
      errors.push(`capsule is missing required file ${required}`);
    }
  }
  if (!safePortablePath(component.entrypoint || '')) {
    errors.push('locked capsule entrypoint is not a safe portable path');
    return;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(
      readRegularFile(
        join(root, 'package.json'),
        'capsule package.json',
        { maxBytes: MAX_FILE_BYTES },
      ).bytes.toString('utf8'),
    );
  } catch (error) {
    errors.push(
      `capsule package.json is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (packageJson && packageJson.version !== component.version) {
    errors.push(
      `capsule package version ${packageJson.version || '(missing)'} does not match ${
        component.version
      }`,
    );
  }

  let packageLock;
  let packageLockBytes;
  try {
    packageLockBytes = readRegularFile(
      join(root, 'package-lock.json'),
      'capsule package-lock.json',
      { maxBytes: MAX_FILE_BYTES },
    ).bytes;
    packageLock = JSON.parse(packageLockBytes.toString('utf8'));
  } catch (error) {
    errors.push(
      `capsule package-lock.json is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    packageLockBytes
    && sha256(packageLockBytes) !== component.packageLockSha256
  ) {
    errors.push(
      `capsule package-lock.json SHA-256 ${
        sha256(packageLockBytes)
      } does not match ${component.packageLockSha256}`,
    );
  }
  if (packageLock) {
    if (packageLock.version !== component.version) {
      errors.push(
        `capsule package-lock version ${packageLock.version || '(missing)'} does not match ${
          component.version
        }`,
      );
    }
    if (packageLock.packages?.['']?.version !== component.version) {
      errors.push(
        `capsule package-lock root version ${
          packageLock.packages?.['']?.version || '(missing)'
        } does not match ${component.version}`,
      );
    }
  }

  const entrypoint = join(root, ...String(component.entrypoint || '').split('/'));
  try {
    const stat = lstatSync(entrypoint);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`capsule entrypoint is not a regular file: ${component.entrypoint}`);
    }
  } catch {
    // The missing-file error above is more useful and deterministic.
  }
}

function compareActualFiles(actual, files, errors) {
  const actualByPath = new Map(actual.map((record) => [record.path, record]));
  const expectedByPath = new Map(files.map((record) => [record.path, record]));
  for (const record of files) {
    const observed = actualByPath.get(record.path);
    if (!observed) {
      errors.push(`capsule is missing manifested file ${record.path}`);
      continue;
    }
    for (const field of ['size', 'sha256', 'gitBlobSha1']) {
      if (observed[field] !== record[field]) {
        errors.push(
          `capsule file ${record.path} ${field} ${observed[field]} does not match ${
            record[field]
          }`,
        );
      }
    }
    if (
      process.platform !== 'win32'
      && observed.executable !== (record.mode === '100755')
    ) {
      errors.push(
        `capsule file ${record.path} executable mode does not match ${record.mode}`,
      );
    }
  }
  for (const record of actual) {
    if (!expectedByPath.has(record.path)) {
      errors.push(`capsule has an unmanifested file: ${record.path}`);
    }
  }
}

export function verifyRuntimeSourceCapsule({
  root,
  manifestPath,
  component,
  componentName = 'brain',
  containmentRoot,
}) {
  const errors = [];
  const resolvedRoot = resolve(root);
  const resolvedManifestPath = resolve(manifestPath);
  const resolvedContainmentRoot = resolve(
    containmentRoot || commonParent(resolvedRoot, resolvedManifestPath),
  );
  const result = {
    errors,
    root: resolvedRoot,
    manifestPath: resolvedManifestPath,
    containmentRoot: resolvedContainmentRoot,
    manifest: null,
    manifestSha256: '',
    treeSha256: '',
    files: [],
    upstreamMapping: RUNTIME_SOURCE_UPSTREAM_MAPPING,
  };

  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    errors.push('locked capsule component must be an object');
    return result;
  }
  const distributionSource = component.distributionSource;
  if (
    !distributionSource
    || typeof distributionSource !== 'object'
    || Array.isArray(distributionSource)
  ) {
    errors.push('locked capsule component is missing distributionSource');
  } else {
    if (distributionSource.mode !== 'vendored-capsule') {
      errors.push('locked capsule distributionSource.mode must be vendored-capsule');
    }
    if (!HEX_64.test(distributionSource.manifestSha256 || '')) {
      errors.push('locked capsule distributionSource.manifestSha256 is invalid');
    }
    if (!HEX_64.test(distributionSource.treeSha256 || '')) {
      errors.push('locked capsule distributionSource.treeSha256 is invalid');
    }
  }

  validateContainmentPath(
    resolvedContainmentRoot,
    resolvedRoot,
    'capsule root',
    errors,
  );
  validateContainmentPath(
    resolvedContainmentRoot,
    resolvedManifestPath,
    'capsule manifest',
    errors,
  );

  let manifestBytes;
  try {
    const inspectedManifest = readRegularFile(
      resolvedManifestPath,
      'capsule manifest',
      { maxBytes: MAX_MANIFEST_BYTES },
    );
    manifestBytes = inspectedManifest.bytes;
    result.manifestSha256 = sha256(manifestBytes);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
  if (
    distributionSource?.manifestSha256
    && result.manifestSha256 !== distributionSource.manifestSha256
  ) {
    errors.push(
      `capsule manifest SHA-256 ${result.manifestSha256} does not match locked ${
        distributionSource.manifestSha256
      }`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    result.manifest = manifest;
  } catch (error) {
    errors.push(
      `capsule manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return result;
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('capsule manifest must be a JSON object');
    return result;
  }
  const allowedManifestFields = new Set([
    'schemaVersion',
    'component',
    'repository',
    'commit',
    'tree',
    'version',
    'packageLockSha256',
    'entrypoint',
    'serviceId',
    'upstreamMapping',
    'files',
    'treeSha256',
  ]);
  const extraManifestFields = Object.keys(manifest)
    .filter((field) => !allowedManifestFields.has(field));
  if (extraManifestFields.length) {
    errors.push(
      `capsule manifest has unsupported field(s): ${extraManifestFields.join(', ')}`,
    );
  }
  if (manifest.schemaVersion !== RUNTIME_SOURCE_CAPSULE_SCHEMA_VERSION) {
    errors.push(
      `capsule manifest schemaVersion must be ${
        RUNTIME_SOURCE_CAPSULE_SCHEMA_VERSION
      }`,
    );
  }
  if (manifest.upstreamMapping !== RUNTIME_SOURCE_UPSTREAM_MAPPING) {
    errors.push(
      `capsule manifest upstreamMapping must be ${
        RUNTIME_SOURCE_UPSTREAM_MAPPING
      }`,
    );
  }
  const componentFields = [
    ['component', componentName],
    ['repository', component.repository],
    ['commit', component.commit],
    ['tree', component.tree],
    ['version', component.version],
    ['packageLockSha256', component.packageLockSha256],
    ['entrypoint', component.entrypoint],
    ['serviceId', component.serviceId],
  ];
  for (const [field, expected] of componentFields) {
    if (manifest[field] !== expected) {
      errors.push(
        `capsule manifest ${field} ${manifest[field] || '(missing)'} does not match ${
          expected || '(missing)'
        }`,
      );
    }
  }

  const files = validateManifestFiles(manifest, errors);
  result.files = files;
  result.treeSha256 = runtimeSourceCapsuleTreeSha256(files);
  if (!HEX_64.test(manifest.treeSha256 || '')) {
    errors.push('capsule manifest treeSha256 is invalid');
  } else if (manifest.treeSha256 !== result.treeSha256) {
    errors.push(
      `capsule tree SHA-256 ${result.treeSha256} does not match manifest ${
        manifest.treeSha256
      }`,
    );
  }
  if (
    distributionSource?.treeSha256
    && result.treeSha256 !== distributionSource.treeSha256
  ) {
    errors.push(
      `capsule tree SHA-256 ${result.treeSha256} does not match locked ${
        distributionSource.treeSha256
      }`,
    );
  }

  const inspected = inspectCapsuleDirectory(
    resolvedRoot,
    errors,
    componentName,
  );
  compareActualFiles(inspected.records, files, errors);
  validatePackageMetadata(resolvedRoot, files, component, errors);
  result.errors = [...new Set(errors)];
  return result;
}

export function materializeRuntimeSourceCapsule({
  root,
  manifestPath,
  component,
  componentName = 'brain',
  containmentRoot,
  target,
}) {
  const verification = verifyRuntimeSourceCapsule({
    root,
    manifestPath,
    component,
    componentName,
    containmentRoot,
  });
  if (verification.errors.length) {
    throw new Error(
      `runtime source capsule failed verification:\n- ${
        verification.errors.join('\n- ')
      }`,
    );
  }

  const sourceRoot = resolve(root);
  const destination = resolve(target);
  const destinationFromSource = relative(sourceRoot, destination);
  if (
    destination === sourceRoot
    || (
      destinationFromSource
      && destinationFromSource !== '..'
      && !destinationFromSource.startsWith(`..${sep}`)
      && !isAbsolute(destinationFromSource)
    )
  ) {
    throw new Error('capsule materialization target must be outside the capsule');
  }
  if (existsSync(destination)) {
    throw new Error(`capsule materialization target already exists: ${destination}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  const scratch = mkdtempSync(join(dirname(destination), '.runtime-capsule-'));
  const payload = join(scratch, 'payload');
  mkdirSync(payload);
  try {
    for (const record of verification.files) {
      const source = join(sourceRoot, ...record.path.split('/'));
      const inspected = readRegularFile(
        source,
        `capsule file ${record.path}`,
        { maxBytes: MAX_FILE_BYTES },
      );
      if (
        inspected.bytes.length !== record.size
        || sha256(inspected.bytes) !== record.sha256
        || gitObjectSha1('blob', inspected.bytes) !== record.gitBlobSha1
      ) {
        throw new Error(
          `capsule file changed after verification: ${record.path}`,
        );
      }
      const output = join(payload, ...record.path.split('/'));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, inspected.bytes, {
        mode: record.mode === '100755' ? 0o755 : 0o644,
      });
      if (process.platform !== 'win32') {
        chmodSync(output, record.mode === '100755' ? 0o755 : 0o644);
      }
    }
    renameSync(payload, destination);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return {
    ...verification,
    target: destination,
  };
}
