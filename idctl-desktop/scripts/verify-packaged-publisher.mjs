#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingIdentityErrors } from './release-signing-policy.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(desktop, 'package.json'));
const { load } = requireFromDesktop('js-yaml');
const configPath = resolve(process.argv[2] || '');
const errors = signingIdentityErrors('win');
if (errors.length) {
  console.error(`packaged publisher verification failed: ${errors.join('; ')}`);
  process.exit(1);
}
let config;
try {
  config = load(readFileSync(configPath, 'utf8'));
} catch (error) {
  console.error(`packaged publisher verification failed: cannot read app-update.yml: ${error.message}`);
  process.exit(1);
}
const actual = Array.isArray(config?.publisherName)
  ? config.publisherName
  : config?.publisherName == null
    ? []
    : [config.publisherName];
if (
  actual.length !== 1
  || actual[0] !== process.env.WINDOWS_EXPECTED_PUBLISHER_SUBJECT
) {
  console.error('packaged publisher verification failed: app-update.yml does not contain exactly the expected full publisher subject DN');
  process.exit(1);
}
console.log('Packaged Windows updater publisher subject is exactly pinned.');
