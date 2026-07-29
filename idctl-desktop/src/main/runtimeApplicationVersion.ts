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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Bind a packaged application to the runtime staged from its exact source
 * version. Production packages keep the historical one-version equality.
 * Review packages may add only the compiled `-review.N` identity while the
 * immutable Manager/Brain manifest remains bound to the stable source version.
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

  if (input.reviewBuild) {
    const expectedReviewPattern = new RegExp(
      `^${escapeRegularExpression(sourceVersion)}-review\\.[1-9][0-9]*$`,
    );
    if (!expectedReviewPattern.test(compiledApplicationVersion)) {
      return {
        ok: false,
        error: 'compiled review application identity is malformed',
      };
    }
  } else if (compiledApplicationVersion !== sourceVersion) {
    return {
      ok: false,
      error: 'compiled production application identity does not match its source version',
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
