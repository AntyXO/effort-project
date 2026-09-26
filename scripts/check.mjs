import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let failed=false,count=0;
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(/\.(mjs|js)$/.test(p)){const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});count++;if(r.status!==0){failed=true;process.stderr.write(r.stderr);}}}}
for(const dir of ['src','bin','test','web','scripts'])await walk(dir);
console.log(`Syntax checked ${count} JavaScript files.`);process.exitCode=failed?1:0;
