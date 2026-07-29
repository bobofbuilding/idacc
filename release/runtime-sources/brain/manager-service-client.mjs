function validManagerServiceToken(token) {
  const bytes = Buffer.byteLength(token, 'utf8');
  return bytes >= 32
    && bytes <= 4096
    && !/[\u0000-\u0020\u007f]/u.test(token);
}

function withoutPrincipalHeaders(extra = {}) {
  const headers = { ...extra };
  for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (normalized === 'authorization' || normalized === 'x-id-service') {
      delete headers[name];
    }
  }
  return headers;
}

/**
 * Build the managed Brain service principal for Manager GET/HEAD requests.
 * The base token remains process-local and is never placed in a URL.
 */
export function managerServiceHeaders(extra = {}, env = process.env) {
  const headers = withoutPrincipalHeaders(extra);
  const token = String(env.IDACC_MANAGER_SERVICE_TOKEN ?? '');
  if (!token) return headers;
  if (!validManagerServiceToken(token)) {
    throw new Error('IDACC_MANAGER_SERVICE_TOKEN is malformed');
  }
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
    'X-Id-Service': 'brain',
  };
}

export function managerServiceCredentialAvailable(env = process.env) {
  const token = String(env.IDACC_MANAGER_SERVICE_TOKEN ?? '');
  return validManagerServiceToken(token);
}
