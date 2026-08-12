/**
 * Production-safe bridge from ordinary local Codex tasks to IDACC's normal
 * coordination workflows.
 *
 * The stdio MCP process receives only a private locator for this broker. The
 * Manager administrator credential and dynamic Manager port stay inside the
 * Electron main process, and every broker operation is mapped to an existing
 * allow-listed application workflow.
 */
import { app } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import crossSpawn from 'cross-spawn';
import { existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { ensurePrivateAppDirectory, readPrivateAppTextFile, writePrivateAppTextFileAtomic } from './appStatePrivacy.ts';
import { externalChildEnvironment } from './externalChildEnvironment.ts';
import { sanitizeSecretPayload } from './secretRedaction.ts';

type BridgeCall = (method: string, args?: unknown[]) => Promise<unknown>;

export interface CodexCoordinationStatus {
  running: boolean;
  port: number;
  sessionFile: string;
  registration: 'installed' | 'ready' | 'disabled' | 'conflict' | 'codex-unavailable' | 'failed';
  detail?: string;
}

type AgentRecord = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  health?: unknown;
  runtime?: unknown;
  model?: unknown;
  metadata?: unknown;
};

type TaskRecord = {
  name?: unknown;
  uuid?: unknown;
  shortId?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  ownerName?: unknown;
  teamName?: unknown;
  projectId?: unknown;
  planId?: unknown;
  workflowState?: unknown;
  blockedDetail?: unknown;
  validationDetail?: unknown;
  outcomeDetail?: unknown;
  completionEvidence?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  completedAt?: unknown;
};

const SERVER_NAME = 'idacc-coordination';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 16_000;
const MAX_NAME_LENGTH = 256;
const MAX_TASKS = 200;
const MANAGED_MARKER = 'idacc-v1';

const state: {
  server: http.Server | null;
  sockets: Set<Socket>;
  token: string;
  port: number;
  sessionFile: string;
  stopPromise: Promise<void> | null;
} = {
  server: null,
  sockets: new Set(),
  token: '',
  port: 0,
  sessionFile: '',
  stopPromise: null,
};

function coordinationDirectory(): string {
  return join(app.getPath('userData'), 'idacc-coordination');
}

export function codexCoordinationSessionPath(): string {
  return join(coordinationDirectory(), 'session.json');
}

export function codexCoordinationMcpPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'idacc-coordination-mcp', 'server.mjs')
    : join(__dirname, '../../resources/idacc-coordination-mcp/server.mjs');
}

function cleanString(value: unknown, label: string, maximum = MAX_NAME_LENGTH, required = false): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > maximum) throw new Error(`${label} is too long.`);
  return text;
}

function cleanStringList(value: unknown, label: string, maximumItems: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (value.length > maximumItems) throw new Error(`${label} has too many entries.`);
  return [...new Set(value.map((entry) => cleanString(entry, label, MAX_NAME_LENGTH, true)))];
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function catalogAgent(team: string, agent: AgentRecord) {
  const metadata = objectValue(agent.metadata);
  const catalog = objectValue(metadata.catalog);
  return {
    team,
    id: String(agent.id || ''),
    name: String(agent.name || ''),
    status: String(agent.status || ''),
    health: String(agent.health || ''),
    runtime: String(agent.runtime || metadata.runtime || ''),
    model: String(agent.model || ''),
    skills: Array.isArray(metadata.skills) ? metadata.skills.filter((item): item is string => typeof item === 'string').slice(0, 100) : [],
    catalog: {
      description: String(catalog.description || metadata.description || ''),
      role: String(catalog.role || metadata.role || ''),
      expertise: Array.isArray(catalog.expertise) ? catalog.expertise.filter((item): item is string => typeof item === 'string').slice(0, 50) : [],
      availability: String(catalog.status || agent.status || ''),
      currentTask: typeof catalog.currentTask === 'string' ? catalog.currentTask : null,
      costTier: String(catalog.costTier || ''),
      notSuitableFor: Array.isArray(catalog.notSuitableFor) ? catalog.notSuitableFor.filter((item): item is string => typeof item === 'string').slice(0, 50) : [],
    },
  };
}

function taskSummary(task: TaskRecord) {
  return sanitizeSecretPayload({
    ref: String(task.shortId || task.name || task.uuid || ''),
    title: String(task.title || ''),
    description: typeof task.description === 'string' ? task.description : null,
    status: String(task.status || ''),
    workflowState: String(task.workflowState || ''),
    owner: typeof task.ownerName === 'string' ? task.ownerName : null,
    team: String(task.teamName || ''),
    projectId: typeof task.projectId === 'string' ? task.projectId : undefined,
    planId: typeof task.planId === 'string' ? task.planId : undefined,
    blockedDetail: task.blockedDetail,
    validationDetail: task.validationDetail,
    outcomeDetail: task.outcomeDetail,
    completionEvidence: task.completionEvidence,
    createdAt: Number(task.createdAt || 0) || undefined,
    updatedAt: Number(task.updatedAt || 0) || undefined,
    completedAt: Number(task.completedAt || 0) || undefined,
  });
}

function matchesBearer(header: string | undefined): boolean {
  const supplied = String(header || '').replace(/^Bearer\s+/i, '');
  if (!state.token || supplied.length !== state.token.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(state.token));
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('coordination request is too large');
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('coordination request must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function publicCoordinationError(error: unknown): string {
  const message = String(sanitizeSecretPayload(error instanceof Error ? error.message : String(error)))
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/gi, '[app-owned local service]')
    .replace(/\b(?:127\.0\.0\.1|localhost|\[::1\]):\d+\b/gi, '[app-owned local service]')
    .trim();
  return (message || 'IDACC rejected the coordination request.').slice(0, 1_000);
}

async function toolManagerHealth(call: BridgeCall) {
  const [health, teamsRaw, groupsRaw] = await Promise.all([
    call('health'),
    call('teams'),
    call('agents:allTeams', [{ requireComplete: true }]),
  ]);
  const teams = Array.isArray(teamsRaw) ? teamsRaw : [];
  const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
  const agents = groups.flatMap((entry) => {
    const group = objectValue(entry);
    return Array.isArray(group.agents) ? group.agents : [];
  }) as AgentRecord[];
  return {
    ok: true,
    manager: sanitizeSecretPayload(health),
    teams: teams.map((entry) => {
      const team = objectValue(entry);
      return { id: String(team.id || ''), name: String(team.name || ''), agentCount: Number(team.agentCount || 0) };
    }),
    fleet: {
      total: agents.length,
      running: agents.filter((agent) => !/stop|offline|dead|exit|error|crash|down|disabled/i.test(String(agent.status || ''))).length,
      states: Object.fromEntries([...new Set(agents.map((agent) => String(agent.status || 'unknown')))]
        .map((status) => [status, agents.filter((agent) => String(agent.status || 'unknown') === status).length])),
    },
  };
}

async function toolProjectCatalog(call: BridgeCall, args: Record<string, unknown>) {
  const status = cleanString(args.status, 'status');
  const projectsRaw = await call('projects:list');
  const projects = (Array.isArray(projectsRaw) ? projectsRaw : [])
    .map((entry) => objectValue(entry))
    .filter((project) => !status || String(project.status || '') === status)
    .map((project) => ({
      id: String(project.id || ''),
      name: String(project.name || ''),
      status: String(project.status || ''),
      description: String(project.description || ''),
      team: String(project.team || ''),
      lead: String(project.lead || ''),
      policy: String(project.policy || ''),
      tags: Array.isArray(project.tags) ? project.tags.filter((item): item is string => typeof item === 'string').slice(0, 50) : [],
      updatedAt: Number(project.updatedAt || 0) || undefined,
    }));
  return { ok: true, projects };
}

async function toolCatalog(call: BridgeCall, args: Record<string, unknown>) {
  const teamFilter = cleanString(args.team, 'team');
  const statusFilter = cleanString(args.status, 'status');
  const groupsRaw = await call('agents:allTeams', [{ requireComplete: true }]);
  const groups = Array.isArray(groupsRaw) ? groupsRaw : [];
  const agents = groups.flatMap((entry) => {
    const group = objectValue(entry);
    const team = String(group.team || '');
    if (teamFilter && team !== teamFilter) return [];
    return (Array.isArray(group.agents) ? group.agents : [])
      .map((agent) => catalogAgent(team, objectValue(agent) as AgentRecord))
      .filter((agent) => !statusFilter || agent.status === statusFilter);
  });
  return { ok: true, agents };
}

async function toolInterAgent(call: BridgeCall, args: Record<string, unknown>) {
  const action = cleanString(args.action, 'action', 32, true);
  const team = cleanString(args.team, 'team');
  if (action === 'poll') {
    const queryId = cleanString(args.queryId, 'queryId', MAX_NAME_LENGTH, true);
    const waitSeconds = boundedInteger(args.waitSeconds, 0, 0, 30);
    return { ok: true, query: sanitizeSecretPayload(await call('query:poll', [queryId, waitSeconds, team || undefined])) };
  }
  if (action !== 'send') throw new Error('action must be send or poll');
  const agent = cleanString(args.agent, 'agent', MAX_NAME_LENGTH, true);
  const message = cleanString(args.message, 'message', MAX_MESSAGE_LENGTH, true);
  const envelope = await call('remote', [message, agent, team || undefined]);
  return { ok: true, dispatch: sanitizeSecretPayload(envelope) };
}

async function toolTaskDiscipline(call: BridgeCall, args: Record<string, unknown>) {
  const action = cleanString(args.action, 'action', 32, true);
  const team = cleanString(args.team, 'team');
  if (action === 'context') {
    const refs = cleanStringList(args.refs, 'refs', 50);
    if (!refs.length) throw new Error('refs is required for task context.');
    return { ok: true, contexts: sanitizeSecretPayload(await call('tasks:context', [refs])) };
  }
  if (action === 'reconcile') {
    const refs = cleanStringList(args.refs, 'refs', 50);
    if (!team || !refs.length) throw new Error('team and refs are required for reconciliation.');
    return { ok: true, reconciliation: sanitizeSecretPayload(await call('work:reconcileWaiting', [team, refs])) };
  }
  if (action === 'audit-evidence') {
    const ref = cleanString(args.ref, 'ref', MAX_NAME_LENGTH, true);
    if (!team) throw new Error('team is required for evidence audit.');
    return { ok: true, audit: sanitizeSecretPayload(await call('work:auditTaskEvidence', [team, ref])) };
  }
  if (action !== 'list') throw new Error('unsupported task-discipline action');
  const status = cleanString(args.status, 'status');
  const projectId = cleanString(args.projectId, 'projectId');
  const refs = cleanStringList(args.refs, 'refs', 50);
  const refSet = new Set(refs.map((ref) => ref.replace(/^#/, '').toLowerCase()));
  const limit = boundedInteger(args.limit, 100, 1, MAX_TASKS);
  const tasksRaw = await call('tasks:allTeams');
  const tasks = (Array.isArray(tasksRaw) ? tasksRaw : [])
    .map((entry) => objectValue(entry) as TaskRecord)
    .filter((task) => !team || String(task.teamName || '') === team)
    .filter((task) => !status || String(task.status || '') === status || String(task.workflowState || '') === status)
    .filter((task) => !projectId || String(task.projectId || '') === projectId)
    .filter((task) => {
      if (!refSet.size) return true;
      return [task.shortId, task.name, task.uuid]
        .some((ref) => refSet.has(String(ref || '').replace(/^#/, '').toLowerCase()));
    })
    .slice(0, limit)
    .map(taskSummary);
  return { ok: true, tasks };
}

async function toolTeamCoordinator(call: BridgeCall, args: Record<string, unknown>) {
  const action = cleanString(args.action, 'action', 32, true);
  const teams = cleanStringList(args.teams, 'teams', 32);
  if (action === 'list-leads') {
    const listed = teams.length ? [] : await call('teams');
    const names = teams.length ? teams : (Array.isArray(listed) ? listed : []);
    const teamNames = teams.length
      ? teams
      : (names as unknown[]).map((entry) => String(objectValue(entry).name || '')).filter(Boolean);
    return { ok: true, leads: sanitizeSecretPayload(await call('work:teamLeads', [teamNames])) };
  }
  if (action !== 'delegate') throw new Error('action must be list-leads or delegate');
  const objective = cleanString(args.objective, 'objective', MAX_MESSAGE_LENGTH, true);
  const projectId = cleanString(args.projectId, 'projectId');
  if (teams.length) {
    return {
      ok: true,
      delegation: sanitizeSecretPayload(await call('work:fanout', [objective, teams, projectId || undefined])),
    };
  }
  const options = {
    currentTeam: cleanString(args.currentTeam, 'currentTeam') || undefined,
    primaryLead: cleanString(args.primaryLead, 'primaryLead') || undefined,
    projectId: projectId || undefined,
    planId: cleanString(args.planId, 'planId') || undefined,
  };
  return { ok: true, delegation: sanitizeSecretPayload(await call('work:delegateToTeamLeads', [objective, options])) };
}

async function runTool(call: BridgeCall, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'idacc_manager_health': return toolManagerHealth(call);
    case 'idacc_project_catalog': return toolProjectCatalog(call, args);
    case 'idacc_catalog': return toolCatalog(call, args);
    case 'idacc_inter_agent': return toolInterAgent(call, args);
    case 'idacc_task_discipline': return toolTaskDiscipline(call, args);
    case 'idacc_team_coordinator': return toolTeamCoordinator(call, args);
    default: throw new Error(`Unknown IDACC coordination tool: ${name}`);
  }
}

function mcpCliEnvironment(): NodeJS.ProcessEnv {
  const home = homedir();
  const directories = [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    process.env.PNPM_HOME,
    process.env.VOLTA_HOME ? join(process.env.VOLTA_HOME, 'bin') : join(home, '.volta', 'bin'),
    ...(process.platform === 'win32'
      ? [process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']),
    ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
  ].filter((value): value is string => Boolean(value));
  return externalChildEnvironment(process.env, { PATH: [...new Set(directories)].join(delimiter) });
}

type CodexMcpRecord = {
  enabled?: boolean;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string> | null;
  };
};

function codexCommand(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

function runCodexMcp(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = crossSpawn.sync(codexCommand(), ['mcp', ...args], {
    encoding: 'utf8',
    env: mcpCliEnvironment(),
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

function addCodexMcp(sessionFile: string, mcpPath: string): { ok: boolean; detail?: string } {
  const result = runCodexMcp([
    'add',
    '--env', `ELECTRON_RUN_AS_NODE=1`,
    '--env', `IDACC_COORDINATION_MANAGED=${MANAGED_MARKER}`,
    '--env', `IDACC_COORDINATION_SESSION_FILE=${sessionFile}`,
    SERVER_NAME,
    '--',
    process.execPath,
    mcpPath,
  ]);
  return { ok: result.ok, detail: result.ok ? undefined : (result.stderr.trim() || 'Codex rejected MCP registration.') };
}

function expectedRegistration(current: CodexMcpRecord, sessionFile: string, mcpPath: string): boolean {
  return current.transport?.type === 'stdio'
    && current.transport.command === process.execPath
    && Array.isArray(current.transport.args)
    && current.transport.args.length === 1
    && current.transport.args[0] === mcpPath
    && current.transport.env?.ELECTRON_RUN_AS_NODE === '1'
    && current.transport.env?.IDACC_COORDINATION_MANAGED === MANAGED_MARKER
    && current.transport.env?.IDACC_COORDINATION_SESSION_FILE === sessionFile;
}

export function ensureCodexCoordinationRegistered(sessionFile = codexCoordinationSessionPath()): Pick<CodexCoordinationStatus, 'registration' | 'detail'> {
  const mcpPath = codexCoordinationMcpPath();
  if (!existsSync(mcpPath)) return { registration: 'failed', detail: 'The bundled IDACC coordination MCP server is missing.' };
  const currentResult = runCodexMcp(['get', SERVER_NAME, '--json']);
  if (!currentResult.ok) {
    const missing = /No MCP server named|MCP server .* not found/i.test(`${currentResult.stdout}\n${currentResult.stderr}`);
    if (!missing && /ENOENT|not recognized|command not found/i.test(currentResult.stderr)) {
      return { registration: 'codex-unavailable', detail: 'Codex CLI is not installed or not discoverable.' };
    }
    if (!missing) return { registration: 'failed', detail: currentResult.stderr.trim() || 'Could not inspect Codex MCP configuration.' };
    const added = addCodexMcp(sessionFile, mcpPath);
    return added.ok ? { registration: 'installed' } : { registration: 'failed', detail: added.detail };
  }
  let current: CodexMcpRecord;
  try {
    current = JSON.parse(currentResult.stdout) as CodexMcpRecord;
  } catch {
    return { registration: 'failed', detail: 'Codex returned malformed MCP configuration.' };
  }
  if (current.transport?.env?.IDACC_COORDINATION_MANAGED === MANAGED_MARKER && current.enabled === false) {
    return { registration: 'disabled', detail: 'The user disabled the managed IDACC coordination server in Codex.' };
  }
  if (expectedRegistration(current, sessionFile, mcpPath)) {
    return { registration: 'ready' };
  }
  if (current.transport?.env?.IDACC_COORDINATION_MANAGED !== MANAGED_MARKER) {
    return { registration: 'conflict', detail: 'A user-owned Codex MCP server already uses the idacc-coordination name; IDACC did not overwrite it.' };
  }
  const removed = runCodexMcp(['remove', SERVER_NAME]);
  if (!removed.ok) return { registration: 'failed', detail: removed.stderr.trim() || 'Could not refresh the managed Codex MCP registration.' };
  const added = addCodexMcp(sessionFile, mcpPath);
  return added.ok ? { registration: 'installed' } : { registration: 'failed', detail: added.detail };
}

function writeSessionFile(): void {
  ensurePrivateAppDirectory(coordinationDirectory());
  state.sessionFile = codexCoordinationSessionPath();
  writePrivateAppTextFileAtomic(state.sessionFile, `${JSON.stringify({
    url: `http://127.0.0.1:${state.port}`,
    token: state.token,
    pid: process.pid,
    updatedAt: Date.now(),
  })}\n`);
}

function currentSessionMatches(): boolean {
  try {
    const parsed = JSON.parse(readPrivateAppTextFile(state.sessionFile, 16 * 1024));
    return parsed?.token === state.token && Number(parsed?.pid) === process.pid;
  } catch {
    return false;
  }
}

export async function startCodexCoordinationBroker(call: BridgeCall): Promise<CodexCoordinationStatus> {
  if (state.server) {
    return { running: true, port: state.port, sessionFile: state.sessionFile, ...ensureCodexCoordinationRegistered(state.sessionFile) };
  }
  if (state.stopPromise) await state.stopPromise;
  state.token = randomBytes(24).toString('hex');
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, { ok: true, service: SERVER_NAME });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/tool') {
        sendJson(response, 404, { ok: false, reason: 'not_found', message: 'Not found.' });
        return;
      }
      if (!matchesBearer(request.headers.authorization)) {
        sendJson(response, 401, { ok: false, reason: 'unauthorized', message: 'Invalid IDACC coordination authority.' });
        return;
      }
      const payload = await readJsonBody(request);
      const name = cleanString(payload.name, 'tool name', MAX_NAME_LENGTH, true);
      const args = objectValue(payload.arguments);
      sendJson(response, 200, await runTool(call, name, args));
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        reason: 'coordination_request_rejected',
        message: publicCoordinationError(error),
      });
    }
  });
  state.server = server;
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || !address.port) throw new Error('coordination broker did not bind an explicit loopback port');
    state.port = address.port;
    writeSessionFile();
    return {
      running: true,
      port: state.port,
      sessionFile: state.sessionFile,
      ...ensureCodexCoordinationRegistered(state.sessionFile),
    };
  } catch (error) {
    await stopCodexCoordinationBroker();
    throw error;
  }
}

export function stopCodexCoordinationBroker(): Promise<void> {
  if (state.stopPromise) return state.stopPromise;
  const server = state.server;
  state.server = null;
  const attempt = (async () => {
    for (const socket of state.sockets) socket.destroy();
    state.sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (state.sessionFile && currentSessionMatches()) {
      try { unlinkSync(state.sessionFile); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    state.token = '';
    state.port = 0;
    state.sessionFile = '';
  })();
  let tracked: Promise<void>;
  tracked = attempt.finally(() => {
    if (state.stopPromise === tracked) state.stopPromise = null;
  });
  state.stopPromise = tracked;
  return tracked;
}
