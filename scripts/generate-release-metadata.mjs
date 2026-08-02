#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJson,
  sha256,
  sha256File,
  validateRuntimeLock,
  verifyRuntimeManifest,
} from './lib/runtime-provenance.mjs';
import {
  desktopPackagedExclusionRoots,
  installedProductionPackageEntries,
} from './lib/release-dependency-inventory.mjs';
import { verifyRuntimeSourceCapsule } from './lib/runtime-source-capsule.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const BRAIN_RUNTIME_CAPSULE_NAME = 'brain-runtime-capsule.json';

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : fallback;
}

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const runtimeRoot = resolve(option('--runtime-root', join(root, 'idctl-desktop', 'resources', 'idacc-runtime')));
const lockPath = resolve(option('--lock', join(root, 'release', 'runtime-lock.json')));
const output = resolve(option('--output', join(root, 'idctl-desktop', 'release', 'metadata')));
const noticesOnlyPath = option('--notices-only')
  ? resolve(option('--notices-only'))
  : '';
const artifactPaths = options('--artifact').map((path) => resolve(path));

if (!artifactPaths.length && !noticesOnlyPath) {
  console.error('release metadata generation failed: at least one --artifact is required');
  process.exit(1);
}

for (const [label, path] of [
  ['runtime root', runtimeRoot],
  ['runtime manifest', join(runtimeRoot, 'manifest.json')],
  ['runtime lock', lockPath],
  ['desktop package lock', join(root, 'idctl-desktop', 'package-lock.json')],
]) {
  if (!existsSync(path)) {
    console.error(`release metadata generation failed: ${label} not found at ${path}`);
    process.exit(1);
  }
}

for (const path of artifactPaths) {
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    console.error(`release metadata generation failed: artifact must be a file: ${path}`);
    process.exit(1);
  }
}

const artifactNames = artifactPaths.map((path) => basename(path));
if (new Set(artifactNames).size !== artifactNames.length) {
  console.error('release metadata generation failed: artifact basenames must be unique');
  process.exit(1);
}

const lock = readJson(lockPath, 'runtime lock');
const lockErrors = validateRuntimeLock(lock);
const runtimeManifestPath = join(runtimeRoot, 'manifest.json');
const runtimeManifest = readJson(runtimeManifestPath, 'runtime manifest');
const runtimeErrors = verifyRuntimeManifest(runtimeRoot, runtimeManifest, lock);
if (lockErrors.length || runtimeErrors.length) {
  console.error('release metadata generation failed: runtime provenance is invalid');
  for (const error of [...lockErrors, ...runtimeErrors]) console.error(`- ${error}`);
  process.exit(1);
}
let brainRuntimeCapsule = null;
if (lock.components.brain.distributionSource?.mode === 'vendored-capsule') {
  const distributionSource = lock.components.brain.distributionSource;
  const capsuleRoot = resolve(root, distributionSource.path);
  const capsuleManifestPath = resolve(root, distributionSource.manifest);
  const verification = verifyRuntimeSourceCapsule({
    root: capsuleRoot,
    manifestPath: capsuleManifestPath,
    component: lock.components.brain,
    componentName: 'brain',
    containmentRoot: root,
  });
  if (verification.errors.length) {
    console.error('release metadata generation failed: Brain runtime capsule is invalid');
    for (const error of verification.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  brainRuntimeCapsule = {
    manifestPath: capsuleManifestPath,
    manifestSha256: verification.manifestSha256,
    treeSha256: verification.treeSha256,
  };
}
const desktopPackage = readJson(join(root, 'idctl-desktop', 'package.json'), 'desktop package');
const desktopPackageLock = readJson(join(root, 'idctl-desktop', 'package-lock.json'), 'desktop package lock');
const applicationErrors = [];
if (desktopPackageLock.name !== desktopPackage.name || desktopPackageLock.version !== desktopPackage.version) {
  applicationErrors.push('desktop package lock identity does not match the desktop package');
}
if (
  desktopPackageLock.packages?.['']?.name !== desktopPackage.name
  || desktopPackageLock.packages?.['']?.version !== desktopPackage.version
) {
  applicationErrors.push('desktop package lock root identity does not match the desktop package');
}
if (runtimeManifest.application?.name !== desktopPackage.name) {
  applicationErrors.push('runtime manifest application name does not match the desktop package');
}
if (runtimeManifest.application?.version !== desktopPackage.version) {
  applicationErrors.push('runtime manifest application version does not match the desktop package');
}
if (runtimeManifest.application?.dirty !== false) {
  applicationErrors.push('runtime manifest was staged from a dirty application checkout');
}
if (runtimeManifest.build?.platform !== process.platform) {
  applicationErrors.push(`runtime manifest platform ${runtimeManifest.build?.platform || '(missing)'} does not match ${process.platform}`);
}
if (applicationErrors.length) {
  console.error('release metadata generation failed: application provenance is invalid');
  for (const error of applicationErrors) console.error(`- ${error}`);
  process.exit(1);
}

function dependencyName(packagePath, record) {
  if (record.name) return record.name;
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) return '';
  const tail = packagePath.slice(index + marker.length);
  const parts = tail.split('/');
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] || ''}` : parts[0];
}

function purl(name, version) {
  const encoded = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function integrityHash(integrity) {
  const match = String(integrity || '').match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/);
  if (!match) return [];
  return [{
    alg: match[1].toUpperCase().replace('SHA', 'SHA-'),
    content: Buffer.from(match[2], 'base64').toString('hex'),
  }];
}

function licenseChoice(value) {
  const license = String(value || '').trim();
  if (!license) return [];
  if (/^[A-Za-z0-9-.+]+$/.test(license)) return [{ license: { id: license } }];
  if (/^[A-Za-z0-9-.+()\s]+$/.test(license) && /\b(?:AND|OR|WITH)\b/.test(license)) {
    return [{ expression: license }];
  }
  return [{ license: { name: license } }];
}

function packageLicenseTexts(installRoot, packagePath) {
  if (
    !packagePath
    || packagePath.startsWith('/')
    || packagePath.split(/[\\/]+/).includes('..')
  ) return [];
  const packageRoot = join(installRoot, packagePath);
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) return [];
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(packageRoot, entry.name);
      if (lstatSync(path).size > 512 * 1024) return [];
      const text = readFileSync(path, 'utf8').replace(/\0/g, '').trim();
      return text ? [{ name: entry.name, text }] : [];
    });
}

function packagesFromLock(path, source, installRoot, { excludedPackageRoots = [] } = {}) {
  const packageLock = readJson(path, `${source} package lock`);
  const rows = [];
  for (const { packagePath, record } of installedProductionPackageEntries(
    packageLock,
    installRoot,
    { excludedPackageRoots },
  )) {
    const name = dependencyName(packagePath, record);
    const version = String(record.version || '');
    if (!name || !version) continue;
    const packageUrl = purl(name, version);
    rows.push({
      component: {
        type: 'library',
        'bom-ref': packageUrl,
        name,
        version,
        purl: packageUrl,
        ...(record.integrity ? { hashes: integrityHash(record.integrity) } : {}),
        ...(record.license ? { licenses: licenseChoice(record.license) } : {}),
        properties: [{ name: 'idacc:component-source', value: source }],
      },
      licenseTexts: packageLicenseTexts(installRoot, packagePath),
    });
  }
  return rows;
}

const lockInputs = [
  {
    path: join(root, 'idctl-desktop', 'package-lock.json'),
    source: 'desktop',
    installRoot: join(root, 'idctl-desktop'),
    excludedPackageRoots: desktopPackagedExclusionRoots(
      desktopPackage,
      runtimeManifest.build?.platform,
    ),
  },
  {
    path: join(runtimeRoot, 'manager', 'package-lock.json'),
    source: 'manager',
    installRoot: join(runtimeRoot, 'manager'),
  },
  {
    path: join(runtimeRoot, 'brain', 'package-lock.json'),
    source: 'brain',
    installRoot: join(runtimeRoot, 'brain'),
  },
];
for (const { path, source } of lockInputs) {
  if (!existsSync(path)) {
    console.error(`release metadata generation failed: ${source} package lock not found at ${path}`);
    process.exit(1);
  }
}

const componentMap = new Map();
const licenseTextMap = new Map();
for (const {
  path,
  source,
  installRoot,
  excludedPackageRoots,
} of lockInputs) {
  for (const { component, licenseTexts } of packagesFromLock(
    path,
    source,
    installRoot,
    { excludedPackageRoots },
  )) {
    const existing = componentMap.get(component['bom-ref']);
    if (!existing) {
      componentMap.set(component['bom-ref'], component);
    } else {
      const sources = new Set([
        ...existing.properties.map((property) => property.value),
        ...component.properties.map((property) => property.value),
      ]);
      existing.properties = [...sources].sort().map((value) => ({ name: 'idacc:component-source', value }));
    }
    if (licenseTexts.length) {
      const texts = licenseTextMap.get(component['bom-ref']) || new Map();
      for (const record of licenseTexts) {
        texts.set(`${record.name}\0${sha256(record.text)}`, { ...record, source });
      }
      licenseTextMap.set(component['bom-ref'], texts);
    }
  }
}

function repositoryPurl(repository, commit) {
  try {
    const url = new URL(repository);
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return `pkg:github/${path}@${commit}`;
  } catch {
    return `idacc:git:${commit}`;
  }
}

const runtimeComponents = ['manager', 'brain'].map((name) => {
  const packageJson = readJson(join(runtimeRoot, name, 'package.json'), `${name} package`);
  const locked = lock.components[name];
  const packageUrl = repositoryPurl(locked.repository, locked.commit);
  const licensePath = join(runtimeRoot, name, 'LICENSE');
  if (existsSync(licensePath) && lstatSync(licensePath).isFile()) {
    const text = readFileSync(licensePath, 'utf8').replace(/\0/g, '').trim();
    if (text) {
      licenseTextMap.set(packageUrl, new Map([
        [`LICENSE\0${sha256(text)}`, { name: 'LICENSE', text, source: name }],
      ]));
    }
  }
  return {
    type: 'application',
    'bom-ref': packageUrl,
    name: packageJson.name,
    version: locked.version,
    purl: packageUrl,
    ...(packageJson.license ? { licenses: licenseChoice(packageJson.license) } : {}),
    properties: [
      { name: 'idacc:component-source', value: name },
      { name: 'idacc:repository', value: locked.repository },
      { name: 'idacc:commit', value: locked.commit },
      { name: 'idacc:git-tree', value: locked.tree },
      { name: 'idacc:package-lock-sha256', value: locked.packageLockSha256 },
      { name: 'idacc:service-id', value: locked.serviceId },
      ...(name === 'brain' && brainRuntimeCapsule ? [
        { name: 'idacc:distribution-mode', value: 'vendored-capsule' },
        {
          name: 'idacc:capsule-manifest-sha256',
          value: brainRuntimeCapsule.manifestSha256,
        },
        {
          name: 'idacc:capsule-tree-sha256',
          value: brainRuntimeCapsule.treeSha256,
        },
      ] : []),
    ],
  };
});

const electronVersion = String(runtimeManifest.build?.electron || '');
if (!/^\d+\.\d+\.\d+/.test(electronVersion)) {
  console.error('release metadata generation failed: runtime manifest has no valid Electron version');
  process.exit(1);
}
const electronPurl = purl('electron', electronVersion);
const electronPackage = readJson(join(root, 'idctl-desktop', 'node_modules', 'electron', 'package.json'), 'Electron package');
const electronLicenseTexts = packageLicenseTexts(join(root, 'idctl-desktop'), 'node_modules/electron');
if (electronLicenseTexts.length) {
  licenseTextMap.set(electronPurl, new Map(electronLicenseTexts.map((record) => [
    `${record.name}\0${sha256(record.text)}`,
    { ...record, source: 'desktop' },
  ])));
}
const electronComponent = {
  type: 'framework',
  'bom-ref': electronPurl,
  name: 'electron',
  version: electronVersion,
  purl: electronPurl,
  ...(electronPackage.license ? { licenses: licenseChoice(electronPackage.license) } : {}),
  properties: [{ name: 'idacc:component-source', value: 'desktop-runtime' }],
};
const finalComponents = new Map(componentMap);
for (const component of [...runtimeComponents, electronComponent]) {
  finalComponents.set(component['bom-ref'], component);
}
const components = [...finalComponents.values()]
  .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));

function deterministicUuid(hex) {
  const chars = hex.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${deterministicUuid(runtimeManifest.trees.runtime)}`,
  version: 1,
  metadata: {
    timestamp: runtimeManifest.generatedAt,
    tools: {
      components: [{
        type: 'application',
        name: 'idacc-release-metadata',
        version: '1',
      }],
    },
    component: {
      type: 'application',
      'bom-ref': `idacc:${desktopPackage.version}`,
      name: desktopPackage.productName || desktopPackage.name,
      version: desktopPackage.version,
      ...(desktopPackage.license ? { licenses: licenseChoice(desktopPackage.license) } : {}),
      properties: [
        { name: 'idacc:commit', value: runtimeManifest.application.commit },
        { name: 'idacc:runtime-tree-sha256', value: runtimeManifest.trees.runtime },
        { name: 'idacc:manager-commit', value: lock.components.manager.commit },
        { name: 'idacc:brain-commit', value: lock.components.brain.commit },
        ...(brainRuntimeCapsule ? [
          { name: 'idacc:brain-distribution-mode', value: 'vendored-capsule' },
          {
            name: 'idacc:brain-capsule-manifest-sha256',
            value: brainRuntimeCapsule.manifestSha256,
          },
          {
            name: 'idacc:brain-capsule-tree-sha256',
            value: brainRuntimeCapsule.treeSha256,
          },
        ] : []),
      ],
    },
  },
  components,
};

const noticeLines = [
  '# Third-Party Notices',
  '',
  `Generated for ${desktopPackage.productName || desktopPackage.name} ${desktopPackage.version}.`,
  'The authoritative dependency inventory is the accompanying CycloneDX SBOM.',
  '',
  '| Package | Version | License | Used by |',
  '| --- | --- | --- | --- |',
];
for (const component of components) {
  const license = component.licenses
    ?.map((entry) => entry.license?.id || entry.license?.name || entry.expression)
    .filter(Boolean)
    .join(', ') || 'Not declared';
  const sources = component.properties
    .filter((property) => property.name === 'idacc:component-source')
    .map((property) => property.value)
    .join(', ');
  noticeLines.push(`| ${component.name.replace(/\|/g, '\\|')} | ${component.version} | ${license.replace(/\|/g, '\\|')} | ${sources} |`);
}
noticeLines.push(
  '',
  '## Included license and notice texts',
  '',
  'The following texts were collected from the exact installed production packages used to build this release.',
  '',
);
for (const component of components) {
  const texts = [...(licenseTextMap.get(component['bom-ref'])?.values() || [])]
    .sort((a, b) => `${a.name}\0${a.source}`.localeCompare(`${b.name}\0${b.source}`));
  for (const record of texts) {
    noticeLines.push(
      `### ${component.name} ${component.version} — ${record.name}`,
      '',
      `Source group: ${record.source}`,
      '',
      `----- BEGIN ${record.name} -----`,
      record.text,
      `----- END ${record.name} -----`,
      '',
    );
  }
}

const noticesText = noticeLines.join('\n');
if (noticesOnlyPath) {
  mkdirSync(dirname(noticesOnlyPath), { recursive: true });
  writeFileSync(noticesOnlyPath, noticesText);
  console.log(`Third-party notices generated → ${noticesOnlyPath}`);
  process.exit(0);
}

mkdirSync(output, { recursive: true });
const sbomPath = join(output, 'SBOM.cdx.json');
const noticesPath = join(output, 'THIRD_PARTY_NOTICES.md');
const copiedLockPath = join(output, 'runtime-lock.json');
const copiedRuntimeManifestPath = join(output, 'runtime-manifest.json');
const copiedBrainRuntimeCapsulePath = brainRuntimeCapsule
  ? join(output, BRAIN_RUNTIME_CAPSULE_NAME)
  : '';
writeFileSync(sbomPath, JSON.stringify(sbom, null, 2) + '\n');
writeFileSync(noticesPath, noticesText);
// Git may materialize tracked JSON with platform-native line endings. Release
// metadata must be byte-identical across builders, so serialize the already
// validated structures instead of preserving checkout-specific bytes.
writeFileSync(copiedLockPath, JSON.stringify(lock, null, 2) + '\n');
writeFileSync(copiedRuntimeManifestPath, JSON.stringify(runtimeManifest, null, 2) + '\n');
if (brainRuntimeCapsule) {
  copyFileSync(brainRuntimeCapsule.manifestPath, copiedBrainRuntimeCapsulePath);
  const copiedCapsuleSha256 = sha256File(copiedBrainRuntimeCapsulePath);
  if (copiedCapsuleSha256 !== brainRuntimeCapsule.manifestSha256) {
    console.error(
      'release metadata generation failed: Brain runtime capsule manifest changed while it was copied',
    );
    process.exit(1);
  }
}

const artifacts = artifactPaths.map((path) => ({
  name: basename(path),
  size: lstatSync(path).size,
  sha256: sha256File(path),
}));
const releaseManifest = {
  schemaVersion: 1,
  generatedAt: runtimeManifest.generatedAt,
  application: runtimeManifest.application,
  build: runtimeManifest.build,
  components: runtimeManifest.components,
  trees: runtimeManifest.trees,
  metadata: {
    runtimeLock: { name: basename(copiedLockPath), sha256: sha256File(copiedLockPath) },
    runtimeManifest: { name: basename(copiedRuntimeManifestPath), sha256: sha256File(copiedRuntimeManifestPath) },
    sbom: { name: basename(sbomPath), sha256: sha256File(sbomPath) },
    thirdPartyNotices: { name: basename(noticesPath), sha256: sha256File(noticesPath) },
    ...(brainRuntimeCapsule ? {
      brainRuntimeCapsule: {
        name: basename(copiedBrainRuntimeCapsulePath),
        sha256: sha256File(copiedBrainRuntimeCapsulePath),
      },
    } : {}),
  },
  artifacts,
};
const releaseManifestPath = join(output, 'release-manifest.json');
writeFileSync(releaseManifestPath, JSON.stringify(releaseManifest, null, 2) + '\n');

const checksumInputs = [
  ...artifactPaths,
  copiedLockPath,
  copiedRuntimeManifestPath,
  sbomPath,
  noticesPath,
  ...(brainRuntimeCapsule ? [copiedBrainRuntimeCapsulePath] : []),
  releaseManifestPath,
];
const checksumNames = checksumInputs.map((path) => basename(path));
if (new Set(checksumNames).size !== checksumNames.length) {
  console.error('release metadata generation failed: checksum entry basenames collide');
  process.exit(1);
}
const checksumLines = checksumInputs
  .map((path) => `${sha256File(path)}  ${basename(path)}`)
  .sort();
writeFileSync(join(output, 'SHA256SUMS'), checksumLines.join('\n') + '\n');

const metadataDigest = sha256(readFileSync(releaseManifestPath));
console.log(`Release metadata generated → ${output}`);
console.log(`  ${components.length} dependency components`);
console.log(`  ${artifacts.length} release artifact(s)`);
console.log(`  release-manifest sha256 ${metadataDigest}`);
