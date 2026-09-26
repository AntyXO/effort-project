import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, cp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../bin/effort.mjs', import.meta.url));

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'effort-auto-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const metadata = join(cwd, 'metadata-must-not-exist');
  const env = { PATH: cwd, HOME: cwd, USERPROFILE: cwd, EFFORT_DATA_DIR: metadata };
  for (const key of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  function invoke(args, entry = cli) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd, env, input: '', encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false,
    });
    if (result.error) throw result.error;
    return result;
  }
  async function config(value, name = 'routing.json') {
    const path = join(cwd, name);
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  }
  return { cwd, invoke, config, metadata };
}

function failure(result, message) {
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.equal(result.stdout, '');
  if (message) assert.match(result.stderr, message);
}

test('automatic dry runs work without a TTY or provider executables and disclose effective Claude permissions', async (t) => {
  const f = await fixture(t);
  const codex = f.invoke(['auto', 'codex', '--dry-run']);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stderr, '');
  const codexSetup = JSON.parse(codex.stdout);
  assert.equal(codexSetup.willExecute, false);
  assert.equal(codexSetup.desktopControl, false);
  assert.equal(codexSetup.cwd, f.cwd);
  const claude = f.invoke(['auto', 'claude', '--dry-run']);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(JSON.parse(claude.stdout).allowWrite, false);
  assert.equal(JSON.parse(claude.stdout).timeoutMs, 120_000);
  const writable = f.invoke(['auto', 'claude', '--allow-write', '--timeout', '7.5', '--dry-run']);
  assert.equal(writable.status, 0, writable.stderr);
  assert.equal(JSON.parse(writable.stdout).allowWrite, true);
  assert.equal(JSON.parse(writable.stdout).timeoutMs, 7500);
  await assert.rejects(access(f.metadata), { code: 'ENOENT' });
});

test('auto commands require a terminal before launching any live integration', async (t) => {
  const f = await fixture(t);
  for (const provider of ['codex', 'claude']) {
    failure(f.invoke(['auto', provider]), /interactive terminal/);
  }
  await assert.rejects(access(f.metadata), { code: 'ENOENT' });
});

test('invalid bounds, fixed models, and Claude execution settings fail even in dry-run mode', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['--min-effort', 'high', '--max-effort', 'low'],
    ['--min-effort', 'bogus'], ['--max-effort', 'bogus'], ['--effort', 'bogus'],
    ['--effort', 'high', '--max-effort', 'medium'],
    ['--model', 'bad model'], ['--model=--dangerously-skip-permissions'],
    ['--timeout', 'nope'], ['--timeout', '0'], ['--timeout', '-1'], ['--timeout', '1801'],
    ['--effort', 'xhigh', '--max-effort', 'max'],
    ['--min-effort', 'xhigh', '--max-effort', 'max'],
  ]) failure(f.invoke(['auto', 'claude', ...args, '--dry-run']));
  failure(f.invoke(['auto', 'codex', '--model', 'bad model', '--dry-run']));
  await assert.rejects(access(f.metadata), { code: 'ENOENT' });
});

test('single-task flags and provider-specific permission flags cannot silently change auto behavior', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['claude', '--json'], ['claude', '--verify', '["node","--test"]'],
    ['claude', '--max-attempts', '2'], ['claude', '--prompt-file', 'task.txt'],
    ['claude', 'a hidden one-shot prompt'], ['codex', '--allow-write'], ['codex', '--timeout', '5'],
    ['unsupported-provider'],
  ]) failure(f.invoke(['auto', ...args, '--dry-run']));
});

test('routing config rejects malformed or oversized data and unknown model-map entries', async (t) => {
  const f = await fixture(t);
  const invalid = [
    '{bad JSON', null, [], true, { unexpected: true }, { models: [] }, { models: 'guess' },
    { models: { low: 'bad model' } }, { models: { unknown: 'model-id' } },
    { models: { low: '--model=bad' } }, { models: { constructor: 'model-id' } },
    { minEffort: 'max', maxEffort: 'low' }, { maxEffort: 'bogus' },
    JSON.stringify({ models: { low: 'x'.repeat(17_000) } }),
  ];
  for (const [index, value] of invalid.entries()) {
    const config = await f.config(value, `invalid-${index}.json`);
    failure(f.invoke(['auto', 'claude', '--routing-config', config, '--dry-run']));
  }
  failure(f.invoke(['auto', 'claude', '--routing-config', join(f.cwd, 'missing.json'), '--dry-run']));
});

test('explicit CLI bounds and model retain precedence over validated routing configuration', async (t) => {
  const f = await fixture(t);
  const config = await f.config({ models: { low: 'claude-sonnet-4-6', high: 'claude-opus-4-6' }, minEffort: 'medium', maxEffort: 'high' });
  const before = await readFile(config, 'utf8');
  const result = f.invoke(['auto', 'claude', '--routing-config', config, '--min-effort', 'low', '--max-effort', 'medium', '--model', 'claude-sonnet-4-6', '--effort', 'low', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const setup = JSON.parse(result.stdout);
  assert.equal(setup.minEffort, 'low');
  assert.equal(setup.maxEffort, 'medium');
  assert.equal(setup.model, 'claude-sonnet-4-6');
  assert.equal(setup.effort, 'low');
  assert.deepEqual(setup.models, { low: 'claude-sonnet-4-6', high: 'claude-opus-4-6' });
  assert.equal(await readFile(config, 'utf8'), before);
  await assert.rejects(access(f.metadata), { code: 'ENOENT' });
});

test('config opencode generates an importable native plugin from an installation path containing spaces and percent characters', async (t) => {
  const f = await fixture(t);
  const installed = join(f.cwd, 'installed project 100%');
  await mkdir(installed);
  await cp(join(root, 'bin'), join(installed, 'bin'), { recursive: true });
  await cp(join(root, 'src'), join(installed, 'src'), { recursive: true });
  const generated = f.invoke(['config', 'opencode'], join(installed, 'bin', 'effort.mjs'));
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(generated.stderr, '');
  const wrapper = join(f.cwd, 'generated-plugin.mjs');
  await writeFile(wrapper, generated.stdout);
  const plugin = await import(pathToFileURL(wrapper).href);
  assert.equal(typeof plugin.default, 'function');
  const hooks = await plugin.default({ directory: f.cwd });
  t.after(() => hooks.dispose());
  await hooks.config({});
  const message = { id: 'generated-wrapper-message', role: 'user', agent: 'build' };
  await hooks['chat.message']({ sessionID: 'generated-wrapper-session', agent: 'build' }, {
    message, parts: [{ type: 'text', text: 'Fix a spelling typo in the heading.' }],
  });
  const output = { options: { unrelated: 'preserved' } };
  await hooks['chat.params']({ sessionID: 'generated-wrapper-session', message, agent: 'build', model: {
    providerID: 'fixture', id: 'reasoning-model', capabilities: { reasoning: true },
    variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } },
  } }, output);
  assert.equal(output.options.reasoningEffort, 'low');
  assert.equal(output.options.unrelated, 'preserved');
});
