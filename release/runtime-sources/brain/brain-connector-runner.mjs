#!/usr/bin/env node
/**
 * Universal Brain connector runner.
 *
 * Reads ~/.brain-connectors.json, loads each project brain-connector.json, and
 * runs feed adapters with env-only configuration. Poll feeds run on their
 * interval; event feeds long-poll their declared event streams and hand each
 * batch to the adapter through environment variables plus a temp batch file.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRY = join(homedir(), '.brain-connectors.json');
const DEFAULT_BRAIN_URL = process.env.BRAIN_URL ?? 'http://127.0.0.1:4200';
const DEFAULT_RETRY_MS = Number(process.env.BRAIN_CONNECTOR_RETRY_MS ?? 5000);

function now() {
  return new Date().toISOString();
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}

function slug(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'feed';
}

export function logEvent(event, logger = console.log) {
  logger(JSON.stringify({ ts: now(), service: 'brain-connector-runner', ...event }));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, payload) {
  const tmpFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpFile, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmpFile, file);
}

export function registryPath() {
  return process.env.BRAIN_CONNECTORS_REGISTRY || DEFAULT_REGISTRY;
}

export function loadRegistry(file = registryPath()) {
  const resolved = isAbsolute(file) ? file : resolve(file);
  if (!existsSync(resolved)) return { path: resolved, connectors: [] };
  const parsed = readJson(resolved);
  if (!Array.isArray(parsed.connectors)) throw new Error(`${resolved} must contain a connectors array`);
  return { path: resolved, connectors: parsed.connectors.map(String).filter(Boolean) };
}

function normalizeProduces(feed) {
  return Array.isArray(feed.produces) ? feed.produces.map(String).filter(Boolean) : [];
}

function normalizeFeed(feed) {
  return {
    ...feed,
    name: String(feed.name ?? '').trim(),
    type: String(feed.type ?? 'poll').trim(),
    interval_seconds: Number(feed.interval_seconds ?? feed.intervalSeconds ?? 3600),
    produces: normalizeProduces(feed),
  };
}

export function loadConnector(file) {
  const connectorFile = isAbsolute(file) ? file : resolve(file);
  const connector = readJson(connectorFile);
  if (!connector.project) throw new Error(`${connectorFile} missing project`);
  if (!Array.isArray(connector.feeds)) throw new Error(`${connectorFile} missing feeds array`);
  const dir = dirname(connectorFile);
  return {
    ...connector,
    version: String(connector.version ?? '1'),
    brain_url: connector.brain_url ?? DEFAULT_BRAIN_URL,
    file: connectorFile,
    dir,
    feeds: connector.feeds.map(normalizeFeed).filter((feed) => feed.name),
  };
}

export function loadConnectors(file = registryPath(), { logger = console.log } = {}) {
  const registry = loadRegistry(file);
  const registryDir = dirname(registry.path);
  const connectors = [];
  for (const entry of registry.connectors) {
    const connectorPath = isAbsolute(entry) ? entry : resolve(registryDir, entry);
    if (!existsSync(connectorPath)) {
      logEvent({ level: 'warn', event: 'connector_missing', file: connectorPath }, logger);
      continue;
    }
    try {
      connectors.push(loadConnector(connectorPath));
    } catch (error) {
      logEvent({
        level: 'error',
        event: 'connector_invalid',
        file: connectorPath,
        message: error instanceof Error ? error.message : String(error),
      }, logger);
    }
  }
  return connectors;
}

function resolveScript(connector, script) {
  if (!script) return null;
  return isAbsolute(script) ? script : resolve(connector.dir, script);
}

function commandForScript(script) {
  if (/\.(mjs|cjs|js|ts)$/.test(script)) return { command: process.execPath, args: [script] };
  return { command: script, args: [] };
}

function feedStateDir(connector) {
  const root = process.env.BRAIN_CONNECTOR_STATE_DIR
    ? resolve(process.env.BRAIN_CONNECTOR_STATE_DIR)
    : join(connector.dir, '.brain-connector-state');
  mkdirSync(root, { recursive: true });
  return root;
}

export function cursorStateFile(connector, feed) {
  return join(feedStateDir(connector), `${slug(connector.project)}-${slug(feed.name)}.json`);
}

export function readCursorState(connector, feed) {
  const file = cursorStateFile(connector, feed);
  if (!existsSync(file)) return '';
  try {
    const parsed = readJson(file);
    if (parsed.cursor === undefined || parsed.cursor === null) return '';
    return String(parsed.cursor);
  } catch {
    return '';
  }
}

export function writeCursorState(connector, feed, cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return;
  writeJsonAtomic(cursorStateFile(connector, feed), {
    project: connector.project,
    feed: feed.name,
    cursor: String(cursor),
    updated_at: now(),
  });
}

function initialCursor(feed) {
  const cursor = feed.cursor ?? feed.since ?? feed.start_cursor ?? feed.startCursor ?? '';
  return cursor === undefined || cursor === null ? '' : String(cursor);
}

function eventStreamUrl(feed) {
  return feed.event_stream ?? feed.eventStream ?? feed.url ?? feed.stream_url ?? feed.streamUrl ?? '';
}

function managedBy(feed) {
  return feed.managed_by ?? feed.managedBy ?? '';
}

function logManagedEventFeed(connector, feed, logger) {
  const manager = managedBy(feed);
  logEvent({
    level: 'info',
    event: 'event_feed_managed_externally',
    project: connector.project,
    feed: feed.name,
    managed_by: manager,
  }, logger);
  return { code: 0, skipped: true, managed: true };
}

function eventCursorParam(feed, streamUrl) {
  if (feed.cursor_param || feed.cursorParam) return String(feed.cursor_param ?? feed.cursorParam);
  return streamUrl.includes('/events') ? 'since' : 'cursor';
}

function nextCursor(data, events, previous) {
  const last = events.at(-1) ?? {};
  const candidates = [
    data.next_seq,
    data.next_cursor,
    data.nextCursor,
    data.cursor,
    data.since,
    last.seq,
    last.cursor,
    previous,
  ];
  const value = candidates.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  return value === undefined || value === null ? '' : String(value);
}

function withCursor(url, cursor, waitSeconds, cursorParam) {
  const parsed = new URL(url);
  if (cursor !== '') parsed.searchParams.set(cursorParam, cursor);
  if (!parsed.searchParams.has('wait')) parsed.searchParams.set('wait', String(waitSeconds));
  return parsed.toString();
}

function writeEventBatch(connector, feed, payload) {
  const file = join(tmpdir(), `brain-connector-${slug(connector.project)}-${slug(feed.name)}-${randomUUID()}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export function feedEnv(connector, feed, extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    BRAIN_URL: connector.brain_url ?? DEFAULT_BRAIN_URL,
    BRAIN_CONNECTOR_PROJECT: String(connector.project),
    BRAIN_CONNECTOR_VERSION: String(connector.version ?? '1'),
    BRAIN_CONNECTOR_FILE: connector.file,
    BRAIN_CONNECTOR_DIR: connector.dir,
    BRAIN_CONNECTOR_FEED_NAME: feed.name,
    BRAIN_CONNECTOR_FEED_TYPE: feed.type,
    BRAIN_CONNECTOR_FEED_SOURCE: String(feed.source ?? ''),
    BRAIN_CONNECTOR_FEED_PRODUCES: JSON.stringify(feed.produces ?? []),
    BRAIN_CONNECTOR_FEED: JSON.stringify(feed),
  };
}

export function runAdapter(connector, feed, { logger = console.log, extraEnv = {} } = {}) {
  const script = resolveScript(connector, feed.script);
  if (!script) {
    logEvent({ level: 'warn', event: 'adapter_skipped', project: connector.project, feed: feed.name, reason: 'missing_script' }, logger);
    return Promise.resolve({ code: 0, skipped: true });
  }
  const { command, args } = commandForScript(script);
  const startedAt = Date.now();
  logEvent({ level: 'info', event: 'adapter_start', project: connector.project, feed: feed.name, script }, logger);
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: connector.dir,
      env: feedEnv(connector, feed, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logEvent({ level: 'info', event: 'adapter_stdout', project: connector.project, feed: feed.name, text }, logger);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logEvent({ level: 'warn', event: 'adapter_stderr', project: connector.project, feed: feed.name, text }, logger);
    });
    child.on('error', (error) => {
      logEvent({ level: 'error', event: 'adapter_error', project: connector.project, feed: feed.name, message: error.message }, logger);
      resolvePromise({ code: 1, error });
    });
    child.on('exit', (code, signal) => {
      const duration_ms = Date.now() - startedAt;
      logEvent({
        level: code === 0 ? 'info' : 'error',
        event: 'adapter_exit',
        project: connector.project,
        feed: feed.name,
        code,
        signal,
        duration_ms,
      }, logger);
      resolvePromise({ code: code ?? 1, signal, duration_ms });
    });
  });
}

async function processEventFeed(connector, feed, { signal, logger = console.log } = {}) {
  if (managedBy(feed)) {
    logManagedEventFeed(connector, feed, logger);
    return;
  }

  const streamUrl = eventStreamUrl(feed);
  if (!streamUrl) {
    logEvent({ level: 'warn', event: 'event_skipped', project: connector.project, feed: feed.name, reason: 'missing_event_stream' }, logger);
    return;
  }

  const cursorParam = eventCursorParam(feed, streamUrl);
  const waitSeconds = Math.max(1, Math.min(Number(feed.wait_seconds ?? feed.waitSeconds ?? 30), 120));
  let cursor = readCursorState(connector, feed) || initialCursor(feed);

  while (!signal?.aborted) {
    try {
      const response = await fetch(withCursor(streamUrl, cursor, waitSeconds, cursorParam), {
        signal,
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      const events = Array.isArray(data.events) ? data.events : Array.isArray(data.items) ? data.items : [];
      const advancedCursor = nextCursor(data, events, cursor);

      logEvent({
        level: response.ok ? 'info' : 'error',
        event: 'event_poll',
        project: connector.project,
        feed: feed.name,
        status: response.status,
        events: events.length,
        cursor,
        next_cursor: advancedCursor,
      }, logger);

      if (!response.ok) {
        await sleep(DEFAULT_RETRY_MS, signal);
        continue;
      }

      if (feed.script && events.length > 0) {
        const batchFile = writeEventBatch(connector, feed, {
          project: connector.project,
          feed: feed.name,
          source: feed.source ?? null,
          event_stream: streamUrl,
          cursor,
          next_cursor: advancedCursor,
          events,
        });
        try {
          const result = await runAdapter(connector, feed, {
            logger,
            extraEnv: {
              BRAIN_CONNECTOR_EVENT_STREAM: streamUrl,
              BRAIN_CONNECTOR_EVENT_CURSOR: cursor,
              BRAIN_CONNECTOR_EVENT_NEXT_CURSOR: advancedCursor,
              BRAIN_CONNECTOR_EVENT_CURSOR_PARAM: cursorParam,
              BRAIN_CONNECTOR_EVENT_BATCH_FILE: batchFile,
              BRAIN_CONNECTOR_EVENT_COUNT: String(events.length),
            },
          });
          if (result.code !== 0) {
            await sleep(DEFAULT_RETRY_MS, signal);
            continue;
          }
        } finally {
          rmSync(batchFile, { force: true });
        }
      }

      if (advancedCursor !== '') {
        writeCursorState(connector, feed, advancedCursor);
        cursor = advancedCursor;
      }
      if (events.length === 0) {
        await sleep(waitSeconds * 1000, signal);
      }
    } catch (error) {
      if (signal?.aborted) return;
      logEvent({
        level: 'error',
        event: 'event_poll_error',
        project: connector.project,
        feed: feed.name,
        message: error instanceof Error ? error.message : String(error),
      }, logger);
      await sleep(DEFAULT_RETRY_MS, signal);
    }
  }
}

function schedulePollFeed(connector, feed, { signal, logger = console.log, runImmediately = true } = {}) {
  const intervalMs = Math.max(Number(feed.interval_seconds ?? 3600), 1) * 1000;
  let running = false;
  const tick = async () => {
    if (running || signal?.aborted) return;
    running = true;
    try {
      await runAdapter(connector, feed, { logger });
    } finally {
      running = false;
    }
  };
  if (runImmediately) void tick();
  const timer = setInterval(tick, intervalMs);
  signal?.addEventListener('abort', () => clearInterval(timer), { once: true });
  logEvent({ level: 'info', event: 'poll_scheduled', project: connector.project, feed: feed.name, interval_ms: intervalMs }, logger);
  return timer;
}

export async function runOnce({ registry = registryPath(), logger = console.log } = {}) {
  const connectors = loadConnectors(registry, { logger });
  const results = [];
  for (const connector of connectors) {
    for (const feed of connector.feeds) {
      if (feed.type === 'poll') {
        if (!feed.script) continue;
        results.push(await runAdapter(connector, feed, { logger }));
        continue;
      }
      if (feed.type === 'event' && managedBy(feed)) {
        results.push(logManagedEventFeed(connector, feed, logger));
      }
    }
  }
  return results;
}

export function startRunner({ registry = registryPath(), logger = console.log } = {}) {
  const connectors = loadConnectors(registry, { logger });
  const controller = new AbortController();
  logEvent({ level: 'info', event: 'runner_start', registry, connectors: connectors.length }, logger);
  for (const connector of connectors) {
    logEvent({ level: 'info', event: 'connector_loaded', project: connector.project, file: connector.file, feeds: connector.feeds.length }, logger);
    for (const feed of connector.feeds) {
      if (feed.type === 'poll') {
        schedulePollFeed(connector, feed, { signal: controller.signal, logger });
        continue;
      }
      if (feed.type === 'event') {
        void processEventFeed(connector, feed, { signal: controller.signal, logger });
        continue;
      }
      logEvent({ level: 'warn', event: 'feed_skipped', project: connector.project, feed: feed.name, type: feed.type, reason: 'unknown_type' }, logger);
    }
  }
  return controller;
}

async function main() {
  const once = process.argv.includes('--once') || process.env.BRAIN_CONNECTOR_ONCE === '1';
  try {
    if (once) {
      const results = await runOnce();
      const failures = results.filter((result) => !result.skipped && result.code !== 0).length;
      process.exitCode = failures ? 1 : 0;
      return;
    }
    const controller = startRunner();
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => {
        logEvent({ level: 'info', event: 'runner_stop', signal: sig });
        controller.abort();
        setTimeout(() => process.exit(0), 100).unref();
      });
    }
  } catch (error) {
    logEvent({
      level: 'error',
      event: 'runner_error',
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
