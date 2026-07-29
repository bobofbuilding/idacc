export async function handleMetricsRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  readBody,
  send,
  buildLearningReport,
  buildLearningMetrics,
  buildLearningHistoryExport,
  buildBrainHealthView,
  writeSourcePrecisionSnapshot,
  writeInstructionScopeSnapshot,
  writeQualityMetricSnapshot,
  readQualityMetricTrend,
}) {
  if (method === 'GET' && path === '/brain/learning-report') {
    send(res, 200, { ok: true, report: buildLearningReport({ days: searchParams.get('days') ?? 7 }) });
    return true;
  }

  if (method === 'GET' && path === '/metrics/learning') {
    send(res, 200, { ok: true, metrics: buildLearningMetrics({ days: searchParams.get('days') ?? 7 }) });
    return true;
  }

  if (method === 'GET' && path === '/brain/learning-history') {
    const exportData = buildLearningHistoryExport({ days: searchParams.get('days') ?? 7 });
    const format = String(searchParams.get('format') ?? 'json').toLowerCase();
    if (format === 'csv') {
      const csv = exportData.csv ?? '';
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="learning-history.csv"',
        'Content-Length': Buffer.byteLength(csv),
      });
      res.end(csv);
      return true;
    }
    send(res, 200, { ok: true, export: exportData });
    return true;
  }

  if (method === 'GET' && path === '/brain/health-view') {
    send(res, 200, { ok: true, health: buildBrainHealthView({ days: searchParams.get('days') ?? 7 }) });
    return true;
  }

  if (method === 'POST' && path === '/brain/source-precision-snapshot') {
    const body = await readBody(req);
    const snapshot = writeSourcePrecisionSnapshot({
      day: body.day,
      days: Number(body.days ?? 90),
      source: body.source ?? 'brain-cycle',
    });
    send(res, 200, { ok: true, snapshot });
    return true;
  }

  if (method === 'POST' && path === '/brain/instruction-scope-snapshot') {
    const body = await readBody(req);
    const snapshot = writeInstructionScopeSnapshot({
      day: body.day,
      source: body.source ?? 'brain-cycle',
    });
    send(res, 200, { ok: true, snapshot });
    return true;
  }

  if (method === 'POST' && path === '/brain/quality-metrics-snapshot') {
    const body = await readBody(req);
    const snapshot = writeQualityMetricSnapshot({
      day: body.day,
      source: body.source ?? 'brain-quality-metrics',
      values: body.values ?? {},
      brain_totals: body.brain_totals ?? {},
      sample_size: Number(body.sample_size ?? 0),
      window_days: Number(body.window_days ?? 7),
      pass_count: Number(body.pass_count ?? 0),
      total_count: Number(body.total_count ?? 0),
      all_pass: Boolean(body.all_pass),
    });
    send(res, 200, { ok: true, snapshot });
    return true;
  }

  if (method === 'GET' && path === '/brain/quality-metrics-trend') {
    const trend = readQualityMetricTrend({
      days: Number(searchParams.get('days') ?? 30),
      source: searchParams.get('source') ?? 'brain-quality-metrics',
    });
    send(res, 200, { ok: true, trend });
    return true;
  }

  return false;
}
