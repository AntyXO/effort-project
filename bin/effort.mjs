#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { recommend, LEVELS } from '../src/policy.mjs';
import { repositoryFacts } from '../src/repository.mjs';
import { Store } from '../src/store.mjs';
import { runTask } from '../src/runner.mjs';
import { getAdapter, capabilities } from '../src/registry.mjs';
import { serveMcp } from '../src/mcp.mjs';
import { startDashboard } from '../src/server.mjs';
import { createAutomaticRouter, validateModelMap } from '../src/automatic.mjs';

const help=`The Effort Project · 0.1.0\nLocal effort decisions, with evidence you can inspect.\n\n  effort doctor [--json]\n  effort recommend "task" [--provider codex|claude|generic] [--cwd path] [--json]\n  effort run "task" --provider codex|claude --cwd path [--allow-write]\n    [--verify '["node","--test"]'] [--max-attempts 3] [--timeout 120]\n    [--effort auto|low|medium|high] [--max-effort high] [--model model-id]\n    [--prompt-file path] [--dry-run] [--json]\n  effort auto codex|claude [--cwd path] [--effort auto|low|medium|high]\n    [--min-effort low] [--max-effort high] [--model model-id]\n    [--routing-config path] [--dry-run] [--allow-write (Claude only)]\n  effort dashboard [--port 0]\n  effort history [--json]\n  effort mcp\n  effort config codex|claude|opencode\n\nAuto Codex: normal Codex terminal UI through an experimental local router.\nAuto Claude: Effort's text session, resuming Claude Code between prompts.\nAuto selects before each user turn; fixed --effort and --model override routing.\nOpenCode: config opencode prints a native plugin module; see docs/automatic.md.\nManaged runs use your installed, signed-in provider CLI and its billed access.\nRun/Claude defaults: read-only, 120 seconds per task/turn, high effort ceiling.\nAuto Codex preserves the official interface's sandbox and approval settings.\n--allow-write permits provider-constrained edits. Verification is your explicitly\nchosen local command; it is NOT sandboxed by Effort. Review it before running.\nWithout --verify a completed task is UNVERIFIED and never auto-retried.\nDesktop MCP offers advice; it cannot change the host chat's effort.\nPrompts, code, responses and test output are not stored by Effort. Provider CLIs\nhave their own storage policies. EFFORT_DATA_DIR changes the metadata directory.\n`;
const controller=new AbortController();
function handleCancellation(){process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());}
function number(value,fallback){if(value===undefined)return fallback;const n=Number(value);if(!Number.isFinite(n))throw new Error('Numeric option is invalid.');return n;}
function print(data,json){process.stdout.write((json?JSON.stringify(data,null,2):String(data))+'\n');}
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{
    help:{type:'boolean',short:'h'},version:{type:'boolean'},json:{type:'boolean'},provider:{type:'string'},cwd:{type:'string'},model:{type:'string'},effort:{type:'string'},'min-effort':{type:'string'},'max-effort':{type:'string'},'routing-config':{type:'string'},'allow-write':{type:'boolean'},verify:{type:'string'},'max-attempts':{type:'string'},timeout:{type:'string'},port:{type:'string'},'prompt-file':{type:'string'},'dry-run':{type:'boolean'}
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
    if(target==='opencode')return print(`export { default } from ${JSON.stringify(pathToFileURL(resolve(fileURLToPath(new URL('../src/integrations/opencode.mjs',import.meta.url)))).href)};`);
    throw new Error('Use effort config codex, claude, or opencode. Merge the printed entry; do not replace existing settings.');
  }
  if(command==='auto'){
    const provider=positionals[1]??values.provider;
    if(!['codex','claude'].includes(provider))throw new Error('Use effort auto codex or effort auto claude.');
    if(values.json||values.verify||values['max-attempts']||values['prompt-file']||positionals.length>2)throw new Error('Auto is interactive. Use effort run for a single task, JSON output, or verification/retries.');
    if(provider==='codex'&&(values['allow-write']||values.timeout))throw new Error('Auto Codex uses the official terminal UI permissions and cancellation controls. Do not pass --allow-write or --timeout.');
    const cwd=resolve(values.cwd??process.cwd());
    if(!(await stat(cwd)).isDirectory())throw new Error('Workspace is not a directory.');
    let config={};
    if(values['routing-config']){
      const source=await readFile(resolve(values['routing-config']),'utf8');
      if(source.length>16_384)throw new Error('Routing configuration is too large.');
      config=JSON.parse(source);
      if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>!['models','minEffort','maxEffort'].includes(key)))throw new Error('Routing configuration accepts models, minEffort, and maxEffort only.');
    }
    const options={cwd,model:values.model,models:validateModelMap(config.models),effort:values.effort??'auto',minEffort:values['min-effort']??config.minEffort??'low',maxEffort:values['max-effort']??config.maxEffort??'high',signal:controller.signal};
    if(options.model!==undefined)validateModelMap({low:options.model});
    if(provider==='claude'){
      options.allowWrite=values['allow-write']??false;
      options.timeoutMs=number(values.timeout,120)*1000;
      if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>1_800_000)throw new Error('Claude timeout must be between 0.001 and 1800 seconds.');
      if(options.effort!=='auto'&&!getAdapter('claude').capabilities.levels.includes(options.effort))throw new Error('The Claude adapter supports low, medium, or high effort.');
    }
    createAutomaticRouter({...options,provider}); // Validate bounds even in dry-run mode.
    if(provider==='claude'&&!getAdapter('claude').capabilities.levels.some(level=>LEVELS.indexOf(level)>=LEVELS.indexOf(options.minEffort)&&LEVELS.indexOf(level)<=LEVELS.indexOf(options.maxEffort)))throw new Error('The Claude adapter has no supported effort within these bounds.');
    if(values['dry-run'])return print({provider,mode:provider==='codex'?'native-terminal-router':'managed-resumable-chat',...options,signal:undefined,willExecute:false,desktopControl:false},true);
    if(!process.stdin.isTTY)throw new Error('Auto requires an interactive terminal. Use --dry-run to inspect setup, or effort run for scripts.');
    handleCancellation();
    if(provider==='codex'){
      print('Starting experimental automatic Codex. Effort is selected before each text prompt; native approvals remain in Codex.');
      const {launchCodexAutomatic}=await import('../src/integrations/codex-remote.mjs');
      process.exitCode=await launchCodexAutomatic({...options,onDecision:event=>process.stderr.write(`[effort] ${JSON.stringify(event)}\n`)});
      return;
    }
    const {createManagedChat}=await import('../src/integrations/managed-chat.mjs');
    const chat=createManagedChat({...options,adapter:getAdapter('claude'),onEvent:event=>{
      if(['routing','diagnostic','error'].includes(event.type))process.stderr.write(`[effort] ${JSON.stringify(event)}\n`);
    }});
    const input=createInterface({input:process.stdin,output:process.stdout,terminal:true,historySize:0});
    const close=()=>input.close();controller.signal.addEventListener('abort',close,{once:true});
    input.on('SIGINT',()=>controller.abort());
    print('Automatic Claude session · one prompt per line. /new starts a new conversation; /quit exits.\nClaude uses your signed-in access. Results are unverified; provider transcripts follow Claude settings.');
    input.setPrompt('You > ');input.prompt();
    try{
      for await(const line of input){
        const prompt=line.trim();
        if(prompt==='/quit')break;
        if(prompt==='/new'){chat.reset();print('New conversation.');input.prompt();continue;}
        if(!prompt){input.prompt();continue;}
        if(prompt.startsWith('/')){print('Supported commands: /new, /quit.');input.prompt();continue;}
        try{
          const result=await chat.submit(prompt);
          print(`${result.text||'No response text.'}\n[${result.status}] ${result.decision?.effort??result.requestedEffort??'unchanged'} effort requested${result.requiresReset?'; use /new before another prompt':''}.`);
        }catch(error){print(`Session error: ${error.message}`);}
        if(controller.signal.aborted)break;
        input.prompt();
      }
    }finally{input.close();controller.signal.removeEventListener('abort',close);}
    return;
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
