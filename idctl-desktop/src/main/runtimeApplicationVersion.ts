export interface RuntimeApplicationVersionContractInput {
  applicationVersion: string;
  compiledApplicationVersion: string;
  compiledSourceVersion: string;
  manifestVersion: string;
  reviewBuild: boolean;
}

export type RuntimeApplicationVersionContractResult =
  | {
      ok: true;
      runtimeVersion: string;
    }
  | {
      ok: false;
      error: string;
    };

const STABLE_SOURCE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Bind a packaged application to the runtime staged from its exact source
 * version. Review is a distribution policy, not part of the version identity,
 * so production and review packages both preserve one-version equality.
 */
export function evaluateRuntimeApplicationVersionContract(
  input: RuntimeApplicationVersionContractInput,
): RuntimeApplicationVersionContractResult {
  const sourceVersion = String(input.compiledSourceVersion || '').trim();
  const compiledApplicationVersion = String(
    input.compiledApplicationVersion || '',
  ).trim();
  const applicationVersion = String(input.applicationVersion || '').trim();
  const manifestVersion = String(input.manifestVersion || '').trim();

  if (!STABLE_SOURCE_VERSION.test(sourceVersion)) {
    return {
      ok: false,
      error: 'runtime source-version integrity metadata is unavailable or malformed',
    };
  }

  if (compiledApplicationVersion !== sourceVersion) {
    return {
      ok: false,
      error: 'compiled application identity does not match its source version',
    };
  }

  if (applicationVersion !== compiledApplicationVersion) {
    return {
      ok: false,
      error: `packaged application ${applicationVersion || '(missing)'} does not match compiled identity ${compiledApplicationVersion}`,
    };
  }
  if (manifestVersion !== sourceVersion) {
    return {
      ok: false,
      error: `runtime manifest targets application source ${manifestVersion || '(missing)'}, not ${sourceVersion}`,
    };
  }

  return {
    ok: true,
    runtimeVersion: sourceVersion,
  };
}
