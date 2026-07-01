/**
 * Managed subscription auth for the CLI runtimes IDACC can operate today. These
 * use the CLIs' OAuth login, NOT metered API keys — so an agent on the matching
 * runtime runs on the user's subscription with no key stored in IDACC.
 *
 *   claude auth status | login | logout   → Claude (claude.ai) subscription
 *   codex  login status | login | logout  → ChatGPT subscription
 *   cursor-agent status | login | logout  → Cursor subscription
 *
 * status is read-only; signin spawns the CLI which opens the browser for the
 * user to authenticate (we never handle credentials ourselves).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';

const execFileP = promisify(execFile);

/** Candidate CLI dirs (GUI apps inherit a minimal PATH). */
function cliDirs(): string[] {
  const home = homedir();
  return ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin', ...(process.env.PATH ? process.env.PATH.split(':') : [])];
}
/** GUI apps inherit a minimal PATH — add the usual CLI locations so claude/codex resolve. */
function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: cliDirs().join(':') };
}
/** Is a CLI binary installed (resolvable on the augmented PATH)? */
function cliInstalled(bin: string): boolean {
  return cliDirs().some((d) => existsSync(`${d}/${bin}`));
}
/** Install hint shown when a subscription CLI isn't present. */
const INSTALL_HINT: Record<string, string> = {
  cursor: 'cursor-agent not installed — install the Cursor CLI: curl https://cursor.com/install -fsS | bash',
  claude: 'claude CLI not installed',
  chatgpt: 'codex CLI not installed',
};

/** The official one-line installer per provider's CLI (run in the user's Terminal). */
const INSTALL_CMD: Partial<Record<SubProvider, string>> = {
  cursor: 'curl https://cursor.com/install -fsS | bash',
};

/**
 * Kick off a CLI install. Opens the user's Terminal and runs the vendor's
 * official installer there — visible and abortable, the user's own shell — and
 * returns the command either way so the UI can fall back to clipboard if macOS
 * blocks Terminal automation.
 */
export async function subsInstall(provider: SubProvider): Promise<{ ok: boolean; ran: boolean; command?: string; error?: string }> {
  const cmd = INSTALL_CMD[provider];
  if (!cmd) return { ok: false, ran: false, error: 'no installer available for this provider' };
  try {
    const osa = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
    await execFileP('osascript', ['-e', osa], { timeout: 8000 });
    return { ok: true, ran: true, command: cmd };
  } catch (e) {
    // Automation likely blocked — let the renderer copy the command instead.
    return { ok: false, ran: false, command: cmd, error: e instanceof Error ? e.message : String(e) };
  }
}

export type SubProvider = 'claude' | 'chatgpt' | 'cursor';

export interface SubStatus {
  provider: SubProvider;
  loggedIn: boolean;
  /** Whether the provider's CLI is installed at all. */
  installed?: boolean;
  plan?: string;
  email?: string;
  method?: string;
  detail?: string;
}

/** login / logout CLI invocations per subscription provider. */
const LOGIN_CMD: Record<SubProvider, [string, string[]]> = {
  claude: ['claude', ['auth', 'login']],
  chatgpt: ['codex', ['login']],
  cursor: ['cursor-agent', ['login']],
};
const LOGOUT_CMD: Record<SubProvider, [string, string[]]> = {
  claude: ['claude', ['auth', 'logout']],
  chatgpt: ['codex', ['logout']],
  cursor: ['cursor-agent', ['logout']],
};

async function claudeStatus(): Promise<SubStatus> {
  try {
    const { stdout } = await execFileP('claude', ['auth', 'status'], { env: cliEnv(), timeout: 8000 });
    const j = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string };
    return { provider: 'claude', loggedIn: !!j.loggedIn, plan: j.subscriptionType, email: j.email, method: j.authMethod };
  } catch (e: unknown) {
    return { provider: 'claude', loggedIn: false, detail: e instanceof Error ? e.message : String(e) };
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
 * Never throws — returns {} if the file/token is absent or malformed (e.g. an
 * API-key login, which carries no id_token).
 */
function codexAccount(): { email?: string; plan?: string } {
  try {
    const file = join(codexHome(), 'auth.json');
    if (!existsSync(file)) return {};
    const auth = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: { id_token?: string } };
    const idToken = auth.tokens?.id_token;
    if (!idToken || idToken.split('.').length !== 3) return {};
    // JWT payload is the middle base64url segment; decode just its claims.
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
  try {
    const { stdout, stderr } = await execFileP('codex', ['login', 'status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in/i.test(out);
    // Only surface identity when actually signed in (don't read stale tokens otherwise).
    const acct = loggedIn ? codexAccount() : {};
    return { provider: 'chatgpt', loggedIn, plan: acct.plan, email: acct.email, detail: out };
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    return { provider: 'chatgpt', loggedIn: false, detail: (err.stdout || err.message || '').trim() };
  }
}

/** Cursor subscription via `cursor-agent status` (Pro/Business OAuth). */
async function cursorStatus(): Promise<SubStatus> {
  if (!cliInstalled('cursor-agent')) {
    return { provider: 'cursor', loggedIn: false, installed: false, detail: INSTALL_HINT.cursor };
  }
  try {
    const { stdout, stderr } = await execFileP('cursor-agent', ['status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    const loggedIn = /logged in|authenticated|signed in/i.test(out) && !/not logged in|not authenticated|signed out/i.test(out);
    const email = out.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
    return { provider: 'cursor', loggedIn, installed: true, email, detail: out.slice(0, 200) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    return { provider: 'cursor', loggedIn: false, installed: true, detail: (err.stdout || err.message || '').trim() };
  }
}

export async function subsStatus(): Promise<{ claude: SubStatus; chatgpt: SubStatus; cursor: SubStatus }> {
  const [claude, chatgpt, cursor] = await Promise.all([claudeStatus(), codexStatus(), cursorStatus()]);
  return { claude, chatgpt, cursor };
}

/**
 * Launch the CLI OAuth login. The CLI opens the browser (we also open any URL
 * it prints, as a fallback). Resolves once the flow is underway — the user
 * completes sign-in in the browser, then re-checks status.
 */
export function subsSignin(provider: SubProvider): Promise<{ started: boolean; url?: string; error?: string }> {
  const [bin, args] = LOGIN_CMD[provider] ?? LOGIN_CMD.claude;
  if (!cliInstalled(bin)) {
    return Promise.resolve({ started: false, error: INSTALL_HINT[provider] ?? `${bin} is not installed` });
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
  const [bin, args] = LOGOUT_CMD[provider] ?? LOGOUT_CMD.claude;
  try {
    await execFileP(bin, args, { env: cliEnv(), timeout: 15000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
