#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const { dump, load } = requireFromDesktop('js-yaml');
const args = process.argv.slice(2);

function options(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function option(name) {
  return options(name)[0] || '';
}

function fail(message) {
  console.error(`update metadata merge failed: ${message}`);
  process.exit(1);
}

function safeUrl(value) {
  const url = String(value || '').trim();
  if (
    !url
    || basename(url) !== url
    || !/^[A-Za-z0-9][A-Za-z0-9._+()-]*$/.test(url)
  ) {
    fail(`unsafe artifact URL: ${url || '(missing)'}`);
  }
  return url;
}

const inputPaths = options('--input').map((path) => resolve(path));
const outputPath = resolve(option('--output') || '');
if (inputPaths.length < 2 || !option('--output')) {
  fail('usage: scripts/merge-update-metadata.mjs --input <yml> --input <yml> --output <yml> [--require-mac-arches]');
}
if (new Set(inputPaths).size !== inputPaths.length) fail('input paths must be unique');
if (inputPaths.includes(outputPath)) fail('output must not overwrite an input feed');

function safeSha512(value, url) {
  const digest = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) fail(`${url} has an invalid SHA-512 digest`);
  const decoded = Buffer.from(digest, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== digest) {
    fail(`${url} must use a canonical 64-byte SHA-512 digest`);
  }
  return digest;
}

const documents = inputPaths.map((path) => {
  if (!existsSync(path)) fail(`input does not exist: ${path}`);
  const document = load(readFileSync(path, 'utf8'));
  if (!document || typeof document !== 'object') fail(`input is not a YAML object: ${path}`);
  if (!Array.isArray(document.files) || !document.files.length) fail(`input has no files: ${path}`);
  const primaryUrl = safeUrl(document.path);
  const primarySha512 = safeSha512(document.sha512, primaryUrl);
  const primary = document.files.find((file) => file && file.url === primaryUrl);
  if (!primary || String(primary.sha512 || '') !== primarySha512) {
    fail(`${basename(path)} path/sha512 does not match one of its file records`);
  }
  return { path, document };
});

const version = String(documents[0].document.version || '');
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid version: ${version || '(missing)'}`);
for (const { path, document } of documents) {
  if (String(document.version || '') !== version) {
    fail(`${basename(path)} version does not match ${version}`);
  }
}

const files = new Map();
for (const { path, document } of documents) {
  for (const raw of document.files) {
    if (!raw || typeof raw !== 'object') fail(`${basename(path)} contains an invalid file record`);
    const url = safeUrl(raw.url);
    const sha512 = safeSha512(raw.sha512, url);
    const size = Number(raw.size);
    if (!Number.isSafeInteger(size) || size <= 0) fail(`${url} has an invalid size`);
    const normalized = { ...raw, url, sha512, size };
    const previous = files.get(url);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
      fail(`conflicting records for ${url}`);
    }
    files.set(url, normalized);
  }
}

const sortedFiles = [...files.values()].sort((left, right) => left.url.localeCompare(right.url));
if (args.includes('--require-mac-arches')) {
  const seenInputArches = new Set();
  for (const { path, document } of documents) {
    if (
      document.files.length !== 1
      || !String(document.files[0]?.url || '').toLowerCase().endsWith('.zip')
    ) {
      fail(`${basename(path)} must contain exactly one ZIP updater and no DMG or other file record`);
    }
    const arches = new Set(document.files.flatMap((file) => {
      const tokens = String(file?.url || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return ['arm64', 'x64'].filter((arch) => tokens.includes(arch));
    }));
    if (arches.size !== 1) fail(`${basename(path)} must describe exactly one macOS architecture`);
    const [arch] = arches;
    if (seenInputArches.has(arch)) fail(`duplicate macOS ${arch} update feed`);
    seenInputArches.add(arch);
  }
  if (sortedFiles.length !== 2 || sortedFiles.some((file) => !file.url.toLowerCase().endsWith('.zip'))) {
    fail('merged macOS feed must contain exactly the arm64 and x64 ZIP updaters');
  }
  for (const arch of ['arm64', 'x64']) {
    const zipFiles = sortedFiles.filter((file) => {
      const tokens = file.url.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      return tokens.includes(arch) && file.url.toLowerCase().endsWith('.zip');
    });
    if (zipFiles.length !== 1) fail(`merged macOS feed must contain exactly one ${arch} ZIP`);
  }
}

const preferred = sortedFiles.find((file) => file.url.includes('x64') && file.url.toLowerCase().endsWith('.zip'))
  || sortedFiles.find((file) => file.url.toLowerCase().endsWith('.zip'))
  || sortedFiles[0];
const releaseDates = documents
  .map(({ document }) => String(document.releaseDate || ''))
  .filter(Boolean)
  .sort();
const merged = {
  ...documents[0].document,
  version,
  files: sortedFiles,
  path: preferred.url,
  sha512: preferred.sha512,
  ...(releaseDates.length ? { releaseDate: releaseDates.at(-1) } : {}),
};

writeFileSync(outputPath, dump(merged, {
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
}), 'utf8');
console.log(`Merged ${inputPaths.length} update feeds (${sortedFiles.length} files) → ${outputPath}`);
