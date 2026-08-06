const DEFAULT_BASE_URL = (process.env.BRAIN_MCP_BASE_URL ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 4200}`)
  .replace(/\/+$/, '');

function jsonHeaders(body, token) {
  return {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function parsePayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeSuccessEnvelope(payload, meta) {
  if (payload && typeof payload === 'object' && payload.ok === true) {
    const data = 'data' in payload
      ? payload.data
      : Object.fromEntries(
          Object.entries(payload).filter(([key]) => !['ok', 'meta', 'profile'].includes(key)),
        );
    return {
      ok: true,
      data,
      meta: { ...(payload.meta ?? {}), ...meta },
      profile: payload.profile ?? 'local',
    };
  }
  return {
    ok: true,
    data: payload,
    meta,
    profile: payload?.profile ?? 'local',
  };
}

function normalizeErrorEnvelope(status, payload, meta) {
  if (payload && typeof payload === 'object' && payload.ok === false && payload.error) {
    return {
      ok: false,
      error: payload.error,
      meta: { ...(payload.meta ?? {}), ...meta },
      profile: payload.profile ?? 'local',
    };
  }
  const message = typeof payload?.error === 'string'
    ? payload.error
    : typeof payload?.error?.message === 'string'
      ? payload.error.message
      : `Brain request failed with status ${status}`;
  return {
    ok: false,
    error: {
      type: `brain.http.${status}`,
      message,
      status,
    },
    meta,
    profile: payload?.profile ?? 'local',
  };
}

export function createBrainHttpClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  token = process.env.BRAIN_TOKEN ?? '',
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation required for brain MCP client');
  }
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request({
    method = 'GET',
    path,
    query,
    body,
    toolName,
  } = {}) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const res = await fetchImpl(url, {
      method,
      headers: jsonHeaders(body, token),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const payload = parsePayload(text);
    const meta = {
      route: path,
      tool: toolName,
      upstream_status: res.status,
      base_url: root,
    };
    return res.ok
      ? normalizeSuccessEnvelope(payload, meta)
      : normalizeErrorEnvelope(res.status, payload, meta);
  }

  return {
    baseUrl: root,
    request,
    get(path, query, toolName) {
      return request({ method: 'GET', path, query, toolName });
    },
    post(path, body, toolName) {
      return request({ method: 'POST', path, body, toolName });
    },
  };
}
