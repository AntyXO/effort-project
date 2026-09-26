import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startCodexRemote } from '../src/integrations/codex-remote.mjs';

// Deliberate test boundary: real TCP/HTTP Upgrade and an independent Node JSONL
// child, but WebSocket frame encoding/decoding is represented by this injected
// EventEmitter. These tests do not prove compatibility with ws or the real TUI.
function fakeWebSocketServer() {
  const instances = [];
  class FakeWebSocket extends EventEmitter {
    constructor(socket) {
      super();
      this.socket = socket;
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
      socket.once('end', () => socket.destroy());
      socket.once('close', () => {
        this.readyState = 3;
        this.emit('close');
      });
      socket.on('error', () => {});
    }
    send(text, callback) {
      const message = JSON.parse(text);
      this.sent.push(message);
      this.emit('sent', message);
      callback?.();
    }
    terminate() { this.socket.destroy(); }
    receive(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  }
  class FakeServer extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.connections = [];
      instances.push(this);
    }
    handleUpgrade(_request, socket, _head, callback) {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      const ws = new FakeWebSocket(socket);
      this.connections.push(ws);
      callback(ws);
    }
    close(callback) { this.closed = true; queueMicrotask(callback); }
  }
  return { Class: FakeServer, instances };
}

const backend = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = value => appendFileSync(process.env.EFFORT_FIXTURE_LOG, JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
record({ pid: process.pid, argv: process.argv.slice(2) });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  record({ message });
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'offline-fixture' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: {
    thread: { id: 'fixture-thread', cwd: process.cwd() }, cwd: process.cwd(),
    model: 'fixture-model', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }
  } });
  else if (message.method === 'model/list') send({ id: message.id, result: { data: [{
    id: 'fixture-model', model: 'fixture-model', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low','medium','high'].map(reasoningEffort => ({ reasoningEffort }))
  }], nextCursor: null } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fixture-turn', status: 'inProgress', items: [], error: null } } });
    if (process.env.EFFORT_FIXTURE_MODE === 'approval') send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', command: 'fixture command' } });
  }
  else if (message.id === 'approval-1' && message.result) send({ method: 'fixture/approval-received', params: message.result });
  else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'interrupted', items: [] } } });
  }
  else if (message.method === 'fixture/exit') { process.stderr.write('private fixture diagnostics'); process.exit(0); }
});
`;

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'effort-remote-test-'));
  const script = join(cwd, 'fake-app-server.mjs');
  const log = join(cwd, 'protocol.jsonl');
  await writeFile(script, backend);
  const fake = fakeWebSocketServer();
  const decisions = [];
  const sockets = [];
  let proxy;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await proxy?.close();
    await rm(cwd, { recursive: true, force: true });
  });
  proxy = await startCodexRemote({ cwd, executable: process.execPath, executableArgs: [script],
    env: { EFFORT_FIXTURE_LOG: log, EFFORT_FIXTURE_MODE: options.mode ?? 'normal', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    WebSocketServerClass: fake.Class, onDecision: decision => decisions.push(decision),
    repositoryFactsFn: options.repositoryFactsFn ?? (async () => ({ languages: ['javascript'] })), signal: options.signal,
  });
  const port = Number(new URL(proxy.url).port);
  async function upgrade({ authorization = `Bearer ${proxy.token}`, origin, host = `127.0.0.1:${port}`, path = '/' } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      sockets.push(socket);
      let headers = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Upgrade response timed out.')); }, 3000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => socket.write([
        `GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
        ...(authorization == null ? [] : [`Authorization: ${authorization}`]),
        ...(origin == null ? [] : [`Origin: ${origin}`]), '', '',
      ].join('\r\n')));
      socket.on('data', chunk => {
        headers += chunk.toString();
        if (!headers.includes('\r\n\r\n')) return;
        clearTimeout(timer);
        const status = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]);
        if (status !== 101) socket.destroy();
        resolve({ status, socket, ws: status === 101 ? fake.instances[0].connections.at(-1) : undefined });
      });
    });
  }
  const readLog = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { proxy, fake, decisions, upgrade, readLog };
}

function message(ws, predicate) {
  const existing = ws.sent.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('sent', receive); reject(new Error('Expected protocol message was not received.')); }, 3000);
    const receive = value => { if (predicate(value)) { clearTimeout(timer); ws.off('sent', receive); resolve(value); } };
    ws.on('sent', receive);
  });
}

async function initialize(ws) {
  ws.receive({ id: 1, method: 'initialize', params: { clientInfo: { name: 'offline-test' } } });
  await message(ws, value => value.id === 1);
  ws.receive({ method: 'initialized' });
  ws.receive({ id: 2, method: 'thread/start', params: { sandbox: 'read-only', approvalPolicy: 'on-request' } });
  await message(ws, value => value.id === 2);
}

const turn = { id: 3, method: 'turn/start', params: {
  threadId: 'fixture-thread', input: [{ type: 'text', text: 'Fix a spelling typo.' }], effort: 'high',
  approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
} };

async function closed(ws) {
  if (ws.readyState === 3) return;
  await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { ws.off('close', done); reject(new Error('Expected WebSocket transport to close.')); }, 3000);
    ws.once('close', done);
  });
}

async function assertProcessStopped(pid) {
  for (let i = 0; i < 150; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(20);
  }
  assert.fail(`Fixture process ${pid} survived transport cleanup.`);
}

test('Codex remote requires bearer authentication, exact loopback Host, no Origin, and one client', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const options of [
    { authorization: null }, { authorization: 'Bearer wrong-token' },
    { origin: 'https://example.test' }, { host: 'example.test' }, { path: '/unexpected' },
  ]) assert.equal((await f.upgrade(options)).status, 403);
  assert.equal(f.fake.instances[0].connections.length, 0);
  const accepted = await f.upgrade();
  assert.equal(accepted.status, 101);
  assert.equal((await f.upgrade()).status, 403);
  assert.equal(f.fake.instances[0].connections.length, 1);
  assert.deepEqual(f.fake.instances[0].options, { noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  await initialize(accepted.ws);
});

test('Codex remote rewrites the child request and hides its private model discovery messages', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const { ws } = await f.upgrade();
  await initialize(ws);
  ws.receive(turn);
  await message(ws, value => value.id === 3);
  const entries = await f.readLog();
  assert.deepEqual(entries[0].argv, ['app-server', '--listen', 'stdio://']);
  const requests = entries.filter(entry => entry.message).map(entry => entry.message);
  const discovered = requests.find(value => value.method === 'model/list');
  assert.ok(discovered.id.startsWith('effort_'));
  assert.deepEqual(discovered.params, { includeHidden: true });
  const forwarded = requests.find(value => value.method === 'turn/start');
  assert.deepEqual(forwarded, { ...turn, params: { ...turn.params, effort: 'low' } });
  assert.equal(ws.sent.some(value => value.id === discovered.id), false);
  assert.equal(ws.sent.some(value => value.result?.data?.[0]?.supportedReasoningEfforts), false);
  assert.equal(f.decisions[0].evidence, 'turn-request-rewrite');
  assert.equal(JSON.stringify(f.decisions).includes('spelling typo'), false);
});

test('Codex remote passes provider approvals, user responses, and cancellation without alteration', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { mode: 'approval' });
  const { ws } = await f.upgrade();
  await initialize(ws);
  ws.receive(turn);
  const approval = await message(ws, value => value.id === 'approval-1');
  assert.deepEqual(approval, { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', command: 'fixture command' } });
  const response = { id: 'approval-1', result: { decision: 'cancel' } };
  ws.receive(response);
  assert.deepEqual((await message(ws, value => value.method === 'fixture/approval-received')).params, response.result);
  const cancel = { id: 4, method: 'turn/interrupt', params: { threadId: 'fixture-thread', turnId: 'fixture-turn' } };
  ws.receive(cancel);
  await message(ws, value => value.method === 'turn/completed');
  const requests = (await f.readLog()).filter(entry => entry.message).map(entry => entry.message);
  assert.deepEqual(requests.find(value => value.id === 'approval-1'), response);
  assert.deepEqual(requests.find(value => value.method === 'turn/interrupt'), cancel);
  assert.equal(requests.some(value => /config\/.*write/.test(value.method ?? '')), false);
});

test('Codex remote closes the client and listener when the backend exits', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const { ws } = await f.upgrade();
  await initialize(ws);
  const pid = (await f.readLog())[0].pid;
  ws.receive({ id: 5, method: 'fixture/exit', params: {} });
  await closed(ws);
  await f.proxy.close();
  await assertProcessStopped(pid);
  assert.equal(f.fake.instances[0].closed, true);
  assert.equal(JSON.stringify(ws.sent).includes('private fixture diagnostics'), false);
  await assert.rejects(f.upgrade(), error => error.code === 'ECONNREFUSED');
});

test('Codex remote abort closes the active session and rejects pre-aborted startup', { timeout: 10_000 }, async t => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const fake = fakeWebSocketServer();
  await assert.rejects(startCodexRemote({ signal: alreadyAborted.signal, WebSocketServerClass: fake.Class }), /cancelled/);
  assert.equal(fake.instances.length, 0);
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  const { ws } = await f.upgrade();
  await initialize(ws);
  const pid = (await f.readLog())[0].pid;
  controller.abort();
  await closed(ws);
  await f.proxy.close();
  await assertProcessStopped(pid);
});

test('Codex remote immediate abort settles startup without opening a child session', { timeout: 5_000 }, async () => {
  const controller = new AbortController();
  const fake = fakeWebSocketServer();
  const startup = startCodexRemote({ signal: controller.signal, WebSocketServerClass: fake.Class });
  controller.abort();
  await assert.rejects(startup, /cancelled/);
  assert.equal(fake.instances.length, 1);
  assert.equal(fake.instances[0].connections.length, 0);
  assert.equal(fake.instances[0].closed, true);
});

test('Codex remote interrupt overtakes delayed routing and prevents the unsent model turn', { timeout: 10_000 }, async t => {
  let factsStarted, releaseFacts;
  const started = new Promise(resolve => { factsStarted = resolve; });
  const delayed = new Promise(resolve => { releaseFacts = resolve; });
  const f = await fixture(t, { repositoryFactsFn: async () => { factsStarted(); await delayed; return { languages: ['javascript'] }; } });
  const { ws } = await f.upgrade();
  await initialize(ws);
  ws.receive(turn);
  await started;
  ws.receive({ id: 4, method: 'turn/interrupt', params: { threadId: 'fixture-thread', turnId: 'fixture-turn' } });
  await message(ws, value => value.id === 4);
  releaseFacts();
  const cancelled = await message(ws, value => value.id === 3);
  assert.equal(cancelled.error.code, -32800);
  const requests = (await f.readLog()).filter(entry => entry.message).map(entry => entry.message);
  assert.equal(requests.some(value => value.method === 'turn/start'), false);
  assert.equal(requests.filter(value => value.method === 'turn/interrupt').length, 1);
});

test('Codex remote cleanup is idempotent and client disconnect also reaps the child', { timeout: 15_000 }, async t => {
  for (const mode of ['explicit', 'disconnect']) {
    const f = await fixture(t);
    const { ws, socket } = await f.upgrade();
    await initialize(ws);
    const pid = (await f.readLog())[0].pid;
    if (mode === 'explicit') await Promise.all([f.proxy.close(), f.proxy.close()]);
    else socket.destroy();
    await closed(ws);
    await f.proxy.close();
    await assertProcessStopped(pid);
    assert.equal(f.fake.instances[0].closed, true);
  }
});
