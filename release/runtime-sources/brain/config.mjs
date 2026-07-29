import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const PORT = Number(process.env.BRAIN_PORT ?? 4200);
export const FRAMEWORK_DIR = import.meta.dirname;

export function defaultBrainStateDir(env = process.env) {
  if (env.BRAIN_STATE_DIR) return resolve(env.BRAIN_STATE_DIR);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ID Agents', 'Brain');
  if (platform() === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ID Agents', 'Brain');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'id-agents', 'brain');
}

export function resolveBrainDbPath(env = process.env) {
  return resolve(env.BRAIN_DB_PATH || join(defaultBrainStateDir(env), 'brain.db'));
}

export const STATE_DIR = defaultBrainStateDir();
export const DB_PATH = resolveBrainDbPath();

export function ensureBrainDbDir(dbPath = DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
}

export const CORS_ALLOWED_ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
