import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutomaticRouter, validateModelMap } from '../src/automatic.mjs';

const request = (router, prompt, options = {}) => router.decide({ sessionId: 'a', model: 'test-model', supportedEfforts: ['low', 'medium', 'high'], prompt, ...options });

test('routes mechanical and risky requests without another model call', () => {
  const router = createAutomaticRouter();
  assert.equal(request(router, 'Fix a spelling typo in the README.').effort, 'low');
  assert.equal(request(router, 'Investigate a payment authorization race condition.').effort, 'high');
});

test('short followups keep the prior task context and sessions stay isolated', () => {
  const router = createAutomaticRouter();
  request(router, 'Investigate the intermittent data loss.');
  for (const prompt of ['yes', 'continue', 'please fix it', 'try again']) assert.equal(request(router, prompt).effort, 'high');
  assert.equal(request(router, 'Fix a typo.', { sessionId: 'b' }).effort, 'low');
});

test('two explicit simpler requests allow downgrade, including after a model change', () => {
  const router = createAutomaticRouter();
  request(router, 'Debug the authentication regression.');
  assert.equal(request(router, 'Fix a spelling typo.', { model: 'new-model' }).effort, 'high');
  assert.equal(request(router, 'Rename a README heading.', { model: 'new-model' }).effort, 'low');
});

test('reset forgets prior complexity', () => {
  const router = createAutomaticRouter();
  request(router, 'Debug the authentication regression.');
  router.forget('a');
  assert.equal(request(router, 'Fix a typo.').effort, 'low');
});

test('uses advertised capabilities and preserves requests when no adequate bounded effort exists', () => {
  const router = createAutomaticRouter();
  assert.equal(request(router, 'Fix a typo.', { supportedEfforts: ['medium', 'high'] }).effort, 'medium');
  assert.equal(request(router, 'Debug a regression.', { supportedEfforts: ['low'] }).action, 'preserve');
  assert.equal(request(router, 'Debug a regression.', { supportedEfforts: ['xhigh'] }).action, 'preserve');
  assert.equal(request(createAutomaticRouter({ maxEffort: 'xhigh' }), 'Debug a regression.', { supportedEfforts: ['low', 'xhigh'] }).effort, 'xhigh');
});

test('fixed effort and explicit ceiling win and cannot exceed bounds', () => {
  assert.equal(request(createAutomaticRouter({ effort: 'low' }), 'Investigate data loss.').effort, 'low');
  assert.equal(request(createAutomaticRouter({ maxEffort: 'medium' }), 'Investigate data loss.').effort, 'medium');
  assert.throws(() => createAutomaticRouter({ effort: 'high', maxEffort: 'medium' }), /bounds/);
  assert.throws(() => createAutomaticRouter({ minEffort: 'high', maxEffort: 'low' }), /Minimum/);
});

test('a narrow mechanical edit is not inflated by unrelated repository languages', () => {
  assert.equal(request(createAutomaticRouter(), 'Fix a spelling typo.', { facts: { languages: ['python', 'swift', 'go'], mentionedFiles: 1 } }).effort, 'low');
  assert.equal(request(createAutomaticRouter(), 'Rename these files.', { facts: { mentionedFiles: 6 } }).effort, 'high');
});

test('invalid input is rejected and public decisions contain no prompt', () => {
  const router = createAutomaticRouter();
  assert.throws(() => request(router, ''), /Prompt/);
  const secretPrompt = 'Rename PRIVATE_MARKER in a README.';
  assert.ok(!JSON.stringify(request(router, secretPrompt)).includes('PRIVATE_MARKER'));
});

test('model routing tables accept only explicit effort-to-ID mappings', () => {
  assert.deepEqual(validateModelMap({ low: 'provider/small', high: 'provider/large' }), { low: 'provider/small', high: 'provider/large' });
  assert.throws(() => validateModelMap({ cheap: 'anything' }), /Unsupported effort/);
  assert.throws(() => validateModelMap({ high: '--flag value' }), /model ID/);
  assert.throws(() => validateModelMap([]), /models/);
});
