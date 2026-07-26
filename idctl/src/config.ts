/**
 * Runtime configuration for idctl.
 *
 * Everything is resolved from environment variables (matching the conventions
 * the id-agents manager and the idagents-admin-control skill already use) with
 * CLI-flag overrides layered on top. We deliberately default to 127.0.0.1
 * rather than `localhost`: on macOS `localhost` often resolves to ::1 (IPv6)
 * first, and the manager binds IPv4 — so `localhost` can silently hit a
 * different process (see idagents-admin-control SKILL.md, "IPv6 vs IPv4").
 */

export interface Config {
  /** Manager daemon base URL, e.g. http://127.0.0.1:4100 */
  managerUrl: string;
  /** Optional default team; sent as the X-Id-Team header on every request. */
  team?: string;
  /** Optional manager API token; sent as Authorization: Bearer when present. */
  apiKey?: string;
  /**
   * Send `X-Id-Admin: 1` on requests. The manager grants admin only to
   * loopback callers that set this header and, when configured, present the
   * matching bearer (admin-gated routes: skill install, MCP attach, team
   * auto-create). idctl is the operator's local control center talking to
   * 127.0.0.1, so it is a legitimate admin client.
   */
  admin?: boolean;
  /** How often (ms) the fleet/agents snapshot is re-polled. */
  refreshMs: number;
  /** Long-poll window (s, clamped 0..30 by the daemon) for /events + /query. */
  waitSeconds: number;
}

function envUrl(): string {
  const raw = process.env.MANAGER_URL?.trim();
  if (!raw) return 'http://127.0.0.1:4100';
  // Normalize localhost -> 127.0.0.1 to dodge the IPv6 resolution trap.
  return raw.replace('://localhost', '://127.0.0.1').replace(/\/+$/, '');
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    managerUrl: envUrl(),
    team: process.env.ID_TEAM?.trim() || undefined,
    refreshMs: Number(process.env.IDCTL_REFRESH_MS) || 3000,
    waitSeconds: 25,
  };
  return { ...base, ...stripUndefined(overrides) };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
