/**
 * Managed subscription auth for CLI runtimes IDACC can inspect or launch.
 * These use each CLI's own browser/device OAuth flow, not metered API keys, so
 * IDACC never stores or displays provider credentials.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import { runInTerminal } from './system.ts';

const execFileP = promisify(execFile);
const SUBS_STATUS_CACHE_TTL_MS = 60_000;

export type SubProvider = 'claude' | 'chatgpt' | 'cursor' | 'grok' | 'antigravity' | 'copilot' | 'kiro-cli' | 'q';

type LoginMode = 'spawn' | 'terminal';
type CommandSpec = [string, string[]];

interface SubProviderMeta {
  provider: SubProvider;
  runtime: string;
  label: string;
  bin: string;
  appPaths?: string[];
  login?: CommandSpec;
  loginMode?: LoginMode;
  logout?: CommandSpec;
  install?: string;
  installHint: string;
  installOpensApp?: boolean;
  postInstall?: string;
  statusNote?: string;
}

export interface SubStatus {
  provider: SubProvider;
  runtime: string;
  label: string;
  loggedIn: boolean;
  /** Safe account label, such as an email or username. Never a token. */
  account?: string;
  /** Human-readable source for the account label. */
  accountSource?: string;
  /** True when local account evidence exists but the CLI has no safe status command. */
  linked?: boolean;
  /** Whether the provider's CLI is installed at all. */
  installed?: boolean;
  /** Read-only evidence path/source for installed state. */
  installedSource?: string;
  /** Whether IDACC can check sign-in state without opening the interactive CLI. */
  statusSupported?: boolean;
  /** Whether IDACC can launch a sign-in/account-selection flow. */
  loginSupported?: boolean;
  /** Whether IDACC can sign out through a documented non-secret command. */
  logoutSupported?: boolean;
  /** Whether IDACC has a reviewed visible install command for this CLI. */
  installSupported?: boolean;
  plan?: string;
  email?: string;
  method?: string;
  detail?: string;
  postInstall?: string;
  installOpensApp?: boolean;
}

const SUB_PROVIDERS: SubProvider[] = ['claude', 'chatgpt', 'cursor', 'grok', 'antigravity', 'copilot', 'kiro-cli', 'q'];
let subsStatusCache: { at: number; rows: Record<SubProvider, SubStatus> } | null = null;
let subsStatusInflight: Promise<Record<SubProvider, SubStatus>> | null = null;

const SUB_META: Record<SubProvider, SubProviderMeta> = {
  claude: {
    provider: 'claude',
    runtime: 'claude-code-cli',
    label: 'Claude (Anthropic)',
    bin: 'claude',
    login: ['claude', ['auth', 'login']],
    logout: ['claude', ['auth', 'logout']],
    installHint: 'claude CLI not installed',
  },
  chatgpt: {
    provider: 'chatgpt',
    runtime: 'codex',
    label: 'OpenAI (ChatGPT)',
    bin: 'codex',
    login: ['codex', ['login']],
    logout: ['codex', ['logout']],
    installHint: 'codex CLI not installed',
  },
  cursor: {
    provider: 'cursor',
    runtime: 'cursor-cli',
    label: 'Cursor',
    bin: 'cursor-agent',
    login: ['cursor-agent', ['login']],
    logout: ['cursor-agent', ['logout']],
    install: 'curl https://cursor.com/install -fsS | bash',
    installHint: 'cursor-agent not installed',
  },
  grok: {
    provider: 'grok',
    runtime: 'grok',
    label: 'xAI Grok Build',
    bin: 'grok',
    login: ['grok', ['login', '--oauth']],
    logout: ['grok', ['logout']],
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    installHint: 'grok CLI not installed',
    postInstall: 'After install, IDACC will detect the grok binary. Use Manage account in IDACC to launch Grok OAuth.',
    statusNote: 'Installed. IDACC checks Grok sign-in and model availability with `grok models`.',
  },
  antigravity: {
    provider: 'antigravity',
    runtime: 'antigravity',
    label: 'Google Antigravity CLI',
    bin: 'agy',
    login: ['agy', []],
    loginMode: 'terminal',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    installHint: 'agy CLI not installed',
    postInstall: 'After install, IDACC will detect the agy binary. Use Manage account in IDACC to open Antigravity login.',
    statusNote: 'Installed. IDACC checks Antigravity sign-in and model availability with `agy models`.',
  },
  copilot: {
    provider: 'copilot',
    runtime: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    login: ['copilot', ['login']],
    loginMode: 'terminal',
    install: 'npm install -g @github/copilot',
    installHint: 'copilot CLI not installed',
    postInstall: 'After install, IDACC will detect the copilot binary. Use Manage account in IDACC to run copilot login.',
    statusNote: 'Installed. IDACC can launch Copilot login; account switching/listing lives inside the Copilot CLI prompt.',
  },
  'kiro-cli': {
    provider: 'kiro-cli',
    runtime: 'kiro-cli',
    label: 'Kiro CLI',
    bin: 'kiro-cli',
    appPaths: ['/Applications/Kiro.app', '/Applications/Kiro CLI.app'],
    login: ['kiro-cli', ['login']],
    loginMode: 'terminal',
    logout: ['kiro-cli', ['logout']],
    install: 'curl -fsSL https://cli.kiro.dev/install | bash',
    installHint: 'kiro-cli not installed',
    installOpensApp: true,
    postInstall: 'The official macOS installer may open Kiro once to finish CLI setup. IDACC will re-check for kiro-cli after install; sign-in is still a separate action.',
  },
  q: {
    provider: 'q',
    runtime: 'q',
    label: 'Amazon Q CLI (legacy)',
    bin: 'q',
    login: ['q', ['login']],
    loginMode: 'terminal',
    logout: ['q', ['logout']],
    installHint: 'q CLI not installed; current Amazon Q CLI docs point users to Kiro CLI.',
    statusNote: 'Legacy Amazon Q CLI is treated as available when present; Kiro CLI is the current managed path.',
  },
};

/** Candidate CLI dirs (GUI apps inherit a minimal PATH). */
function cliDirs(): string[] {
  const home = homedir();
  return Array.from(new Set([
    '/opt/homebrew/bin',
    `${home}/.local/bin`,
    `${home}/.grok/bin`,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.PATH ? process.env.PATH.split(':') : []),
  ]));
}

/** GUI apps inherit a minimal PATH; add the usual CLI locations. */
function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: cliDirs().join(':') };
}

/** Is a CLI binary installed (resolvable on the augmented PATH)? */
function cliPath(bin: string): string | undefined {
  return cliDirs().map((d) => `${d}/${bin}`).find((p) => existsSync(p));
}

function firstCliPath(bins: string[]): { bin: string; path: string } | undefined {
  for (const bin of bins) {
    const path = cliPath(bin);
    if (path) return { bin, path };
  }
  return undefined;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, homedir());
}

function installEvidence(meta: SubProviderMeta): { installed: boolean; source?: string; detail?: string; cliPath?: string } {
  const binPath = cliPath(meta.bin);
  if (binPath) return { installed: true, source: binPath, detail: `${meta.bin} found at ${binPath}`, cliPath: binPath };
  for (const app of meta.appPaths ?? []) {
    const p = expandHome(app);
    if (existsSync(p)) return { installed: true, source: p, detail: `App installed at ${p}, but ${meta.bin} is not on PATH yet.` };
  }
  return { installed: false };
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandLine([bin, args]: CommandSpec): string {
  return [bin, ...args].map(shellQuote).join(' ');
}

function truncateDetail(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readJsonWithLineComments(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeAccount(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (!s || s.length > 120) return undefined;
  if (/token|secret|bearer|gh[psuor]_|github_pat_|sk-[a-z0-9]/i.test(s)) return undefined;
  return s;
}

function detailForAccount(prefix: string, account?: string): string | undefined {
  return account ? `${prefix}: ${account}` : undefined;
}

function baseStatus(provider: SubProvider, patch: Partial<SubStatus>): SubStatus {
  const meta = SUB_META[provider];
  const evidence = installEvidence(meta);
  return {
    provider,
    runtime: meta.runtime,
    label: meta.label,
    loggedIn: false,
    installed: evidence.installed,
    installedSource: evidence.source,
    statusSupported: false,
    loginSupported: Boolean(meta.login),
    logoutSupported: Boolean(meta.logout),
    installSupported: Boolean(meta.install),
    installOpensApp: meta.installOpensApp,
    postInstall: meta.postInstall,
    detail: evidence.detail ?? meta.statusNote,
    ...patch,
  };
}

function notInstalled(provider: SubProvider): SubStatus {
  const meta = SUB_META[provider];
  return baseStatus(provider, { installed: false, detail: meta.installHint });
}

async function claudeStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.claude.bin)) return notInstalled('claude');
  try {
    const { stdout } = await execFileP('claude', ['auth', 'status'], { env: cliEnv(), timeout: 8000 });
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
    return baseStatus('claude', { loggedIn: !!j.loggedIn, installed: true, statusSupported: true, plan: j.subscriptionType, email: j.email, account: j.email, accountSource: 'claude auth status', method: j.authMethod });
  } catch (e: unknown) {
    return baseStatus('claude', { installed: true, statusSupported: true, detail: e instanceof Error ? truncateDetail(e.message) : truncateDetail(String(e)) });
  }
}

/** codex stores OAuth tokens at $CODEX_HOME/auth.json (default ~/.codex). */
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** Prettify an OpenAI `chatgpt_plan_type` token (best-effort; raw value as fallback). */
function prettyChatgptPlan(t: string): string {
  const map: Record<string, string> = {
    free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro (lite)',
    team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
  };
  return map[t.toLowerCase()] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Best-effort identity for a ChatGPT-authenticated codex install. `codex login
 * status` only prints "Logged in using ChatGPT" — the email and plan live in the
 * OAuth id_token (a JWT) inside ~/.codex/auth.json. We decode ONLY the JWT's
 * identity claims (email + plan); the access/refresh tokens are never read out.
 */
function codexAccount(): { email?: string; plan?: string } {
  try {
    const file = join(codexHome(), 'auth.json');
    if (!existsSync(file)) return {};
    const auth = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { id_token?: string } };
    const idToken = auth.tokens?.id_token;
    if (!idToken || idToken.split('.').length !== 3) return {};
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const authClaim = payload['https://api.openai.com/auth'] as { chatgpt_plan_type?: string } | undefined;
    const planType = authClaim?.chatgpt_plan_type;
    const plan = typeof planType === 'string' && planType ? prettyChatgptPlan(planType) : undefined;
    return { email, plan };
  } catch {
    return {};
  }
}

async function codexStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.chatgpt.bin)) return notInstalled('chatgpt');
  try {
    const { stdout, stderr } = await execFileP('codex', ['login', 'status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in/i.test(out);
    const acct = loggedIn ? codexAccount() : {};
    return baseStatus('chatgpt', { loggedIn, installed: true, statusSupported: true, plan: acct.plan, email: acct.email, account: acct.email, accountSource: acct.email ? 'codex auth token identity claim' : undefined, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus('chatgpt', { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || '') });
  }
}

/** Cursor subscription via `cursor-agent status` (Pro/Business OAuth). */
async function cursorStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.cursor.bin)) return notInstalled('cursor');
  try {
    const { stdout, stderr } = await execFileP('cursor-agent', ['status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in|authenticated|signed in/i.test(out) && !/not logged in|not authenticated|signed out/i.test(out);
    const email = out.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    return baseStatus('cursor', { loggedIn, installed: true, statusSupported: true, email, account: email, accountSource: email ? 'cursor-agent status' : undefined, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus('cursor', { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || '') });
  }
}

function grokAccount(): Pick<SubStatus, 'account' | 'accountSource' | 'email' | 'method' | 'linked' | 'detail'> {
  const auth = readJsonObject(join(homedir(), '.grok', 'auth.json'));
  if (!auth) return {};
  const candidates = Object.values(auth)
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
    .map((v) => ({
      email: safeAccount(v.email),
      method: safeAccount(v.auth_mode),
      createTime: typeof v.create_time === 'string' ? Date.parse(v.create_time) : 0,
    }))
    .filter((v) => v.email);
  candidates.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
  const hit = candidates[0];
  if (!hit?.email) return {};
  return {
    account: hit.email,
    accountSource: 'grok auth cache',
    email: hit.email,
    method: hit.method,
    linked: true,
    detail: detailForAccount('Grok linked account', hit.email),
  };
}

async function grokStatus(): Promise<SubStatus> {
  if (!cliPath(SUB_META.grok.bin)) return notInstalled('grok');
  const account = grokAccount();
  try {
    const { stdout, stderr } = await execFileP('grok', ['models'], { env: cliEnv(), timeout: 15000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /available models/i.test(out) && !/not authenticated|not logged in|signed out|login required/i.test(out);
    return baseStatus('grok', {
      loggedIn,
      installed: true,
      statusSupported: true,
      ...account,
      linked: account.linked && !loggedIn ? true : undefined,
      detail: truncateDetail(out),
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus('grok', {
      installed: true,
      statusSupported: true,
      ...account,
      loggedIn: false,
      detail: truncateDetail(err.stdout || err.stderr || err.message || SUB_META.grok.statusNote || ''),
    });
  }
}

function copilotAccount(): Pick<SubStatus, 'account' | 'accountSource' | 'linked' | 'detail'> {
  const home = process.env.COPILOT_HOME || join(homedir(), '.copilot');
  const cfg = readJsonWithLineComments(join(home, 'config.json'));
  const last = cfg?.lastLoggedInUser;
  const lastUser = last && typeof last === 'object' ? last as Record<string, unknown> : null;
  const login = safeAccount(lastUser?.login);
  const host = safeAccount(lastUser?.host);
  if (!login) return {};
  const account = host && !/^https:\/\/github\.com\/?$/i.test(host) ? `${login} @ ${host.replace(/^https?:\/\//, '')}` : login;
  return {
    account,
    accountSource: 'copilot config',
    linked: true,
    detail: detailForAccount('Copilot linked account', account),
  };
}

function googleAccountHint(): Pick<SubStatus, 'account' | 'accountSource' | 'email' | 'linked' | 'detail'> {
  const cfg = readJsonObject(join(homedir(), '.gemini', 'google_accounts.json'));
  const active = safeAccount(cfg?.active);
  if (!active) return {};
  return {
    account: active,
    accountSource: 'Google account cache',
    email: active,
    linked: true,
    detail: `${active} from Google account cache; Antigravity CLI does not expose a safe non-interactive status/logout command.`,
  };
}

async function antigravityStatus(): Promise<SubStatus> {
  const cli = firstCliPath(['agy', 'antigravity']);
  if (!cli) return notInstalled('antigravity');
  const account = googleAccountHint();
  try {
    const { stdout, stderr } = await execFileP(cli.path, ['models'], { env: cliEnv(), timeout: 15000 });
    const out = `${stdout}${stderr}`.trim();
    const models = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.length <= 120 && !/token|secret|bearer|api[_-]?key/i.test(line));
    const authError = /not authenticated|not logged in|signed out|login required/i.test(out);
    const loggedIn = models.length > 0 && !authError;
    return baseStatus('antigravity', {
      loggedIn,
      installed: true,
      statusSupported: true,
      ...account,
      linked: account.linked && !loggedIn ? true : undefined,
      detail: loggedIn
        ? `agy models returned ${models.length} model${models.length === 1 ? '' : 's'}: ${models.slice(0, 8).join(', ')}`
        : truncateDetail(out || `${cli.bin} detected at ${cli.path}, but no models were returned`),
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = truncateDetail(err.stdout || err.stderr || err.message || SUB_META.antigravity.statusNote || '');
    return baseStatus('antigravity', {
      installed: true,
      statusSupported: true,
      ...account,
      loggedIn: false,
      detail: detail ? `agy models probe failed: ${detail}` : SUB_META.antigravity.statusNote,
    });
  }
}

async function whoamiStatus(provider: 'kiro-cli' | 'q', command: CommandSpec): Promise<SubStatus> {
  const meta = SUB_META[provider];
  const evidence = installEvidence(meta);
  if (!evidence.installed) return notInstalled(provider);
  if (!evidence.cliPath) {
    return baseStatus(provider, {
      installed: true,
      statusSupported: false,
      loginSupported: false,
      logoutSupported: false,
      detail: `${meta.label} is installed, but ${meta.bin} is not on PATH yet. Open the app once or add the CLI to PATH, then re-check.`,
    });
  }
  try {
    const { stdout, stderr } = await execFileP(command[0], command[1], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = Boolean(out) && !/not logged in|not authenticated|signed out|no credentials|login required/i.test(out);
    const email = out.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    return baseStatus(provider, { loggedIn, installed: true, statusSupported: true, email, account: email, accountSource: email ? `${command[0]} ${command[1].join(' ')}` : undefined, detail: truncateDetail(out) });
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return baseStatus(provider, { installed: true, statusSupported: true, detail: truncateDetail(err.stdout || err.stderr || err.message || meta.statusNote || '') });
  }
}

async function cliPresenceStatus(provider: 'copilot'): Promise<SubStatus> {
  const meta = SUB_META[provider];
  if (!cliPath(meta.bin)) return notInstalled(provider);
  const account = copilotAccount();
  return baseStatus(provider, {
    installed: true,
    statusSupported: false,
    loggedIn: false,
    ...account,
    detail: account.detail ?? meta.statusNote,
  });
}

async function providerStatus(provider: SubProvider): Promise<SubStatus> {
  switch (provider) {
    case 'claude': return claudeStatus();
    case 'chatgpt': return codexStatus();
    case 'cursor': return cursorStatus();
    case 'grok': return grokStatus();
    case 'antigravity': return antigravityStatus();
    case 'kiro-cli': return whoamiStatus('kiro-cli', ['kiro-cli', ['whoami']]);
    case 'q': return whoamiStatus('q', ['q', ['whoami']]);
    case 'copilot':
      return cliPresenceStatus(provider);
  }
}

export function invalidateSubsStatusCache(): void {
  subsStatusCache = null;
}

export async function subsStatus(force = false): Promise<Record<SubProvider, SubStatus>> {
  if (!force && subsStatusCache && Date.now() - subsStatusCache.at < SUBS_STATUS_CACHE_TTL_MS) {
    return subsStatusCache.rows;
  }
  if (!force && subsStatusInflight) return subsStatusInflight;
  subsStatusInflight = Promise.all(SUB_PROVIDERS.map(async (provider) => [provider, await providerStatus(provider)] as const))
    .then((rows) => {
      const result = Object.fromEntries(rows) as Record<SubProvider, SubStatus>;
      subsStatusCache = { at: Date.now(), rows: result };
      return result;
    })
    .finally(() => { subsStatusInflight = null; });
  return subsStatusInflight;
}

/**
 * Kick off a visible CLI install. Opens the user's Terminal and runs the vendor's
 * official installer there — visible and abortable — and returns the command either
 * way so the UI can fall back to clipboard if macOS blocks Terminal automation.
 */
export async function subsInstall(provider: SubProvider): Promise<{ ok: boolean; ran: boolean; command?: string; error?: string; postInstall?: string; installOpensApp?: boolean }> {
  const meta = SUB_META[provider];
  if (!meta?.install) return { ok: false, ran: false, error: 'no installer available for this provider' };
  const r = await runInTerminal(meta.install);
  return { ok: r.ok, ran: r.ran, command: r.command, error: r.error, postInstall: meta.postInstall, installOpensApp: meta.installOpensApp };
}

/**
 * Launch the CLI OAuth/login flow. For fully non-interactive status/login CLIs we
 * spawn and open printed URLs; for TUI-first CLIs we open a real Terminal.
 */
export function subsSignin(provider: SubProvider): Promise<{ started: boolean; url?: string; command?: string; error?: string }> {
  const meta = SUB_META[provider];
  if (!meta?.login) return Promise.resolve({ started: false, error: 'no sign-in command available for this provider' });
  const [bin, args] = meta.login;
  if (!cliPath(bin)) {
    const evidence = installEvidence(meta);
    const detail = evidence.installed
      ? `${meta.label} is installed, but ${bin} is not on PATH yet. Open the app once or update PATH, then re-check.`
      : (meta.installHint ?? `${bin} is not installed`);
    return Promise.resolve({ started: false, error: detail });
  }
  if (meta.loginMode === 'terminal') {
    const cmd = commandLine(meta.login);
    return runInTerminal(cmd).then((r) => ({ started: r.ran, command: r.command, error: r.ran ? undefined : r.error }));
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env: cliEnv() });
    } catch (e) {
      return resolve({ started: false, error: e instanceof Error ? e.message : String(e) });
    }
    let url: string | undefined;
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve({ started: true, url });
      }
    };
    const scan = (buf: Buffer) => {
      const m = buf.toString().match(/https?:\/\/[^\s'"]+/);
      if (m && !url) {
        url = m[0];
        void shell.openExternal(url).catch(() => {});
        finish();
      }
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        resolve({ started: false, error: e.message });
      }
    });
    // If the CLI opened the browser itself without printing a URL, report started.
    setTimeout(finish, 6000);
  });
}

export async function subsSignout(provider: SubProvider): Promise<{ ok: boolean; error?: string }> {
  const meta = SUB_META[provider];
  if (!meta?.logout) return { ok: false, error: 'no sign-out command available for this provider' };
  const [bin, args] = meta.logout;
  try {
    await execFileP(bin, args, { env: cliEnv(), timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
