/**
 * Versioned manager-extension contract that IDACC expects from id-agents.
 *
 * This mirrors id-agents/src/control-center/manifest.ts so the downloaded app can
 * distinguish a fully compatible manager from a stock/stale one before exposing
 * controls that rely on Control Center-only routes.
 */

export const CONTROL_CENTER_API_VERSION = 5;
export const CONTROL_CENTER_EXTENSION = 'id-agents-control-center';

export interface ControlCenterRoute {
  method: string;
  path: string;
  group: string;
}

export const CONTROL_CENTER_REQUIRED_ROUTES: ControlCenterRoute[] = [
  { method: 'GET', path: '/capabilities', group: 'core' },
  { method: 'POST', path: '/control/brain', group: 'brain-control' },
  { method: 'POST', path: '/control-event', group: 'control-events' },
  { method: 'GET', path: '/control/state/:scope', group: 'control-state' },
  { method: 'GET', path: '/control/state/:scope/:key', group: 'control-state' },
  { method: 'POST', path: '/control/state/:scope/:key', group: 'control-state' },
  { method: 'DELETE', path: '/control/state/:scope/:key', group: 'control-state' },
  { method: 'POST', path: '/control/memory', group: 'brain-control' },
  { method: 'GET', path: '/activity', group: 'observability' },
  { method: 'POST', path: '/activity/record', group: 'observability' },
  { method: 'GET', path: '/usage', group: 'observability' },
  { method: 'POST', path: '/usage/record', group: 'observability' },
  { method: 'GET', path: '/usage/by-task', group: 'observability' },
  { method: 'GET', path: '/agents/:id/queries/active', group: 'observability' },
  { method: 'POST', path: '/runtime/preflight', group: 'manager-controls' },
  { method: 'GET', path: '/manager/local-concurrency', group: 'manager-controls' },
  { method: 'POST', path: '/manager/local-concurrency', group: 'manager-controls' },
  { method: 'GET', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/instructions', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/runtime', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/mcp', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/delegates', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/team', group: 'agent-config' },
  { method: 'POST', path: '/agents/:id/metadata', group: 'agent-config' },
  { method: 'GET', path: '/teams/:name/config', group: 'team-config' },
  { method: 'POST', path: '/teams/:name/delegates', group: 'team-config' },
  { method: 'GET', path: '/library/plugins', group: 'library' },
  { method: 'POST', path: '/library/skills/install', group: 'library' },
];

export const CONTROL_CENTER_REQUIRED_FEATURES = [
  'observability',
  'manager-controls',
  'runtime-preflight',
  'agent-config',
  'team-config',
  'library',
  'brain-context',
  'brain-control',
  'control-events',
  'control-state',
  'stalled-sweep',
];

export function controlCenterRouteKey(route: Pick<ControlCenterRoute, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

export interface ControlCenterCapabilities {
  cc_api_version?: number;
  extension?: string;
  features?: string[];
  routes?: ControlCenterRoute[];
}

export interface ControlCenterCompatibility {
  ready: boolean;
  apiVersion: number;
  extension?: string;
  missingFeatures: string[];
  missingRoutes: string[];
  unexpectedFeatures: string[];
  unexpectedRoutes: string[];
  issues: string[];
}

/**
 * Evaluate a Manager capability manifest against the application contract.
 *
 * Normal connected-manager checks accept a compatible future superset.
 * Immutable bundled-runtime verification sets `exactSurface` so the application
 * binary and its pinned Manager cannot silently drift apart.
 */
export function evaluateControlCenterCapabilities(
  capabilities: ControlCenterCapabilities | null | undefined,
  options: { exactSurface?: boolean } = {},
): ControlCenterCompatibility {
  const apiVersion = Number(capabilities?.cc_api_version) || 0;
  const extension = typeof capabilities?.extension === 'string' ? capabilities.extension : undefined;
  const features = new Set((capabilities?.features ?? []).map(String));
  const routes = new Set((capabilities?.routes ?? []).map(controlCenterRouteKey));
  const requiredFeatures = new Set(CONTROL_CENTER_REQUIRED_FEATURES);
  const requiredRoutes = new Set(CONTROL_CENTER_REQUIRED_ROUTES.map(controlCenterRouteKey));
  const missingFeatures = CONTROL_CENTER_REQUIRED_FEATURES.filter((feature) => !features.has(feature));
  const missingRoutes = [...requiredRoutes].filter((route) => !routes.has(route));
  const unexpectedFeatures = [...features].filter((feature) => !requiredFeatures.has(feature)).sort();
  const unexpectedRoutes = [...routes].filter((route) => !requiredRoutes.has(route)).sort();
  const issues = [
    ...(capabilities ? [] : ['capabilities:missing']),
    ...(extension === CONTROL_CENTER_EXTENSION ? [] : [`extension:${extension || 'missing'}`]),
    ...(options.exactSurface
      ? (apiVersion === CONTROL_CENTER_API_VERSION ? [] : [`api:${apiVersion || 'missing'}`])
      : (apiVersion >= CONTROL_CENTER_API_VERSION ? [] : [`api:${apiVersion || 'missing'}`])),
    ...missingFeatures.map((feature) => `feature:${feature}`),
    ...missingRoutes,
    ...(options.exactSurface ? unexpectedFeatures.map((feature) => `unexpected-feature:${feature}`) : []),
    ...(options.exactSurface ? unexpectedRoutes.map((route) => `unexpected-route:${route}`) : []),
  ];
  return {
    ready: issues.length === 0,
    apiVersion,
    extension,
    missingFeatures,
    missingRoutes,
    unexpectedFeatures,
    unexpectedRoutes,
    issues,
  };
}
