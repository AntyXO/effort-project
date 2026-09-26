import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommend, nextDecision, classifyFailure } from '../src/policy.mjs';
import { repositoryFacts } from '../src/repository.mjs';
import { Store } from '../src/store.mjs';
import { verify } from '../src/verify.mjs';
import { runTask } from '../src/runner.mjs';

test('unknown tasks remain uncertain and mechanical requests can start low',()=>{
  assert.equal(recommend({prompt:'Do this task'}).effort,'medium');
  assert.equal(recommend({prompt:'Rename this local variable'}).effort,'low');
  assert.equal(recommend({prompt:'Rename the authentication token and migrate all permissions'}).effort,'high');
  assert.equal(recommend({prompt:'Investigate a race condition'}).confidence,'low');
});
test('explicit caps and invalid inputs are respected',()=>{
  assert.equal(recommend({prompt:'Investigate concurrency',maxEffort:'medium'}).effort,'medium');
  for(const prompt of ['',null,{},'x'.repeat(100001)])assert.throws(()=>recommend({prompt}));
  assert.throws(()=>recommend({prompt:'x',minEffort:'high',maxEffort:'low'}));
  assert.throws(()=>recommend({prompt:'x',provider:'__proto__'}));
});
test('failures do not all become expensive retries',()=>{
  for(const [text,expected] of [['Error: Cannot find module x','environment'],['Operation not permitted','permission'],['Invalid API key','access'],['AssertionError expected 3 received 2','test'],['something went wrong','unknown']])assert.equal(classifyFailure(text),expected);
  for(const kind of ['access','permission','environment','timeout','unknown'])assert.equal(nextDecision({effort:'low',kind,repeatCount:3}).action,'stop');
});
test('escalation needs repeated checks, obeys support and stops at ceiling',()=>{
  assert.equal(nextDecision({effort:'low',kind:'test'}).effort,'low');
  assert.equal(nextDecision({effort:'low',kind:'test',repeatCount:2}).effort,'medium');
  assert.equal(nextDecision({effort:'low',kind:'test',repeatCount:2,supportedLevels:['low','high']}).effort,'high');
  assert.equal(nextDecision({effort:'high',kind:'test',repeatCount:2}).action,'stop');
  assert.throws(()=>nextDecision({effort:'low',kind:'test',repeatCount:-2}));
});
test('repository metadata skips dependencies, dotfiles and symlink targets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'effort-repo-'));
  await writeFile(join(dir,'main.py'),'secret code');
  await mkdir(join(dir,'node_modules'));await writeFile(join(dir,'node_modules','dep.swift'),'x');
  await writeFile(join(dir,'.secret.js'),'x');
  if(process.platform!=='win32')await symlink(tmpdir(),join(dir,'linked'));
  const facts=await repositoryFacts(dir,'Change main.py');
  assert.deepEqual(facts.languages,['python']);assert.equal(facts.scannedFiles,1);assert.equal(facts.mentionedFiles,1);
});
test('store rejects traversal, symlink records and malformed files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'effort-store-'));const store=await new Store(dir).initialize();
  await assert.rejects(store.get('../../private'));
  const id='11111111-1111-4111-8111-111111111111';
  await store.save({id,createdAt:'2026-01-01',status:'unverified'});
  assert.equal((await store.get(id)).status,'unverified');
  await writeFile(join(dir,'22222222-2222-4222-8222-222222222222.json'),'{bad');
  assert.equal((await store.list()).length,1);
});
test('verification uses literal argv and classifies exit/errors/timeouts',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'effort-verify-'));
  const pass=await verify([process.execPath,'-e','process.exit(0)'],{cwd});assert.equal(pass.status,'passed');
  const fail=await verify([process.execPath,'-e','console.log("AssertionError expected 2 received 3");process.exit(1)'],{cwd});assert.equal(fail.kind,'test');
  const missing=await verify(['effort-nonexistent-command'],{cwd});assert.equal(missing.kind,'environment');
  const timeout=await verify([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd,timeoutMs:40});assert.equal(timeout.kind,'timeout');
  const literal=await verify([process.execPath,'-e','console.log(process.argv[1])','$(touch should-not-exist)'],{cwd});assert.match(literal.output,/touch/);
  await assert.rejects(readFile(join(cwd,'should-not-exist')));
});
test('identical failing node checks keep the same fingerprint despite timings',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'effort-signature-'));
  await writeFile(join(cwd,'fail.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(2,3));");
  const first=await verify([process.execPath,'--test','fail.test.cjs'],{cwd});
  const second=await verify([process.execPath,'--test','fail.test.cjs'],{cwd});
  assert.equal(first.kind,'test');assert.equal(first.fingerprint,second.fingerprint);
});
test('verification timeout reaps descendants holding stdout open',{skip:process.platform==='win32'},async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'effort-tree-'));
  const script=`const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); fs.writeFileSync('pid',String(c.pid));setInterval(()=>{},1000);`;
  const start=Date.now();const result=await verify([process.execPath,'-e',script],{cwd,timeoutMs:150});
  assert.equal(result.kind,'timeout');assert.ok(Date.now()-start<2200);
  const pid=Number(await readFile(join(cwd,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0));
});
async function fixture(run){
  const cwd=await mkdtemp(join(tmpdir(),'effort-run-'));const store=await new Store(join(cwd,'records')).initialize();
  return {cwd,store,adapter:{capabilities:{id:'codex',levels:['low','medium','high']},run}};
}
const completed={status:'completed',sessionId:'fake-session',text:'sensitive response',effortEvidence:'fixture-request',usage:{inputTokens:10,outputTokens:2}};
test('managed runs resume same session and escalate only after repeated check failure',async()=>{
  const calls=[];const f=await fixture(async o=>{calls.push(o);return completed;});let checks=0;
  const result=await runTask({prompt:'Rename variable',cwd:f.cwd,effort:'low',verify:['fake-check'],maxAttempts:3},{...f,verifyFn:async()=>++checks===3?{status:'passed',exitCode:0}:{status:'failed',kind:'test',exitCode:1,output:'sensitive test output',fingerprint:'same'}});
  assert.deepEqual(calls.map(x=>x.effort),['low','low','medium']);assert.equal(calls[1].sessionId,'fake-session');
  assert.equal(result.task.status,'verified');assert.equal(result.task.attempts.length,3);
  const saved=await readFile(join(f.store.dir,`${result.task.id}.json`),'utf8');
  for(const secret of ['Rename variable','sensitive response','sensitive test output','fake-session'])assert.ok(!saved.includes(secret));
});
test('provider completion alone is unverified and no re-prompt is invented',async()=>{
  let count=0;const f=await fixture(async()=>{count++;return completed;});
  const result=await runTask({prompt:'Summarize',cwd:f.cwd},{...f});
  assert.equal(result.task.status,'unverified');assert.equal(count,1);
});
test('access/environment failures stop without escalation',async()=>{
  let count=0;const f=await fixture(async()=>{count++;return completed;});
  const r=await runTask({prompt:'Fix this',cwd:f.cwd,verify:['fake']},{...f,verifyFn:async()=>({status:'blocked',kind:'environment',exitCode:1,output:'MODULE_NOT_FOUND'})});
  assert.equal(r.task.status,'blocked');assert.equal(count,1);
});
test('missing resume capability cannot silently start a disconnected retry',async()=>{
  const f=await fixture(async()=>({...completed,sessionId:null}));
  const r=await runTask({prompt:'Rename',cwd:f.cwd,verify:['fake']},{...f,verifyFn:async()=>({status:'failed',kind:'test',exitCode:1,output:'FAIL',fingerprint:'x'})});
  assert.equal(r.task.status,'blocked');assert.match(r.task.stopReason,/resumable/);
});
test('provider errors are recorded as blocked without raw error persistence',async()=>{
  const f=await fixture(async()=>{throw new Error('SECRET_PROVIDER_PAYLOAD');});
  const r=await runTask({prompt:'Rename',cwd:f.cwd},{...f});assert.equal(r.task.status,'blocked');
  assert.ok(!JSON.stringify(await f.store.get(r.task.id)).includes('SECRET_PROVIDER_PAYLOAD'));
});
