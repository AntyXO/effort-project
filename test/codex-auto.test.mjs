import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexRouting } from '../src/integrations/codex-routing.mjs';

const catalogModel = (model = 'codex-fixture', levels = ['low', 'medium', 'high'], id = model) => ({
  id, model, displayName: model, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: 'Fixture capability' })),
  inputModalities: ['text', 'image'], isDefault: true,
});

function fixture(options = {}) {
  const events = [];
  const requests = [];
  const factsCalls = [];
  let nextId = 100;
  const routing = createCodexRouting({
    cwd: '/workspace/default',
    request: async (method, params) => {
      requests.push({ method, params });
      return { data: [catalogModel()], nextCursor: null };
    },
    repositoryFactsFn: async (cwd, prompt) => { factsCalls.push({ cwd, prompt }); return { languages: ['javascript'], mentionedFiles: 0 }; },
    ...options,
    onDecision: event => { events.push(event); options.onDecision?.(event); },
  });
  const turn = (prompt = 'Correct a spelling typo in the heading.', threadId = 'thread-1', extra = {}) => ({
    id: nextId++, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: 'high', ...extra },
  });
  async function thread(id = 'thread-1', model = 'codex-fixture', cwd = '/workspace/project', method = 'thread/start', extra = {}) {
    const request = { id: nextId++, method, params: { model, cwd, ...extra } };
    assert.strictEqual(await routing.fromClient(request), request);
    const response = { id: request.id, result: { thread: { id, cwd, status: { type: 'idle' } }, model, cwd, reasoningEffort: 'medium', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false } } };
    assert.strictEqual(routing.fromServer(response), response);
  }
  const ack = message => routing.fromServer({ id: message.id, result: { turn: { id: `turn-${message.id}`, status: 'inProgress', items: [], error: null } } });
  return { ...routing, events, requests, factsCalls, thread, turn, ack };
}

test('Codex automatic routing rewrites actual turn effort and preserves security controls and text', async () => {
  const f = fixture();
  await f.thread();
  const original = f.turn('Fix this spelling typo: "$(do-not-run)".', 'thread-1', {
    approvalPolicy: 'on-request', approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/workspace/project'], networkAccess: false },
    outputSchema: { type: 'object' }, summary: 'concise', serviceTier: 'flex',
  });
  const rewritten = await f.fromClient(original);
  assert.equal(rewritten.params.effort, 'low');
  assert.deepEqual(rewritten, { ...original, params: { ...original.params, effort: 'low' } });
  assert.equal(original.params.effort, 'high');
  assert.strictEqual(rewritten.params.input, original.params.input);
  assert.strictEqual(rewritten.params.sandboxPolicy, original.params.sandboxPolicy);
  assert.deepEqual(f.requests, [{ method: 'model/list', params: { includeHidden: true } }]);
  assert.equal(f.factsCalls[0].cwd, '/workspace/project');
  assert.equal(f.events[0].evidence, 'turn-request-rewrite');
  assert.equal(f.events[0].action, 'apply');
  assert.equal(JSON.stringify(f.events).includes('do-not-run'), false);
  assert.equal(JSON.stringify(f.events).includes('/workspace'), false);
});

test('Codex leaves approvals, interrupts, steering, tool replies, and unknown methods untouched', async () => {
  const f = fixture();
  for (const message of [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_tui' } } },
    { id: 'approval', result: { decision: 'decline' } },
    { id: 2, method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } },
    { id: 3, method: 'turn/steer', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Debug security' }] } },
    { method: 'initialized' },
    { id: 4, method: 'future/command', params: { effort: 'high' } },
  ]) assert.strictEqual(await f.fromClient(message), message);
  const approval = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'a command' } };
  assert.strictEqual(f.fromServer(approval), approval);
  assert.equal(f.events.length, 0);
  assert.equal(f.requests.length, 0);
});

test('Codex discovers paginated catalogs and matches advertised picker aliases', async () => {
  const calls = [];
  const f = fixture({ request: async (method, params) => {
    calls.push(params);
    return params.cursor ? { data: [catalogModel('codex-fixture', ['low', 'medium', 'high'], 'picker-fixture')], nextCursor: null } : { data: [catalogModel('other-model')], nextCursor: 'next-page' };
  } });
  await f.thread('thread-1', 'picker-fixture');
  const rewritten = await f.fromClient(f.turn());
  assert.equal(rewritten.params.effort, 'low');
  assert.equal(rewritten.params.model, undefined, 'normal model selection is not rewritten');
  assert.deepEqual(calls, [{ includeHidden: true }, { includeHidden: true, cursor: 'next-page' }]);
});

test('Codex can observe a client model catalog without making private RPC calls', async () => {
  const f = fixture({ request: undefined });
  await f.thread();
  const catalogRequest = { id: 'models-client', method: 'model/list', params: {} };
  await f.fromClient(catalogRequest);
  const catalogReply = { id: 'models-client', result: { data: [catalogModel()], nextCursor: null } };
  assert.strictEqual(f.fromServer(catalogReply), catalogReply);
  assert.equal((await f.fromClient(f.turn())).params.effort, 'low');
});

test('Codex preserves unknown models and unsupported efforts instead of inventing capabilities', async () => {
  const f = fixture();
  await f.thread('thread-1', 'unknown-model');
  const unknown = f.turn();
  assert.strictEqual(await f.fromClient(unknown), unknown);
  assert.match(f.events.at(-1).reasons[0], /no discovered/);

  const limited = fixture({ request: async () => ({ data: [catalogModel('codex-fixture', ['low'])], nextCursor: null }) });
  await limited.thread();
  const complex = limited.turn('Investigate the distributed authentication regression.');
  assert.strictEqual(await limited.fromClient(complex), complex);
  assert.equal(limited.events.at(-1).action, 'preserve');
});

test('Codex respects discovered xhigh capabilities and configured ceilings', async () => {
  const request = async () => ({ data: [catalogModel('codex-fixture', ['xhigh'])], nextCursor: null });
  const f = fixture({ request, maxEffort: 'xhigh' });
  await f.thread();
  assert.equal((await f.fromClient(f.turn())).params.effort, 'xhigh');
  const ceiling = fixture({ request });
  await ceiling.thread();
  const original = ceiling.turn();
  assert.strictEqual(await ceiling.fromClient(original), original);
});

test('Codex fixed effort pins override heuristic and TUI effort within bounds', async () => {
  const f = fixture({ effort: 'medium', minEffort: 'medium', maxEffort: 'high' });
  await f.thread();
  assert.equal((await f.fromClient(f.turn('Investigate a security vulnerability.'))).params.effort, 'medium');
  assert.equal(f.events.at(-1).mode, 'fixed');
  assert.throws(() => createCodexRouting({ effort: 'low', minEffort: 'medium' }), /outside/);
  assert.throws(() => createCodexRouting({ minEffort: 'high', maxEffort: 'low' }), /Minimum/);
  const unsupported = fixture({ effort: 'medium', request: async () => ({ data: [catalogModel('codex-fixture', ['low', 'high'])], nextCursor: null }) });
  await unsupported.thread();
  const original = unsupported.turn();
  assert.strictEqual(await unsupported.fromClient(original), original);
});

test('Codex explicit model maps use discovered models, while launcher model pin wins', async () => {
  const request = async () => ({ data: [catalogModel(), catalogModel('fast-model'), catalogModel('deep-model')], nextCursor: null });
  const f = fixture({ request, models: { low: 'fast-model', high: 'deep-model' } });
  await f.thread();
  const easy = await f.fromClient(f.turn());
  assert.equal(easy.params.model, 'fast-model');
  assert.equal(easy.params.effort, 'low');
  f.ack(easy);
  const hard = await f.fromClient(f.turn('Diagnose a race condition.'));
  assert.equal(hard.params.model, 'deep-model');
  assert.equal(hard.params.effort, 'high');
  f.ack(hard);
  const followup = await f.fromClient(f.turn('Yes, do it.'));
  assert.equal(followup.params.model, 'deep-model');
  assert.equal(followup.params.effort, 'high');

  const pinned = fixture({ request, model: 'codex-fixture', models: { low: 'fast-model' } });
  await pinned.thread();
  assert.equal((await pinned.fromClient(pinned.turn())).params.model, 'codex-fixture');
  assert.equal(pinned.events.at(-1).modelSelection, 'pinned');
});

test('Codex unknown mapped models preserve the complete request', async () => {
  const f = fixture({ models: { low: 'unavailable-model' } });
  await f.thread();
  const original = f.turn();
  assert.strictEqual(await f.fromClient(original), original);
  assert.throws(() => createCodexRouting({ models: { low: '--injected option' } }), /exact model/);
});

test('Codex rewrites collaboration settings that take precedence without changing mode instructions', async () => {
  const f = fixture({ request: async () => ({ data: [catalogModel(), catalogModel('plan-model')], nextCursor: null }) });
  await f.thread();
  const original = f.turn('Fix the spelling typo.', 'thread-1', {
    model: 'unavailable-stale-top-level-model',
    collaborationMode: { mode: 'plan', settings: { model: 'plan-model', reasoning_effort: 'high', developer_instructions: 'Keep the plan requirements.' } },
  });
  const rewritten = await f.fromClient(original);
  assert.equal(rewritten.params.effort, 'low');
  assert.equal(rewritten.params.model, original.params.model);
  assert.deepEqual(rewritten.params.collaborationMode, { mode: 'plan', settings: { model: 'plan-model', reasoning_effort: 'low', developer_instructions: 'Keep the plan requirements.' } });
  assert.equal(original.params.collaborationMode.settings.reasoning_effort, 'high');
  assert.equal(f.events.at(-1).model, 'plan-model');

  const pinned = fixture({ model: 'codex-fixture' });
  await pinned.thread();
  const result = await pinned.fromClient(original);
  assert.equal(result.params.model, 'codex-fixture');
  assert.equal(result.params.collaborationMode.settings.model, 'codex-fixture');
});

test('Codex preserves unfamiliar input and mode shapes, empty input and oversized text', async () => {
  const f = fixture();
  await f.thread();
  for (const extra of [
    { input: [] }, { input: [{ type: 'text', text: ' ' }] },
    { input: [{ type: 'image', url: 'data:fixture' }, { type: 'text', text: 'Review' }] },
    { input: [{ type: 'skill', path: '/skill' }, { type: 'text', text: 'Review' }] },
    { input: [{ type: 'text', text: 'x'.repeat(100_001) }] },
    { input: Array.from({ length: 65 }, () => ({ type: 'text', text: 'typo' })) },
    { toolOutput: { name: 'shell', output: 'OK' } },
    { collaborationMode: { mode: 'future', settings: { model: 'codex-fixture' } } },
    { collaborationMode: { mode: 'plan', settings: {} } },
  ]) {
    const original = f.turn(undefined, 'thread-1', extra);
    assert.strictEqual(await f.fromClient(original), original);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.factsCalls.length, 0);
  const missingModel = f.turn(undefined, 'unobserved-thread');
  assert.strictEqual(await f.fromClient(missingModel), missingModel);
});

test('Codex follows acknowledged resume/fork metadata, turn workspace, and settings notifications', async () => {
  const f = fixture({ request: async () => ({ data: [catalogModel(), catalogModel('alternate-model', ['medium', 'high'])], nextCursor: null }) });
  await f.thread('resumed', 'alternate-model', '/workspace/resumed', 'thread/resume', { threadId: 'resumed' });
  assert.equal((await f.fromClient(f.turn(undefined, 'resumed'))).params.effort, 'medium');
  assert.equal(f.factsCalls.at(-1).cwd, '/workspace/resumed');
  await f.thread('forked', 'codex-fixture', '/workspace/forked', 'thread/fork', { threadId: 'resumed' });
  assert.equal((await f.fromClient(f.turn(undefined, 'forked', { cwd: '/workspace/turn' }))).params.effort, 'low');
  assert.equal(f.factsCalls.at(-1).cwd, '/workspace/turn');
  f.fromServer({ method: 'thread/settings/updated', params: { threadId: 'forked', threadSettings: { model: 'alternate-model', effort: 'high', cwd: '/workspace/changed' } } });
  assert.equal((await f.fromClient(f.turn(undefined, 'forked'))).params.effort, 'medium');
  assert.equal(f.factsCalls.at(-1).cwd, '/workspace/changed');
});

test('Codex errors fail open without exposing exception details or changing user settings', async () => {
  for (const options of [
    { request: async () => { throw new Error('secret-provider-details'); } },
    { request: async () => ({ data: 'not an array' }) },
    { repositoryFactsFn: async () => { throw new Error('secret-file-name'); } },
  ]) {
    const f = fixture(options);
    await f.thread();
    const original = f.turn();
    assert.strictEqual(await f.fromClient(original), original);
    assert.equal(f.events.at(-1).action, 'preserve');
    assert.equal(JSON.stringify(f.events).includes('secret'), false);
  }
  const observer = fixture({ onDecision: () => { throw new Error('Observer failed'); } });
  await observer.thread();
  assert.equal((await observer.fromClient(observer.turn())).params.effort, 'low');
});

test('Codex bounds catalog pagination and repeated cursors', async () => {
  for (const repeat of [true, false]) {
    let calls = 0;
    const f = fixture({ request: async () => { calls++; return { data: [catalogModel()], nextCursor: repeat ? 'same' : `cursor-${calls}` }; } });
    await f.thread();
    const original = f.turn();
    assert.strictEqual(await f.fromClient(original), original);
    assert.equal(calls, repeat ? 2 : 10);
    assert.equal(f.events.at(-1).action, 'preserve');
  }
});

test('Codex concurrent threads share discovery while retaining independent routing history', async () => {
  let complete;
  let calls = 0;
  const waiting = new Promise(resolve => { complete = resolve; });
  const f = fixture({ request: async () => { calls++; await waiting; return { data: [catalogModel()], nextCursor: null }; } });
  await f.thread('hard');
  await f.thread('easy');
  const hard = f.fromClient(f.turn('Investigate a security regression.', 'hard'));
  const easy = f.fromClient(f.turn('Fix the spelling typo.', 'easy'));
  complete();
  const [hardResult, easyResult] = await Promise.all([hard, easy]);
  assert.equal(calls, 1);
  assert.equal(hardResult.params.effort, 'high');
  assert.equal(easyResult.params.effort, 'low');
  assert.equal((await f.fromClient(f.turn('Yes, continue.', 'hard'))).params.effort, 'high');
  assert.equal((await f.fromClient(f.turn('Fix another spelling typo.', 'easy'))).params.effort, 'low');
});

test('Codex model switching waits for two independent simpler prompts', async () => {
  const f = fixture({ models: { low: 'fast-model', high: 'deep-model' }, request: async () => ({ data: [catalogModel(), catalogModel('fast-model'), catalogModel('deep-model')], nextCursor: null }) });
  await f.thread();
  const initial = await f.fromClient(f.turn('Diagnose the concurrency regression.'));
  f.ack(initial);
  const firstSimple = await f.fromClient(f.turn('Correct a spelling typo.'));
  assert.equal(firstSimple.params.model, 'deep-model');
  assert.equal(firstSimple.params.effort, 'high');
  f.ack(firstSimple);
  const secondSimple = await f.fromClient(f.turn('Correct another spelling typo.'));
  assert.equal(secondSimple.params.model, 'fast-model');
  assert.equal(secondSimple.params.effort, 'low');
});

test('Codex releases closed thread state and bounds retained metadata', async () => {
  const f = fixture();
  await f.thread();
  await f.fromClient(f.turn('Diagnose the security regression.'));
  f.fromServer({ method: 'thread/closed', params: { threadId: 'thread-1' } });
  const closed = f.turn();
  assert.strictEqual(await f.fromClient(closed), closed);
  await f.thread();
  assert.equal((await f.fromClient(f.turn())).params.effort, 'low');
  for (let i = 0; i < 129; i++) await f.thread(`bounded-${i}`);
  const evicted = f.turn(undefined, 'bounded-0');
  assert.strictEqual(await f.fromClient(evicted), evicted);
});
