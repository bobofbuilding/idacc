import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LibraryPluginEntry } from '../../../idctl/src/api/client.ts';
import type { ControlCenterRoute } from '../../../idctl/src/api/controlCenterContract.ts';
import { MCP_CATALOG } from '../../../idctl/src/settings/mcpCatalog.ts';
import { RUNTIMES, runtimeSupports } from '../../../idctl/src/settings/runtimeCatalog.ts';
import type { HeadroomStatus } from './headroom.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';

export interface HeadroomPluginPathAuditInput {
  managerCapabilities?: {
    cc_api_version?: number;
    features?: string[];
    routes?: ControlCenterRoute[];
  } | null;
  managerPlugins?: LibraryPluginEntry[];
  headroomStatus?: HeadroomStatus;
}

export interface HeadroomPluginPathAudit {
  coreReady: false;
  pilotReady: boolean;
  verdict: 'valid-pilot-path-runtime-neutral-contract-required';
  candidate: {
    name: 'idacc-context-retrieval';
    bundled: boolean;
    bundledPath: string | null;
    manifestOk: boolean;
    skillOk: boolean;
    toolOk: boolean;
    smokeOk: boolean;
    mcpOk: boolean;
    portableOk: boolean;
    adapterCoverage: {
      portablePluginRuntimes: string[];
      skillRuntimes: string[];
      mcpRuntimes: string[];
      nativePluginRuntimes: string[];
      directFallbackRuntimes: string[];
      unsupportedRuntimes: string[];
    };
    smokeError?: string;
  };
  manager: {
    capabilitiesRoute: boolean;
    retrievalFeatureAdvertised: boolean;
    pluginListed: boolean;
    pluginSourcePath?: string | null;
  };
  headroom: {
    mcpCatalogEntry: boolean;
    cliFound: boolean;
    proxyReachable: boolean;
  };
  runtimeCoverage: {
    allRuntimes: string[];
    pluginRuntimes: string[];
    portablePluginRuntimes: string[];
    mcpRuntimes: string[];
    directFallbackRuntimes: string[];
    pluginOnlyWouldExclude: string[];
  };
  modeMatrix: Array<{
    mode:
      | 'direct-deterministic'
      | 'headroom-mcp'
      | 'idacc-context-retrieval-plugin'
      | 'idacc-context-retrieval-mcp'
      | 'idacc-portable-plugin-package'
      | 'manager-retrieval-contract';
    coreEligible: boolean;
    pilotEligible: boolean;
    reason: string;
  }>;
  guardrails: string[];
  blockers: string[];
}

const CANDIDATE_NAME = 'idacc-context-retrieval';
const RETRIEVAL_FEATURES = new Set(['context-retrieval', 'headroom-context-retrieval', CANDIDATE_NAME]);

function candidatePaths(): string[] {
  const out = [
    process.env.IDACC_CONTEXT_RETRIEVAL_PLUGIN,
    resolve(process.cwd(), 'resources', CANDIDATE_NAME),
    resolve(process.cwd(), 'idctl-desktop', 'resources', CANDIDATE_NAME),
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, CANDIDATE_NAME) : undefined,
  ].filter((p): p is string => !!p);
  return Array.from(new Set(out));
}

function bundledCandidatePath(): string | null {
  return candidatePaths().find((p) => existsSync(join(p, 'plugin.json')) || existsSync(join(p, 'SKILL.md'))) ?? null;
}

function parseManifest(dir: string | null): Record<string, unknown> | null {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listFromManifest(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function runtimeSet(value: string[]): string[] {
  const allowed = new Set(RUNTIMES);
  return Array.from(new Set(value.filter((runtime) => allowed.has(runtime))));
}

function portableCoverage(
  manifest: Record<string, unknown> | null,
  expectedNativePluginRuntimes: string[],
  expectedMcpRuntimes: string[],
) {
  const portable = manifest?.idaccPortablePlugin && typeof manifest.idaccPortablePlugin === 'object'
    ? manifest.idaccPortablePlugin as Record<string, unknown>
    : null;
  const adapters = portable?.adapters && typeof portable.adapters === 'object'
    ? portable.adapters as Record<string, unknown>
    : {};
  const adapter = (name: string) => adapters[name] && typeof adapters[name] === 'object'
    ? adapters[name] as Record<string, unknown>
    : {};
  const skill = adapter('skill');
  const mcp = adapter('mcp');
  const nativePlugin = adapter('nativePlugin');
  const directFallback = adapter('directFallback');
  const skillRuntimes = runtimeSet(listFromManifest(skill.runtimes));
  const mcpRuntimes = runtimeSet(listFromManifest(mcp.runtimes));
  const nativePluginRuntimes = runtimeSet(listFromManifest(nativePlugin.runtimes));
  const directFallbackRuntimes = runtimeSet(listFromManifest(directFallback.runtimes));
  const portablePluginRuntimes = RUNTIMES.filter((runtime) =>
    skillRuntimes.includes(runtime) ||
    mcpRuntimes.includes(runtime) ||
    nativePluginRuntimes.includes(runtime) ||
    directFallbackRuntimes.includes(runtime),
  );
  const unsupportedRuntimes = RUNTIMES.filter((runtime) => !portablePluginRuntimes.includes(runtime));
  const mcpArgs = listFromManifest(mcp.args);
  const mcpCommandOk = mcp.command === 'node' && mcpArgs.includes('tools/contract.mjs') && mcpArgs.includes('mcp');
  const nativeOk = expectedNativePluginRuntimes.every((runtime) => nativePluginRuntimes.includes(runtime));
  const mcpOk = expectedMcpRuntimes.every((runtime) => mcpRuntimes.includes(runtime));
  const fallbackOk = RUNTIMES.every((runtime) => directFallbackRuntimes.includes(runtime));
  const skillOk = RUNTIMES.every((runtime) => skillRuntimes.includes(runtime));
  const neutral = portable?.neutral === true;
  return {
    ok: Boolean(neutral && mcpCommandOk && nativeOk && mcpOk && fallbackOk && skillOk && unsupportedRuntimes.length === 0),
    portablePluginRuntimes,
    skillRuntimes,
    mcpRuntimes,
    nativePluginRuntimes,
    directFallbackRuntimes,
    unsupportedRuntimes,
  };
}

function fileContains(dir: string | null, rel: string, pattern: RegExp): boolean {
  if (!dir) return false;
  try {
    return pattern.test(readFileSync(join(dir, rel), 'utf8'));
  } catch {
    return false;
  }
}

function toolLooksExecutable(dir: string | null): boolean {
  if (!dir) return false;
  try {
    return statSync(join(dir, 'tools', 'contract.mjs')).isFile();
  } catch {
    return false;
  }
}

function toolLooksMcpCapable(dir: string | null): boolean {
  return (
    toolLooksExecutable(dir) &&
    fileContains(dir, 'tools/contract.mjs', /idacc_context_resolve/) &&
    fileContains(dir, 'tools/contract.mjs', /cmd === 'mcp'/)
  );
}

function smokePluginTool(dir: string | null): Promise<{ ok: boolean; error?: string }> {
  if (!dir || !toolLooksExecutable(dir)) return Promise.resolve({ ok: false, error: 'contract tool missing' });
  return new Promise((resolveSmoke) => {
    execFile(process.execPath, [join(dir, 'tools', 'contract.mjs'), 'smoke'], {
      env: externalChildEnvironment(),
      timeout: 5000,
    }, (err, stdout, stderr) => {
      if (err) {
        resolveSmoke({ ok: false, error: (stderr || err.message || '').trim() || 'smoke failed' });
        return;
      }
      try {
        const payload = JSON.parse(stdout || '{}') as { ok?: boolean; protectedRejected?: boolean; capabilities?: Record<string, boolean> };
        resolveSmoke({
          ok: payload.ok === true && payload.protectedRejected === true && payload.capabilities?.resolve === true,
          error: payload.ok === true ? undefined : 'smoke returned not-ok',
        });
      } catch {
        resolveSmoke({ ok: false, error: 'smoke returned invalid JSON' });
      }
    });
  });
}

export async function headroomPluginPathAudit(input: HeadroomPluginPathAuditInput = {}): Promise<HeadroomPluginPathAudit> {
  const bundledPath = bundledCandidatePath();
  const manifest = parseManifest(bundledPath);
  const manifestOk = manifest?.name === CANDIDATE_NAME && manifest.entrypoint === 'SKILL.md';
  const skillOk = fileContains(bundledPath, 'SKILL.md', /resolve a handle before relying on omitted material/i);
  const toolOk = toolLooksExecutable(bundledPath);
  const mcpOk = toolLooksMcpCapable(bundledPath);
  const smoke = await smokePluginTool(bundledPath);
  const managerPlugins = Array.isArray(input.managerPlugins) ? input.managerPlugins : [];
  const listed = managerPlugins.find((plugin) => plugin.name === CANDIDATE_NAME);
  const features = new Set((input.managerCapabilities?.features ?? []).map(String));
  const retrievalFeatureAdvertised = Array.from(RETRIEVAL_FEATURES).some((feature) => features.has(feature));
  const routes = input.managerCapabilities?.routes ?? [];
  const capabilitiesRoute = routes.some((route) => route.method?.toUpperCase() === 'GET' && route.path === '/capabilities') || !!input.managerCapabilities;
  const pluginRuntimes = RUNTIMES.filter((runtime) => runtimeSupports(runtime, 'plugins'));
  const mcpRuntimes = RUNTIMES.filter((runtime) => runtimeSupports(runtime, 'mcp'));
  const portablePluginRuntimes = RUNTIMES.filter((runtime) => runtimeSupports(runtime, 'portablePlugins'));
  const coverage = portableCoverage(manifest, pluginRuntimes, mcpRuntimes);
  const pluginOnlyWouldExclude = RUNTIMES.filter((runtime) => !pluginRuntimes.includes(runtime));
  const headroomMcp = MCP_CATALOG.some((entry) => entry.id === 'headroom' && entry.command === 'headroom');
  const cliFound = input.headroomStatus?.cli.found === true;
  const proxyReachable = input.headroomStatus?.proxy.reachable === true;
  const pluginValid = Boolean(bundledPath && manifestOk && skillOk && toolOk && smoke.ok);
  const mcpResolverValid = Boolean(bundledPath && manifestOk && skillOk && mcpOk && smoke.ok);
  const pilotReady = (pluginValid || mcpResolverValid) && headroomMcp && capabilitiesRoute;
  return {
    coreReady: false,
    pilotReady,
    verdict: 'valid-pilot-path-runtime-neutral-contract-required',
    candidate: {
      name: CANDIDATE_NAME,
      bundled: Boolean(bundledPath),
      bundledPath,
      manifestOk,
      skillOk,
      toolOk,
      smokeOk: smoke.ok,
      mcpOk,
      portableOk: coverage.ok,
      adapterCoverage: coverage,
      ...(smoke.error && { smokeError: smoke.error }),
    },
    manager: {
      capabilitiesRoute,
      retrievalFeatureAdvertised,
      pluginListed: Boolean(listed),
      pluginSourcePath: listed?.source_path ?? null,
    },
    headroom: {
      mcpCatalogEntry: headroomMcp,
      cliFound,
      proxyReachable,
    },
    runtimeCoverage: {
      allRuntimes: [...RUNTIMES],
      pluginRuntimes,
      portablePluginRuntimes,
      mcpRuntimes,
      directFallbackRuntimes: [...RUNTIMES],
      pluginOnlyWouldExclude,
    },
    modeMatrix: [
      {
        mode: 'direct-deterministic',
        coreEligible: true,
        pilotEligible: true,
        reason: 'No runtime-specific tooling required; protected and unsupported cases stay exact.',
      },
      {
        mode: 'headroom-mcp',
        coreEligible: headroomMcp && cliFound && proxyReachable,
        pilotEligible: headroomMcp,
        reason: 'Runtime-neutral across MCP-capable local agents, but requires Headroom CLI/proxy smoke tests before use.',
      },
      {
        mode: 'idacc-context-retrieval-plugin',
        coreEligible: false,
        pilotEligible: pluginValid,
        reason: 'Valid as a Claude-family pilot resolver, but plugins do not cover Codex, Ollama, or cursor runtimes.',
      },
      {
        mode: 'idacc-context-retrieval-mcp',
        coreEligible: mcpResolverValid && retrievalFeatureAdvertised,
        pilotEligible: mcpResolverValid,
        reason: 'Same guarded resolver exposed over stdio MCP for Claude, Codex, and Ollama; cursor and future runtimes keep direct fallback unless the manager resolves handles for them.',
      },
      {
        mode: 'idacc-portable-plugin-package',
        coreEligible: coverage.ok && retrievalFeatureAdvertised,
        pilotEligible: coverage.ok,
        reason: 'IDACC-level plugin package is portable only when its manifest declares Skill, MCP, native plugin, and direct-fallback adapters across the runtime catalog.',
      },
      {
        mode: 'manager-retrieval-contract',
        coreEligible: retrievalFeatureAdvertised && (coverage.ok || mcpResolverValid || pluginValid || (headroomMcp && cliFound && proxyReachable)),
        pilotEligible: capabilitiesRoute,
        reason: 'Best core path because IDACC can feature-detect retrieval support at the manager boundary and keep unsupported or stale managers on direct fallback.',
      },
    ],
    guardrails: [
      'Plugin-only routing is not core-eligible because it would exclude non-Claude runtimes.',
      'IDACC plugins are runtime-neutral only as portable packages with declared Skill, MCP, native-plugin, and direct-fallback adapters; native plugin loaders remain runtime-specific.',
      'MCP resolver routing may cover Claude, Codex, and Ollama, but runtimes without a resolver surface must keep direct prompts or use a manager-side resolve contract.',
      'Persistent memory, task orchestration, goals, plans, routing, wallet/key flows, and Brain sync must remain outside the retrieval plugin contract.',
      'Protected content remains direct and must never be stored behind a retrieval handle.',
      'Headroom compression must remain an engine behind a retrieval/fallback contract, not a frontend feature toggle or a runtime lock-in.',
      'Direct deterministic routing remains the universal fallback for stock managers and unsupported runtimes.',
    ],
    blockers: [
      ...(retrievalFeatureAdvertised ? [] : ['Manager /capabilities does not advertise a context-retrieval contract yet.']),
      ...(coverage.ok ? [] : ['The bundled idacc-context-retrieval manifest is not yet a complete portable plugin package across all runtimes.']),
      ...(mcpResolverValid ? [] : ['The bundled idacc-context-retrieval resolver does not expose a validated MCP surface yet.']),
      ...(listed ? [] : ['The manager plugin inventory does not list idacc-context-retrieval yet; bundled candidate is local-only until installed or copied into the manager plugin root.']),
      ...(cliFound && proxyReachable ? [] : ['Headroom CLI/proxy is not fully reachable, so Headroom cannot be treated as active core compression.']),
      ...(pluginOnlyWouldExclude.length ? [`Plugin-only routing would exclude: ${pluginOnlyWouldExclude.join(', ')}.`] : []),
    ],
  };
}
