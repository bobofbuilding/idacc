export type BrainDashboardRequestHeaders = Record<string, string>;

export type BrainDashboardRequestDecision = {
  allowed: boolean;
  requestHeaders: BrainDashboardRequestHeaders;
};

export type BrainDashboardWindowHandle = {
  isDestroyed(): boolean;
  destroy(): void;
};

function withoutAuthorizationHeader(
  requestHeaders: BrainDashboardRequestHeaders = {},
): BrainDashboardRequestHeaders {
  const nextHeaders = { ...requestHeaders };
  for (const name of Object.keys(nextHeaders)) {
    if (name.toLowerCase() === 'authorization') delete nextHeaders[name];
  }
  return nextHeaders;
}

export function denyBrainDashboardRequest(
  requestHeaders: BrainDashboardRequestHeaders = {},
): BrainDashboardRequestDecision {
  return {
    allowed: false,
    requestHeaders: withoutAuthorizationHeader(requestHeaders),
  };
}

export class BrainDashboardChildWindowRegistry {
  private readonly windows = new Set<BrainDashboardWindowHandle>();

  track(window: BrainDashboardWindowHandle): () => void {
    this.windows.add(window);
    return () => this.windows.delete(window);
  }

  destroyAll(): void {
    const tracked = [...this.windows];
    this.windows.clear();
    for (const window of tracked) {
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch {
        // The retired session remains deny-all if a native window already died.
      }
    }
  }

  size(): number {
    return this.windows.size;
  }
}

export function canonicalBrainDashboardOrigin(value: string): string {
  const url = new URL(String(value || '').trim());
  const hostname = url.hostname.toLowerCase();
  const port = Number(url.port);
  if (
    url.protocol !== 'http:'
    || hostname !== '127.0.0.1'
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error('Brain dashboard access requires an uncredentialed 127.0.0.1 HTTP origin');
  }
  return url.origin;
}

/**
 * The Brain dashboard is a bearer-authorized, privileged surface. Navigation
 * stays inside its exact loopback origin; external URLs are denied here rather
 * than handed to the system browser, because script-driven navigation cannot be
 * distinguished reliably from a trusted user gesture.
 */
export function brainDashboardNavigationAllowed(
  targetUrl: string,
  allowedOrigin: string,
): boolean {
  const canonicalOrigin = canonicalBrainDashboardOrigin(allowedOrigin);
  try {
    const target = new URL(targetUrl);
    return !target.username
      && !target.password
      && target.origin === canonicalOrigin;
  } catch {
    return false;
  }
}

export function authorizeBrainDashboardRequest(
  requestUrl: string,
  allowedOrigin: string,
  authorizationHeader: string,
  requestHeaders: BrainDashboardRequestHeaders = {},
): BrainDashboardRequestDecision {
  const canonicalOrigin = canonicalBrainDashboardOrigin(allowedOrigin);
  if (!/^Bearer [A-Za-z0-9_-]{32,}$/.test(authorizationHeader)) {
    throw new Error('Brain dashboard authorization is unavailable');
  }

  const nextHeaders = withoutAuthorizationHeader(requestHeaders);

  const allowed = brainDashboardNavigationAllowed(requestUrl, canonicalOrigin);
  if (allowed) nextHeaders.Authorization = authorizationHeader;
  return { allowed, requestHeaders: nextHeaders };
}
