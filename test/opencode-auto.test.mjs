import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import EffortPlugin, { createEffortPlugin } from '../src/integrations/opencode.mjs';

const nativeModel = (change = {}) => ({
  id: 'fixture-reasoning-model', providerID: 'fixture-provider', capabilities: { reasoning: true },
  variants: {
    low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' },
  }, ...change,
});

async function fixture(t, options = {}, config = {}, context = {}) {
  const calls = [], logs = [];
  const hooks = await createEffortPlugin({
    repositoryFactsFn: async (...args) => { calls.push(args); return { languages: ['javascript'] }; },
    ...options,
  })({ directory: '/fixture/project', client: { app: { log: async event => logs.push(event) } }, ...context });
  t.after(() => hooks.dispose());
  await hooks.config(config);
  async function submit({ prompt = 'Rename a local variable.', session = 'session-a', message = 'message-a',
    agent = 'build', input = {}, info = {}, parts } = {}) {
    const user = { id: message, role: 'user', agent,
      model: { providerID: 'fixture-provider', modelID: 'fixture-reasoning-model' }, ...info };
    await hooks['chat.message']({ sessionID: session, agent, ...input }, {
      message: user, parts: parts ?? [{ type: 'text', text: prompt }],
    });
    return { sessionID: session, agent, model: nativeModel(), message: user };
  }
  async function params(input, options = { reasoningEffort: 'medium', unrelated: true }) {
    const output = { options };
    await hooks['chat.params'](input, output);
    return output;
  }
  return { hooks, calls, logs, submit, params };
}

test('native submitted prompts choose request effort automatically without model calls', async t => {
  const f = await fixture(t);
  const simple = await f.submit();
  const output = await f.params(simple);
  assert.deepEqual(output.options, { reasoningEffort: 'low', unrelated: true });
  const complex = await f.submit({ prompt: 'Investigate a race condition in authentication.', message: 'complex' });
  assert.equal((await f.params(complex)).options.reasoningEffort, 'high');
  assert.deepEqual(f.calls[0], ['/fixture/project', 'Rename a local variable.']);
  assert.deepEqual(simple.message.model, { providerID: 'fixture-provider', modelID: 'fixture-reasoning-model' });
  assert.equal(f.logs[0].body.extra.control, 'automatic');
  assert.equal(f.logs[0].body.extra.evidence, 'request-options');
  assert.equal(f.logs[0].body.extra.providerAccepted, null);
  assert.ok(!JSON.stringify(f.logs).includes('Rename a local variable.'));
  assert.ok(!JSON.stringify(f.logs).includes('authentication'));
});

test('default export uses real local repository metadata without an SDK dependency', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'effort-opencode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'fixture.js'), 'export const fixture = true;');
  const hooks = await EffortPlugin({ directory });
  t.after(() => hooks.dispose());
  await hooks.config({});
  const message = { id: 'real-files', role: 'user', agent: 'build' };
  await hooks['chat.message']({ sessionID: 'real' }, { message, parts: [{ type: 'text', text: 'Rename fixture.js.' }] });
  const output = { options: {} };
  await hooks['chat.params']({ sessionID: 'real', agent: 'build', message, model: nativeModel() }, output);
  assert.equal(output.options.reasoningEffort, 'low');
});

test('explicit native variants survive in all supported hook shapes', async t => {
  const f = await fixture(t);
  for (const change of [
    { input: { variant: 'high' } }, { info: { variant: 'high' } },
    { info: { model: { providerID: 'fixture-provider', modelID: 'fixture-reasoning-model', variant: 'high' } } },
  ]) {
    const input = await f.submit(change);
    const original = { reasoningEffort: 'high' };
    assert.equal((await f.params(input, original)).options, original);
  }
  assert.equal(f.calls.length, 0);
});

test('explicit provider, model and agent effort settings take precedence', async t => {
  for (const config of [
    { provider: { 'fixture-provider': { options: { reasoningEffort: 'high' } } } },
    { provider: { 'fixture-provider': { models: { 'fixture-reasoning-model': { options: { thinking: { type: 'adaptive' } } } } } } },
    { agent: { build: { reasoningEffort: 'high' } } },
    { agent: { build: { options: { thinkingConfig: { thinkingLevel: 'high' } } } } },
    { agent: { build: { variant: 'custom-pinned' } } },
  ]) {
    const f = await fixture(t, {}, config);
    const input = await f.submit();
    const original = { reasoningEffort: 'high' };
    assert.equal((await f.params(input, original)).options, original);
    assert.equal(f.calls.length, 0);
  }
});

test('native defaults and unrelated configuration do not disable automatic effort', async t => {
  const f = await fixture(t, {}, { agent: { build: { temperature: 0.4 } }, provider: {
    'fixture-provider': { options: { baseURL: 'https://example.invalid' },
      models: { 'fixture-reasoning-model': { variants: { low: { reasoningEffort: 'low' } }, options: { textVerbosity: 'low' } } } },
  } });
  const input = await f.submit();
  input.model.options = { reasoningEffort: 'medium' };
  assert.equal((await f.params(input)).options.reasoningEffort, 'low');
});

test('native supported variant objects handle nested providers without mutating defaults', async t => {
  for (const patch of [
    { thinking: { type: 'adaptive' }, effort: 'low' },
    { thinkingConfig: { thinkingLevel: 'low' } },
    { reasoningConfig: { type: 'adaptive', maxReasoningEffort: 'low' } },
    { reasoning: { effort: 'low' } },
    { output_config: { effort: 'low' } },
  ]) {
    const f = await fixture(t);
    const input = await f.submit();
    input.model = nativeModel({ variants: { low: patch } });
    const original = { thinkingConfig: { includeThoughts: true }, unrelated: { keep: true } };
    const before = structuredClone(original);
    const variantBefore = structuredClone(patch);
    const result = await f.params(input, original);
    assert.notEqual(result.options, original);
    assert.deepEqual(original, before);
    assert.deepEqual(patch, variantBefore);
    assert.equal(result.options.thinkingConfig.includeThoughts, true);
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'thinkingConfig') assert.equal(result.options[key].thinkingLevel, 'low');
      else assert.deepEqual(result.options[key], value);
    }
  }
});

test('tool steps and simultaneous requests reuse one decision for the exact message', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { repositoryFactsFn: async () => { calls++; await gate; return {}; } });
  const input = await f.submit();
  const first = f.params(input), second = f.params(input);
  release();
  const results = await Promise.all([first, second]);
  for (const result of results) assert.equal(result.options.reasoningEffort, 'low');
  assert.equal((await f.params(input)).options.reasoningEffort, 'low');
  assert.equal(calls, 1);
  assert.equal(f.logs.length, 1);
});

test('session and message caches cannot apply another task decision', async t => {
  const f = await fixture(t);
  const hard = await f.submit({ prompt: 'Investigate a deadlock.', session: 'hard', message: 'same-id' });
  const easy = await f.submit({ session: 'easy', message: 'same-id' });
  assert.equal((await f.params(hard)).options.reasoningEffort, 'high');
  assert.equal((await f.params(easy)).options.reasoningEffort, 'low');
  const original = {};
  assert.equal((await f.params({ ...easy, message: { ...easy.message, id: 'unseen' } }, original)).options, original);
  assert.equal((await f.params({ ...easy, model: nativeModel({ id: 'different-model' }) }, original)).options, original);
});

test('short continuations retain context and two simpler tasks permit lower effort', async t => {
  const f = await fixture(t);
  for (const [message, prompt, effort] of [
    ['hard', 'Investigate a deadlock.', 'high'], ['continue', 'Continue.', 'high'],
    ['rename', 'Rename a local variable.', 'high'], ['typo', 'Fix a spelling typo.', 'low'],
  ]) assert.equal((await f.params(await f.submit({ message, prompt }))).options.reasoningEffort, effort);
});

test('internal agents, unknown messages, synthetic content and oversized text remain native', async t => {
  const f = await fixture(t);
  for (const change of [
    { agent: 'title' }, { agent: 'compaction' }, { agent: 'summary' }, { agent: 'explore' },
    { prompt: 'x'.repeat(100_001) }, { prompt: '  ' }, { info: { role: 'assistant' } },
    { parts: [{ type: 'file', url: 'file:///private/file' }] },
    { parts: [{ type: 'text', text: 'Investigate everything.', synthetic: true }] },
    { parts: [{ type: 'text', text: 'Investigate everything.', ignored: true }] },
  ]) {
    const input = await f.submit(change);
    const original = { native: true };
    assert.equal((await f.params(input, original)).options, original);
  }
  assert.equal(f.calls.length, 0);
  const input = await f.submit({ parts: [
    { type: 'text', text: 'Rename a local variable.' },
    { type: 'text', text: 'Investigate authentication.', synthetic: true },
  ] });
  assert.equal((await f.params({ ...input, agent: 'title' })).options.reasoningEffort, 'medium');
  assert.equal((await f.params(input)).options.reasoningEffort, 'low');
  assert.equal(f.calls[0][1], 'Rename a local variable.');
});

test('explicitly selected custom agents can participate', async t => {
  const f = await fixture(t, { agents: ['project-builder'] });
  const input = await f.submit({ agent: 'project-builder' });
  assert.equal((await f.params(input)).options.reasoningEffort, 'low');
});

test('unsupported and insufficient effort variants preserve the original request', async t => {
  const f = await fixture(t);
  for (const model of [
    nativeModel({ capabilities: { reasoning: false } }), nativeModel({ capabilities: {} }),
    nativeModel({ variants: {} }), nativeModel({ variants: { fast: { reasoningEffort: 'low' } } }),
    nativeModel({ variants: { low: { temperature: 0.2 } } }),
    nativeModel({ variants: { max: { effort: 'max' } } }),
  ]) {
    const input = await f.submit(); input.model = model;
    const original = { native: true };
    assert.equal((await f.params(input, original)).options, original);
  }
  const hard = await f.submit({ prompt: 'Investigate authentication.' });
  hard.model = nativeModel({ variants: { low: { reasoningEffort: 'low' } } });
  const original = {};
  assert.equal((await f.params(hard, original)).options, original);
});

test('models with only high support receive high instead of a fabricated low setting', async t => {
  const f = await fixture(t);
  const input = await f.submit();
  input.model = nativeModel({ variants: { high: { thinking: { type: 'enabled', budgetTokens: 16000 } } } });
  assert.deepEqual((await f.params(input, {})).options, { thinking: { type: 'enabled', budgetTokens: 16000 } });
});

test('metadata errors, deadlines and logging errors cannot block or alter native requests', async t => {
  for (const repositoryFactsFn of [
    () => { throw new Error('SECRET_FILESYSTEM_PATH'); },
    async () => { throw new Error('SECRET_FILESYSTEM_PATH'); },
    async () => new Promise(() => {}),
  ]) {
    const f = await fixture(t, { repositoryFactsFn, metadataTimeoutMs: 5 });
    const input = await f.submit(); const original = { native: true };
    assert.equal((await f.params(input, original)).options, original);
    assert.ok(!JSON.stringify(f.logs).includes('SECRET_FILESYSTEM_PATH'));
  }
  const f = await fixture(t, {}, {}, { client: { app: { log: async () => { throw new Error('Log failed.'); } } } });
  assert.equal((await f.params(await f.submit())).options.reasoningEffort, 'low');
});

test('cache capacity and pending expiry discard unused prompt decisions', async t => {
  const f = await fixture(t, { maxCachedMessages: 1, pendingTtlMs: 10 });
  const old = await f.submit({ message: 'old' });
  const fresh = await f.submit({ message: 'fresh' });
  const original = {};
  assert.equal((await f.params(old, original)).options, original);
  await delay(25);
  assert.equal((await f.params(fresh, original)).options, original);
  assert.equal(f.calls.length, 0);
});

test('session deletion and disposal clear decisions and history; idle clears unused text', async t => {
  const f = await fixture(t);
  const hard = await f.submit({ prompt: 'Investigate a deadlock.' });
  assert.equal((await f.params(hard)).options.reasoningEffort, 'high');
  await f.hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'session-a' } } } });
  const original = {};
  assert.equal((await f.params(hard, original)).options, original);
  assert.equal((await f.params(await f.submit({ message: 'new' }))).options.reasoningEffort, 'low');
  const pending = await f.submit({ message: 'pending' });
  await f.hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session-a' } } });
  assert.equal((await f.params(pending, original)).options, original);
  const completed = await f.submit({ message: 'completed' });
  await f.params(completed);
  await f.hooks.dispose();
  assert.equal((await f.params(completed, original)).options, original);
});

test('configuration is required and later explicit overrides also stop cached decisions', async t => {
  const hooks = await EffortPlugin({ directory: '/does/not/exist' });
  t.after(() => hooks.dispose());
  const message = { id: 'missing-config', role: 'user', agent: 'build' };
  await hooks['chat.message']({ sessionID: 'missing-config' }, { message, parts: [{ type: 'text', text: 'Rename a variable.' }] });
  const output = { options: {} }, original = output.options;
  await hooks['chat.params']({ sessionID: 'missing-config', agent: 'build', message, model: nativeModel() }, output);
  assert.equal(output.options, original);
  const f = await fixture(t);
  const input = await f.submit(); await f.params(input);
  await f.hooks.config({ agent: { build: { effort: 'high' } } });
  assert.equal((await f.params(input, original)).options, original);
});

test('an explicit variant added after submission still wins', async t => {
  const f = await fixture(t);
  const input = await f.submit();
  input.message.model.variant = 'high';
  const original = { reasoningEffort: 'high' };
  assert.equal((await f.params(input, original)).options, original);
  assert.equal(f.calls.length, 0);
});

test('prototype-polluting and invalid variant objects are rejected atomically', async t => {
  const f = await fixture(t);
  for (const patch of [
    JSON.parse('{"reasoningEffort":"low","__proto__":{"effortPolluted":true}}'),
    JSON.parse('{"thinking":{"constructor":{"prototype":{"effortPolluted":true}}}}'),
    { reasoningEffort: 'low', invalid: () => true },
  ]) {
    const input = await f.submit(); input.model = nativeModel({ variants: { low: patch } });
    const original = { keep: { nested: true } };
    assert.equal((await f.params(input, original)).options, original);
    assert.equal({}.effortPolluted, undefined);
  }
});

test('invalid plugin options are rejected before installation', () => {
  for (const options of [
    { agents: [] }, { agents: 'build' }, { maxCachedMessages: 0 }, { maxCachedMessages: Infinity },
    { pendingTtlMs: -1 }, { metadataTimeoutMs: 0 }, { repositoryFactsFn: null },
  ]) assert.throws(() => createEffortPlugin(options));
});
