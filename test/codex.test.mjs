import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, capabilities } from '../src/adapters/codex.mjs';

// This fixture is an independent JSONL server, not a mock of the adapter internals.
const fixtureSource = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const mode = process.env.FIXTURE_MODE;
const record = value => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value)+'\n');
record({ argv: process.argv.slice(2), pid: process.pid });
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const threadId = 'thread-fixture';
const turnId = 'turn-fixture';
let effort = 'medium';
let resumed = false;
const usage = (inputTokens, outputTokens, cachedInputTokens) => ({ inputTokens, outputTokens, cachedInputTokens, totalTokens:inputTokens+outputTokens, reasoningOutputTokens:0 });
const usageEvent = (total, last=total, tid=turnId) => notify('thread/tokenUsage/updated', { threadId, turnId:tid, tokenUsage:{ total,last } });
const end = (status='completed', id=turnId) => notify('turn/completed', { threadId, turn:{ id,status,items:[],error:null } });
createInterface({ input:process.stdin }).on('line', line => {
  const msg=JSON.parse(line); record(msg);
  if (msg.method==='initialize') {
    if(mode==='hang-init') return;
    if(mode==='malformed') { process.stdout.write('not json sk-fixture-secret\n'); return; }
    if(mode==='big-line') { process.stdout.write('x'.repeat(3*1024*1024)); return; }
    if(mode==='exit') { process.stderr.write('sk-fixture-secret'); process.exit(2); }
    reply(msg.id,{userAgent:'fixture'});
  }
  if (['thread/start','thread/resume'].includes(msg.method)) {
    resumed=msg.method==='thread/resume';
    reply(msg.id, { thread:{id:threadId,status:{type:mode==='busy'?'active':'idle'}},model:mode==='model-mismatch'?'other-model':(msg.params.model??'model-fixture'), sandbox:{type:mode==='policy-mismatch'?'dangerFullAccess':(msg.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly')},approvalPolicy:mode==='approval-policy-mismatch'?'never':msg.params.approvalPolicy,approvalsReviewer:'user' });
    if(resumed && mode!=='no-baseline') usageEvent(usage(200,100,20),usage(0,0,0),'old-turn');
  }
  if(msg.method==='model/list') {
    if(mode==='rpc-error') {send({id:msg.id,error:{code:-123,message:'sk-fixture-secret'}});return;}
    if(mode==='pagination' && !msg.params.cursor) { reply(msg.id,{data:[],nextCursor:'page-2'});return; }
    if(mode==='loop-pages') { reply(msg.id,{data:[],nextCursor:'loop'});return; }
    reply(msg.id,{data:[{id:'picker-fixture',model:'model-fixture',supportedReasoningEfforts:(mode==='unsupported'?['high']:['low','medium','high']).map(reasoningEffort=>({reasoningEffort}))}],nextCursor:null});
  }
  if(msg.method==='turn/start') {
    effort=msg.params.effort;
    if(mode==='early-complete') {
      notify('item/completed',{threadId,turnId,item:{id:'a',type:'agentMessage',phase:'final_answer',text:'early answer'}});
      end();
    }
    reply(msg.id,{turn:{id:turnId,status:'inProgress',items:[]}});
    if(mode==='early-complete') return;
    if(mode==='hang-turn' || mode==='child') {
      if(mode==='child') {
        // Record readiness from the child after installing its signal handler. It
        // must survive SIGTERM, forcing the adapter's SIGKILL and reaping path.
        spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.env.CHILD_PID,String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
      }
      return;
    }
    if(mode==='approval') {send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId,turnId}});return;}
    if(mode==='permission') {send({id:'approval-1',method:'item/permissions/requestApproval',params:{threadId,turnId}});return;}
    if(mode==='question') {send({id:'question-1',method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{question:'Secret?'}]}});return;}
    if(mode==='rerouted') {notify('model/rerouted',{threadId,turnId,fromModel:'model-fixture',toModel:'other-model'});return;}
    if(mode==='wrong-turn') {
      notify('item/completed',{threadId,turnId:'other-turn',item:{id:'a',type:'agentMessage',text:'wrong answer'}});
      notify('turn/completed',{threadId:'other-thread',turn:{id:turnId,status:'completed',items:[]}});
      end('completed','other-turn');
    }
    if(mode==='big-answer') {notify('item/completed',{threadId,turnId,item:{id:'big',type:'agentMessage',text:'x'.repeat(300*1024)}});return;}
    notify('item/completed',{threadId,turnId,item:{id:'comment',type:'agentMessage',phase:'commentary',text:'working'}});
    notify('item/completed',{threadId,turnId,item:{id:'a',type:'agentMessage',phase:'final_answer',text:'final answer'}});
    // Duplicate item delivery must not duplicate the answer.
    notify('item/completed',{threadId,turnId,item:{id:'a',type:'agentMessage',phase:'final_answer',text:'final answer'}});
    usageEvent(resumed?usage(230,112,25):usage(30,12,5),usage(10,4,2));
    if(mode==='failed') end('failed'); else end();
  }
  if(msg.method==='thread/read') reply(msg.id,{thread:{id:threadId,reasoningEffort:mode==='effort-mismatch'?'high':effort}});
  if(msg.method==='turn/interrupt') {reply(msg.id,{});end('interrupted');}
});
`;

async function setup(t, mode = 'normal') {
  const cwd = await mkdtemp(join(tmpdir(), 'effort-codex-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fixturePath = join(cwd, 'mock codex.mjs');
  const log = join(cwd, 'protocol.jsonl');
  await writeFile(fixturePath, fixtureSource);
  const events = [];
  const options = {
    cwd, executable: process.execPath, executableArgs: [fixturePath], prompt: 'A prompt with spaces, quotes " and $(do-not-run).', effort: 'low', timeoutMs: 3000,
    // Fixtures receive no provider credentials or inherited provider configuration.
    env: { FIXTURE_MODE: mode, FIXTURE_LOG: log, CHILD_PID: join(cwd, 'child.pid') },
    onEvent: (event) => events.push(event),
  };
  return { options, events, log, readLog: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('Codex sends effort per turn over stdin, discovers support, and defaults to read-only', async (t) => {
  const f = await setup(t);
  const result = await run(f.options);
  assert.equal(result.status, 'completed');
  assert.equal(result.sessionId, 'thread-fixture');
  assert.equal(result.text, 'final answer');
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12, cachedInputTokens: 5, costUsd: null });
  assert.equal(result.effortEvidence.kind, 'turn-request');
  assert.equal(result.effortEvidence.accepted, true);
  assert.equal(result.effortEvidence.configuredEffort, 'low');
  const log = await f.readLog();
  assert.deepEqual(log[0].argv, ['app-server', '--listen', 'stdio://']);
  assert.equal(log[0].argv.includes(f.options.prompt), false);
  const request = log.find((message) => message.method === 'turn/start');
  assert.equal(request.params.effort, 'low');
  assert.equal(request.params.input[0].text, f.options.prompt);
  assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(request.params.approvalPolicy, 'untrusted');
  assert.equal(request.params.approvalsReviewer, 'user');
  assert.ok(log.findIndex((message) => message.method === 'model/list') < log.indexOf(request));
  assert.equal(log.some((message) => /config\/.*write/.test(message.method ?? '')), false);
});

test('Codex resumes exactly the requested session at a different effort with explicit write scope', async (t) => {
  const f = await setup(t);
  const result = await run({ ...f.options, sessionId: 'thread-fixture', effort: 'high', allowWrite: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12, cachedInputTokens: 5, costUsd: null });
  const log = await f.readLog();
  const resumed = log.find((message) => message.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 'thread-fixture');
  assert.equal(resumed.params.excludeTurns, true);
  assert.equal(resumed.params.approvalPolicy, 'on-request');
  assert.equal(resumed.params.approvalsReviewer, 'user');
  assert.equal(log.some((message) => message.method === 'thread/start'), false);
  const request = log.find((message) => message.method === 'turn/start');
  assert.equal(request.params.effort, 'high');
  assert.equal(request.params.approvalPolicy, 'on-request');
  assert.equal(request.params.approvalsReviewer, 'user');
  assert.equal(request.params.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(request.params.sandboxPolicy.networkAccess, false);
  assert.equal(request.params.sandboxPolicy.excludeSlashTmp, true);
  assert.equal(request.params.sandboxPolicy.writableRoots.length, 1);
});

test('resumed usage remains unknown when the provider supplies no pre-turn baseline', async (t) => {
  const f = await setup(t, 'no-baseline');
  const result = await run({ ...f.options, sessionId: 'thread-fixture' });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null });
  assert.ok(f.events.some((event) => event.code === 'usage_unavailable'));
});

for (const mode of ['unsupported', 'model-mismatch', 'policy-mismatch', 'approval-policy-mismatch', 'busy']) {
  test(`Codex blocks ${mode} before sending a model turn`, async (t) => {
    const f = await setup(t, mode);
    const result = await run({ ...f.options, model: 'model-fixture' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.effortEvidence.accepted, false);
    assert.equal((await f.readLog()).some((message) => message.method === 'turn/start'), false);
  });
}

for (const mode of ['approval', 'permission', 'question']) {
  for (const allowWrite of [false, true]) test(`Codex fails closed on ${mode} requests without granting approval (allowWrite=${allowWrite})`, async (t) => {
    const f = await setup(t, mode);
    const result = await run({ ...f.options, allowWrite });
    assert.equal(result.status, 'blocked');
    const log = await f.readLog();
    const response = log.find((message) => ['approval-1', 'question-1'].includes(message.id) && !message.method);
    if (mode === 'approval') assert.deepEqual(response.result, { decision: 'cancel' });
    if (mode === 'permission') assert.deepEqual(response.result, { permissions: {}, scope: 'turn' });
    if (mode === 'question') assert.equal(response.error.code, -32601);
    assert.ok(log.some((message) => message.method === 'turn/interrupt'));
  });
}

test('explicit write permission still requires the server to confirm the requested approval policy', async (t) => {
  const f = await setup(t, 'approval-policy-mismatch');
  const result = await run({ ...f.options, allowWrite: true });
  assert.equal(result.status, 'blocked');
  assert.equal(result.effortEvidence.accepted, false);
  assert.equal((await f.readLog()).some((message) => message.method === 'turn/start'), false);
});

for (const mode of ['early-complete', 'wrong-turn', 'pagination']) {
  test(`Codex handles ${mode} protocol ordering correctly`, async (t) => {
    const f = await setup(t, mode);
    const result = await run(f.options);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, mode === 'early-complete' ? 'early answer' : 'final answer');
    if (mode === 'pagination') assert.equal((await f.readLog()).filter((message) => message.method === 'model/list').length, 2);
  });
}

for (const mode of ['malformed', 'rpc-error', 'exit', 'loop-pages', 'big-line', 'big-answer', 'effort-mismatch', 'failed']) {
  test(`Codex reports ${mode} without leaking provider diagnostics`, async (t) => {
    const f = await setup(t, mode);
    const result = await run(f.options);
    assert.equal(result.status, 'failed');
    assert.ok(result.text.length <= 256 * 1024);
    assert.equal(JSON.stringify({ result, events: f.events }).includes('sk-fixture-secret'), false);
  });
}

test('Codex refuses server-side model substitution', async (t) => {
  const f = await setup(t, 'rerouted');
  assert.equal((await run(f.options)).status, 'blocked');
});

test('Codex timeout interrupts the managed turn and reaps the CLI', async (t) => {
  const f = await setup(t, 'hang-turn');
  const result = await run({ ...f.options, timeoutMs: 300 });
  assert.equal(result.status, 'failed');
  assert.ok(f.events.some((event) => event.code === 'timeout'));
  const log = await f.readLog();
  assert.ok(log.some((message) => message.method === 'turn/interrupt'));
  assert.throws(() => process.kill(log[0].pid, 0), { code: 'ESRCH' });
});

test('Codex abort interrupts a running turn and reaps descendants on POSIX', { skip: process.platform === 'win32' }, async (t) => {
  const f = await setup(t, 'child');
  const controller = new AbortController();
  const resultPromise = run({ ...f.options, signal: controller.signal });
  let childPid;
  t.after(() => {
    controller.abort();
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
  });
  for (let attempt = 0; attempt < 200; attempt++) {
    try { childPid = Number(await readFile(f.options.env.CHILD_PID, 'utf8')); break; } catch {}
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.ok(childPid);
  controller.abort();
  assert.equal((await resultPromise).status, 'cancelled');
  const log = await f.readLog();
  assert.ok(log.some((message) => message.method === 'turn/interrupt'));
  assert.throws(() => process.kill(log[0].pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('already-aborted calls never launch the CLI; invalid effort is rejected', async (t) => {
  const f = await setup(t);
  const controller = new AbortController(); controller.abort();
  assert.equal((await run({ ...f.options, signal: controller.signal })).status, 'cancelled');
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
  await assert.rejects(run({ ...f.options, effort: 'max' }), /low, medium, or high/);
  assert.deepEqual(capabilities.levels, ['low', 'medium', 'high']);
});

test('missing CLI produces a useful bounded failure', async (t) => {
  const f = await setup(t);
  const result = await run({ ...f.options, executable: join(f.options.cwd, 'not-installed') });
  assert.equal(result.status, 'blocked');
  assert.ok(f.events.some((event) => event.code === 'cli_not_found'));
});

test('executableArgs rejects nonarrays, nonstrings, NUL, and excessive arguments before launch', async (t) => {
  const f = await setup(t);
  for (const executableArgs of ['not-an-array', null, [17], ['a\0b'], Array(101).fill('x'), ['x'.repeat(20_001)]]) {
    await assert.rejects(run({ ...f.options, executableArgs }), /executableArgs/);
  }
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});
