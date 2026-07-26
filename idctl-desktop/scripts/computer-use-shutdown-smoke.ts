import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeComputerUseServer,
  createComputerUseRequestLifecycle,
  trackComputerUseServerSockets,
} from '../src/main/computeruse/requestLifecycle.ts';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

// An ordinary disarm invalidates a delayed capture without closing the local
// listener. No image/state mutation is allowed, but the caller gets a small
// generic stopped response rather than hanging.
{
  const lifecycle = createComputerUseRequestLifecycle();
  lifecycle.openAdmission();
  const lease = lifecycle.begin();
  assert.ok(lease);
  const capture = deferred<string>();
  let exposedFrames = 0;
  let stoppedResponses = 0;
  const pass = capture.promise.then(() => {
    if (lease.isCurrent()) exposedFrames += 1;
    else if (lifecycle.isAccepting()) stoppedResponses += 1;
    lease.finish();
  });
  lifecycle.invalidateActiveWork();
  capture.resolve('private-frame');
  await pass;
  assert.equal(exposedFrames, 0);
  assert.equal(stoppedResponses, 1);
  assert.equal(await lifecycle.drain(10), true);
}

// Terminal stop makes a held approval stale before its await resumes. It may
// neither execute input nor append a late audit entry.
{
  const lifecycle = createComputerUseRequestLifecycle();
  lifecycle.openAdmission();
  const lease = lifecycle.begin();
  assert.ok(lease);
  const approval = deferred<boolean>();
  let inputActions = 0;
  let auditWrites = 0;
  const pass = approval.promise.then((allowed) => {
    if (allowed && lease.isCurrent()) {
      inputActions += 1;
      auditWrites += 1;
    }
    lease.finish();
  });
  lifecycle.closeAdmission();
  approval.resolve(true);
  await pass;
  assert.equal(inputActions, 0);
  assert.equal(auditWrites, 0);
  assert.equal(await lifecycle.drain(10), true);
}

// A client that advertises a body but never finishes sending it is actively
// aborted. The listener close and admitted-request drain are both confirmed.
{
  const lifecycle = createComputerUseRequestLifecycle();
  lifecycle.openAdmission();
  const sockets = new Set<net.Socket>();
  const requestSeen = deferred<void>();
  const server = http.createServer((req) => {
    const lease = lifecycle.begin();
    assert.ok(lease);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      lease.finish();
    };
    req.once('aborted', finish);
    req.once('close', finish);
    req.once('error', finish);
    req.resume();
    requestSeen.resolve(undefined);
  });
  trackComputerUseServerSockets(server, sockets);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = net.createConnection({
    host: '127.0.0.1',
    port: address.port,
  });
  client.on('error', () => {});
  const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));
  client.write([
    'POST /action HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Content-Length: 100',
    '',
    '{"type":"screenshot"',
  ].join('\r\n'));
  await requestSeen.promise;
  assert.equal(lifecycle.activeCount(), 1);
  lifecycle.closeAdmission();
  const [listenerClosed, requestsDrained] = await Promise.all([
    closeComputerUseServer(server, sockets, 250),
    lifecycle.drain(250),
  ]);
  await clientClosed;
  assert.equal(listenerClosed, true);
  assert.equal(requestsDrained, true);
  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
}

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const brokerSource = readFileSync(
  join(desktopRoot, 'src/main/computeruse/broker.ts'),
  'utf8',
);
const mainSource = readFileSync(join(desktopRoot, 'src/main/main.ts'), 'utf8');

const screenshotSource = brokerSource.slice(
  brokerSource.indexOf("if (type === 'screenshot')"),
  brokerSource.indexOf('if (INPUT_VERBS.has(type))'),
);
assert.match(
  screenshotSource,
  /await captureDisplay[\s\S]*if \(!lease\.isCurrent\(\)\) return stoppedAction\(\);[\s\S]*S\.lastShot =/,
  'a delayed screenshot must re-check its generation before exposing frame state',
);
const approvalSource = brokerSource.slice(
  brokerSource.indexOf('const approved = await requestApproval'),
  brokerSource.indexOf('const finalFrame = currentFrameState'),
);
assert.match(
  approvalSource,
  /await requestApproval[\s\S]*if \(!lease\.isCurrent\(\)\) return stoppedAction\(\);[\s\S]*rec\(/,
  'a held action must re-check its generation before input-side audit mutation',
);
const sendSource = brokerSource.slice(
  brokerSource.indexOf('const send = (status: number'),
  brokerSource.indexOf('// DNS-rebinding'),
);
assert.doesNotMatch(
  sendSource,
  /!lease\.isCurrent/,
  'ordinary disarm must still permit a safe stopped response',
);
assert.match(
  brokerSource,
  /await readBody\(req\)[\s\S]*if \(!lease\.isCurrent\(\)\) \{[\s\S]*send\(stopped\.status, stopped\.json\)/,
);
const stopSource = brokerSource.slice(brokerSource.indexOf('export function stopBroker():'));
assert.ok(
  stopSource.indexOf('requestLifecycle.closeAdmission()')
    < stopSource.indexOf('disarmBroker()')
    && stopSource.indexOf('disarmBroker()')
      < stopSource.indexOf('closeComputerUseServer(')
    && stopSource.indexOf('requestLifecycle.drain(')
      < stopSource.indexOf('resetComputerUseAuditProfileState()'),
  'stop must revoke admission, close/drain the listener, then reset profile state',
);
assert.match(mainSource, /trackBackgroundStop\(stopBroker\(\)\)/);

console.log('computer use shutdown smoke: ok');
