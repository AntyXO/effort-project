import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { handleRpc } from '../src/mcp.mjs';
import { startDashboard } from '../src/server.mjs';

const rpc=(method,params)=>({jsonrpc:'2.0',id:1,method,params});
test('MCP negotiation, discovery, error handling, and advisory semantics',()=>{
  assert.equal(handleRpc(rpc('initialize',{protocolVersion:'2025-06-18'})).result.protocolVersion,'2025-06-18');
  assert.equal(handleRpc(rpc('tools/list')).result.tools.length,3);
  assert.equal(handleRpc({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const r=handleRpc(rpc('tools/call',{name:'effort_recommend',arguments:{prompt:'debug race condition',provider:'codex'}}));
  assert.equal(r.result.structuredContent.effort,'high');assert.equal(r.result.structuredContent.applied,false);assert.equal(r.result.structuredContent.control,'advisory');
  assert.equal(handleRpc(rpc('tools/call',{name:'effort_recommend',arguments:{prompt:'x',command:'rm'}})).result.isError,true);
  assert.equal(handleRpc(rpc('tools/call',{name:'effort_observe',arguments:{effort:'low',kind:'access',repeatCount:3}})).result.structuredContent.action,'stop');
  assert.equal(handleRpc(rpc('execute_shell')).error.code,-32601);
});
test('MCP stdio works through real packaged entry point without stdout noise',async()=>{
  const entry=new URL('../bin/effort.mjs',import.meta.url);
  const result=await new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[fileURLToPath(entry),'mcp'],{stdio:['pipe','pipe','pipe']});let out='',err='';
    p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>resolve({out,err,code}));
    p.stdin.end(JSON.stringify(rpc('initialize',{protocolVersion:'2025-06-18'}))+'\n'+JSON.stringify(rpc('tools/list'))+'\n');
  });
  assert.equal(result.code,0);assert.equal(result.err,'');assert.equal(result.out.trim().split('\n').length,2);
  assert.equal(JSON.parse(result.out.trim().split('\n')[1]).result.tools.length,3);
});
test('MCP exits on host termination instead of swallowing SIGTERM',async()=>{
  const p=spawn(process.execPath,[fileURLToPath(new URL('../bin/effort.mjs',import.meta.url)),'mcp'],{stdio:['pipe','pipe','pipe']});
  const exit=new Promise(resolve=>p.once('close',resolve));
  const initialized=new Promise(resolve=>p.stdout.once('data',resolve));
  p.stdin.write(JSON.stringify(rpc('initialize',{protocolVersion:'2025-06-18'}))+'\n');await initialized;
  p.kill('SIGTERM');
  const timer=setTimeout(()=>p.kill('SIGKILL'),1500);
  await exit;clearTimeout(timer);
  if(process.platform!=='win32')assert.equal(p.signalCode,'SIGTERM');
});
test('dashboard requires token and rejects cross-origin, bad host and path access',async t=>{
  const store=await new Store(await mkdtemp(join(tmpdir(),'effort-http-'))).initialize();
  const {server,url,token}=await startDashboard({store});t.after(()=>server.close());const base=url.split('/#')[0];
  assert.equal((await fetch(`${base}/api/status`)).status,401);
  const headers={Authorization:`Bearer ${token}`};
  const status=await fetch(`${base}/api/status`,{headers});assert.equal(status.status,200);assert.equal((await status.json()).stats.tasks,0);
  assert.equal((await fetch(`${base}/api/status`,{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
  const badHostStatus=await new Promise((resolve,reject)=>{const req=request(`${base}/api/status`,{headers:{...headers,Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(badHostStatus,403);
  assert.equal((await fetch(`${base}/api/run`,{headers,method:'POST'})).status,404);
  assert.equal((await fetch(`${base}/package.json`)).status,404);
  const r=await fetch(`${base}/api/recommend`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({prompt:'Rename local variable',provider:'codex'})});
  assert.equal((await r.json()).applied,false);
});
