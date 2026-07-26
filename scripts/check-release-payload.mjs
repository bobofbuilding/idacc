#!/usr/bin/env node
/**
 * Release payload guard: IDACC may ship framework code and helper resources, but
 * never a developer's local Brain database, Learn blobs, or app/user session data.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectConsumerPayload,
  inspectConsumerTextEntry,
  portableArchiveEntry,
} from './lib/consumer-payload-policy.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputs = process.argv.slice(2).map((p) => resolve(p));

if (!inputs.length) {
  console.error('usage: scripts/check-release-payload.mjs <path> [path...]');
  process.exit(2);
}

const forbidden = [
  {
    label: 'Brain database',
    re: /(?:^|\/)brain\.db(?:[-.\w]*)?$/i,
  },
  {
    label: 'Brain workspace state',
    re: /(?:^|\/)(?:id-agents\/)?workspace\/projects\/brain\/(?:(?:brain\.db(?:[-.\w]*)?)|(?:data|exports|snapshots|approvals|facts|text-units|logs|output|uploads|control-center|plans)(?:\/|$)|\.[\w.-]*cursor\.json$|[^/]+\.bak-[^/]+$)/i,
  },
  {
    label: 'Profile-owned living plans',
    re: /(?:^|\/)(?:idacc-runtime\/)?brain\/plans(?:\/|$)|(?:^|\/)brain-plans(?:\/|$)/i,
  },
  {
    label: 'Learn blob snapshots',
    re: /(?:^|\/)learn\/blobs(?:\/|$)/i,
  },
  {
    label: 'Learn material records',
    re: /(?:^|\/)learn\/(?:materials|queue)(?:\/|$)|(?:^|\/)materials\/mat_[^/]+/i,
  },
  {
    label: 'IDCTL local config/session state',
    re: /(?:^|\/)(?:\.config\/idctl|config\/idctl|idctl\/(?:questions|goals|plans|dreams|work|learn|chats))(?:\/|$)/i,
  },
  {
    label: 'Electron userData state',
    re: /(?:^|\/)Application Support\/ID Agents Control Center(?:\/|$)/i,
  },
  {
    label: 'Question/goal session JSON',
    re: /(?:^|\/)(?:questions\/q_[^/]+|goals\/goal_[^/]+|plans\/plan_[^/]+|dreams\/dream_[^/]+)\.json$/i,
  },
];

function rel(path) {
  const r = path.startsWith(root) ? path.slice(root.length + 1) : path;
  return r.split(sep).join('/');
}

function checkPath(path, hits) {
  const normalized = rel(path);
  for (const rule of forbidden) {
    if (rule.re.test(normalized)) hits.push(`${rule.label}: ${normalized}`);
  }
}

function walk(path, hits) {
  if (!existsSync(path)) return;
  checkPath(path, hits);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  for (const name of readdirSync(path)) walk(join(path, name), hits);
}

function asarApi() {
  const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
  for (const name of ['@electron/asar', 'asar']) {
    try {
      return requireFromDesktop(name);
    } catch {
      // Try the maintained package first and retain compatibility with older installs.
    }
  }
  return null;
}

function resourceRoot(appPath) {
  if (basename(appPath).endsWith('.app')) return join(appPath, 'Contents', 'Resources');
  const unpackedResources = join(appPath, 'resources');
  if (existsSync(unpackedResources)) return unpackedResources;
  return '';
}

function checkAsar(resources, hits) {
  const asar = join(resources, 'app.asar');
  if (!existsSync(asar) || !lstatSync(asar).isFile()) {
    hits.push(`Missing packaged application archive: ${rel(asar)}`);
    return null;
  }
  const api = asarApi();
  if (!api) {
    hits.push(`Could not inspect app.asar because the asar tool is unavailable: ${rel(asar)}`);
    return null;
  }
  let entries;
  try {
    entries = api.listPackage(asar);
  } catch (error) {
    hits.push(`Could not read packaged application archive ${rel(asar)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  let buildMode = null;
  for (const listedPath of entries) {
    const nativeEntry = String(listedPath).replace(/^[\\/]+/, '');
    const entry = portableArchiveEntry(listedPath);
    if (!entry || !nativeEntry) continue;
    checkPath(join(asar, ...entry.split('/')), hits);
    if (
      !/^(?:out\/(?:main|preload|renderer)(?:\/|$)|out\/build-mode\.json$|package\.json$)/i
        .test(entry)
    ) continue;
    try {
      const stat = api.statFile(asar, nativeEntry, false);
      if (stat && typeof stat === 'object' && 'files' in stat) continue;
      const content = api.extractFile(asar, nativeEntry);
      if (entry.toLowerCase() === 'out/build-mode.json') {
        try {
          buildMode = JSON.parse(content.toString('utf8'));
        } catch {
          hits.push(`Packaged build provenance is invalid JSON: ${rel(asar)}/out/build-mode.json`);
        }
      }
      for (const error of inspectConsumerTextEntry(`app.asar/${entry}`, content)) {
        hits.push(`Application bundle policy: ${error}`);
      }
    } catch (error) {
      hits.push(`Could not inspect first-party application entry ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return buildMode;
}

function checkWindowsContainmentPayload(appPath, resources, hits, buildMode) {
  if (!existsSync(join(appPath, 'ID Agents Control Center.exe'))) return;
  const jobHost = join(
    resources,
    'app.asar.unpacked',
    'out',
    'native',
    'idacc-job-host.exe',
  );
  const bootstrap = join(
    resources,
    'app.asar.unpacked',
    'out',
    'main',
    'managed-service-bootstrap.cjs',
  );
  for (const [label, path, minimum, maximum] of [
    ['Windows Job Host', jobHost, 4_096, 8 * 1024 * 1024],
    ['managed-service bootstrap', bootstrap, 256, 256 * 1024],
  ]) {
    if (!existsSync(path)) {
      hits.push(`Missing required ${label} payload: ${rel(path)}`);
      continue;
    }
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size < minimum
      || stat.size > maximum
    ) {
      hits.push(`Invalid required ${label} payload: ${rel(path)}`);
    }
  }
  if (existsSync(jobHost) && lstatSync(jobHost).isFile()) {
    const magic = readFileSync(jobHost).subarray(0, 2);
    if (magic.length !== 2 || magic[0] !== 0x4d || magic[1] !== 0x5a) {
      hits.push(`Invalid Windows Job Host executable header: ${rel(jobHost)}`);
    }
  }
  const provenance = buildMode?.windowsJobHost;
  if (
    !provenance
    || provenance.buildPlatform !== 'win32'
    || provenance.available !== true
  ) {
    hits.push('Packaged Windows build provenance does not enable its Job Host');
    return;
  }
  const bootstrapSha256 = String(provenance.bootstrapSha256 || '');
  if (!/^[0-9a-f]{64}$/.test(bootstrapSha256)) {
    hits.push('Packaged Windows build provenance is missing the bootstrap SHA-256');
  } else if (existsSync(bootstrap) && lstatSync(bootstrap).isFile()) {
    const actual = createHash('sha256').update(readFileSync(bootstrap)).digest('hex');
    if (actual !== bootstrapSha256) {
      hits.push('Packaged managed-service bootstrap does not match build provenance');
    }
  }
  if (provenance.verificationMode === 'sha256') {
    const executableSha256 = String(provenance.executableSha256 || '');
    if (!/^[0-9a-f]{64}$/.test(executableSha256)) {
      hits.push('Packaged Windows build provenance is missing the Job Host SHA-256');
    } else if (existsSync(jobHost) && lstatSync(jobHost).isFile()) {
      const actual = createHash('sha256').update(readFileSync(jobHost)).digest('hex');
      if (actual !== executableSha256) {
        hits.push('Packaged Windows Job Host does not match unsigned build provenance');
      }
    }
  } else if (
    provenance.verificationMode !== 'authenticode-publisher'
    || typeof provenance.expectedPublisher !== 'string'
    || !provenance.expectedPublisher.trim()
  ) {
    hits.push('Packaged Windows Job Host verification policy is invalid');
  }
}

const hits = [];
for (const input of inputs) {
  if (!existsSync(input)) {
    hits.push(`Release payload input does not exist: ${rel(input)}`);
    continue;
  }
  const inputStat = lstatSync(input);
  if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) {
    hits.push(`Release payload input must be a real directory: ${rel(input)}`);
    continue;
  }
  walk(input, hits);
  const resources = resourceRoot(input);
  if (resources) {
    if (!existsSync(resources) || !lstatSync(resources).isDirectory()) {
      hits.push(`Missing packaged application resources directory: ${rel(resources)}`);
    }
    const buildMode = checkAsar(resources, hits);
    checkWindowsContainmentPayload(input, resources, hits, buildMode);
    const manifestRelative = join('idacc-runtime', 'manifest.json');
    for (const required of ['IDACC-LICENSE.txt', 'THIRD_PARTY_NOTICES.md', manifestRelative]) {
      if (!existsSync(join(resources, required))) hits.push(`Missing required application payload: ${rel(join(resources, required))}`);
    }
    const noticesPath = join(resources, 'THIRD_PARTY_NOTICES.md');
    if (existsSync(noticesPath)) {
      const notices = readFileSync(noticesPath, 'utf8');
      if (
        !notices.startsWith('# Third-Party Notices\n')
        || !notices.includes('## Included license and notice texts')
        || !/----- BEGIN [^-]+ -----/.test(notices)
      ) {
        hits.push(`Third-party notices are incomplete or malformed: ${rel(noticesPath)}`);
      }
    }
    const manifestPath = join(resources, manifestRelative);
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.schemaVersion !== 2) hits.push(`Invalid unified runtime manifest schema: ${manifest.schemaVersion ?? '(missing)'}`);
        if (manifest.application?.dirty !== false) hits.push('Unified runtime manifest was generated from a dirty IDACC checkout');
        if (!/^[0-9a-f]{64}$/.test(manifest.trees?.runtime || '')) hits.push('Unified runtime manifest is missing its runtime tree SHA-256');
        if (!Array.isArray(manifest.files) || !manifest.files.length) hits.push('Unified runtime manifest has no per-file inventory');
        for (const name of ['manager', 'brain']) {
          const component = manifest.components?.[name];
          if (!component || !/^[0-9a-f]{40}$/.test(component.commit || '')) {
            hits.push(`Unified runtime manifest is missing ${name} commit provenance`);
            continue;
          }
          if (!/^[0-9a-f]{64}$/.test(component.packageLockSha256 || '')) {
            hits.push(`Unified runtime manifest is missing ${name} package-lock SHA-256`);
          }
          const entrypoint = String(component.entrypoint || '');
          if (!entrypoint || entrypoint.startsWith('/') || entrypoint.split(/[\\/]+/).includes('..')) {
            hits.push(`Unified runtime manifest has an unsafe ${name} entrypoint`);
          } else {
            const required = join('idacc-runtime', name, entrypoint);
            if (!existsSync(join(resources, required))) hits.push(`Missing required application payload: ${rel(join(resources, required))}`);
          }
        }
      } catch (error) {
        hits.push(`Unified runtime manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const consumerRuntime = resources
    ? join(resources, 'idacc-runtime')
    : (
      existsSync(join(input, 'manager')) && existsSync(join(input, 'brain'))
        ? input
        : existsSync(join(input, 'idacc-runtime'))
          ? join(input, 'idacc-runtime')
          : ''
    );
  if (!resources && !consumerRuntime) {
    hits.push(`Unrecognized release payload shape (expected an unpacked app or manager/brain runtime): ${rel(input)}`);
  }
  if (consumerRuntime && existsSync(consumerRuntime)) {
    for (const error of inspectConsumerPayload(consumerRuntime)) {
      hits.push(`Consumer-neutral runtime policy: ${error}`);
    }
  }
}

if (hits.length) {
  console.error('Release payload check failed: local state, organization policy, personal paths, and secret material must not ship in IDACC.');
  for (const hit of hits.slice(0, 80)) console.error(`- ${hit}`);
  if (hits.length > 80) console.error(`- ... ${hits.length - 80} more`);
  process.exit(1);
}

console.log(`Release payload check passed: ${inputs.map(rel).join(', ')}`);
