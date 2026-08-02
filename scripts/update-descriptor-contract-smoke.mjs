#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const verifier = join(root, 'scripts', 'verify-update-descriptors.mjs');
const version = '1.2.3';
const directory = mkdtempSync(join(tmpdir(), 'idacc-update-contract-'));
const installers = [
  `ID-Agents-Control-Center-${version}-arm64.dmg`,
  `ID-Agents-Control-Center-${version}-x64.dmg`,
  `ID-Agents-Control-Center-${version}-arm64.zip`,
  `ID-Agents-Control-Center-${version}-x64.zip`,
  `ID-Agents-Control-Center-${version}-x64.exe`,
  `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
  `ID-Agents-Control-Center-${version}-amd64.deb`,
];

function digest(algorithm, data, encoding = 'hex') {
  return createHash(algorithm).update(data).digest(encoding);
}

function bytes(name) {
  return Buffer.from(`${name}:consumer-bytes\n`);
}

function descriptor(files, primary) {
  return Buffer.from([
    `version: ${version}`,
    'files:',
    ...files.flatMap((name) => {
      const data = readFileSync(join(directory, name));
      return [
        `  - url: ${name}`,
        `    sha512: ${digest('sha512', data, 'base64')}`,
        `    size: ${data.length}`,
        ...(name.endsWith('.AppImage') ? ['    blockMapSize: 8'] : []),
      ];
    }),
    `path: ${primary}`,
    `sha512: ${digest('sha512', readFileSync(join(directory, primary)), 'base64')}`,
    '',
  ].join('\n'));
}

function refreshChecksums() {
  const names = [
    ...installers,
    'latest-mac.yml',
    'latest.yml',
    'latest-linux.yml',
  ];
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    `${names.sort((a, b) => a.localeCompare(b)).map((name) => (
      `${digest('sha256', readFileSync(join(directory, name)))}  ${name}`
    )).join('\n')}\n`,
  );
}

function run() {
  return spawnSync(process.execPath, [
    verifier,
    '--directory', directory,
    '--version', version,
  ], { cwd: root, encoding: 'utf8' });
}

try {
  for (const name of installers) writeFileSync(join(directory, name), bytes(name));
  writeFileSync(
    join(directory, 'latest-mac.yml'),
    descriptor(
      [
        `ID-Agents-Control-Center-${version}-arm64.zip`,
        `ID-Agents-Control-Center-${version}-x64.zip`,
      ],
      `ID-Agents-Control-Center-${version}-x64.zip`,
    ),
  );
  writeFileSync(
    join(directory, 'latest.yml'),
    descriptor(
      [`ID-Agents-Control-Center-${version}-x64.exe`],
      `ID-Agents-Control-Center-${version}-x64.exe`,
    ),
  );
  writeFileSync(
    join(directory, 'latest-linux.yml'),
    descriptor(
      [
        `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
        `ID-Agents-Control-Center-${version}-amd64.deb`,
      ],
      `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
    ),
  );
  refreshChecksums();

  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /Update descriptors verified/);

  const linuxPath = join(directory, 'latest-linux.yml');
  const validLinux = readFileSync(linuxPath);
  writeFileSync(
    linuxPath,
    descriptor(
      [`ID-Agents-Control-Center-${version}-x86_64.AppImage`],
      `ID-Agents-Control-Center-${version}-x86_64.AppImage`,
    ),
  );
  refreshChecksums();
  const missingDeb = run();
  assert.notEqual(missingDeb.status, 0);
  assert.match(missingDeb.stderr, /latest-linux\.yml exact updater file set differs/);
  writeFileSync(linuxPath, validLinux);

  const macPath = join(directory, 'latest-mac.yml');
  const validMac = readFileSync(macPath);
  writeFileSync(
    macPath,
    descriptor(
      [
        `ID-Agents-Control-Center-${version}-arm64.zip`,
        `ID-Agents-Control-Center-${version}-x64.zip`,
      ],
      `ID-Agents-Control-Center-${version}-arm64.zip`,
    ),
  );
  refreshChecksums();
  const wrongPrimary = run();
  assert.notEqual(wrongPrimary.status, 0);
  assert.match(wrongPrimary.stderr, /latest-mac\.yml primary path/);
  writeFileSync(macPath, validMac);

  const windowsPath = join(directory, 'latest.yml');
  const validWindows = readFileSync(windowsPath);
  writeFileSync(
    windowsPath,
    validWindows.toString('utf8').replace(/sha512: [A-Za-z0-9+/=]+/, `sha512: ${Buffer.alloc(64).toString('base64')}`),
  );
  refreshChecksums();
  const wrongDigest = run();
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /latest\.yml SHA-512 does not match/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('update descriptor contract smoke: ok');
