# idctl developer terminal client

`idctl` is an advanced, source-run terminal client for an ID Agents Manager.
It is useful for Manager development, diagnostics, and scripted fleet snapshots.

It is **not** a separately distributed consumer application. Public IDACC
releases contain the signed desktop application, bundled Agent manager, and
bundled Brain together. They do not contain an `idctl` binary, `install.sh`, or
a second update channel.

## Connection model

The terminal client talks to an explicitly reachable Manager HTTP endpoint. In
development, the default is `http://127.0.0.1:4100`; override it with
`--manager`, `MANAGER_URL`, or a saved Manager profile.

The unified desktop application launches its bundled Manager on a private random
loopback port with an ephemeral control credential. `idctl` does not discover or
attach to that private session. Use the desktop interface for a normal consumer
installation, or start a development Manager yourself before using this client.

Connection precedence is:

1. `--manager` and `--team`;
2. `MANAGER_URL` and `ID_TEAM`;
3. the saved default Manager profile; and
4. the developer default `http://127.0.0.1:4100`.

## Run from source

Use the repository-pinned Node and npm versions.

```bash
npm ci --prefix idctl
npm start --prefix idctl

# One-shot, scriptable snapshot:
npm run status --prefix idctl
npm run status --prefix idctl -- --json

# Explicit development Manager and team:
npm start --prefix idctl -- --manager http://127.0.0.1:4100 --team default
```

The client never edits a Manager source checkout. Actions are sent through the
Manager API, so destructive operations still require the confirmations exposed
by the terminal interface.

## Commands

```text
idctl [options]            launch the terminal dashboard
idctl status [--json]      print one fleet snapshot
idctl config               show resolved configuration
idctl init                 create an empty configuration
idctl --help               show command help
```

`idctl upgrade` is retained only as a migration message. Standalone self-update
was retired when IDACC adopted one signed update authority for the desktop,
Manager, and Brain.

## Main views

- Dashboard: fleet status, runtime, model, and activity.
- Chat: talk to the selected team lead or a named agent.
- Inbox and Tasks: answer blockers and inspect work.
- Health: probe selected or all agents.
- Identity & Keys: exercise the configured mock or live identity provider.
- Schedule: inspect and change agent check-ins.
- Config and All Teams: operate explicitly connected development Managers.
- Settings: Manager endpoints, model providers, and assignments.

Common keys are `1`–`9`/`0` or `Tab` to switch views, `r` to refresh, `t` to
switch team, `?` for help, and `q` to quit. Destructive actions confirm.

## Configuration

| Variable | Developer default | Purpose |
|---|---|---|
| `MANAGER_URL` | `http://127.0.0.1:4100` | Explicit Manager endpoint |
| `ID_TEAM` | Manager/default profile | Active team |
| `IDCTL_CONFIG` | `~/.config/idctl/config.json` | Terminal-client configuration |
| `IDCTL_REFRESH_MS` | `3000` | Fleet refresh interval |

The configuration directory is created with mode `0700` and the file with mode
`0600`. It may contain Manager profiles and provider settings. Unlike the
consumer desktop application, this developer client does not use Electron
safeStorage; prefer environment variables for development API keys.

Supported provider kinds are Ollama, LM Studio, OpenAI-compatible, Anthropic,
and OpenAI. Model assignments are sent to the connected Manager and may require
an agent restart.

## Development verification

Maintainers can type-check, test, or create a local JavaScript bundle from
source. The repository intentionally contains no standalone binary installer,
standalone app packager, or second self-update implementation.

```bash
npm run typecheck --prefix idctl
npm test --prefix idctl
npm run build:mjs --prefix idctl
```

For the supported consumer downloads, installation, first-run setup, update
policy, and security boundary, see the repository [README](../README.md).
