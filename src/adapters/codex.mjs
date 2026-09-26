import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const capabilities = Object.freeze({
  id: 'codex',
  name: 'Codex CLI',
  levels: Object.freeze(['low', 'medium', 'high']),
  control: 'managed-turns',
  notes: 'Uses app-server turn/start.effort and checks model/list. Controls new managed turns, not in-flight requests or desktop chats. Approval requests stop the run.',
});

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens'];
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const emptyUsage = () => ({ inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null });
const activeSessions = new Set();

class AdapterError extends Error {
  constructor(code, message, status = 'failed') {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Provider error text and stderr may contain credentials. Expose fixed diagnostics instead.
const protocolError = () => new AdapterError('protocol_error', 'Codex returned an unsupported or invalid app-server response.');
const tokens = (value) => value && TOKEN_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
  ? Object.fromEntries(TOKEN_KEYS.map((key) => [key, value[key]])) : null;

class AppServer {
  constructor({ executable, executableArgs, cwd, env, onMessage, onFailure }) {
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.bytes = 0;
    this.closing = false;
    this.failure = null;
    this.closed = false;
    this.child = spawn(executable, [...executableArgs, 'app-server', '--listen', 'stdio://'], {
      cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsHide: true,
    });
    this.closedPromise = new Promise((resolveClosed) => {
      this.child.once('close', () => {
        this.closed = true;
        resolveClosed();
        if (!this.closing) this.fail(new AdapterError('process_exit', 'Codex exited before the managed turn finished.'), onFailure);
      });
    });
    this.child.on('error', (error) => this.fail(new AdapterError(
      error.code === 'ENOENT' ? 'cli_not_found' : 'process_error',
      error.code === 'ENOENT' ? 'Codex CLI was not found. Install it and sign in before running this adapter.' : 'Codex CLI could not be started.',
      'blocked',
    ), onFailure));
    this.child.stdin.on('error', () => {
      if (!this.closing) this.fail(new AdapterError('stdin_closed', 'The Codex protocol input closed unexpectedly.'), onFailure);
    });
    // Drain stderr without retaining or forwarding potentially sensitive provider diagnostics.
    this.child.stderr.on('data', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      if (this.failure || this.closing) return;
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_STREAM_BYTES) return this.fail(new AdapterError('output_limit', 'Codex exceeded the protocol output limit.'), onFailure);
      this.buffer += chunk;
      let boundary;
      while ((boundary = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.fail(new AdapterError('output_limit', 'A Codex protocol message exceeded the size limit.'), onFailure);
        let message;
        try { message = JSON.parse(line); } catch { return this.fail(protocolError(), onFailure); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail(protocolError(), onFailure);
        if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            if (message.error) pending.reject(new AdapterError('rpc_error', `Codex rejected the ${pending.method} request.`));
            else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
            else pending.reject(protocolError());
          }
        } else if (typeof message.method === 'string') {
          try { onMessage(message); } catch (error) { this.fail(error instanceof AdapterError ? error : protocolError(), onFailure); }
        } else return this.fail(protocolError(), onFailure);
        if (this.failure) return;
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.fail(new AdapterError('output_limit', 'An unterminated Codex message exceeded the size limit.'), onFailure);
    });
  }

  fail(error, onFailure) {
    if (this.failure || this.closing) return;
    this.failure = error;
    this.rejectPending(error);
    onFailure(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  write(message) {
    if (this.closed || this.child.stdin.destroyed) throw new AdapterError('stdin_closed', 'The Codex protocol input is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      this.pending.set(id, { resolve: resolveRequest, reject, method });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async close(threadId, turnId, interrupt) {
    this.closing = true;
    this.rejectPending(new AdapterError('closed', 'The managed Codex connection closed.'));
    if (interrupt && threadId && turnId && !this.closed) {
      try { this.write({ id: this.nextId++, method: 'turn/interrupt', params: { threadId, turnId } }); } catch {}
      await Promise.race([this.closedPromise, sleep(150)]);
    }
    this.child.stdin.end();
    await Promise.race([this.closedPromise, sleep(150)]);
    const pid = this.child.pid;
    if (pid && process.platform !== 'win32') {
      // Terminate the process group even if its leader exited but tool descendants remain.
      try { process.kill(-pid, 'SIGTERM'); } catch {}
      await Promise.race([this.closedPromise, sleep(150)]);
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    } else if (pid && !this.closed) {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore', windowsHide: true });
      await Promise.race([new Promise((done) => { killer.once('error', done); killer.once('close', done); }), sleep(1000)]);
      killer.kill();
      this.child.kill();
    }
    await Promise.race([this.closedPromise, sleep(250)]);
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.stdin.destroy();
    this.buffer = '';
  }
}

/** Execute exactly one Codex turn; sessionId is the resumable Codex thread ID. */
export async function run({ prompt, cwd, effort, model, sessionId, allowWrite = false, timeoutMs = 120000, signal, onEvent = () => {}, env = process.env, executable = 'codex', executableArgs = [] } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > MAX_TEXT_BYTES) throw new TypeError('prompt must be nonempty text of at most 256 KiB.');
  if (!capabilities.levels.includes(effort)) throw new TypeError('Codex adapter effort must be low, medium, or high.');
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) throw new TypeError('cwd must identify an existing directory.');
  if (typeof allowWrite !== 'boolean') throw new TypeError('allowWrite must be a boolean.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('timeoutMs must be a positive, supported timer duration.');
  if (typeof executable !== 'string' || !executable || executable.includes('\0')) throw new TypeError('executable must be a CLI path or command name.');
  if (!Array.isArray(executableArgs) || executableArgs.length > 100 || executableArgs.some((argument) => typeof argument !== 'string' || argument.includes('\0') || argument.length > 20_000)) throw new TypeError('executableArgs must be an array of at most 100 bounded strings without NUL characters.');
  for (const [key, value] of [['model', model], ['sessionId', sessionId]]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value))) throw new TypeError(`${key} must be a nonempty identifier.`);
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function.');
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) throw new TypeError('signal must be an AbortSignal.');
  const directory = await realpath(resolve(cwd));
  if (!(await stat(directory)).isDirectory()) throw new TypeError('cwd must identify an existing directory.');
  const approvalPolicy = allowWrite ? 'on-request' : 'untrusted';

  let eventCount = 0;
  const emit = (event) => {
    if (eventCount++ >= 2000) return;
    try { onEvent({ provider: 'codex', ...event }); } catch { /* UI observers must not strand a child process. */ }
  };
  const result = {
    provider: 'codex', sessionId: sessionId ?? null, requestedEffort: effort,
    effortEvidence: { kind: 'turn-request', method: 'turn/start', requestedEffort: effort, accepted: false, model: null, supportedEfforts: [], configuredEffort: null },
    text: '', usage: emptyUsage(), status: 'failed',
  };
  if (signal?.aborted) return { ...result, status: 'cancelled' };
  if (sessionId && activeSessions.has(sessionId)) {
    emit({ type: 'diagnostic', code: 'session_busy', message: 'This adapter already has a turn running for that session.' });
    return { ...result, status: 'blocked' };
  }
  if (sessionId) activeSessions.add(sessionId);
  let registeredId = sessionId;
  let turnId = null;
  let submitted = false;
  let finished = false;
  let baseline = sessionId ? null : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let latestTotal = null;
  let textBytes = 0;
  const messages = new Map();
  const earlyEvents = [];
  const completion = Promise.withResolvers();
  const failure = Promise.withResolvers();
  completion.promise.catch(() => {});
  failure.promise.catch(() => {});
  let failureReason;
  const fail = (error) => {
    if (failureReason) return;
    failureReason = error;
    failure.reject(error);
  };

  const collectMessage = (item) => {
    if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || typeof item.text !== 'string') return;
    const old = messages.get(item.id);
    textBytes += Buffer.byteLength(item.text) - Buffer.byteLength(old?.text ?? '');
    if (textBytes > MAX_TEXT_BYTES || messages.size >= 2000 && !old) throw new AdapterError('output_limit', 'Codex exceeded the retained answer limit.');
    messages.set(item.id, { text: item.text, phase: item.phase });
  };

  const processNotification = ({ method, params = {} }) => {
    if (params.threadId !== result.sessionId) return;
    if (method === 'thread/tokenUsage/updated' && !submitted) {
      baseline = tokens(params.tokenUsage?.total);
      return;
    }
    if (submitted && !turnId) {
      if (earlyEvents.length >= 128) throw new AdapterError('output_limit', 'Too many Codex notifications arrived before the turn was acknowledged.');
      earlyEvents.push({ method, params });
      return;
    }
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (!turnId || eventTurnId !== turnId) return;
    if (method === 'item/completed') {
      collectMessage(params.item);
      if (params.item?.type !== 'agentMessage') emit({ type: 'tool', name: params.item?.type ?? 'unknown', status: params.item?.status ?? 'completed', exitCode: params.item?.exitCode ?? null });
    } else if (method === 'thread/tokenUsage/updated') {
      latestTotal = tokens(params.tokenUsage?.total);
    } else if (method === 'model/rerouted') {
      throw new AdapterError('model_rerouted', 'Codex reported a server-side model change; this adapter does not silently substitute models.', 'blocked');
    } else if (method === 'error') {
      emit({ type: 'diagnostic', code: params.willRetry ? 'provider_retry' : 'provider_error', message: params.willRetry ? 'Codex reported a retryable provider error.' : 'Codex reported a provider error.' });
    } else if (method === 'turn/completed') {
      if (!params.turn || !['completed', 'failed', 'interrupted'].includes(params.turn.status)) throw protocolError();
      for (const item of params.turn.items ?? []) collectMessage(item);
      finished = true;
      completion.resolve(params.turn.status);
    }
  };

  let server;
  const abort = () => fail(new AdapterError('cancelled', 'The managed Codex turn was cancelled.', 'cancelled'));
  const timer = setTimeout(() => fail(new AdapterError('timeout', 'The managed Codex turn exceeded its time limit.')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    if (failureReason) throw failureReason;
    server = new AppServer({ executable, executableArgs, cwd: directory, env, onFailure: fail, onMessage: (message) => {
      if (Object.hasOwn(message, 'id')) {
        // No UI approval callback is in the adapter contract. Deny rather than approve implicitly.
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          server.write({ id: message.id, result: { decision: 'cancel' } });
        } else if (message.method === 'item/permissions/requestApproval') {
          server.write({ id: message.id, result: { permissions: {}, scope: 'turn' } });
        } else {
          server.write({ id: message.id, error: { code: -32601, message: 'This managed client cannot answer interactive requests.' } });
        }
        fail(new AdapterError('interaction_required', 'Codex requested approval or user input. Continue in Codex to review it.', 'blocked'));
      } else processNotification(message);
    } });
    emit({ type: 'status', status: 'starting', sandbox: allowWrite ? 'workspace-write' : 'read-only' });
    const execute = async () => {
      await server.request('initialize', { clientInfo: { name: 'effort_project', title: 'Effort Project', version: '0.1.0' } });
      server.write({ method: 'initialized', params: {} });
      const threadParams = {
        cwd: directory, sandbox: allowWrite ? 'workspace-write' : 'read-only',
        approvalPolicy, approvalsReviewer: 'user',
        ...(model ? { model } : {}),
        ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false }),
      };
      const opened = await server.request(sessionId ? 'thread/resume' : 'thread/start', threadParams);
      const id = opened?.thread?.id;
      if (typeof id !== 'string' || !id || typeof opened.model !== 'string') throw protocolError();
      if (sessionId && id !== sessionId) throw new AdapterError('session_mismatch', 'Codex resumed a different session than requested.');
      if (opened.thread.status?.type === 'active') throw new AdapterError('session_busy', 'The Codex session already has active work.', 'blocked');
      result.sessionId = id;
      if (!registeredId) { registeredId = id; activeSessions.add(id); }
      const expectedSandbox = allowWrite ? 'workspaceWrite' : 'readOnly';
      if (opened.sandbox?.type !== expectedSandbox || opened.approvalPolicy !== approvalPolicy || opened.approvalsReviewer !== 'user') {
        throw new AdapterError('policy_mismatch', 'Codex did not confirm the requested sandbox and approval policy.', 'blocked');
      }
      if (model && opened.model !== model) throw new AdapterError('model_mismatch', 'Codex resolved a different model than the one requested.', 'blocked');
      result.effortEvidence.model = opened.model;
      emit({ type: 'session', sessionId: id, model: opened.model });

      let cursor;
      let supported;
      const seen = new Set();
      for (let page = 0; page < 20; page++) {
        const catalog = await server.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(catalog?.data)) throw protocolError();
        const entry = catalog.data.find((item) => item?.model === opened.model);
        if (entry) { supported = entry.supportedReasoningEfforts?.map((option) => option.reasoningEffort); break; }
        if (!catalog.nextCursor) break;
        if (typeof catalog.nextCursor !== 'string' || seen.has(catalog.nextCursor)) throw protocolError();
        cursor = catalog.nextCursor;
        seen.add(cursor);
      }
      if (!Array.isArray(supported) || !supported.includes(effort)) throw new AdapterError('unsupported_effort', 'The selected Codex model does not advertise the requested effort.', 'blocked');
      result.effortEvidence.supportedEfforts = supported.filter((level) => typeof level === 'string').slice(0, 32);
      const sandboxPolicy = allowWrite
        ? { type: 'workspaceWrite', writableRoots: [directory], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }
        : { type: 'readOnly', networkAccess: false };
      submitted = true;
      const started = await server.request('turn/start', {
        threadId: id, input: [{ type: 'text', text: prompt }], cwd: directory,
        model: opened.model, effort, sandboxPolicy, approvalPolicy, approvalsReviewer: 'user',
      });
      if (typeof started?.turn?.id !== 'string' || !started.turn.id) throw protocolError();
      turnId = started.turn.id;
      result.effortEvidence = { ...result.effortEvidence, accepted: true, threadId: id, turnId };
      emit({ type: 'effort', effort, evidence: 'turn-request', accepted: true });
      for (const message of earlyEvents.splice(0)) processNotification(message);
      if (['completed', 'failed', 'interrupted'].includes(started.turn.status) && !finished) processNotification({ method: 'turn/completed', params: { threadId: id, turn: started.turn } });
      const status = await completion.promise;
      result.status = status === 'interrupted' ? 'cancelled' : status;
      if (result.status === 'completed') {
        const metadata = await Promise.race([
          server.request('thread/read', { threadId: id, includeTurns: false }).catch(() => null),
          sleep(1000).then(() => null),
        ]);
        const configured = metadata?.thread?.reasoningEffort;
        if (typeof configured === 'string') {
          result.effortEvidence.configuredEffort = configured;
          if (configured !== effort) throw new AdapterError('effort_mismatch', 'Codex thread configuration did not match the requested effort.');
        }
      }
    };
    await Promise.race([execute(), failure.promise]);
  } catch (error) {
    const safe = error instanceof AdapterError ? error : new AdapterError('adapter_error', 'The Codex adapter could not complete this turn.');
    result.status = safe.status;
    emit({ type: 'diagnostic', code: safe.code, message: safe.message });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (server) await server.close(result.sessionId, turnId, submitted && !finished);
    if (registeredId) activeSessions.delete(registeredId);
  }
  const finalMessages = [...messages.values()].filter((message) => message.phase === 'final_answer');
  result.text = (finalMessages.length ? finalMessages : [...messages.values()]).map((message) => message.text).join('\n\n');
  if (baseline && latestTotal && TOKEN_KEYS.every((key) => latestTotal[key] >= baseline[key])) {
    result.usage = { ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, latestTotal[key] - baseline[key]])), costUsd: null };
  } else if (latestTotal) emit({ type: 'diagnostic', code: 'usage_unavailable', message: 'No reliable pre-turn token baseline was reported; per-turn usage is unavailable.' });
  emit({ type: 'status', status: result.status });
  return result;
}
