export interface RuntimeFreshnessRequestOptions {
  force?: boolean;
}

export interface RuntimeFreshnessReadPolicy {
  catalog: {
    refreshCli: boolean;
    refreshClaude: boolean;
  };
  subscriptions: {
    force?: boolean;
  };
}

/**
 * Resolve every cache boundary covered by a runtime freshness request.
 *
 * A first-run re-check must not combine a freshly rendered subscription badge
 * with stale assignment evidence from the nested runtime catalog. Keeping this
 * policy in one small, testable boundary makes a forced read authoritative for
 * both CLI model discovery and subscription authentication.
 */
export function runtimeFreshnessReadPolicy(
  options: RuntimeFreshnessRequestOptions = {},
): RuntimeFreshnessReadPolicy {
  const force = options.force === true;
  return {
    catalog: {
      refreshCli: force,
      refreshClaude: force,
    },
    subscriptions: force ? { force: true } : {},
  };
}

export async function handleRuntimeFreshnessRequest<T>(
  options: RuntimeFreshnessRequestOptions | undefined,
  read: (policy: RuntimeFreshnessReadPolicy) => Promise<T>,
): Promise<T> {
  return read(runtimeFreshnessReadPolicy(options));
}
