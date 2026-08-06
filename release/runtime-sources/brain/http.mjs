// ─── HTTP helpers ─────────────────────────────────────────────────────────────

import { timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = Number(process.env.BRAIN_MAX_BODY_BYTES ?? 1024 * 1024);
const PUBLIC_READINESS_ROUTES = new Set(['/health']);

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', err => { if (!done) reject(err); });
  });
}

export function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

export function ok(data = {}, meta = {}, profile = 'local') {
  return { ok: true, data, meta, profile };
}

export function err(type, message, {
  hint = '',
  retry_command = '',
  retryCommand = '',
  retry_delay = null,
  retryDelay = null,
  retry_delay_ms = null,
  retryDelayMs = null,
  risk = {},
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
    profile,
  };
}

export function fail(res, status, type, message, options = {}) {
  send(res, status, err(type, message, options));
  return true;
}


function bearerToken(req) {
  const authorization = String(req?.headers?.authorization ?? '');
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? '';
}

function tokensMatch(provided, required) {
  if (!provided || !required) return false;
  const providedBytes = Buffer.from(provided);
  const requiredBytes = Buffer.from(required);
  return providedBytes.length === requiredBytes.length
    && timingSafeEqual(providedBytes, requiredBytes);
}

export function requestHasValidBearer(req, required) {
  return Boolean(required) && tokensMatch(bearerToken(req), String(required));
}

export function isDashboardRoute(path) {
  return path === '/dashboard'
    || path?.startsWith('/dashboard/')
    || path === '/graph/app'
    || path?.startsWith('/graph/app/')
    || path === '/graph/quality';
}

export function requiredRequestToken(path, env = process.env) {
  const brainToken = String(env.BRAIN_TOKEN ?? '');
  if (brainToken) return brainToken;
  return isDashboardRoute(path) ? String(env.DASHBOARD_TOKEN ?? '') : '';
}

export function isPublicReadinessRequest(method, path) {
  return method === 'GET' && PUBLIC_READINESS_ROUTES.has(path);
}

export function applyCorsAndSecurityGuard({ req, res, method, path, corsAllowedOrigins }) {
  if (method === 'OPTIONS') {
    const origin = req.headers.origin;
    const headers = origin && corsAllowedOrigins.includes(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      : {};
    res.writeHead(204, headers);
    res.end();
    return true;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    const host = req.headers.host;
    if (host) {
      const hostPart = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostPart)) {
        fail(res, 403, 'brain.security', 'cross-site request blocked', {
          hint: 'send mutating requests from localhost',
          risk: { level: 'high', action: 'blocked' },
        });
        return true;
      }
    }

    const origin = req.headers.origin;
    if (origin && !corsAllowedOrigins.includes(origin)) {
      fail(res, 403, 'brain.security', 'cross-site request blocked', {
        hint: 'use an allowed dashboard origin',
        risk: { level: 'high', action: 'blocked' },
      });
      return true;
    }

    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
      fail(res, 403, 'brain.security', 'cross-site request blocked', {
        hint: 'retry from same-origin or no-origin context',
        risk: { level: 'high', action: 'blocked' },
      });
      return true;
    }

  }

  const required = requiredRequestToken(path);
  if (
    required
    && !isPublicReadinessRequest(method, path)
    && !requestHasValidBearer(req, required)
  ) {
    fail(res, 401, 'brain.auth', 'unauthorized', {
      hint: 'provide an Authorization: Bearer header',
      risk: { level: 'medium', action: 'authenticate' },
    });
    return true;
  }

  return false;
}
