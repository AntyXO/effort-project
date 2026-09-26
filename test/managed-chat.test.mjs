import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedChat } from '../src/integrations/managed-chat.mjs';

const SESSION = '12345678-1234-4234-8234-123456789abc';
const OTHER_SESSION = '87654321-1234-4234-8234-123456789abc';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function completed(options, changes = {}) {
  return { status: 'completed', sessionId: options.sessionId ?? SESSION, text: 'A provider answer.',
    requestedEffort: options.effort, usage: { inputTokens: 8, outputTokens: 5, costUsd: null },
    effortEvidence: { type: 'launch-flag', requested: options.effort,
      observedEffort: null, verified: false, observedModel: options.model ?? DEFAULT_MODEL }, ...changes };
}

async function fixture(t, options = {}, run = async (request) => completed(request)) {
  const cwd = await mkdtemp(join(tmpdir(), 'effort-chat-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [];
  const events = [];
  const adapter = { capabilities: { id: 'claude', levels: ['low', 'medium', 'high'] },
    async run(request) { calls.push(request); return run(request); } };
  const chat = createManagedChat({ adapter, cwd, onEvent: (event) => events.push(event), ...options });
  return { chat, calls, events, adapter, cwd };
}

test('routes before the provider call, resumes the same session, and retains the observed model', async (t) => {
  const f = await fixture(t);
  const first = await f.chat.submit('Fix a spelling typo in the heading.');
  assert.equal(first.status, 'unverified');
  assert.equal(f.calls[0].effort, 'low');
  assert.equal(f.calls[0].sessionId, undefined);
  assert.equal(f.calls[0].model, undefined);
  assert.equal(f.events[0].type, 'routing');
  assert.equal(f.events[0].requestedEffort, 'low');
  assert.equal(first.requestedModel, null);
  assert.equal(first.observedModel, DEFAULT_MODEL);
  const second = await f.chat.submit('Investigate a regression across the permission system.');
  assert.equal(second.status, 'unverified');
  assert.equal(f.calls[1].effort, 'high');
  assert.equal(f.calls[1].sessionId, SESSION);
  assert.equal(f.calls[1].model, DEFAULT_MODEL);
  assert.equal(second.turn, 2);
  assert.equal(second.verification.status, 'not-run');
  assert.equal(second.observedEffort, null);
  assert.equal(second.effortEvidence.verified, false);
});

test('an ambiguous continuation retains earlier effort after learning the actual model', async (t) => {
  const f = await fixture(t);
  await f.chat.submit('Investigate a security regression.');
  const second = await f.chat.submit('Yes, do it.');
  assert.equal(second.requestedEffort, 'high');
  assert.match(second.decision.reasons.join(' '), /continue the same task/);
  await f.chat.submit('Fix a spelling typo.');
  await f.chat.submit('Fix another spelling typo.');
  assert.deepEqual(f.calls.map((call) => call.effort), ['high', 'high', 'high', 'low']);
});

test('explicit effort and model pins take precedence over prompt difficulty and the model table', async (t) => {
  const f = await fixture(t, { effort: 'low', model: 'claude-opus-4-6', models: { low: DEFAULT_MODEL } });
  const result = await f.chat.submit('Investigate an authentication vulnerability.');
  assert.equal(f.calls[0].effort, 'low');
  assert.equal(f.calls[0].model, 'claude-opus-4-6');
  assert.deepEqual(result.decision.reasons, ['Explicit user effort selection.']);
  await f.chat.submit('Continue.');
  assert.equal(f.calls[1].model, 'claude-opus-4-6');
});

test('opt-in model routing uses only supplied tiers and holds the current model for missing tiers', async (t) => {
  const models = { low: DEFAULT_MODEL, high: 'claude-opus-4-6' };
  const f = await fixture(t, { models });
  models.low = 'unexpected-model';
  await f.chat.submit('Fix a spelling typo.');
  await f.chat.submit('Investigate a security regression.');
  assert.deepEqual(f.calls.map((call) => call.model), [DEFAULT_MODEL, 'claude-opus-4-6']);
  assert.equal(f.calls[1].sessionId, SESSION);
  const missingTier = await fixture(t, { models: { high: 'claude-opus-4-6' } });
  await missingTier.chat.submit('Fix a spelling typo.');
  await missingTier.chat.submit('Write a short description of the project.');
  assert.equal(missingTier.calls[0].model, undefined);
  assert.equal(missingTier.calls[1].model, DEFAULT_MODEL);
});

test('fresh repository metadata is read for each prompt without writing task records', async (t) => {
  const f = await fixture(t);
  const first = await f.chat.submit('Describe the project.');
  assert.equal(first.repository.scannedFiles, 0);
  await writeFile(join(f.cwd, 'main.py'), 'secret source body');
  const second = await f.chat.submit('Describe main.py.');
  assert.equal(second.repository.scannedFiles, 1);
  assert.equal(second.repository.mentionedFiles, 1);
  assert.deepEqual(second.repository.languages, ['python']);
  assert.deepEqual(await readdir(f.cwd), ['main.py']);
  assert.ok(!JSON.stringify(second).includes('secret source body'));
});

test('bounds apply before invocation and unsupported fixed settings never launch', async (t) => {
  const capped = await fixture(t, { maxEffort: 'medium' });
  assert.equal((await capped.chat.submit('Investigate a security regression.')).requestedEffort, 'medium');
  const floor = await fixture(t, { minEffort: 'high' });
  assert.equal((await floor.chat.submit('Fix a spelling typo.')).requestedEffort, 'high');
  for (const options of [{ effort: 'xhigh', maxEffort: 'max' }, { effort: 'high', maxEffort: 'medium' }, { effort: 'low', minEffort: 'medium' }]) {
    const f = await fixture(t, options);
    const result = await f.chat.submit('Read the project.');
    assert.equal(result.status, 'blocked');
    assert.equal(result.code, 'unsupported_effort');
    assert.equal(f.calls.length, 0);
  }
});

test('an automatic request with no suitable supported effort does not silently downgrade', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const chat = createManagedChat({ cwd: f.cwd, adapter: { capabilities: { id: 'claude', levels: ['low'] }, run: async (request) => calls.push(request) } });
  const result = await chat.submit('Investigate a security regression.');
  assert.equal(result.status, 'blocked');
  assert.equal(result.decision.action, 'preserve');
  assert.equal(result.requestedEffort, null);
  assert.equal(calls.length, 0);
});

test('concurrent submission and reset are rejected without a second provider call', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, {}, async (request) => { started.resolve(); await release.promise; return completed(request); });
  const pending = f.chat.submit('Read the project.');
  await started.promise;
  await assert.rejects(f.chat.submit('Submit another task.'), /one prompt at a time/);
  assert.throws(() => f.chat.reset(), /current turn/);
  release.resolve();
  assert.equal((await pending).status, 'unverified');
  assert.equal(f.calls.length, 1);
});

test('failed, blocked, cancelled, and unknown provider results require explicit reset without retry', async (t) => {
  for (const status of ['failed', 'blocked', 'cancelled', 'unknown']) {
    const f = await fixture(t, {}, async (request) => completed(request, { status }));
    const first = await f.chat.submit('Read the project.');
    assert.equal(first.status, status === 'cancelled' ? 'cancelled' : 'blocked');
    assert.equal(first.requiresReset, true);
    const next = await f.chat.submit('Continue.');
    assert.equal(next.code, 'reset_required');
    assert.equal(f.calls.length, 1);
  }
});

test('thrown provider errors are not exposed and do not silently restart a resumed conversation', async (t) => {
  let count = 0;
  const f = await fixture(t, {}, async (request) => {
    if (++count === 2) throw new Error('sensitive-prompt-secret-key');
    return completed(request);
  });
  await f.chat.submit('Read the project.');
  const failure = await f.chat.submit('Continue.');
  assert.equal(failure.code, 'provider_error');
  assert.equal(failure.requiresReset, true);
  assert.ok(!JSON.stringify(failure).includes('sensitive-prompt-secret-key'));
  assert.equal(f.calls[1].sessionId, SESSION);
  await f.chat.submit('Try again.');
  assert.equal(f.calls.length, 2);
  f.chat.reset();
  assert.equal((await f.chat.submit('Fix a spelling typo.')).status, 'unverified');
  assert.equal(f.calls[2].sessionId, undefined);
  assert.equal(f.calls[2].effort, 'low');
});

test('missing or changed session IDs block further prompts rather than losing conversation context', async (t) => {
  for (const badId of [null, '', '../transcript.json', OTHER_SESSION]) {
    let count = 0;
    const f = await fixture(t, {}, async (request) => completed(request, ++count === 1 ? {} : { sessionId: badId }));
    await f.chat.submit('Read the project.');
    const result = await f.chat.submit('Continue.');
    assert.equal(result.code, 'session_unconfirmed');
    assert.equal(result.status, 'blocked');
    assert.equal(result.sessionId, SESSION);
    assert.equal(result.requiresReset, true);
    await f.chat.submit('Continue again.');
    assert.equal(f.calls.length, 2);
  }
});

test('reset clears the provider session, learned model, routing history, and turn counter', async (t) => {
  const f = await fixture(t);
  await f.chat.submit('Investigate a security regression.');
  f.chat.reset();
  const next = await f.chat.submit('Fix a spelling typo.');
  assert.equal(next.turn, 1);
  assert.equal(next.requestedEffort, 'low');
  assert.equal(f.calls[1].sessionId, undefined);
  assert.equal(f.calls[1].model, undefined);
});

test('cancellation before launch does not call the provider', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t, { signal: controller.signal });
  const result = await f.chat.submit('Read the project.');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requiresReset, false);
  assert.equal(f.calls.length, 0);
});

test('cancellation during an active turn is passed through and prevents uncertain continuation', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal }, async (request) => {
    assert.equal(request.signal, controller.signal);
    controller.abort();
    return completed(request, { status: 'cancelled' });
  });
  const result = await f.chat.submit('Read the project.');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.requiresReset, true);
  assert.equal(f.calls.length, 1);
});

test('adapter execution settings and explicit write permission pass through without weakening defaults', async (t) => {
  const f = await fixture(t, { executable: process.execPath, executableArgs: ['fake.mjs'], env: { PATH: 'fixture-path' }, maxTurns: 3, maxBudgetUsd: 0.1, timeoutMs: 3000 });
  await f.chat.submit('Read the project.');
  assert.equal(f.calls[0].allowWrite, false);
  assert.equal(f.calls[0].executable, process.execPath);
  assert.deepEqual(f.calls[0].executableArgs, ['fake.mjs']);
  assert.deepEqual(f.calls[0].env, { PATH: 'fixture-path' });
  assert.equal(f.calls[0].maxTurns, 3);
  assert.equal(f.calls[0].maxBudgetUsd, 0.1);
  assert.equal(f.calls[0].timeoutMs, 3000);
  const writable = await fixture(t, { allowWrite: true });
  await writable.chat.submit('Fix a spelling typo.');
  assert.equal(writable.calls[0].allowWrite, true);
});

test('invalid configuration and prompt inputs fail before provider invocation', async (t) => {
  const f = await fixture(t);
  const base = { adapter: f.adapter, cwd: f.cwd };
  for (const options of [{ cwd: 'relative' }, { model: '--model=bad' }, { model: 'bad model' }, { models: { low: 'x\nrun' } },
    { models: { unknown: DEFAULT_MODEL } }, { models: ['model'] }, { models: { low: () => 'model' } },
    { effort: 'ultra' }, { minEffort: 'high', maxEffort: 'low' }, { allowWrite: 'true' }, { timeoutMs: -1 }, { signal: {} }]) {
    assert.throws(() => createManagedChat({ ...base, ...options }));
  }
  let getterRead = false;
  assert.throws(() => createManagedChat({ ...base, models: { get low() { getterRead = true; return DEFAULT_MODEL; } } }));
  assert.equal(getterRead, false);
  for (const prompt of ['', ' ', null, {}, 'x\0y', 'x'.repeat(100_001)]) await assert.rejects(f.chat.submit(prompt));
  assert.equal(f.calls.length, 0);
});

test('a preparation error returns a bounded error without submitting the prompt', async (t) => {
  const f = await fixture(t);
  await rm(f.cwd, { recursive: true, force: true });
  const result = await f.chat.submit('Private input that must not appear in a diagnostic.');
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'preparation_error');
  assert.equal(result.requiresReset, false);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(result).includes('Private input'));
});

test('a failed routing observer does not add an unsent prompt to routing history', async (t) => {
  let observerCalls = 0;
  const f = await fixture(t, { onEvent() { if (++observerCalls === 1) throw new Error('observer failed'); } });
  const first = await f.chat.submit('Investigate a security regression.');
  assert.equal(first.code, 'preparation_error');
  assert.equal(first.requiresReset, false);
  assert.equal(f.calls.length, 0);
  const second = await f.chat.submit('Fix a spelling typo.');
  assert.equal(second.status, 'unverified');
  assert.equal(second.requestedEffort, 'low');
});
