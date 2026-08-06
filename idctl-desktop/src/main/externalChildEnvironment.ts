/**
 * Build the environment for tools that are not part of IDACC's managed
 * Manager/Brain runtime. App-owned bearer credentials must never become
 * ambient authority for provider CLIs, Git hooks, model servers, diagnostics,
 * or user-configured MCP processes.
 */

const INTERNAL_CREDENTIAL_PREFIXES = [
  'BRAIN_',
  'MANAGER_',
  'IDACC_',
  'IDCTL_',
  'ID_AGENTS_',
  'ID_CU_',
] as const;

export function isInternalCredentialEnvironmentKey(key: string): boolean {
  const normalized = String(key || '').trim().toUpperCase();
  if (!normalized) return false;
  const internalNamespace = INTERNAL_CREDENTIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  if (!internalNamespace) return false;
  return /(?:^|_)(?:TOKEN|BEARER)(?:_|$)/.test(normalized);
}

export function externalChildEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(environment)) {
    if (isInternalCredentialEnvironmentKey(key)) delete environment[key];
  }
  // Additions are deliberate per-child values, not ambient process state. This
  // preserves explicitly configured provider/MCP credentials while preventing
  // IDACC's own runtime credentials from leaking through inheritance.
  return { ...environment, ...additions };
}
