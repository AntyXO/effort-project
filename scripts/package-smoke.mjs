import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check with npm run smoke:package.');
const scratch = await mkdtemp(join(tmpdir(), 'effort-package-'));
let server;

function execute(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: scratch, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_000_000,
    shell: false, windowsHide: true, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  const cache = join(scratch, 'cache');
  const packed = JSON.parse(execute([npmCli, 'pack', '--json', '--ignore-scripts',
    '--offline', '--cache', cache, '--pack-destination', scratch], { cwd: root }));
  assert.equal(packed.length, 1);
  assert.ok(packed[0].files.some(file => file.path === 'web/index.html'));
  assert.ok(!packed[0].files.some(file => /^(?:test|work|node_modules)\//.test(file.path)));

  const prefix = join(scratch, 'installed');
  execute([npmCli, 'install', '--prefix', prefix, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--no-save', '--package-lock=false', '--cache', cache,
    join(scratch, packed[0].filename)]);
  const installed = join(prefix, 'node_modules', '@antyxo', 'effort-project');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  const entry = join(installed, manifest.bin.effort);
  assert.match(execute([entry, '--help']), /The Effort Project/);
  const recommendation = JSON.parse(execute([entry, 'recommend', 'Rename a local variable', '--json']));
  assert.equal(recommendation.effort, 'low');

  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'effort_recommend', arguments: { prompt: 'Debug a race condition' } } },
  ];
  const replies = execute([entry, 'mcp'], { input: messages.map(value => JSON.stringify(value)).join('\n') + '\n' })
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.equal(replies[1].result.structuredContent.effort, 'high');
  assert.equal(replies[1].result.structuredContent.applied, false);

  const { Store } = await import(pathToFileURL(join(installed, 'src/store.mjs')).href);
  const { startDashboard } = await import(pathToFileURL(join(installed, 'src/server.mjs')).href);
  const data = join(scratch, 'data');
  await mkdir(data);
  const running = await startDashboard({ store: await new Store(data).initialize() });
  server = running.server;
  const base = running.url.split('/#')[0];
  for (const path of ['/', '/app.js', '/style.css']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
  }
  assert.equal((await fetch(base + '/api/status')).status, 401);
  const status = await fetch(base + '/api/status', { headers: { Authorization: `Bearer ${running.token}` } });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).stats.tasks, 0);
  console.log('Packed and installed offline: CLI, MCP, dashboard assets and authenticated API passed.');
} finally {
  if (server) await new Promise(done => server.close(done));
  await rm(scratch, { recursive: true, force: true });
}
