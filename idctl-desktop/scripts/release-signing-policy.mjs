import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const requireFromDesktop = createRequire(join(desktop, 'package.json'));
const { parseDn } = requireFromDesktop('builder-util-runtime');

function exactEnv(env, name) {
  const raw = String(env[name] || '');
  return raw === raw.trim() ? raw : '';
}

export function signingIdentityErrors(platform, env = process.env) {
  const errors = [];
  if (platform === 'mac') {
    const teamId = exactEnv(env, 'MACOS_EXPECTED_TEAM_ID');
    const identity = exactEnv(env, 'MACOS_EXPECTED_SIGNING_IDENTITY');
    if (!/^[A-Z0-9]{10}$/.test(teamId)) {
      errors.push('MACOS_EXPECTED_TEAM_ID must be the exact 10-character production Developer ID Team ID');
    }
    if (
      !identity
      || identity.length > 200
      || /[\r\n]/.test(identity)
      || identity.startsWith('Developer ID Application:')
    ) {
      errors.push('MACOS_EXPECTED_SIGNING_IDENTITY must be the exact electron-builder identity qualifier without the Developer ID Application: prefix');
    } else if (teamId && !identity.endsWith(` (${teamId})`)) {
      errors.push('MACOS_EXPECTED_SIGNING_IDENTITY must end with the configured production Team ID');
    }
    if (exactEnv(env, 'CSC_NAME') !== identity || !identity) {
      errors.push('CSC_NAME must exactly equal MACOS_EXPECTED_SIGNING_IDENTITY');
    }
    if (exactEnv(env, 'APPLE_TEAM_ID') !== teamId || !teamId) {
      errors.push('APPLE_TEAM_ID must exactly equal MACOS_EXPECTED_TEAM_ID');
    }
  } else if (platform === 'win') {
    const subject = exactEnv(env, 'WINDOWS_EXPECTED_PUBLISHER_SUBJECT');
    let parsed = new Map();
    try {
      parsed = parseDn(subject);
    } catch {
      // The error below deliberately avoids echoing the configured subject.
    }
    if (
      !subject
      || subject.length > 512
      || /[\r\n]/.test(subject)
      || !parsed.get('CN')
      || parsed.size < 2
    ) {
      errors.push('WINDOWS_EXPECTED_PUBLISHER_SUBJECT must be the exact full production certificate subject DN, including CN and at least one additional attribute');
    }
  }
  return errors;
}

export function productionBuilderArgs(platform, builderArgs, env = process.env) {
  if (!['mac', 'win', 'linux'].includes(platform)) {
    throw new Error('production builder platform must be mac, win, or linux');
  }
  if (!Array.isArray(builderArgs) || builderArgs.length === 0) {
    throw new Error('production builder requires explicit electron-builder target arguments');
  }
  if (builderArgs.some((arg) => typeof arg !== 'string' || !arg || /[\0\r\n]/.test(arg))) {
    throw new Error('production builder received an unsafe argument');
  }
  const errors = platform === 'linux' ? [] : signingIdentityErrors(platform, env);
  if (errors.length) throw new Error(errors.join('; '));
  if (platform === 'mac') {
    return [
      ...builderArgs,
      '--config.forceCodeSigning=true',
      `--config.mac.identity=${env.MACOS_EXPECTED_SIGNING_IDENTITY}`,
    ];
  }
  if (platform === 'win') {
    return [
      ...builderArgs,
      '--config.forceCodeSigning=true',
      `--config.win.signtoolOptions.publisherName=${env.WINDOWS_EXPECTED_PUBLISHER_SUBJECT}`,
    ];
  }
  return [...builderArgs];
}
