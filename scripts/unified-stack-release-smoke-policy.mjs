import { isAbsolute, relative, resolve } from 'node:path';

export const LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION =
  '--linux-github-actions-suid-sandbox';

const USAGE = 'usage: scripts/unified-stack-release-smoke.mjs '
  + '<IDACC.app|win-unpacked|linux-unpacked> '
  + `[${LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION}]`;

function containedBy(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

export function unifiedStackReleaseSmokePolicy(
  args,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
  } = {},
) {
  if (!Array.isArray(args) || !args[0]) {
    throw new Error(USAGE);
  }

  const [packagedAppArgument, ...options] = args;
  if (
    options.length > 1
    || (
      options.length === 1
      && options[0] !== LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION
    )
  ) {
    throw new Error(`${USAGE}\nunsupported unified-stack release-smoke option`);
  }

  const prepareLinuxGithubActionsSandbox =
    options[0] === LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION;
  const packagedApp = resolve(cwd, packagedAppArgument);
  if (!prepareLinuxGithubActionsSandbox) {
    return {
      packagedApp,
      prepareLinuxGithubActionsSandbox: false,
      runnerTemp: null,
    };
  }

  if (platform !== 'linux') {
    throw new Error(
      `${LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION} is Linux-only`,
    );
  }
  if (
    env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true'
    || env.IDACC_GITHUB_RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.RUNNER_OS !== 'Linux'
    || env.ImageOS !== 'ubuntu24'
  ) {
    throw new Error(
      `${LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION} is restricted to the pinned GitHub-hosted Ubuntu 24 Actions image`,
    );
  }

  const workspace = String(env.GITHUB_WORKSPACE || '');
  const runnerTemp = String(env.RUNNER_TEMP || '');
  if (
    !isAbsolute(workspace)
    || !isAbsolute(runnerTemp)
    || resolve(workspace) === resolve(runnerTemp)
    || resolve(runnerTemp) === '/'
    || containedBy(resolve(workspace), resolve(runnerTemp))
  ) {
    throw new Error(
      `${LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION} requires a private absolute RUNNER_TEMP outside GITHUB_WORKSPACE`,
    );
  }

  const expectedPackagedApp = resolve(
    workspace,
    'idctl-desktop',
    'release',
    'linux-unpacked',
  );
  if (packagedApp !== expectedPackagedApp) {
    throw new Error(
      `${LINUX_GITHUB_ACTIONS_SUID_SANDBOX_OPTION} requires the exact GitHub workspace linux-unpacked path`,
    );
  }

  return {
    packagedApp,
    prepareLinuxGithubActionsSandbox: true,
    runnerTemp: resolve(runnerTemp),
  };
}
