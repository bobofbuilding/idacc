import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

export const BRAIN_RUNTIME_ROOTS = [
  'brain.mjs',
  'brain-cycle.mjs',
  'brain-listener.mjs',
  'brain-mcp.mjs',
  'brain-connector-runner.mjs',
  'brain-connector-validate.mjs',
  'brain-eval.mjs',
  'context/service.mjs',
  'cycle/approvals.mjs',
  'dashboard/dashboards.mjs',
  'listener/contract.mjs',
  'mcp/server.mjs',
  'operator-tools/refresh-source-embeddings.mjs',
  'routes/core.mjs',
];

export const BRAIN_STATIC_ASSETS = [
  'brain-connector.schema.json',
  'prompts/community-report.json',
  'prompts/edge-description.json',
  'prompts/fact-take-synthesis.json',
  'prompts/follow-up-questions.json',
  'prompts/safety-report.json',
];

function fail(message) {
  throw new Error(message);
}

function portableRelative(rootPath, path) {
  return relative(rootPath, path).split(sep).join('/');
}

function localModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^"'()]*?\s+from\s+)?["'](\.[^"']+)["']/g,
    /\bexport\s+[^"']*?\s+from\s+["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

function resolveLocalModule(importer, specifier, sourceRoot) {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = [
    unresolved,
    `${unresolved}.js`,
    `${unresolved}.mjs`,
    `${unresolved}.cjs`,
    `${unresolved}.json`,
    join(unresolved, 'index.js'),
    join(unresolved, 'index.mjs'),
  ];
  const resolvedSourceRoot = resolve(sourceRoot);
  const sourcePrefix = `${resolvedSourceRoot}${sep}`;
  for (const candidate of candidates) {
    const resolvedCandidate = resolve(candidate);
    if (
      resolvedCandidate !== resolvedSourceRoot
      && !resolvedCandidate.startsWith(sourcePrefix)
    ) {
      fail(
        `runtime module import escapes its source root: ${
          portableRelative(sourceRoot, importer)
        } -> ${specifier}`,
      );
    }
    if (
      existsSync(resolvedCandidate)
      && lstatSync(resolvedCandidate).isFile()
    ) {
      return resolvedCandidate;
    }
  }
  return '';
}

export function runtimeModuleGraphPaths(sourceRoot, roots) {
  const queue = [];
  for (const rootModule of roots) {
    const path = join(sourceRoot, rootModule);
    if (existsSync(path)) queue.push(path);
  }
  const selected = new Set();
  while (queue.length) {
    const source = queue.shift();
    const relativePath = portableRelative(sourceRoot, source);
    if (selected.has(relativePath)) continue;
    selected.add(relativePath);
    if (!/\.(?:c?m?js)$/i.test(source)) continue;
    const contents = readFileSync(source, 'utf8');
    for (const specifier of localModuleSpecifiers(contents)) {
      const dependency = resolveLocalModule(source, specifier, sourceRoot);
      if (dependency) queue.push(dependency);
    }
  }
  return [...selected].sort();
}

export function copyRuntimeModuleGraph(sourceRoot, destinationRoot, roots) {
  const paths = runtimeModuleGraphPaths(sourceRoot, roots);
  for (const relativePath of paths) {
    const source = join(sourceRoot, relativePath);
    const destination = join(destinationRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return paths;
}
