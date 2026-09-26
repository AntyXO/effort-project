import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { classifyFailure } from './policy.mjs';

export function validateCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 100 || argv.some(x => typeof x !== 'string' || x.includes('\0') || x.length > 20_000) || !argv[0]) throw new Error('Verification must be a nonempty JSON array of executable and arguments.');
  return argv;
}

export function verify(argv, { cwd, timeoutMs = 60_000, signal, env = process.env } = {}) {
  validateCommand(argv);
  return new Promise(resolve => {
    if (signal?.aborted) return resolve({ status:'blocked', kind:'cancelled', output:'', exitCode:null });
    let output = '', timedOut = false, aborted = false, launchError = null;
    // A fresh verification process must not inherit node:test's nested-run marker:
    // Node can otherwise skip the requested tests and exit successfully.
    const childEnv={...env};delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(argv[0], argv.slice(1), { cwd, env:childEnv, shell:false, stdio:['ignore','pipe','pipe'], windowsHide:true, detached:process.platform!=='win32' });
    const collect = data => { output = (output + data.toString()).slice(-32_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    let hardKill,reapTimer,settled=false;
    const killTree = signalName => {
      if(!child.pid)return;
      if(process.platform==='win32'){
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{shell:false,stdio:'ignore',windowsHide:true});
        killer.on('error',()=>{try{child.kill(signalName);}catch{}});killer.unref();
      }else{try{process.kill(-child.pid,signalName);}catch{try{child.kill(signalName);}catch{}}}
    };
    const stop = () => {
      killTree('SIGTERM');
      hardKill=setTimeout(()=>killTree('SIGKILL'),500);
      reapTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();finish(null);},1500);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => { aborted = true; stop(); };
    signal?.addEventListener('abort', abort, { once:true });
    child.on('error', e => { launchError = e.code || 'launch error'; });
    const finish = code => {
      if(settled)return;settled=true;
      clearTimeout(timer); clearTimeout(hardKill);clearTimeout(reapTimer); signal?.removeEventListener('abort', abort);
      killTree('SIGKILL');
      if (launchError) output = launchError;
      const kind = aborted ? 'cancelled' : code === 0 && !timedOut ? null : classifyFailure(output, {timedOut});
      const status = code === 0 && !timedOut && !aborted ? 'passed' : kind === 'test' ? 'failed' : 'blocked';
      const normalized = output.replace(/\bduration(?:_ms)?\s*[:=]?\s*\d+(?:\.\d+)?/gi,'duration #time').replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds)\b/g, '#time').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g,' ').trim();
      resolve({status,kind,exitCode:code,output,fingerprint:createHash('sha256').update(normalized).digest('hex').slice(0,16)});
    };
    child.on('close',finish);
  });
}
