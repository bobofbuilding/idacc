import { requestHasValidBearer, requiredRequestToken } from '../http.mjs';

export async function handleCoreRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  send,
  dashboards,
  STMT,
  factStatusProjection,
  auditFactEntityIntegrity,
  ftsAvailable,
  sqliteVecStatus,
  routeInventoryReport,
} = {}) {
  if (method === 'GET' && (path === '/dashboard' || path === '/dashboard/health' || path === '/dashboard/skills' || path === '/dashboard/learning' || path === '/dashboard/agents')) {
    const required = requiredRequestToken(path);
    if (required && !requestHasValidBearer(req, required)) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer realm="brain-dashboard"' });
      res.end('Unauthorized - provide an Authorization: Bearer header\n');
      return true;
    }
    const html = path === '/dashboard/health' ? dashboards.health
      : path === '/dashboard/skills' ? dashboards.skills
      : path === '/dashboard/learning' ? dashboards.learning
        : path === '/dashboard/agents' ? dashboards.agents
          : dashboards.main;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return true;
  }

  if (method === 'GET' && path === '/health') {
    const managedServiceId = String(process.env.IDACC_SERVICE_ID || '').trim();
    const managedRuntimeVersion = String(process.env.IDACC_RUNTIME_VERSION || '').trim();
    const managedInstanceNonce = String(process.env.IDACC_INSTANCE_NONCE || '').trim();
    const attestation = {
      ok: true,
      ...(managedServiceId ? { service: managedServiceId } : {}),
      ...(managedRuntimeVersion ? { runtimeVersion: managedRuntimeVersion } : {}),
      ...(managedInstanceNonce ? { instanceNonce: managedInstanceNonce } : {}),
      protocolVersion: 'idacc.health.v1',
    };
    const brainToken = String(process.env.BRAIN_TOKEN ?? '');
    if (brainToken && !requestHasValidBearer(req, brainToken)) {
      send(res, 200, attestation);
      return true;
    }
    const factStatus = factStatusProjection?.() ?? null;
    const factEntityIntegrity = auditFactEntityIntegrity?.() ?? null;
    const rawActiveFacts = Number(factStatus?.raw_active_facts ?? STMT.factCount.get().c ?? 0);
    send(res, 200, {
      ...attestation,
      nodes: STMT.nodeCount.get().c,
      edges: STMT.edgeCount.get().c,
      memories: STMT.memCount.get().c,
      entities: STMT.entityCount.get().c,
      timelineEvents: STMT.timelineCount.get().c,
      facts: rawActiveFacts,
      factsRawActive: rawActiveFacts,
      factsServingActive: Number(factStatus?.serving_active_facts ?? rawActiveFacts),
      factsHistorical: Number(factStatus?.historical_facts ?? 0),
      factsTotal: Number(factStatus?.facts_total ?? rawActiveFacts),
      factStatus,
      factEntityIntegrity,
      fts: ftsAvailable,
      sqliteVec: sqliteVecStatus?.() ?? { available: false },
      routeInventory: routeInventoryReport(),
    });
    return true;
  }

  if (method === 'GET' && path === '/routes') {
    send(res, 200, { ok: true, routeInventory: routeInventoryReport() });
    return true;
  }

  return false;
}
