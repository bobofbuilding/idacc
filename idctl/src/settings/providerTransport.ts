export interface ProviderTransportDecision {
  ok: boolean;
  normalizedUrl?: string;
  loopback: boolean;
  error?: string;
}

const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(error: string): ProviderTransportDecision {
  return { ok: false, loopback: false, error };
}

function rawAuthorityHost(value: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value);
  if (!match) return null;
  const authority = match[1];
  if (!authority || authority.includes('@') || authority.includes('\\') || /\s/.test(authority)) return null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || !/^(?::\d+)?$/.test(authority.slice(close + 1))) return null;
    return authority.slice(0, close + 1).toLowerCase();
  }
  const colon = authority.lastIndexOf(':');
  if (colon >= 0 && !/^\d+$/.test(authority.slice(colon + 1))) return null;
  const host = colon >= 0 ? authority.slice(0, colon) : authority;
  return host.toLowerCase();
}

/**
 * Canonical transport boundary for inference providers.
 *
 * Remote credentials may travel only over HTTPS. Plain HTTP is limited to an
 * exact, explicitly spelled loopback host; URL credentials, queries and
 * fragments are rejected instead of silently stripped.
 */
export function providerTransportDecision(input: string): ProviderTransportDecision {
  const value = String(input ?? '').trim();
  if (!value) return fail('Enter a provider URL.');
  if (value.includes('?')) return fail('Provider URLs cannot contain a query string.');
  if (value.includes('#')) return fail('Provider URLs cannot contain a fragment.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('Enter a valid provider URL.');
  }
  if (url.username || url.password) {
    return fail('Put credentials in the API key field, not in the provider URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('Provider URLs must use HTTPS, or HTTP on an exact loopback host.');
  }
  if (!url.hostname) return fail('Provider URLs must include a host.');

  const rawHost = rawAuthorityHost(value);
  if (!rawHost) return fail('Enter a canonical provider URL without credentials or an ambiguous host.');
  const loopback = LOOPBACK_HTTP_HOSTS.has(rawHost);
  if (url.protocol === 'http:' && !loopback) {
    return fail('Plain HTTP providers are allowed only on exact localhost, 127.0.0.1, or [::1].');
  }

  return {
    ok: true,
    normalizedUrl: url.toString().replace(/\/+$/, ''),
    loopback,
  };
}

export function normalizeProviderBaseUrl(input: string): string {
  const decision = providerTransportDecision(input);
  if (!decision.ok || !decision.normalizedUrl) {
    throw new Error(decision.error || 'Provider URL is not allowed.');
  }
  return decision.normalizedUrl;
}

export function providerTransportAllowed(input: string): boolean {
  return providerTransportDecision(input).ok;
}

export function providerUrlIsLoopback(input: string): boolean {
  const decision = providerTransportDecision(input);
  return decision.ok && decision.loopback;
}
