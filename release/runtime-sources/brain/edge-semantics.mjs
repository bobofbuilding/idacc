// Entity-edge freshness is deliberately independent of database access so the
// graph app and quality overlays can use the exact same bucket boundaries.
export const ENTITY_EDGE_FRESH_MAX_AGE_SECONDS_DEFAULT = 7 * 86400;
export const ENTITY_EDGE_STALE_AFTER_SECONDS_DEFAULT = 30 * 86400;

function positiveIntegerOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// Environment configuration is intentionally read at call time. This keeps
// tests and local overlays able to set their own thresholds without a reload.
export function entityEdgeFreshnessThresholds({ freshMaxAgeSeconds, staleAfterSeconds } = {}) {
  const fresh = positiveIntegerOr(
    freshMaxAgeSeconds ?? process.env.BRAIN_ENTITY_EDGE_FRESH_MAX_AGE_SECONDS,
    ENTITY_EDGE_FRESH_MAX_AGE_SECONDS_DEFAULT,
  );
  const stale = Math.max(fresh, positiveIntegerOr(
    staleAfterSeconds ?? process.env.BRAIN_ENTITY_EDGE_STALE_AFTER_SECONDS,
    ENTITY_EDGE_STALE_AFTER_SECONDS_DEFAULT,
  ));
  return { freshMaxAgeSeconds: fresh, staleAfterSeconds: stale };
}

export function classifyEntityEdgeFreshness(updatedAt, { nowSeconds = Math.floor(Date.now() / 1000), ...thresholdInput } = {}) {
  const thresholds = entityEdgeFreshnessThresholds(thresholdInput);
  const now = positiveIntegerOr(nowSeconds, Math.floor(Date.now() / 1000));
  const timestamp = Number(updatedAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { classification: 'stale', ageSeconds: null, updatedAt: 0, ...thresholds };
  }
  const ageSeconds = Math.max(0, now - Math.floor(timestamp));
  const classification = ageSeconds <= thresholds.freshMaxAgeSeconds
    ? 'fresh'
    : ageSeconds <= thresholds.staleAfterSeconds
      ? 'aging'
      : 'stale';
  return { classification, ageSeconds, updatedAt: Math.floor(timestamp), ...thresholds };
}
