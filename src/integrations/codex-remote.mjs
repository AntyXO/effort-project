import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCodexRouting } from './codex-routing.mjs';

const MAX_BYTES = 8 * 1024 * 1024;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function terminate(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await Promise.race([new Promise((done) => { killer.once('error', done); killer.once('close', done); }), delay(1000)]);
    killer.kill();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await delay(100);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill(); } catch {}
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
}

/** A private, single-client transport; no model call occurs until the TUI submits a turn. */
export async function startCodexRemote({ cwd, executable = 'codex', executableArgs = [], env = process.env,
  signal, onDecision = () => {}, WebSocketServerClass, ...routingOptions } = {}) {
  // Loaded only by this integration. The rest of Effort does not need WebSocket support.
  let WebSocketServer = WebSocketServerClass;
  if (!WebSocketServer) {
    try { WebSocketServer = (await import('ws')).WebSocketServer; }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      throw new Error('The experimental Codex terminal transport requires the ws package. It has not been enabled in this build; see docs/automatic.md.');
    }
  }
  if (signal?.aborted) throw new Error('Automatic session was cancelled.');
  const token = randomBytes(32).toString('hex');
  const internalPrefix = `effort_${randomBytes(16).toString('hex')}_`;
  let sequence = 0, client, child, closed = false, closing, buffer = '', activeTurn = null;
  const pending = new Map();
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', abort);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Codex transport closed.')); }
      pending.clear();
      client?.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([terminate(child), new Promise((done) => server.close(done)), new Promise((done) => wss.close(done))]);
    });
    return closing;
  };
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const fail = () => { void close(); };
  const write = (message) => {
    if (closed || !child || child.stdin.destroyed || child.stdin.writableLength > MAX_BYTES * 2) throw new Error('Codex protocol input unavailable.');
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('Codex message exceeds the transport limit.');
    child.stdin.write(`${line}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (pending.size >= 64) { reject(new Error('Too many routing requests.')); return; }
    const id = internalPrefix + (++sequence);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex capability lookup timed out.')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const router = createCodexRouting({ cwd, onDecision, request, ...routingOptions });
  const send = (message) => {
    if (closed || client?.readyState !== 1) return;
    if (client.bufferedAmount > MAX_BYTES * 2) { fail(); return; }
    client.send(JSON.stringify(message), (error) => { if (error) fail(); });
  };
  server.on('upgrade', (req, socket, head) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${token}`);
    const port = server.address()?.port;
    if (closed || client || req.url !== '/' || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    client = ws;
    child = spawn(executable, [...executableArgs, 'app-server', '--listen', 'stdio://'], {
      cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.once('error', fail);
    child.once('close', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => {}); // Provider stderr may contain credentials or private text.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (closed) return;
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_BYTES) { fail(); return; }
        let message;
        try { message = JSON.parse(line); } catch { fail(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(); return; }
        if (typeof message.id === 'string' && message.id.startsWith(internalPrefix) && !message.method) {
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id); clearTimeout(entry.timer);
            if (message.error || !Object.hasOwn(message, 'result')) entry.reject(new Error('Codex rejected capability discovery.'));
            else entry.resolve(message.result);
          }
        } else {
          try { send(router.fromServer(message)); } catch { fail(); return; }
        }
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) fail();
    });
    ws.on('error', fail);
    ws.once('close', fail);
    ws.on('message', async (data, binary) => {
      if (closed) return;
      if (binary || data.length > MAX_BYTES) { fail(); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { fail(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.id === 'string' && message.id.startsWith(internalPrefix)) { fail(); return; }
      const isTurn = message.method === 'turn/start';
      // Do not reorder two submissions while awaiting capability discovery. Normal
      // response, approval and interrupt messages still pass through immediately.
      if (isTurn && activeTurn) { send({ id: message.id, error: { code: -32000, message: 'A turn is already being routed. Retry after it starts.' } }); return; }
      if (isTurn) activeTurn = { threadId: message.params?.threadId, cancelled: false };
      if (message.method === 'turn/interrupt' && activeTurn?.threadId === message.params?.threadId) activeTurn.cancelled = true;
      try {
        const routed = await router.fromClient(message);
        if (isTurn && activeTurn?.cancelled) send({ id: message.id, error: { code: -32800, message: 'Turn cancelled before submission.' } });
        else write(routed);
      } catch { fail(); }
      finally { if (isTurn) activeTurn = null; }
    });
  });
  wss.on('error', fail);
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.removeListener('error', failed); server.removeListener('close', interrupted); signal?.removeEventListener('abort', interrupted); };
      const failed = (error) => { cleanup(); reject(error); };
      const interrupted = () => failed(new Error('Automatic session was cancelled during startup.'));
      server.once('error', failed); server.once('close', interrupted); signal?.addEventListener('abort', interrupted, { once: true });
      server.listen(0, '127.0.0.1', () => { cleanup(); resolve(); });
      if (signal?.aborted) interrupted();
    });
  } catch (error) { await close(); throw error; }
  server.on('error', fail);
  if (signal?.aborted) { await close(); throw new Error('Automatic session was cancelled.'); }
  return { url: `ws://127.0.0.1:${server.address().port}`, token, close };
}

export async function launchCodexAutomatic(options = {}) {
  const { executable = 'codex', executableArgs = [], cwd, model, signal, env = process.env } = options;
  const proxy = await startCodexRemote(options);
  let tui;
  const stop = () => { tui?.kill(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (signal?.aborted) return 130;
    const args = [...executableArgs, '--remote', proxy.url, '--remote-auth-token-env', 'EFFORT_CODEX_REMOTE_TOKEN', '--cd', cwd];
    if (model) args.push('--model', model);
    // No sandbox or approval flags are replaced: the official interface owns them.
    tui = spawn(executable, args, { cwd, env: { ...env, EFFORT_CODEX_REMOTE_TOKEN: proxy.token }, shell: false, stdio: 'inherit' });
    return await new Promise((resolve, reject) => { tui.once('error', reject); tui.once('close', (code) => resolve(code ?? 130)); });
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
    await proxy.close();
  }
}
