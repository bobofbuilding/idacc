import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

export interface HeadroomStatus {
  cli: {
    found: boolean;
    version?: string;
    error?: string;
  };
  proxy: {
    url: string;
    reachable: boolean;
    httpStatus?: number;
    error?: string;
  };
}

function cliPath(): string {
  const home = homedir();
  const dirs = ['/opt/homebrew/bin', `${home}/.local/bin`, '/usr/local/bin', '/usr/bin', '/bin'];
  const existing = process.env.PATH ? process.env.PATH.split(':') : [];
  return [...dirs, ...existing].join(':');
}

function headroomVersion(timeoutMs = 3000): Promise<HeadroomStatus['cli']> {
  return new Promise((resolve) => {
    const child = execFile('headroom', ['--version'], { env: { ...process.env, PATH: cliPath() }, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        resolve({ found: false, error: msg || 'headroom CLI not found' });
        return;
      }
      resolve({ found: true, version: (stdout || stderr).trim() || 'installed' });
    });
    child.on('error', (err) => resolve({ found: false, error: err.message }));
  });
}

async function probeHeadroomProxy(url = 'http://127.0.0.1:8787/mcp'): Promise<HeadroomStatus['proxy']> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'idctl', version: '1' } } }),
      signal: AbortSignal.timeout(2500),
    });
    return { url, reachable: res.ok || res.status === 400 || res.status === 405, httpStatus: res.status };
  } catch (err) {
    return { url, reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function headroomStatus(): Promise<HeadroomStatus> {
  const [cli, proxy] = await Promise.all([headroomVersion(), probeHeadroomProxy()]);
  return { cli, proxy };
}
