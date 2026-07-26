#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parseRuntimeManifest,
  verifyRuntimePayload,
} from '../src/main/unifiedStackPolicy.ts';

const manifestPath = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: runtime-manifest-policy-check.ts <runtime-manifest.json>');
  process.exit(2);
}

let manifest;
try {
  manifest = parseRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
} catch (error) {
  console.error(`production runtime manifest policy rejected ${manifestPath}: ${
    error instanceof Error ? error.message : String(error)
  }`);
  process.exit(1);
}

const errors = verifyRuntimePayload(dirname(manifestPath), manifest);
if (errors.length) {
  console.error(`production runtime payload policy rejected ${manifestPath}:`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Production runtime manifest policy verified: ${manifest.files.length} files`);
