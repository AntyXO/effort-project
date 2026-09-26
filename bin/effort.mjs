#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recommend } from '../src/policy.mjs';
import { repositoryFacts } from '../src/repository.mjs';
import { Store } from '../src/store.mjs';
import { runTask } from '../src/runner.mjs';
import { getAdapter, capabilities } from '../src/registry.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { startDashboard } from '../src/server.mjs';

const help=`The Effort Project · 0.1.0\nLocal effort decisions, with evidence you can inspect.\n\n  effort doctor [--json]\n  effort recommend "task" [--provider codex|claude|generic] [--cwd path] [--json]\n  effort run "task" --provider codex|claude --cwd path [--allow-write]\n    [--verify '["node","--test"]'] [--max-attempts 3] [--timeout 120]\n    [--effort auto|low|medium|high] [--max-effort high] [--model model-id]\n    [--prompt-file path] [--dry-run] [--json]\n  effort dashboard [--port 0]\n  effort history [--json]\n  effort mcp\n  effort config codex|claude\n\nManaged runs use your installed, signed-in provider CLI and its billed access.\nDefault: read-only, at most 3 attempts, 120 seconds total, high effort ceiling.\n--allow-write permits provider-constrained edits. Verification is your explicitly\nchosen local command; it is NOT sandboxed by Effort. Review it before running.\nWithout --verify a completed task is UNVERIFIED and never auto-retried.\nDesktop MCP offers advice; it cannot change the host chat's effort.\nPrompts, code, responses and test output are not stored by Effort. Provider CLIs\nhave their own storage policies. EFFORT_DATA_DIR changes the metadata directory.\n`;
const controller=new AbortController();
function handleCancellation(){process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());}
function number(value,fallback){if(value===undefined)return fallback;const n=Number(value);if(!Number.isFinite(n))throw new Error('Numeric option is invalid.');return n;}
function print(data,json){process.stdout.write((json?JSON.stringify(data,null,2):String(data))+'\n');}
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean'},json:{type:'boolean'},provider:{type:'string'},cwd:{type:'string'},model:{type:'string'},effort:{type:'string'},'max-effort':{type:'string'},'allow-write':{type:'boolean'},verify:{type:'string'},'max-attempts':{type:'string'},timeout:{type:'string'},port:{type:'string'},'prompt-file':{type:'string'},'dry-run':{type:'boolean'}
  }});
  const command=positionals[0];
  if(values.version)return print('0.1.0');
  if(values.help||!command)return print(help);
  if(command==='mcp'){serveMcp();return;}
  if(command==='doctor'){
    const checks=['codex','claude'].map(name=>{const r=spawnSync(name,['--version'],{encoding:'utf8',timeout:5000,windowsHide:true,shell:false});return {provider:name,installed:!r.error&&r.status===0,version:r.status===0?r.stdout.trim().slice(0,150):null,authenticated:'not checked',liveTest:'not performed'};});
    return print(values.json?{node:process.version,checks,capabilities:capabilities()}:`Node ${process.version}\n${checks.map(c=>`${c.provider}: ${c.installed?c.version:'not found'}; authentication not checked`).join('\n')}\nDesktop: advisory MCP. Live model access is tested only when you run a task.`,values.json);
  }
  if(command==='config'){
    const target=positionals[1],entry=fileURLToPath(import.meta.url),node=process.execPath;
    if(target==='codex')return print(`[mcp_servers.effort]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(entry)}, "mcp"]`);
    if(target==='claude')return print({mcpServers:{effort:{command:node,args:[entry,'mcp']}}},true);
    throw new Error('Use effort config codex or effort config claude. Merge the printed entry; do not replace existing settings.');
  }
  if(command==='recommend'||command==='run'){
    const cwd=resolve(values.cwd??process.cwd());
    if(!(await stat(cwd)).isDirectory())throw new Error('Workspace is not a directory.');
    const prompt=values['prompt-file']?await readFile(resolve(values['prompt-file']),'utf8'):positionals.slice(1).join(' ');
    if(command==='recommend'){
      const result=recommend({prompt,provider:values.provider??'generic',facts:await repositoryFacts(cwd,prompt),maxEffort:values['max-effort']??'high'});
      return print(values.json?result:`${result.effort.toUpperCase()} · heuristic recommendation\n${result.reasons.join('\n')}\n${result.caveat}`,values.json);
    }
    if(!values.provider)throw new Error('Choose --provider codex or claude explicitly.');
    handleCancellation();
    const adapter=getAdapter(values.provider);
    const options={prompt,cwd,model:values.model,effort:values.effort??'auto',maxEffort:values['max-effort']??'high',allowWrite:values['allow-write']??false,maxAttempts:number(values['max-attempts'],3),timeoutMs:number(values.timeout,120)*1000,verify:values.verify?JSON.parse(values.verify):undefined,signal:controller.signal};
    if(values['dry-run']){
      const recommendation=recommend({prompt,provider:values.provider,facts:await repositoryFacts(cwd,prompt),maxEffort:options.maxEffort});
      return print({provider:values.provider,model:values.model??'provider default',effort:options.effort==='auto'?recommendation.effort:options.effort,allowWrite:options.allowWrite,verification:options.verify??null,maxAttempts:options.maxAttempts,timeoutMs:options.timeoutMs,willExecute:false,recommendation},true);
    }
    const store=await new Store().initialize();
    options.onEvent=e=>{if(['attempt','verification','error','diagnostic'].includes(e.type))process.stderr.write(`[effort] ${JSON.stringify(e)}\n`);};
    const result=await runTask(options,{adapter,store});
    print(values.json?result:`${result.text}\n\n[${result.task.status}] ${result.task.id}\n${result.task.stopReason??''}`,values.json);
    if(['failed','blocked','cancelled'].includes(result.task.status))process.exitCode=2;
    return;
  }
  if(command==='history'){
    const tasks=await(await new Store().initialize()).list();
    return print(values.json?tasks:tasks.length?tasks.map(t=>`${t.id}  ${t.provider}  ${t.effort}  ${t.status}`).join('\n'):'No tasks yet. Run effort run to record a managed task.',values.json);
  }
  if(command==='dashboard'){
    handleCancellation();
    const store=await new Store().initialize();
    const {server,url}=await startDashboard({store,port:number(values.port,0)});
    print(`Effort dashboard (local only):\n${url}\nPress Ctrl+C to stop. Treat this URL as a local access token.`);
    controller.signal.addEventListener('abort',()=>server.close(),{once:true});
    return;
  }
  throw new Error(`Unknown command: ${command}. Use effort --help.`);
}
main().catch(e=>{process.stderr.write(`effort: ${e.message}\n`);process.exitCode=1;});
