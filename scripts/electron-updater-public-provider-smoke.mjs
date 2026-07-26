#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(root, 'idctl-desktop', 'package.json'));
const { createClient } = requireFromDesktop('electron-updater/out/providerFactory.js');
const { GitHubProvider } = requireFromDesktop('electron-updater/out/providers/GitHubProvider.js');
const repository = 'bobofbuilding/idacc';
const [owner, repo] = repository.split('/');
const tag = 'v1.2.3';
const digest = Buffer.alloc(64, 0x61).toString('base64');

function updateYaml(platform) {
  const files = platform === 'darwin'
    ? [
        'ID-Agents-Control-Center-1.2.3-arm64.zip',
        'ID-Agents-Control-Center-1.2.3-x64.zip',
      ]
    : platform === 'win32'
      ? ['ID-Agents-Control-Center-1.2.3-x64.exe']
      : [
          'ID-Agents-Control-Center-1.2.3-x64.AppImage',
          'ID-Agents-Control-Center-1.2.3-x64.deb',
        ];
  const primary = platform === 'darwin'
    ? files[1]
    : files[0];
  return [
    'version: 1.2.3',
    'files:',
    ...files.flatMap((name) => [
      `  - url: ${name}`,
      `    sha512: ${digest}`,
      '    size: 100',
      ...(name.endsWith('.AppImage') ? ['    blockMapSize: 10'] : []),
    ]),
    `path: ${primary}`,
    `sha512: ${digest}`,
    '',
  ].join('\n');
}

function pathOf(options) {
  return `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}${options.path}`;
}

const previousGhToken = process.env.GH_TOKEN;
const previousGitHubToken = process.env.GITHUB_TOKEN;
const previousArch = process.env.TEST_UPDATER_ARCH;
process.env.GH_TOKEN = 'must-not-select-private-provider';
process.env.GITHUB_TOKEN = 'must-not-select-private-provider';
process.env.TEST_UPDATER_ARCH = 'x64';

try {
  for (const [platform, channelName, expectedPayloads] of [
    ['darwin', 'latest-mac.yml', [
      'ID-Agents-Control-Center-1.2.3-arm64.zip',
      'ID-Agents-Control-Center-1.2.3-x64.zip',
    ]],
    ['win32', 'latest.yml', ['ID-Agents-Control-Center-1.2.3-x64.exe']],
    ['linux', 'latest-linux.yml', [
      'ID-Agents-Control-Center-1.2.3-x64.AppImage',
      'ID-Agents-Control-Center-1.2.3-x64.deb',
    ]],
  ]) {
    const requests = [];
    const executor = {
      request: async (options) => {
        requests.push(options);
        const url = pathOf(options);
        if (url === `https://github.com/${repository}/releases.atom`) {
          return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<feed xmlns="http://www.w3.org/2005/Atom">',
            '  <entry>',
            `    <title>${tag}</title>`,
            `    <link href="https://github.com/${repository}/releases/tag/${tag}"/>`,
            '    <content>No content.</content>',
            '  </entry>',
            '</feed>',
          ].join('\n');
        }
        if (url === `https://github.com/${repository}/releases/latest`) {
          return JSON.stringify({ tag_name: tag });
        }
        if (url === `https://github.com/${repository}/releases/download/${tag}/${channelName}`) {
          return updateYaml(platform);
        }
        throw new Error(`unexpected electron-updater request: ${url}`);
      },
    };
    const provider = createClient(
      {
        provider: 'github',
        owner,
        repo,
        private: false,
      },
      {
        channel: null,
        allowPrerelease: false,
        fullChangelog: false,
      },
      {
        executor,
        platform,
        isUseMultipleRangeRequest: false,
      },
    );
    assert.ok(provider instanceof GitHubProvider, `${platform} must use the anonymous public GitHubProvider`);
    const info = await provider.getLatestVersion();
    assert.equal(info.tag, tag);
    assert.deepEqual(
      requests.map(pathOf),
      [
        `https://github.com/${repository}/releases.atom`,
        `https://github.com/${repository}/releases/latest`,
        `https://github.com/${repository}/releases/download/${tag}/${channelName}`,
      ],
      `${platform} updater discovery route sequence changed`,
    );
    assert.equal(
      requests[0].headers?.accept,
      'application/xml, application/atom+xml, text/xml, */*',
    );
    assert.equal(requests[1].headers?.Accept, 'application/json');
    assert.equal(
      requests.every((request) => !Object.keys(request.headers || {}).some((name) => name.toLowerCase() === 'authorization')),
      true,
      'the public updater provider must not send ambient GitHub credentials',
    );
    assert.deepEqual(
      provider.resolveFiles(info).map((file) => file.url.href),
      expectedPayloads.map((name) => (
        `https://github.com/${repository}/releases/download/${tag}/${name}`
      )),
    );
  }
} finally {
  if (previousGhToken == null) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousGhToken;
  if (previousGitHubToken == null) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousGitHubToken;
  if (previousArch == null) delete process.env.TEST_UPDATER_ARCH;
  else process.env.TEST_UPDATER_ARCH = previousArch;
}

console.log('electron-updater public GitHub provider contract smoke: ok');
