#!/usr/bin/env node
/**
 * idctl entrypoint.
 *
 *   idctl                 → launch the reactive TUI (default)
 *   idctl status [--json] → print a one-shot fleet snapshot and exit (no TTY needed)
 *   idctl --team <name>   → pin the active team
 *   idctl --manager <url> → override the manager URL
 *   idctl --help          → usage
 */

import { loadConfig, type Config } from './config.ts';
import { resolveConfigPath } from './settings/paths.ts';
import { loadSettings, resolveManagerKey } from './settings/store.ts';
import { IDCTL_VERSION } from './version.ts';

interface ParsedArgs {
  command: 'tui' | 'status' | 'help' | 'config' | 'init' | 'upgrade';
  json: boolean;
  check: boolean;
  probe: boolean;
  post: boolean;
  overrides: Partial<Config>;
  configPath?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const overrides: Partial<Config> = {};
  let command: ParsedArgs['command'] = 'tui';
  let json = false;
  let check = false;
  let probe = false;
  let post = false;
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === 'status') command = 'status';
    else if (a === 'config') command = 'config';
    else if (a === 'init') command = 'init';
    else if (a === 'upgrade' || a === 'update' || a === 'self-update') command = 'upgrade';
    else if (a === 'help' || a === '--help' || a === '-h') command = 'help';
    else if (a === '--json') json = true;
    else if (a === '--check') check = true;
    else if (a === '--probe') probe = true; // internal: health probe
    else if (a === '--post') post = true; // internal: post-update greeting
    else if (a === '--team' || a === '-t') overrides.team = args[++i];
    else if (a === '--manager' || a === '-m') overrides.managerUrl = args[++i];
    else if (a === '--config' || a === '-c') configPath = args[++i];
    else if (a.startsWith('--team=')) overrides.team = a.slice(7);
    else if (a.startsWith('--manager=')) overrides.managerUrl = a.slice(10);
    else if (a.startsWith('--config=')) configPath = a.slice(9);
    // --from=/--to= on the internal --post verb are ignored here.
  }
  return { command, json, check, probe, post, overrides, configPath };
}

/**
 * Build the effective Config, layering (highest→lowest):
 *   manager: explicit --manager flag → MANAGER_URL env → saved defaultManager
 *            profile → built-in (127.0.0.1:4100).
 *   team:    explicit --team flag → ID_TEAM env → manager profile.team →
 *            saved defaultTeam ("default", the repo's shipped team).
 * So out-of-the-box idctl is scoped to the default team, not unscoped.
 */
function buildConfig(p: ParsedArgs): Config {
  const overrides = { ...p.overrides };
  const envUrl = process.env.MANAGER_URL?.trim();
  const envTeam = process.env.ID_TEAM?.trim();
  const settings = loadSettings(resolveConfigPath(p.configPath));
  if (!overrides.managerUrl && !envUrl) {
    const def = settings.managers.find((m) => m.name === settings.defaultManager);
    if (def) {
      overrides.managerUrl = def.url;
      if (overrides.team === undefined && !envTeam) overrides.team = def.team;
      overrides.apiKey = resolveManagerKey(def);
    }
  }
  // Scope to the configured default team when nothing more specific is set.
  if (overrides.team === undefined && !envTeam) {
    overrides.team = settings.defaultTeam ?? 'default';
  }
  return loadConfig(overrides);
}

const HELP = `idctl — ID Agents Control Center  v${IDCTL_VERSION}

USAGE
  idctl [options]            Launch the live terminal dashboard (default)
  idctl status [--json]      Print a one-shot fleet snapshot and exit
  idctl config               Show the config file path + saved profiles
  idctl init                 Create an empty config file if none exists
  idctl upgrade              Explain how idctl is updated with the unified app
  idctl --help

OPTIONS
  -t, --team <name>          Active team (default: $ID_TEAM or manager default)
  -m, --manager <url>        Manager daemon URL (default: $MANAGER_URL, the saved
                             default profile, or http://127.0.0.1:4100)
  -c, --config <path>        Config file (default: $IDCTL_CONFIG or
                             ~/.config/idctl/config.json)
      --json                 (with status) emit raw JSON

ENV
  MANAGER_URL, ID_TEAM, IDCTL_CONFIG, IDCTL_REFRESH_MS

In the TUI: [Tab]/1-9/0 switch views · [r] refresh · [t] team · [?] help · [q] quit
Settings live under view 0: connect managers + inference backends, assign models.`;

async function main() {
  const parsed = parseArgs(process.argv);
  const { command, json } = parsed;

  if (command === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./headless/upgrade-cmd.ts');
    process.exit(await runUpgrade(parsed));
  }
  if (command === 'config' || command === 'init') {
    const { runConfig } = await import('./headless/config-cmd.ts');
    process.exit(runConfig(parsed.configPath, command === 'init'));
  }

  const cfg = buildConfig(parsed);

  if (command === 'status') {
    const { runStatus } = await import('./headless/status.ts');
    process.exit(await runStatus(cfg, { json }));
  }

  // Interactive TUI. Ink needs a TTY for keyboard input (raw mode). If stdin
  // isn't a TTY (piped/CI), fall back to the headless snapshot rather than
  // crashing with "Raw mode is not supported".
  if (!process.stdin.isTTY) {
    process.stderr.write('idctl: no TTY detected — printing a snapshot instead. Use `idctl status` for this on purpose.\n\n');
    const { runStatus } = await import('./headless/status.ts');
    process.exit(await runStatus(cfg, { json: false }));
  }

  const [{ render }, React, { App }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./app/App.tsx'),
  ]);
  const { waitUntilExit } = render(React.createElement(App, { config: cfg }), {
    exitOnCtrlC: false, // we manage quit ourselves so 'q' and Ctrl-C both clean up
  });
  await waitUntilExit();
}

main().catch((err) => {
  process.stderr.write(`idctl fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
