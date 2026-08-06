import assert from 'node:assert/strict';
import {
  CONTROL_CENTER_API_VERSION,
  CONTROL_CENTER_EXTENSION,
  CONTROL_CENTER_REQUIRED_FEATURES,
  CONTROL_CENTER_REQUIRED_ROUTES,
  evaluateControlCenterCapabilities,
} from './controlCenterContract.ts';

const exact = {
  cc_api_version: CONTROL_CENTER_API_VERSION,
  extension: CONTROL_CENTER_EXTENSION,
  features: [...CONTROL_CENTER_REQUIRED_FEATURES],
  routes: CONTROL_CENTER_REQUIRED_ROUTES.map((route) => ({ ...route })),
};

assert.equal(evaluateControlCenterCapabilities(exact).ready, true);
assert.equal(evaluateControlCenterCapabilities(exact, { exactSurface: true }).ready, true);

const stale = evaluateControlCenterCapabilities({
  ...exact,
  cc_api_version: 1,
  features: exact.features.filter((feature) => feature !== 'control-state'),
  routes: exact.routes.filter((route) => route.path !== '/control/brain'),
});
assert.equal(stale.ready, false);
assert.ok(stale.issues.includes('api:1'));
assert.ok(stale.missingFeatures.includes('control-state'));
assert.ok(stale.missingRoutes.includes('POST /control/brain'));

const wrongExtension = evaluateControlCenterCapabilities({
  ...exact,
  extension: 'stock-manager',
});
assert.equal(wrongExtension.ready, false);
assert.ok(wrongExtension.issues.includes('extension:stock-manager'));

const futureSuperset = {
  ...exact,
  cc_api_version: CONTROL_CENTER_API_VERSION + 1,
  features: [...exact.features, 'future-feature'],
  routes: [...exact.routes, { method: 'GET', path: '/future', group: 'future' }],
};
assert.equal(evaluateControlCenterCapabilities(futureSuperset).ready, true);
const pinnedFuture = evaluateControlCenterCapabilities(futureSuperset, { exactSurface: true });
assert.equal(pinnedFuture.ready, false);
assert.ok(pinnedFuture.issues.includes(`api:${CONTROL_CENTER_API_VERSION + 1}`));
assert.ok(pinnedFuture.issues.includes('unexpected-feature:future-feature'));
assert.ok(pinnedFuture.issues.includes('unexpected-route:GET /future'));

console.log('control center contract test: ok');
