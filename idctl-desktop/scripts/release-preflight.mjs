#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signingIdentityErrors } from './release-signing-policy.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const platformIndex = args.indexOf('--platform');
const platform = platformIndex >= 0 ? String(args[platformIndex + 1] || '') : '';
const requireSigning = args.includes('--require-signing');
const errors = [];

function expect(condition, message) {
  if (!condition) errors.push(message);
}

function has(name) {
  return Boolean(String(process.env[name] || '').trim());
}

function packageJson() {
  return JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
}

expect(['mac', 'win', 'linux'].includes(platform), '--platform must be mac, win, or linux');

const pkg = packageJson();
expect(pkg.build?.appId === 'world.idchain.idagents-control', 'the stable application ID must not change');
expect(pkg.build?.publish?.provider === 'github', 'GitHub must remain the default update provider');
expect(pkg.build?.publish?.owner === 'bobofbuilding' && pkg.build?.publish?.repo === 'idacc', 'the update feed must target bobofbuilding/idacc');
expect(/^\d+\.\d+\.\d+$/.test(String(pkg.version || '')), 'the application version must be plain semver');

if (platform === 'mac') {
  expect(process.platform === 'darwin', 'macOS releases must be produced on macOS');
  expect(pkg.build?.mac?.hardenedRuntime === true, 'macOS hardened runtime must be enabled');
  expect(pkg.build?.mac?.notarize === true, 'macOS notarization must be enabled');
  expect(existsSync(join(desktop, String(pkg.build?.mac?.entitlements || ''))), 'macOS app entitlements are missing');
  expect(existsSync(join(desktop, String(pkg.build?.mac?.entitlementsInherit || ''))), 'macOS inherited entitlements are missing');
  if (requireSigning) {
    errors.push(...signingIdentityErrors('mac'));
    expect(has('CSC_LINK'), 'CSC_LINK is required for a production Developer ID build');
    expect(has('CSC_KEY_PASSWORD'), 'CSC_KEY_PASSWORD is required for a production Developer ID build');
    const apiKey = has('APPLE_API_KEY') && has('APPLE_API_KEY_ID') && has('APPLE_API_ISSUER');
    const appleId = has('APPLE_ID') && has('APPLE_APP_SPECIFIC_PASSWORD') && has('APPLE_TEAM_ID');
    const keychain = has('APPLE_KEYCHAIN_PROFILE');
    expect(apiKey || appleId || keychain, 'complete Apple notarization credentials are required');
    if (apiKey) expect(existsSync(process.env.APPLE_API_KEY), 'APPLE_API_KEY must point to an existing private key file');
    expect(process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false', 'production signing cannot disable certificate discovery');
  }
}

if (platform === 'win') {
  expect(process.platform === 'win32', 'Windows releases must be produced on Windows');
  expect(pkg.build?.win?.signAndEditExecutable === true, 'Windows executable signing must be enabled');
  expect(pkg.build?.win?.verifyUpdateCodeSignature === true, 'Windows update signature verification must be enabled');
  if (requireSigning) {
    errors.push(...signingIdentityErrors('win'));
    const linkName = has('WIN_CSC_LINK') ? 'WIN_CSC_LINK' : 'CSC_LINK';
    const passwordName = has('WIN_CSC_KEY_PASSWORD') ? 'WIN_CSC_KEY_PASSWORD' : 'CSC_KEY_PASSWORD';
    expect(has(linkName), 'WIN_CSC_LINK or CSC_LINK is required for a production Authenticode build');
    expect(has(passwordName), 'WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD is required for a production Authenticode build');
  }
}

if (platform === 'linux') {
  expect(process.platform === 'linux', 'Linux releases must be produced on Linux');
}

if (errors.length) {
  console.error('release preflight failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release preflight passed for ${platform}${requireSigning ? ' with signing required' : ''}.`);
