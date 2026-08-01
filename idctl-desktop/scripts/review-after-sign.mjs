import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const APP_IDENTIFIER = 'world.idchain.idagents-control';
const APP_NAME = 'ID Agents Control Center.app';

function fail(message) {
  throw new Error(message);
}

export default async function reviewAfterSign(context) {
  const expectedVersion = String(process.env.IDACC_REVIEW_VERSION || '').trim();
  if (
    process.env.IDACC_REVIEW_BUILD !== '1'
    || !/^\d+\.\d+\.\d+-review\.[1-9][0-9]*$/.test(expectedVersion)
  ) {
    fail('review root signing hook requires an exact review build identity');
  }
  if (process.platform !== 'darwin' || context?.electronPlatformName !== 'darwin') {
    fail('review root signing hook may run only for a macOS package');
  }

  const outputRoot = realpathSync(String(context?.appOutDir || ''));
  const appPath = realpathSync(join(outputRoot, APP_NAME));
  const appRelative = relative(outputRoot, appPath);
  if (appRelative.startsWith('..') || basename(appPath) !== APP_NAME) {
    fail('review root signing hook resolved an unexpected app bundle');
  }

  const packagedVersion = execFileSync('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o', '-',
    join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim();
  if (packagedVersion !== expectedVersion) {
    fail('review root signing hook package version does not match the workflow identity');
  }

  const requirements = resolve('build/review-root-requirements.txt');
  execFileSync('/usr/bin/codesign', [
    '--force',
    '--sign', '-',
    '--preserve-metadata=entitlements,flags',
    '--requirements', requirements,
    appPath,
  ], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath,
  ], { stdio: 'inherit' });
  const displayed = execFileSync('/usr/bin/codesign', [
    '--display',
    '--requirements', '-',
    appPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!displayed.includes(`designated => identifier "${APP_IDENTIFIER}"`)) {
    fail('review root signing hook did not retain the stable app requirement');
  }
}
