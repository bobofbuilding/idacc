import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = Number(process.env.BRAIN_CLIENT_TIMEOUT_MS ?? 15_000);

const CRITICAL_LEARNING_ROUTES = [
  'POST /context/volunteer',
  'POST /context/package',
  'GET /context/packages/:id',
  'POST /context/packages/:id/expand',
  'POST /context/feedback-missing',
  'POST /instructions/feedback',
  'POST /sources/validate',
  'POST /eval/capture',
  'POST /eval/replay',
  'GET /metrics/learning',
  'GET /brain/learning-report',
  'GET /learning-tasks',
  'POST /learning-tasks',
  'GET /learning-rollbacks',
  'POST /approvals',
  'POST /approvals/:id/apply',
].sort();

export const BRAIN_URL = process.env.BRAIN_URL ?? 'http://127.0.0.1:4200';
export const BRAIN_TOKEN = process.env.BRAIN_TOKEN ?? '';

function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, done: () => clearTimeout(timer) };
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    ...(BRAIN_TOKEN ? { Authorization: `Bearer ${BRAIN_TOKEN}` } : {}),
  };
}

export function brainRequestHeaders(extra = {}) {
  return authHeaders(extra);
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function brainRequest(method, path, body, { timeoutMs = DEFAULT_TIMEOUT_MS, strict = true } = {}) {
  const { controller, done } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${BRAIN_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await parseResponse(response);
    if (!response.ok && strict) {
      const message = typeof data?.error === 'object'
        ? data.error.message
        : data?.error;
      const err = new Error(`${method} ${path} failed: HTTP ${response.status}${message ? `: ${message}` : ''}`);
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return { ok: response.ok, data, meta: { status: response.status, method, path } };
  } finally {
    done();
  }
}

export function brainGet(path, options) {
  return brainRequest('GET', path, undefined, options);
}

export function brainPost(path, body = {}, options) {
  return brainRequest('POST', path, body, options);
}

export async function emitTimelineEvent({
  source = 'brain-script',
  type,
  subject = '',
  data = {},
  tags = [],
} = {}, options = {}) {
  return brainPost('/timeline', {
    source,
    type,
    subject,
    data,
    tags,
  }, { strict: false, ...options });
}

export function scriptEnvelope(data = {}, meta = {}) {
  return { ok: true, data, meta, profile: meta.profile ?? 'local' };
}

export function scriptErrorEnvelope(type, message, {
  hint = '',
  retry_command = '',
  retryCommand = '',
  retry_delay = null,
  retryDelay = null,
  retry_delay_ms = null,
  retryDelayMs = null,
  risk = {},
  meta = {},
  profile = 'local',
} = {}) {
  const delay = retry_delay ?? retryDelay ?? retry_delay_ms ?? retryDelayMs;
  return {
    ok: false,
    error: {
      type,
      message,
      hint,
      retry_command: retry_command || retryCommand || '',
      retry_delay: delay == null ? null : delay,
      retry_delay_ms: retry_delay_ms ?? retryDelayMs ?? (typeof delay === 'number' ? delay : null),
      risk: {
        level: risk.level ?? 'medium',
        action: risk.action ?? 'inspect',
        destructive: risk.destructive ?? risk.level === 'destructive' ?? false,
        ...risk,
      },
    },
    meta,
    profile,
  };
}

export function scriptFailureEnvelope(error, {
  script = 'brain-script',
  type = 'brain.operator_tool_error',
  hint = '',
  retry_command = '',
  risk = {},
  profile = 'local',
} = {}) {
  const message = error?.message ?? String(error ?? 'unknown error');
  return {
    ok: false,
    error: {
      type: error?.type ?? type,
      message,
      hint: error?.hint ?? hint,
      retry_command: error?.retry_command ?? error?.retryCommand ?? retry_command,
      risk: {
        level: error?.risk?.level ?? risk.level ?? 'medium',
        action: error?.risk?.action ?? risk.action ?? 'inspect',
        ...(error?.risk ?? {}),
        ...risk,
      },
    },
    meta: { script },
    profile,
  };
}

export async function recordScriptFailure({ script, error, context = {} }) {
  try {
    await emitTimelineEvent({
      source: script ?? 'brain-script',
      type: 'script:failure',
      subject: script ?? '',
      data: {
        message: error?.message ?? String(error),
        stack: error?.stack ? String(error.stack).slice(0, 4000) : '',
        debug: {
          script: script ?? 'brain-script',
          brain_url: BRAIN_URL,
          has_brain_token: Boolean(BRAIN_TOKEN),
          pid: process.pid,
          cwd: process.cwd(),
          status: error?.status ?? null,
          response: error?.data ?? null,
        },
        context,
      },
      tags: ['script', 'failure'],
    });
  } catch {
    // Failure telemetry must not mask the original script failure.
  }
}

export const TRACE_EVENT_SCHEMA_VERSION = 'brain.trace.v1';
export const TRACE_EVENT_TYPES = Object.freeze(['trace:start', 'trace:span', 'trace:generation', 'trace:end']);
export const TRACE_EVENT_DATA_FIELDS = Object.freeze({
  required: Object.freeze(['schema_version', 'trace_id', 'span_id', 'name', 'phase', 'status']),
  optional: Object.freeze(['parent_span_id', 'started_at', 'finished_at', 'duration_ms', 'model', 'provider']),
});

function makeTraceData({
  traceId,
  spanId,
  parentSpanId = null,
  name = '',
  phase = '',
  status = 'ok',
  startedAt = '',
  finishedAt = '',
  durationMs = null,
  model = '',
  provider = '',
  metadata = {},
} = {}) {
  return {
    schema_version: TRACE_EVENT_SCHEMA_VERSION,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    name,
    phase,
    status,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    model,
    provider,
    ...metadata,
  };
}

export function createTraceContext({
  traceId = randomUUID(),
  rootSpanId = randomUUID(),
  source = 'brain-cycle',
  subject = '',
  name = '',
} = {}) {
  return {
    traceId,
    rootSpanId,
    source,
    subject,
    name,
  };
}

export function traceStartEvent(context, {
  spanId = randomUUID(),
  phase = context.name ?? '',
  metadata = {},
  startedAt = new Date().toISOString(),
} = {}) {
  return {
    source: context.source ?? 'brain-cycle',
    type: 'trace:start',
    subject: context.subject ?? '',
    data: makeTraceData({
      traceId: context.traceId,
      spanId,
      parentSpanId: context.rootSpanId ?? null,
      name: context.name ?? phase,
      phase,
      status: 'started',
      startedAt,
      metadata,
    }),
    tags: ['trace', 'start'],
  };
}

export function traceSpanEvent(context, {
  spanId = randomUUID(),
  parentSpanId = null,
  phase = '',
  status = 'ok',
  startedAt = '',
  finishedAt = new Date().toISOString(),
  durationMs = null,
  metadata = {},
} = {}) {
  return {
    source: context.source ?? 'brain-cycle',
    type: 'trace:span',
    subject: context.subject ?? '',
    data: makeTraceData({
      traceId: context.traceId,
      spanId,
      parentSpanId: parentSpanId ?? context.rootSpanId ?? null,
      name: context.name ?? phase,
      phase,
      status,
      startedAt,
      finishedAt,
      durationMs,
      metadata,
    }),
    tags: ['trace', 'span'],
  };
}

export function traceGenerationEvent(context, {
  spanId = randomUUID(),
  parentSpanId = null,
  phase = 'generation',
  status = 'ok',
  startedAt = '',
  finishedAt = new Date().toISOString(),
  durationMs = null,
  provider = '',
  model = '',
  metadata = {},
} = {}) {
  return {
    source: context.source ?? 'brain-cycle',
    type: 'trace:generation',
    subject: context.subject ?? '',
    data: makeTraceData({
      traceId: context.traceId,
      spanId,
      parentSpanId: parentSpanId ?? context.rootSpanId ?? null,
      name: context.name ?? phase,
      phase,
      status,
      startedAt,
      finishedAt,
      durationMs,
      model,
      provider,
      metadata,
    }),
    tags: ['trace', 'generation'],
  };
}

export function traceEndEvent(context, {
  spanId = randomUUID(),
  parentSpanId = null,
  phase = context.name ?? '',
  status = 'ok',
  startedAt = '',
  finishedAt = new Date().toISOString(),
  durationMs = null,
  metadata = {},
} = {}) {
  return {
    source: context.source ?? 'brain-cycle',
    type: 'trace:end',
    subject: context.subject ?? '',
    data: makeTraceData({
      traceId: context.traceId,
      spanId,
      parentSpanId: parentSpanId ?? context.rootSpanId ?? null,
      name: context.name ?? phase,
      phase,
      status,
      startedAt,
      finishedAt,
      durationMs,
      metadata,
    }),
    tags: ['trace', 'end'],
  };
}

export async function recordTraceEvent(event, { dryRun = false } = {}) {
  if (dryRun) return { skipped: true };
  try {
    return await brainPost('/timeline', event, { strict: false });
  } catch {
    return { skipped: true };
  }
}

export async function checkRouteSkew({ expected = CRITICAL_LEARNING_ROUTES } = {}) {
  const health = await brainGet('/health', { strict: false });
  const inventory = health.data?.routeInventory;
  const routes = Array.isArray(inventory?.routes) ? inventory.routes : [];
  const missing = expected.filter(route => !routes.includes(route));
  return {
    ok: Boolean(health.ok) && missing.length === 0,
    brainOk: Boolean(health.ok),
    routeInventoryPresent: routes.length > 0,
    expected,
    missing,
    count: routes.length,
    url: BRAIN_URL,
  };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd) return;
  if (cmd === 'route-skew' || cmd === 'routes') {
    const report = await checkRouteSkew();
    console.log(JSON.stringify(scriptEnvelope(report, { script: 'brain-client', command: cmd }), null, 2));
    process.exit(report.ok ? 0 : 1);
  }
  console.log(JSON.stringify(scriptErrorEnvelope('brain.usage', 'unknown brain-client command', {
    hint: 'run route-skew or routes',
    retry_command: 'node brain-client.mjs route-skew',
    risk: { level: 'low', action: 'inspect-routes' },
    meta: { script: 'brain-client', command: cmd ?? '' },
  }), null, 2));
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.log(JSON.stringify(scriptErrorEnvelope('brain.client', err?.message ?? String(err), {
      hint: 'verify Brain is running and BRAIN_URL/BRAIN_TOKEN are correct',
      retry_command: 'node brain-client.mjs route-skew',
      retry_delay_ms: 1000,
      risk: { level: 'medium', action: 'retry-or-debug' },
      meta: { script: 'brain-client' },
    }), null, 2));
    process.exit(1);
  });
}
