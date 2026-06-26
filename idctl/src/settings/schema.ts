/**
 * On-disk config schema for idctl. Single source of truth for the shape of
 * ~/.config/idctl/config.json. No runtime logic here.
 */

export type ConfigSchemaVersion = 1;

export interface IdctlConfig {
  /** On-disk schema version; bump on incompatible changes to enable migration. */
  version: ConfigSchemaVersion;
  /** Saved id-agents manager connections. */
  managers: ManagerProfile[];
  /** Inference backend connections (cloud + local). */
  providers: ProviderProfile[];
  /**
   * External MCP servers the operator has registered (the "Modules" catalog).
   * These are definitions; attaching one to an agent writes it to that agent's
   * metadata.mcpServers via the manager and takes effect on rebuild.
   */
  mcpServers?: McpServerProfile[];
  /** Name of the manager in `managers` to use by default. */
  defaultManager?: string;
  /** Self-update behaviour. */
  update?: UpdateSettings;
  /**
   * Which agent is each team's coordinator ("lead"). team → agent name. The
   * coordinator is the default target when you "talk to the manager". Lets you
   * name your lead agent anything — "lead" is just the fallback convention.
   */
  coordinators?: Record<string, string>;
  /**
   * Top of the lead hierarchy (#10): the primary coordinator across teams. When
   * several teams each have a lead, this names the one above them — it delegates
   * to the per-team coordinators (which delegate to their workers).
   */
  primaryCoordinator?: { team: string; agent: string };
  /**
   * Middle of the lead hierarchy: secondary leads that sit BETWEEN the primary
   * coordinator and the per-team coordinators. Each owns a set of teams whose
   * leads relay up to it; it delegates down to those team leads/agents, sequences
   * their results, and relays a consolidated status up to the primary. The org-sync
   * loop composes each agent's goals file from this structure. (Default: researcher
   * + coder on the default team.)
   */
  secondaryLeads?: { agent: string; team: string; leadsTeams: string[] }[];
  /**
   * Reactive org-sync: continuously compose each agent's goals & instructions file from
   * the lead hierarchy + the brain's team-instruction memories. `enabled` defaults to on;
   * `autoRebuild` (default on) lets it rebuild an agent when its goals change AND it's idle.
   */
  orgSync?: { enabled?: boolean; autoRebuild?: boolean };
  /**
   * Disabled-by-default background goal driver. When enabled, only active goals whose own
   * autopilot flag is true can spawn gap-fill tasks and publish team instructions.
   */
  goalDriver?: GoalDriverSettings;
  /**
   * The team idctl scopes to on startup (the repo's shipped team). Defaults to
   * "default" — the canonical id-agents team (configs/default.yaml).
   */
  defaultTeam?: string;
  /**
   * Teams idctl presents (switcher + All Teams are filtered to this allowlist,
   * plus the active team). Ships as just the default team; "load"/"new" team
   * actions append to it. Set to null/[] to disable filtering (show all).
   */
  knownTeams?: string[];
  /**
   * App-side skill categorization overlay — auto-derived tags for library skills
   * whose SKILL.md frontmatter has no `metadata.tags`, keyed by skill name. Merged
   * into the Capabilities catalog display + tag search; NEVER written back to the
   * skill file. Cached so auto-categorization runs once per skill. Client-side only.
   */
  skillTags?: Record<string, string[]>;
  /**
   * App-side Kanban lane overlay for tasks — task ref → fine-grained lane
   * (backlog/holding/needs-adjustment/under-review/rework/…). The manager only
   * knows todo/doing/done; this refines the board within those. Client-side only.
   */
  taskLanes?: Record<string, string>;
  /**
   * App-side dependency graph for tasks — task ref → the refs it depends on
   * (its prerequisites). The manager has no deps field, so plan decomposition
   * records the "after #N" edges here and the board surfaces "blocked by …".
   * Client-side only.
   */
  taskDeps?: Record<string, string[]>;
  /**
   * App-side "adjustment loop" state for tasks blocked on a USER decision (a question
   * in the Inbox): task ref → { state, at }. state is 'needs-adjustment' (decision
   * raised) | 'under-review' (user responded) | 'rework' (re-blocked after review); `at`
   * is when that state was set (drives the auto-resolve once a block passes). Drives the
   * board's Adjustment-Loop columns; cleared when the block passes. Client-side only.
   */
  taskReview?: Record<string, { state: string; at: number }>;
  /** Local project tracker entries (the "Projects" page). Client-side only. */
  projects?: ProjectEntry[];
  /**
   * Folder whose immediate subdirectories are tracked as projects (the "Sync
   * from workspace" feature). Defaults to the id-agents `$ID_WORKSPACE_DIR/
   * projects` dir, auto-detected on first run. Client-side only.
   */
  projectsRoot?: string;
  /**
   * Optional local image generator, preferred over the cloud (OpenRouter) image
   * provider for image creation in chat. `url` is the server base (e.g.
   * http://127.0.0.1:7860 for Automatic1111, or an OpenAI-compatible base). When
   * unset, image generation falls back to the cloud provider. Client-side only.
   */
  imageServer?: ImageServerConfig;
  /**
   * Preferred local-model (ollama) concurrency — how many local inferences the
   * manager runs at once. Re-applied to the manager on connect so it survives a
   * manager restart (the manager itself doesn't persist it). Client-side only.
   */
  localConcurrency?: number;
}

/** A local image-generation backend. */
export interface ImageServerConfig {
  url: string;
  /** API style: 'auto1111' = Stable Diffusion WebUI /sdapi/v1/txt2img; 'openai' = /v1/images/generations. */
  type: 'auto1111' | 'openai';
  /** Optional model/checkpoint name (openai-style image APIs). */
  model?: string;
}

export type ProjectStatus = 'active' | 'paused' | 'blocked' | 'done';

/** A tracked project (local to the control center — not a manager concept). */
export interface ProjectEntry {
  id: string;
  name: string;
  status: ProjectStatus;
  description?: string;
  /** Optional linked team name. */
  team?: string;
  tags?: string[];
  /** Related URLs (repo, dashboard, docs…). */
  links?: string[];
  /** Local folder this project lives in (enables git tracking + README import). */
  path?: string;
  notes?: string;
  /**
   * Checkpoint auto-commit: when a task (or a plan-validation task) completes in
   * this project's team and the repo has uncommitted changes, the app requests a
   * commit & push (AI-drafted message, throttled). Needs a `team` + `path`.
   */
  autoCommit?: 'off' | 'task' | 'plan';
  createdAt: number;
  updatedAt: number;
}

export interface UpdateSettings {
  /** Auto-apply a staged update on next launch. Default true. */
  autoUpgrade: boolean;
  /** GitHub repo to poll, "owner/name". Default "bobofbuilding/id-agent-control-center". */
  updateRepo?: string;
  /** Self-hosted version.json URL; when set, used instead of GitHub. */
  updateManifestUrl?: string;
  /** Hours between background checks. Default 12. */
  checkIntervalHours: number;
}

export interface GoalDriverSettings {
  enabled?: boolean;
  cadenceMs?: number;
  maxOpenTasksPerGoal?: number;
}

export function defaultUpdateSettings(): UpdateSettings {
  return { autoUpgrade: true, updateRepo: 'bobofbuilding/id-agent-control-center', checkIntervalHours: 1 };
}

/** The id-agents repo's canonical default team. */
export const DEFAULT_TEAM = 'default';

export interface ManagerProfile {
  /** Unique, user-facing id, e.g. "local", "prod". */
  name: string;
  /** Base URL, e.g. "http://127.0.0.1:4100". */
  url: string;
  /** Team slug → sent as the X-Id-Team header. */
  team?: string;
  /** Optional API token (sent as Authorization: Bearer). Plaintext on disk (file 0600). */
  apiKey?: string;
}

export type ProviderKind = 'ollama' | 'lmstudio' | 'openai-compatible' | 'anthropic' | 'openai';

export interface ProviderProfile {
  /** Unique, user-facing id, e.g. "local-ollama", "claude". */
  name: string;
  kind: ProviderKind;
  /**
   * Base URL of the inference endpoint:
   *   ollama            http://127.0.0.1:11434
   *   lmstudio          http://127.0.0.1:1234/v1
   *   openai-compatible http://host:8000/v1
   *   anthropic         https://api.anthropic.com
   *   openai            https://api.openai.com/v1
   */
  baseUrl: string;
  /** API key — local providers usually need none; cloud requires it. Plaintext on disk. */
  apiKey?: string;
  /** Whether the provider is selectable/active. */
  enabled: boolean;
  /** Marks the default inference provider (at most one). */
  default?: boolean;
  /** Last live connect/sync result (cached so models are discoverable offline). */
  lastSync?: ProviderSync;
}

/** Cached outcome of the most recent "Connect & sync" against a provider. */
export interface ProviderSync {
  /** ms epoch of the sync. */
  at: number;
  /** Probe status: live | auth-error | unreachable | error. */
  status: string;
  /** Number of models discovered. */
  modelCount: number;
  /** Discovered model ids (capped). */
  models: string[];
  /** Where the API key was resolved from (cloud providers). */
  keySource?: 'config' | 'env' | 'none';
}

/** MCP server transport. Only serializable kinds cross the agent-spawn boundary. */
export type McpTransport = 'stdio' | 'http' | 'sse';

/**
 * A registered MCP server definition. `enabled` lets the operator keep a
 * server in the catalog without attaching it. Plaintext on disk (file 0600);
 * env/headers may carry tokens.
 */
export interface McpServerProfile {
  /** Unique, user-facing id, becomes the SDK mcpServers key. */
  name: string;
  transport: McpTransport;
  /** stdio: executable + args + extra env. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http/sse: endpoint URL + headers. */
  url?: string;
  headers?: Record<string, string>;
  /** Whether the server is selectable for attachment. */
  enabled: boolean;
}

/** Sensible default endpoint hint per transport. */
export function defaultMcpEndpoint(transport: McpTransport): string {
  return transport === 'stdio' ? 'npx' : 'http://127.0.0.1:8000/mcp';
}

/** The empty config returned on first run (no file yet). */
export function emptyConfig(): IdctlConfig {
  return {
    version: 1,
    managers: [],
    providers: [],
    update: defaultUpdateSettings(),
    defaultTeam: DEFAULT_TEAM,
    knownTeams: [DEFAULT_TEAM],
  };
}

/** Sensible default baseUrl for a freshly-created provider of each kind. */
export function defaultBaseUrl(kind: ProviderKind): string {
  switch (kind) {
    case 'ollama':
      return 'http://127.0.0.1:11434';
    case 'lmstudio':
      return 'http://127.0.0.1:1234/v1';
    case 'openai-compatible':
      return 'http://127.0.0.1:8000/v1';
    case 'anthropic':
      return 'https://api.anthropic.com';
    case 'openai':
      return 'https://api.openai.com/v1';
  }
}

/** Whether a provider kind normally requires an API key. */
export function kindNeedsKey(kind: ProviderKind): boolean {
  return kind === 'anthropic' || kind === 'openai';
}
