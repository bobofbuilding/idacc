import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache']);
const MANIFEST_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'deno.json',
  'tsconfig.json',
]);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt']);

function hash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function git(path, args) {
  try {
    return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitLines(path, args) {
  const out = git(path, args);
  return out ? out.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

function readMaybe(path, maxChars = 16_000) {
  try {
    return readFileSync(path, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function walk(root, { maxFiles = 300 } = {}) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop();
    const abs = join(root, current);
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const rel = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) stack.push(rel);
        continue;
      }
      if (entry.isFile()) files.push(rel);
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function detectManifests(root, files) {
  return files
    .filter(file => MANIFEST_NAMES.has(basename(file)) || /^\.github\/workflows\/.+\.ya?ml$/.test(file) || /^launchd\/.+\.plist$/.test(file))
    .map(file => {
      const abs = join(root, file);
      const content = readMaybe(abs, 24_000);
      let parsed = null;
      if (basename(file) === 'package.json') {
        try {
          const pkg = JSON.parse(content);
          parsed = {
            name: pkg.name ?? '',
            version: pkg.version ?? '',
            scripts: Object.keys(pkg.scripts ?? {}),
            dependencies: Object.keys(pkg.dependencies ?? {}),
            devDependencies: Object.keys(pkg.devDependencies ?? {}),
          };
        } catch {
          parsed = null;
        }
      }
      return {
        path: file,
        bytes: statSync(abs).size,
        sha1: hash(content),
        parsed,
      };
    });
}

function parsePackageManifest(content) {
  try {
    const pkg = JSON.parse(content);
    return {
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
    };
  } catch {
    return null;
  }
}

function packageManifestAt(root, ref, file) {
  const content = ref
    ? git(root, ['show', `${ref}:${file}`])
    : readMaybe(join(root, file), 24_000);
  return content ? parsePackageManifest(content) : null;
}

function dependencyDriftForPackage({ root, file, previousHead, currentHead }) {
  const before = packageManifestAt(root, previousHead, file);
  const after = packageManifestAt(root, currentHead, file) ?? packageManifestAt(root, '', file);
  if (!after) return null;
  const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const changes = [];
  for (const section of sections) {
    const previousDeps = before?.[section] ?? {};
    const currentDeps = after[section] ?? {};
    const names = [...new Set([...Object.keys(previousDeps), ...Object.keys(currentDeps)])].sort();
    for (const name of names) {
      const previous = previousDeps[name] ?? null;
      const current = currentDeps[name] ?? null;
      if (previous === current) continue;
      const action = previous == null ? 'added' : current == null ? 'removed' : 'changed';
      const risk = /eslint|prettier|typescript|@types\//.test(name) || section === 'devDependencies'
        ? 'low'
        : /auth|crypto|jwt|wallet|web3|ethers|sqlite|database|db|http|server|express|fastify|openai|agent/i.test(name)
          ? 'high'
          : 'medium';
      changes.push({ manifest: file, section, name, previous, current, action, risk });
    }
  }
  if (!changes.length) return null;
  return {
    manifest: file,
    package_changes: changes,
    added: changes.filter(change => change.action === 'added').length,
    removed: changes.filter(change => change.action === 'removed').length,
    changed: changes.filter(change => change.action === 'changed').length,
    risk: highestRisk(changes),
    summary: `${file} dependency drift: ${changes.length} package change(s), highest risk ${highestRisk(changes)}.`,
  };
}

function parseRequirements(content) {
  const deps = {};
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*([<>=!~]=?.*)?$/);
    if (!match) continue;
    deps[match[1]] = (match[2] ?? '*').trim();
  }
  return deps;
}

function parseGoMod(content) {
  const deps = {};
  let inRequireBlock = false;
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    const requireLine = line.startsWith('require ') ? line.slice('require '.length).trim() : inRequireBlock ? line : '';
    if (!requireLine) continue;
    const [name, version] = requireLine.split(/\s+/);
    if (name && version) deps[name] = version;
  }
  return deps;
}

function dependencyDriftForSimpleManifest({ root, file, previousHead, currentHead, kind, parser }) {
  const beforeContent = previousHead ? git(root, ['show', `${previousHead}:${file}`]) : '';
  const afterContent = currentHead ? git(root, ['show', `${currentHead}:${file}`]) : readMaybe(join(root, file), 24_000);
  if (!afterContent) return null;
  const before = parser(beforeContent);
  const after = parser(afterContent);
  const changes = [];
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const previous = before[name] ?? null;
    const current = after[name] ?? null;
    if (previous === current) continue;
    const action = previous == null ? 'added' : current == null ? 'removed' : 'changed';
    const risk = /auth|crypto|jwt|wallet|web3|sql|database|db|http|server|openai|agent|django|flask|fastapi|grpc/i.test(name)
      ? 'high'
      : 'medium';
    changes.push({ manifest: file, ecosystem: kind, name, previous, current, action, risk });
  }
  if (!changes.length) return null;
  return {
    manifest: file,
    ecosystem: kind,
    package_changes: changes,
    added: changes.filter(change => change.action === 'added').length,
    removed: changes.filter(change => change.action === 'removed').length,
    changed: changes.filter(change => change.action === 'changed').length,
    risk: highestRisk(changes),
    summary: `${file} ${kind} dependency drift: ${changes.length} package change(s), highest risk ${highestRisk(changes)}.`,
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(value => String(value ?? '').trim()).filter(Boolean))].sort();
}

function parseTomlShape(content) {
  const sections = [];
  const keys = [];
  let section = '';
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[+([^\]]+)\]+$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      sections.push(section);
      continue;
    }
    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (keyMatch) keys.push(section ? `${section}.${keyMatch[1]}` : keyMatch[1]);
  }
  return { sections: uniqueSorted(sections), keys: uniqueSorted(keys) };
}

function parseWorkflowShape(content) {
  const text = String(content ?? '');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const triggerLine = lines.find(line => line.startsWith('on:')) ?? '';
  const permissionsLine = lines.find(line => line.startsWith('permissions:')) ?? '';
  return {
    triggers: triggerLine ? [triggerLine.replace(/^on:\s*/, '').trim()] : [],
    permissions: permissionsLine.replace(/^permissions:\s*/, '').trim(),
    actions: uniqueSorted([...text.matchAll(/\buses:\s*([^\s#]+)/g)].map(match => match[1])),
    secrets: uniqueSorted([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1])),
  };
}

function parseLaunchdShape(content) {
  const text = String(content ?? '');
  const valuesForKey = (key) => {
    const match = text.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`));
    return match ? [...match[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(item => item[1]) : [];
  };
  const scalarForKey = (key) => {
    const match = text.match(new RegExp(`<key>${key}</key>\\s*<(string|integer)>([\\s\\S]*?)</\\1>`));
    return match ? match[2] : '';
  };
  const hasBoolKey = (key) => {
    const match = text.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`));
    return match ? match[1] : '';
  };
  const envMatch = text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  const envKeys = envMatch ? [...envMatch[1].matchAll(/<key>([\s\S]*?)<\/key>/g)].map(item => item[1]) : [];
  return {
    label: scalarForKey('Label'),
    program_arguments: valuesForKey('ProgramArguments'),
    start_interval: scalarForKey('StartInterval'),
    keep_alive: hasBoolKey('KeepAlive'),
    environment_keys: uniqueSorted(envKeys),
  };
}

function packageNameFromLockPath(path) {
  const parts = String(path ?? '').split('node_modules/');
  return parts.length > 1 ? parts.pop() : '';
}

function parsePackageLockShape(content) {
  try {
    const parsed = JSON.parse(String(content ?? '{}'));
    const packages = parsed.packages && typeof parsed.packages === 'object' ? parsed.packages : {};
    const versions = [];
    for (const [path, details] of Object.entries(packages)) {
      const name = details?.name ?? packageNameFromLockPath(path);
      const version = details?.version ?? '';
      if (name && version) versions.push(`${name}@${version}`);
    }
    return { packages: uniqueSorted(versions.map(entry => entry.replace(/@[^@]+$/, ''))), versions: uniqueSorted(versions) };
  } catch {
    return null;
  }
}

function parseTextLockfileShape(content) {
  const entries = [];
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim().replace(/^["']|["']:$/g, '');
    if (!line || line.startsWith('#') || line.startsWith('lockfileVersion')) continue;
    const match = line.match(/^((?:@[^/]+\/)?[A-Za-z0-9_.-]+)@[^:\s]+/);
    if (match) entries.push(match[1]);
  }
  return { packages: uniqueSorted(entries) };
}

function parseLockfileShape(content) {
  return parsePackageLockShape(content) ?? parseTextLockfileShape(content);
}

function diffArrays(before = [], after = []) {
  return {
    added: after.filter(value => !before.includes(value)),
    removed: before.filter(value => !after.includes(value)),
  };
}

function semanticManifestSummary(kind, beforeContent, afterContent) {
  const parser = kind === 'ci-workflow'
    ? parseWorkflowShape
    : kind === 'launchd'
      ? parseLaunchdShape
      : kind === 'lockfile'
        ? parseLockfileShape
        : kind === 'python-config' || kind === 'rust'
          ? parseTomlShape
          : null;
  if (!parser) return null;
  const before = parser(beforeContent);
  const after = parser(afterContent);
  const changed = [];
  for (const key of uniqueSorted([...Object.keys(before), ...Object.keys(after)])) {
    const previous = before[key];
    const current = after[key];
    const same = Array.isArray(previous) || Array.isArray(current)
      ? JSON.stringify(previous ?? []) === JSON.stringify(current ?? [])
      : previous === current;
    if (!same) changed.push(key);
  }
  const listDiffs = {};
  for (const key of changed) {
    if (Array.isArray(before[key]) || Array.isArray(after[key])) listDiffs[key] = diffArrays(before[key] ?? [], after[key] ?? []);
  }
  return { changed, before, after, list_diffs: listDiffs };
}

function configDriftForManifest({ root, file, previousHead, currentHead, kind, risk = 'medium' }) {
  const beforeContent = previousHead ? git(root, ['show', `${previousHead}:${file}`]) : '';
  const afterContent = currentHead ? git(root, ['show', `${currentHead}:${file}`]) : readMaybe(join(root, file), 24_000);
  if (!afterContent || beforeContent === afterContent) return null;
  const action = beforeContent ? 'changed' : 'added';
  const semantic = semanticManifestSummary(kind, beforeContent, afterContent);
  return {
    manifest: file,
    ecosystem: kind,
    package_changes: [{
      manifest: file,
      ecosystem: kind,
      name: file,
      previous: beforeContent ? hash(beforeContent) : null,
      current: hash(afterContent),
      action,
      risk,
      ...(semantic ? { semantic } : {}),
    }],
    ...(semantic ? { semantic } : {}),
    added: action === 'added' ? 1 : 0,
    removed: 0,
    changed: action === 'changed' ? 1 : 0,
    risk,
    summary: `${file} ${kind} drift: ${action}; risk ${risk}.`,
  };
}

function dependencyDrift(root, manifests, { previousHead = '', currentHead = '' } = {}) {
  if (!previousHead || !currentHead || previousHead === currentHead) return [];
  return manifests
    .map((manifest) => {
      const name = basename(manifest.path);
      if (name === 'package.json') return dependencyDriftForPackage({ root, file: manifest.path, previousHead, currentHead });
      if (name === 'requirements.txt') return dependencyDriftForSimpleManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'python', parser: parseRequirements });
      if (name === 'go.mod') return dependencyDriftForSimpleManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'go', parser: parseGoMod });
      if (['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(name)) {
        return configDriftForManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'lockfile', risk: 'medium' });
      }
      if (name === 'pyproject.toml') return configDriftForManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'python-config', risk: 'medium' });
      if (name === 'Cargo.toml') return configDriftForManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'rust', risk: 'medium' });
      if (/^\.github\/workflows\/.+\.ya?ml$/.test(manifest.path)) return configDriftForManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'ci-workflow', risk: 'high' });
      if (/^launchd\/.+\.plist$/.test(manifest.path)) return configDriftForManifest({ root, file: manifest.path, previousHead, currentHead, kind: 'launchd', risk: 'high' });
      return null;
    })
    .filter(Boolean);
}

function firstReadme(root, files) {
  const file = files.find(item => /^readme(\.(md|markdown|txt|rst))?$/i.test(basename(item)));
  if (!file) return null;
  return { path: file, content: readMaybe(join(root, file), 32_000) };
}

function fileExtension(path) {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function filePriority(path) {
  const name = basename(path).toLowerCase();
  const ext = fileExtension(path);
  if (/^readme(\.|$)/i.test(name)) return 100;
  if (MANIFEST_NAMES.has(name)) return 90;
  if (path.startsWith('docs/') && DOC_EXTENSIONS.has(ext)) return 75;
  if (path.startsWith('routes/') && SOURCE_EXTENSIONS.has(ext)) return 70;
  if (path.startsWith('cycle/') && SOURCE_EXTENSIONS.has(ext)) return 68;
  if (SOURCE_EXTENSIONS.has(ext)) return 60;
  if (DOC_EXTENSIONS.has(ext)) return 50;
  return 0;
}

function selectSourceFiles(root, files, { maxSourceFiles = 12, maxFileBytes = 80_000 } = {}) {
  return files
    .map(path => {
      let size = 0;
      try { size = statSync(join(root, path)).size; } catch { return null; }
      return { path, size, priority: filePriority(path) };
    })
    .filter(Boolean)
    .filter(file => file.priority > 0 && file.size > 0 && file.size <= maxFileBytes)
    .sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, Number(maxSourceFiles) || 0));
}

function extractJsSymbols(content, path) {
  if (!SOURCE_EXTENSIONS.has(fileExtension(path))) return [];
  const symbols = [];
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+let\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+var\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) symbols.push(match[1]);
  }
  const named = content.match(/\bexport\s*\{([^}]+)\}/m);
  if (named) {
    for (const part of named[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) symbols.push(name);
    }
  }
  return [...new Set(symbols)].slice(0, 100).map(name => ({ name, path, kind: 'export' }));
}

function changedFilesBetween(root, previousHead, currentHead) {
  if (!previousHead || !currentHead || previousHead === currentHead) return [];
  return gitLines(root, ['diff', '--name-only', `${previousHead}..${currentHead}`])
    .filter(path => path && !path.includes('\0'))
    .slice(0, 500);
}

function diffSnippetForFile(root, previousHead, currentHead, file, { maxChars = 8_000 } = {}) {
  if (!previousHead || !currentHead || !file) return '';
  return git(root, ['diff', '--unified=3', `${previousHead}..${currentHead}`, '--', file]).slice(0, maxChars);
}

function uniqueTextUnitIds(textUnitIds = []) {
  return [...new Set(textUnitIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))];
}

function linkTextUnitsToEntity(db, entityId, textUnitIds = [], { relation = 'source-evidence', confidence = 0.9 } = {}) {
  const ids = uniqueTextUnitIds(textUnitIds);
  if (!entityId || !ids.length) return 0;
  const normalizedConfidence = Math.max(0, Math.min(1, Number(confidence) || 0.9));
  const stmt = db.prepare(`
    INSERT INTO entity_text_units (entity_id, text_unit_id, relation, confidence, updated_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(entity_id, text_unit_id, relation) DO UPDATE SET
      confidence=MAX(entity_text_units.confidence, excluded.confidence),
      updated_at=unixepoch()
  `);
  let count = 0;
  for (const textUnitId of ids) {
    count += stmt.run(entityId, textUnitId, relation, normalizedConfidence).changes;
  }
  return count;
}

function classifyChangedFile(path) {
  const ext = fileExtension(path);
  const lower = path.toLowerCase();
  if (MANIFEST_NAMES.has(basename(path))) {
    return {
      category: 'manifest',
      risk: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(basename(path)) ? 'medium' : 'low',
      summary: `${path} changed; dependency, script, or project configuration drift may affect agent build/test behavior.`,
    };
  }
  if (lower.includes('/security') || lower.includes('auth') || lower.includes('token') || lower.includes('secret')) {
    return { category: 'security', risk: 'high', summary: `${path} changed in a security-sensitive area.` };
  }
  if (path.startsWith('routes/') || lower.includes('/routes/')) {
    return { category: 'api', risk: 'medium', summary: `${path} changed API route behavior or request handling.` };
  }
  if (path.startsWith('cycle/') || basename(path) === 'brain-cycle.mjs') {
    return { category: 'cycle', risk: 'medium', summary: `${path} changed the autonomous Brain cycle.` };
  }
  if (path.startsWith('db') || lower.includes('migration') || lower.includes('schema')) {
    return { category: 'persistence', risk: 'high', summary: `${path} changed persistence or schema-adjacent code.` };
  }
  if (path.startsWith('test/') || /\.test\.[cm]?[jt]sx?$/.test(path)) {
    return { category: 'test', risk: 'low', summary: `${path} changed verification coverage.` };
  }
  if (DOC_EXTENSIONS.has(ext) || path.startsWith('docs/') || path.startsWith('plans/')) {
    return { category: 'docs', risk: 'low', summary: `${path} changed documentation or planning context.` };
  }
  if (SOURCE_EXTENSIONS.has(ext)) {
    return { category: 'source', risk: 'medium', summary: `${path} changed executable source code.` };
  }
  return { category: 'other', risk: 'low', summary: `${path} changed.` };
}

function highestRisk(details) {
  const order = { high: 3, medium: 2, low: 1 };
  return details.reduce((risk, detail) => order[detail.risk] > order[risk] ? detail.risk : risk, 'low');
}

function summarizeChangedFiles(changedFiles) {
  const details = changedFiles.map(path => ({ path, ...classifyChangedFile(path) }));
  const manifestSet = new Set(changedFiles.filter(path => MANIFEST_NAMES.has(basename(path))));
  return {
    count: changedFiles.length,
    files: changedFiles,
    manifests: [...manifestSet],
    docs: changedFiles.filter(path => DOC_EXTENSIONS.has(fileExtension(path))),
    source: changedFiles.filter(path => SOURCE_EXTENSIONS.has(fileExtension(path))),
    risk: highestRisk(details),
    details,
    summary: details.length
      ? `${details.length} changed file(s); highest risk ${highestRisk(details)}; categories ${[...new Set(details.map(detail => detail.category))].join(', ')}.`
      : '',
  };
}

export function scanRepo(path, { maxFiles = 300 } = {}) {
  if (!path) throw Object.assign(new Error('path required'), { status: 400 });
  const inputPath = resolve(path);
  if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) {
    throw Object.assign(new Error('path must be an existing directory'), { status: 400 });
  }
  const top = git(inputPath, ['rev-parse', '--show-toplevel']) || inputPath;
  const root = resolve(top);
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']);
  const dirty = Boolean(git(root, ['status', '--short']));
  const files = walk(root, { maxFiles });
  const manifests = detectManifests(root, files);
  const readme = firstReadme(root, files);
  const idBasis = remote || root;
  const repoId = `repo:${hash(idBasis)}`;
  return {
    repoId,
    name: basename(root),
    path: root,
    remote,
    head,
    branch,
    dirty,
    fileCountSampled: files.length,
    manifests,
    readme,
  };
}

export function digestRepo(db, {
  path,
  project = '',
  source = 'repo-digestion',
  maxFiles = 300,
  maxSourceFiles = 12,
  maxFileBytes = 80_000,
  previousHead = '',
  processConfig = {},
} = {}, { upsertFact, upsertTextUnitsFromSource } = {}) {
  const scan = scanRepo(path, { maxFiles });
  const files = walk(scan.path, { maxFiles });
  const selectedFiles = selectSourceFiles(scan.path, files, { maxSourceFiles, maxFileBytes });
  const symbols = [];
  let entityLinkCount = 0;
  const changedFiles = changedFilesBetween(scan.path, previousHead, scan.head);
  const changedSummary = summarizeChangedFiles(changedFiles);
  const dependencyDriftSummary = dependencyDrift(scan.path, scan.manifests, { previousHead, currentHead: scan.head });
  const diffSnippets = changedSummary.details.slice(0, Number(process.env.BRAIN_REPO_DIFF_SNIPPET_FILES ?? 20)).map(detail => ({
    ...detail,
    snippet: diffSnippetForFile(scan.path, previousHead, scan.head, detail.path, {
      maxChars: Number(process.env.BRAIN_REPO_DIFF_SNIPPET_CHARS ?? 8_000),
    }),
  })).filter(detail => detail.snippet);
  const tags = ['repo', 'digested', ...(project ? [`project:${project}`] : [])];
  db.prepare(`INSERT INTO entities (id,type,name,description,source,data,tags,status,updated_at)
    VALUES (?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      description=excluded.description,
      source=excluded.source,
      data=excluded.data,
      tags=excluded.tags,
      status=excluded.status,
      updated_at=unixepoch()`)
    .run(
      scan.repoId,
      'repo',
      scan.name,
      scan.remote || scan.path,
      source,
      JSON.stringify({
        path: scan.path,
        remote: scan.remote,
        head: scan.head,
        previous_head: previousHead,
        branch: scan.branch,
        dirty: scan.dirty,
        file_count_sampled: scan.fileCountSampled,
        manifests: scan.manifests,
        selected_files: selectedFiles,
        changed_files: changedSummary,
        dependency_drift: dependencyDriftSummary,
        diff_snippets: diffSnippets.map(({ snippet, ...detail }) => ({ ...detail, chars: snippet.length })),
        project,
      }),
      JSON.stringify(tags),
      'active',
    );

  const facts = [
    ['path', scan.path],
    ['remote', scan.remote],
    ['head', scan.head],
    ['branch', scan.branch],
    ['dirty', scan.dirty],
    ['manifest_paths', scan.manifests.map(m => m.path)],
    ['selected_file_paths', selectedFiles.map(file => file.path)],
    ...(changedFiles.length ? [
      ['changed_files', changedSummary.files],
      ['changed_manifests', changedSummary.manifests],
      ['changed_file_summaries', changedSummary.details],
      ['changed_risk', changedSummary.risk],
      ...(dependencyDriftSummary.length ? [['dependency_drift', dependencyDriftSummary]] : []),
      ['changed_diff_snippets', diffSnippets.map(({ snippet, ...detail }) => ({ ...detail, snippet }))],
    ] : []),
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  for (const [field, value] of facts) {
    upsertFact?.({ entity_id: scan.repoId, field, value, source, confidence: 0.9, context: { project } });
  }

  const sections = [];
  sections.push(`# ${scan.name}`);
  if (scan.remote) sections.push(`Remote: ${scan.remote}`);
  if (scan.head) sections.push(`HEAD: ${scan.head}`);
  if (scan.branch) sections.push(`Branch: ${scan.branch}`);
  sections.push(`Dirty: ${scan.dirty ? 'yes' : 'no'}`);
  if (scan.manifests.length) {
    sections.push(`Manifests:\n${scan.manifests.map(m => `- ${m.path}`).join('\n')}`);
  }
  if (scan.readme?.content) {
    sections.push(`README (${relative(scan.path, join(scan.path, scan.readme.path))}):\n${scan.readme.content}`);
  }

  const text = upsertTextUnitsFromSource?.({
    sourceKind: 'repo',
    sourceId: scan.repoId,
    title: `${scan.name} repository digest`,
    content: sections.join('\n\n'),
    metadata: {
      repo_id: scan.repoId,
      path: scan.path,
      remote: scan.remote,
      head: scan.head,
      previous_head: previousHead,
      branch: scan.branch,
      dirty: scan.dirty,
      project,
      changed_files: changedSummary,
      dependency_drift: dependencyDriftSummary,
      diff_snippets: diffSnippets.map(({ snippet, ...detail }) => ({ ...detail, chars: snippet.length })),
    },
    processConfig: { ...processConfig, allow_small: true },
  });
  entityLinkCount += linkTextUnitsToEntity(db, scan.repoId, text?.textUnitIds ?? []);

  const fileTextUnitIds = [];
  for (const file of selectedFiles) {
    const content = readMaybe(join(scan.path, file.path), Number(process.env.BRAIN_REPO_FILE_MAX_CHARS ?? 40_000));
    if (!content.trim()) continue;
    const fileSymbols = extractJsSymbols(content, file.path);
    symbols.push(...fileSymbols);
    const unit = upsertTextUnitsFromSource?.({
      sourceKind: 'repo-file',
      sourceId: `${scan.repoId}:${file.path}`,
      title: `${scan.name}:${file.path}`,
      content,
      metadata: {
        repo_id: scan.repoId,
        repo_path: scan.path,
        file_path: file.path,
        size: file.size,
        priority: file.priority,
        head: scan.head,
        previous_head: previousHead,
        project,
        symbols: fileSymbols,
        changed: changedFiles.includes(file.path),
      },
      processConfig: { ...processConfig, allow_small: true },
    });
    fileTextUnitIds.push(...(unit?.textUnitIds ?? []));
    entityLinkCount += linkTextUnitsToEntity(db, scan.repoId, unit?.textUnitIds ?? []);
  }

  const diffTextUnitIds = [];
  for (const detail of diffSnippets) {
    const unit = upsertTextUnitsFromSource?.({
      sourceKind: 'repo-diff',
      sourceId: `${scan.repoId}:${previousHead || 'unknown'}..${scan.head}:${detail.path}`,
      title: `${scan.name}:${detail.path} diff`,
      content: [
        `Changed file: ${detail.path}`,
        `Category: ${detail.category}`,
        `Risk: ${detail.risk}`,
        detail.summary,
        '',
        detail.snippet,
      ].filter(Boolean).join('\n'),
      metadata: {
        repo_id: scan.repoId,
        repo_path: scan.path,
        file_path: detail.path,
        previous_head: previousHead,
        head: scan.head,
        category: detail.category,
        risk: detail.risk,
        project,
      },
      processConfig: { ...processConfig, allow_small: true },
    });
    diffTextUnitIds.push(...(unit?.textUnitIds ?? []));
    entityLinkCount += linkTextUnitsToEntity(db, scan.repoId, unit?.textUnitIds ?? []);
  }

  const uniqueSymbols = [...new Map(symbols.map(symbol => [`${symbol.path}:${symbol.name}`, symbol])).values()];
  if (uniqueSymbols.length) {
    upsertFact?.({
      entity_id: scan.repoId,
      field: 'exported_symbols',
      value: uniqueSymbols,
      source,
      confidence: 0.75,
      context: { project, selected_file_count: selectedFiles.length },
    });
  }

  const event = db.prepare(`INSERT INTO timeline (source,type,subject,data,tags) VALUES (?,?,?,?,?)`)
    .run(
      source,
      'repo:digested',
      scan.repoId,
      JSON.stringify({
        project,
        path: scan.path,
        remote: scan.remote,
        previous_head: previousHead,
        head: scan.head,
        dirty: scan.dirty,
        manifests: scan.manifests.map(m => m.path),
        changed_files: changedSummary,
        dependency_drift: dependencyDriftSummary,
        diff_snippets: diffSnippets.map(({ snippet, ...detail }) => ({ ...detail, chars: snippet.length })),
        text_unit_ids: text?.textUnitIds ?? [],
        file_text_unit_ids: fileTextUnitIds,
        diff_text_unit_ids: diffTextUnitIds,
        entity_link_count: entityLinkCount,
        symbols: uniqueSymbols,
      }),
      JSON.stringify(['brain', 'repo', 'digestion']),
    );

  return {
    ok: true,
    repo: {
      id: scan.repoId,
      name: scan.name,
      path: scan.path,
      remote: scan.remote,
      head: scan.head,
      branch: scan.branch,
      dirty: scan.dirty,
      fileCountSampled: scan.fileCountSampled,
      manifests: scan.manifests,
      previousHead,
      changedFiles: changedSummary.files,
      changedManifests: changedSummary.manifests,
      changedFileSummaries: changedSummary.details,
      changedRisk: changedSummary.risk,
      changedSummary: changedSummary.summary,
      dependencyDrift: dependencyDriftSummary,
      diffSnippets: diffSnippets.map(({ snippet, ...detail }) => ({ ...detail, chars: snippet.length })),
    },
    textUnitIds: text?.textUnitIds ?? [],
    fileTextUnitIds,
    diffTextUnitIds,
    entityLinkCount,
    symbols: uniqueSymbols,
    timelineEventId: Number(event.lastInsertRowid),
  };
}
