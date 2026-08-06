#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalRepository,
  COMPONENT_NAMES,
  inspectComponentSource,
  readJson,
  validateRuntimeLock,
} from './lib/runtime-provenance.mjs';
import { verifyRuntimeSourceCapsule } from './lib/runtime-source-capsule.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);

function option(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || '' : fallback;
}

const lockPath = resolve(option('--lock', join(root, 'release', 'runtime-lock.json')));
const noSources = args.includes('--no-sources');
const json = args.includes('--json');
const explicitBrainSource = args.includes('--brain-source')
  || Boolean(process.env.IDACC_BRAIN_SOURCE);
const pinnedSources = join(root, '.runtime-sources');
const managerSource = resolve(option(
  '--manager-source',
  process.env.IDACC_MANAGER_SOURCE
    || (existsSync(join(pinnedSources, 'manager')) ? join(pinnedSources, 'manager') : join(root, '..', 'id-agents')),
));
const brainSource = resolve(option(
  '--brain-source',
  process.env.IDACC_BRAIN_SOURCE
    || (existsSync(join(pinnedSources, 'brain')) ? join(pinnedSources, 'brain') : join(root, '..', 'brain')),
));

if (!existsSync(lockPath)) {
  console.error(`runtime lock validation failed: lock not found at ${lockPath}`);
  process.exit(1);
}

const lock = readJson(lockPath, 'runtime lock');
const errors = validateRuntimeLock(lock);
const inspections = {};

if (!noSources && !errors.length) {
  for (const name of COMPONENT_NAMES) {
    const source = name === 'manager' ? managerSource : brainSource;
    const component = lock.components[name];
    if (component.distributionSource?.mode === 'vendored-capsule') {
      const capsuleRoot = resolve(root, component.distributionSource.path);
      const manifestPath = resolve(root, component.distributionSource.manifest);
      inspections[name] = verifyRuntimeSourceCapsule({
        root: capsuleRoot,
        manifestPath,
        component,
        componentName: name,
        containmentRoot: root,
      });
      errors.push(...inspections[name].errors);
      if (name === 'brain' && explicitBrainSource) {
        if (!existsSync(source)) {
          errors.push(`${name} upstream source not found at ${source}`);
        } else {
          inspections.brainUpstream = inspectComponentSource(name, component, source);
          errors.push(...inspections.brainUpstream.errors);
        }
      }
      continue;
    }
    if (!existsSync(source)) {
      errors.push(`${name} source not found at ${source}`);
      continue;
    }
    inspections[name] = inspectComponentSource(name, component, source);
    errors.push(...inspections[name].errors);
  }
}

const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput && !errors.length) {
  const checkoutRepository = (repository) => canonicalRepository(repository).replace(/^github\.com\//, '');
  appendFileSync(githubOutput, [
    `manager_repository=${checkoutRepository(lock.components.manager.repository)}`,
    `manager_commit=${lock.components.manager.commit}`,
    `brain_repository=${checkoutRepository(lock.components.brain.repository)}`,
    `brain_commit=${lock.components.brain.commit}`,
  ].join('\n') + '\n');
}

if (errors.length) {
  if (json) console.error(JSON.stringify({ ok: false, lockPath, errors, inspections }, null, 2));
  else {
    console.error('runtime lock validation failed:');
    for (const error of errors) console.error(`- ${error}`);
  }
  process.exit(1);
}

const result = { ok: true, lockPath, components: lock.components, ...(noSources ? {} : { inspections }) };
console.log(json ? JSON.stringify(result, null, 2) : `Runtime lock is valid: ${COMPONENT_NAMES.map((name) => `${name}@${lock.components[name].commit.slice(0, 12)}`).join(', ')}`);
