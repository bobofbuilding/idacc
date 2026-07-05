#!/usr/bin/env node
/**
 * Release payload guard: IDACC may ship framework code and helper resources, but
 * never a developer's local Brain database, Learn blobs, or app/user session data.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputs = process.argv.slice(2).map((p) => resolve(p));

if (!inputs.length) {
  console.error('usage: scripts/check-release-payload.mjs <path> [path...]');
  process.exit(2);
}

const forbidden = [
  {
    label: 'Brain database',
    re: /(?:^|\/)brain\.db(?:[-.\w]*)?$/i,
  },
  {
    label: 'Brain workspace state',
    re: /(?:^|\/)(?:id-agents\/)?workspace\/projects\/brain\/(?:(?:brain\.db(?:[-.\w]*)?)|(?:data|exports|snapshots|approvals|facts|text-units|logs|output|uploads|control-center)(?:\/|$)|plans\/archive(?:\/|$)|\.[\w.-]*cursor\.json$|[^/]+\.bak-[^/]+$)/i,
  },
  {
    label: 'Learn blob snapshots',
    re: /(?:^|\/)learn\/blobs(?:\/|$)/i,
  },
  {
    label: 'Learn material records',
    re: /(?:^|\/)learn\/(?:materials|queue)(?:\/|$)|(?:^|\/)materials\/mat_[^/]+/i,
  },
  {
    label: 'IDCTL local config/session state',
    re: /(?:^|\/)(?:\.config\/idctl|config\/idctl|idctl\/(?:questions|goals|plans|dreams|work|learn|chats))(?:\/|$)/i,
  },
  {
    label: 'Electron userData state',
    re: /(?:^|\/)Application Support\/ID Agents Control Center(?:\/|$)/i,
  },
  {
    label: 'Question/goal session JSON',
    re: /(?:^|\/)(?:questions\/q_[^/]+|goals\/goal_[^/]+|plans\/plan_[^/]+|dreams\/dream_[^/]+)\.json$/i,
  },
];

function rel(path) {
  const r = path.startsWith(root) ? path.slice(root.length + 1) : path;
  return r.split(sep).join('/');
}

function checkPath(path, hits) {
  const normalized = rel(path);
  for (const rule of forbidden) {
    if (rule.re.test(normalized)) hits.push(`${rule.label}: ${normalized}`);
  }
}

function walk(path, hits) {
  if (!existsSync(path)) return;
  checkPath(path, hits);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  for (const name of readdirSync(path)) walk(join(path, name), hits);
}

function asarTool() {
  const candidates = [
    join(root, 'idctl-desktop', 'node_modules', '.bin', process.platform === 'win32' ? 'asar.cmd' : 'asar'),
    join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'asar.cmd' : 'asar'),
  ];
  return candidates.find((p) => existsSync(p)) ?? '';
}

function checkAsar(appPath, hits) {
  const asar = join(appPath, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(asar)) return;
  const tool = asarTool();
  if (!tool) {
    hits.push(`Could not inspect app.asar because the asar tool is unavailable: ${rel(asar)}`);
    return;
  }
  const out = execFileSync(tool, ['list', asar], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    checkPath(join(asar, line.replace(/^\/+/, '')), hits);
  }
}

const hits = [];
for (const input of inputs) {
  walk(input, hits);
  if (basename(input).endsWith('.app')) checkAsar(input, hits);
}

if (hits.length) {
  console.error('Release payload check failed: local Brain/Learn/session state must not ship in IDACC.');
  for (const hit of hits.slice(0, 80)) console.error(`- ${hit}`);
  if (hits.length > 80) console.error(`- ... ${hits.length - 80} more`);
  process.exit(1);
}

console.log(`Release payload check passed: ${inputs.map(rel).join(', ')}`);
