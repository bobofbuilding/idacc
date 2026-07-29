'use strict';

const crossSpawn = require('cross-spawn');

const RESULT_PREFIX = 'IDACC_MCP_PROBE_RESULT\t';
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

function boundedTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(parsed)));
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function publish(result) {
  const encoded = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
  process.stdout.write(`${RESULT_PREFIX}${encoded}\n`);
}

if (process.env.IDACC_MCP_PROBE_RUNNER !== '1') {
  process.exitCode = 1;
} else {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  if (
    typeof command !== 'string'
    || command.length < 1
    || command.length > 32 * 1024
    || command.includes('\0')
    || args.length > 4_096
    || args.some((argument) => (
      typeof argument !== 'string'
      || argument.length > 128 * 1024
      || argument.includes('\0')
    ))
  ) {
    publish({ ok: false, error: 'stdio server needs a valid command' });
    process.exitCode = 1;
  } else {
    const timeoutMs = boundedTimeout(process.env.IDACC_MCP_PROBE_TIMEOUT_MS);
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.IDACC_MANAGED_SERVICE;
    delete childEnv.IDACC_MCP_PROBE_RUNNER;
    delete childEnv.IDACC_MCP_PROBE_TIMEOUT_MS;

    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let stopping = false;
    let serverInfo;
    let timeout;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      publish(result);
      // Keep draining while the trusted parent performs process-tree cleanup.
      // A noisy or shutdown-resistant server must not block that cleanup by
      // filling one of this runner's private pipes.
      child?.stdout?.resume();
      child?.stderr?.resume();
    };
    const send = (message) => {
      try {
        child?.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The child exit/error event provides the useful result.
      }
    };
    const requestStop = () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timeout);
      if (
        child
        && Number.isSafeInteger(child.pid)
        && Number(child.pid) > 0
        && child.exitCode === null
        && child.signalCode === null
      ) {
        try { child.kill('SIGTERM'); } catch { /* parent force-kills the group */ }
        return;
      }
      process.exit(0);
    };

    process.once('SIGTERM', requestStop);

    try {
      child = crossSpawn(command, args, {
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, error: safeError(error) });
    }

    if (child) {
      child.stdin?.on('error', () => {});
      child.stdout?.on('data', (chunk) => {
        if (settled) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stdout.length + value.length > MAX_PROTOCOL_BYTES) {
          finish({ ok: false, error: 'MCP server protocol output exceeded its size limit' });
          return;
        }
        stdout = Buffer.concat([stdout, value]);
        let newline;
        while (!settled && (newline = stdout.indexOf(0x0a)) >= 0) {
          const line = stdout.subarray(0, newline).toString('utf8').trim();
          stdout = stdout.subarray(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message?.id === 1) {
            if (message.error) {
              finish({
                ok: false,
                error: String(message.error.message || 'initialize failed'),
              });
              continue;
            }
            serverInfo = message.result?.serverInfo;
            send({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
            });
            send({
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/list',
            });
          } else if (message?.id === 2) {
            if (message.error) {
              finish({
                ok: false,
                error: String(message.error.message || 'tools/list failed'),
              });
              continue;
            }
            finish({
              ok: true,
              tools: Array.isArray(message.result?.tools)
                ? message.result.tools
                    .map((tool) => String(tool?.name || '').trim())
                    .filter(Boolean)
                : [],
              serverInfo: serverInfo && typeof serverInfo === 'object'
                ? {
                    name: typeof serverInfo.name === 'string'
                      ? serverInfo.name
                      : undefined,
                    version: typeof serverInfo.version === 'string'
                      ? serverInfo.version
                      : undefined,
                  }
                : undefined,
            });
          }
        }
      });
      child.stderr?.on('data', (chunk) => {
        if (settled || stderr.length >= MAX_STDERR_BYTES) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderr = Buffer.concat([
          stderr,
          value.subarray(0, MAX_STDERR_BYTES - stderr.length),
        ]);
      });
      child.once('error', (error) => {
        const message = error?.code === 'ENOENT'
          ? `command not found: ${command}. Install it or edit this MCP server to use an absolute command path.`
          : safeError(error);
        finish({ ok: false, error: message });
      });
      child.once('exit', (code, signal) => {
        if (stopping) {
          process.exit(0);
          return;
        }
        if (!settled) {
          const diagnostic = stderr.toString('utf8').trim().slice(0, 200);
          finish({
            ok: false,
            error: `server exited (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})${diagnostic ? `: ${diagnostic}` : ''}`,
          });
        }
      });
      child.once('spawn', () => {
        send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'idctl', version: '1' },
          },
        });
      });
      timeout = setTimeout(() => {
        finish({
          ok: false,
          error: `timed out after ${Math.round(timeoutMs / 1000)}s (first run may download the package — try again)`,
        });
      }, timeoutMs);
    }
  }
}
