import { app } from 'electron';
import { createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppProfilePaths } from './appProfile.ts';

type ServiceName = 'manager' | 'brain';
type ServiceState = {
  name: ServiceName;
  url: string;
  bundled: boolean;
  running: boolean;
  healthy: boolean;
  pid?: number;
  error?: string;
};

const children = new Map<ServiceName, ChildProcess>();
let profile: AppProfilePaths | null = null;
let stopping = false;

function runtimeRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'idacc-runtime')
    : join(app.getAppPath(), 'resources', 'idacc-runtime');
}

function serviceSpec(name: ServiceName) {
  const root = runtimeRoot();
  if (name === 'manager') {
    const url = process.env.MANAGER_URL || 'http://127.0.0.1:4110';
    return {
      entry: join(root, 'manager', 'dist', 'start-agent-manager.js'),
      cwd: join(root, 'manager'),
      url,
      env: { AGENT_MANAGER_PORT: new URL(url).port || '4110' },
    };
  }
  const url = process.env.BRAIN_URL || 'http://127.0.0.1:4210';
  return {
    entry: join(root, 'brain', 'brain.mjs'),
    cwd: join(root, 'brain'),
    url,
    env: { BRAIN_PORT: new URL(url).port || '4210' },
  };
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

function startService(name: ServiceName): void {
  if (children.get(name) || stopping || !profile) return;
  const spec = serviceSpec(name);
  if (!existsSync(spec.entry)) return;
  const log = createWriteStream(join(profile.logs, `${name}.log`), { flags: 'a', mode: 0o600 });
  const child = spawn(process.execPath, [spec.entry], {
    cwd: spec.cwd,
    env: {
      ...process.env,
      ...spec.env,
      ELECTRON_RUN_AS_NODE: '1',
      IDACC_MANAGED_SERVICE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', () => {
    children.delete(name);
    log.end();
    if (!stopping) setTimeout(() => startService(name), 1500).unref?.();
  });
}

export async function startUnifiedStack(paths: AppProfilePaths): Promise<UnifiedStackStatus> {
  profile = paths;
  stopping = false;
  for (const name of ['brain', 'manager'] as const) {
    const spec = serviceSpec(name);
    if (!(await healthy(spec.url))) startService(name);
  }
  return unifiedStackStatus();
}

export async function stopUnifiedStack(): Promise<void> {
  stopping = true;
  const active = [...children.values()];
  children.clear();
  for (const child of active) child.kill('SIGTERM');
  await Promise.all(active.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
}

export interface UnifiedStackStatus {
  managed: boolean;
  profileRoot?: string;
  services: ServiceState[];
  ready: boolean;
}

export async function unifiedStackStatus(): Promise<UnifiedStackStatus> {
  const services = await Promise.all((['manager', 'brain'] as const).map(async (name): Promise<ServiceState> => {
    const spec = serviceSpec(name);
    const child = children.get(name);
    const isHealthy = await healthy(spec.url);
    return {
      name,
      url: spec.url,
      bundled: existsSync(spec.entry),
      running: Boolean(child && child.exitCode === null) || isHealthy,
      healthy: isHealthy,
      pid: child?.pid,
      error: !existsSync(spec.entry) ? 'runtime is not present in this build' : undefined,
    };
  }));
  return {
    managed: true,
    profileRoot: profile?.root,
    services,
    ready: services.every((service) => service.bundled && service.healthy),
  };
}
