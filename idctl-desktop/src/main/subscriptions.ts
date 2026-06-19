/**
 * Subscription auth for the Claude / ChatGPT runtimes. These use the CLIs'
 * OAuth login (claude.ai / ChatGPT), NOT the metered API — so an agent on the
 * claude-* or codex runtime runs on the user's subscription with no API key.
 *
 *   claude auth status | login | logout   → Claude (claude.ai) subscription
 *   codex  login status | login | logout  → ChatGPT subscription
 *
 * status is read-only; signin spawns the CLI which opens the browser for the
 * user to authenticate (we never handle credentials ourselves).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
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

async function codexStatus(): Promise<SubStatus> {
  try {
    const { stdout, stderr } = await execFileP('codex', ['login', 'status'], { env: cliEnv(), timeout: 8000 });
    const out = `${stdout}${stderr}`.trim();
    return { provider: 'chatgpt', loggedIn: /logged in/i.test(out), detail: out };
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
