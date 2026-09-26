import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { recommend, POLICY_VERSION } from './policy.mjs';
import { capabilities } from './registry.mjs';

const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y);};
async function body(req) {
  let data='';
  for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>120_000)throw new Error('Request too large.');}
  return JSON.parse(data);
}
export async function startDashboard({store,port=0}={}) {
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port.');
  const token=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    try {
      const host=`127.0.0.1:${server.address().port}`;
      if(req.headers.host!==host)return json(403,{error:'Invalid host.'});
      if(req.headers.origin && req.headers.origin!==`http://${host}`)return json(403,{error:'Cross-origin request denied.'});
      if(req.headers['sec-fetch-site']==='cross-site')return json(403,{error:'Cross-site request denied.'});
      const path=new URL(req.url,`http://${host}`).pathname;
      if(path.startsWith('/api/')){
        if(!safeEqual(req.headers.authorization??'',`Bearer ${token}`))return json(401,{error:'Open the dashboard URL printed by effort dashboard to authenticate.'});
        if(path==='/api/status'&&req.method==='GET'){
          const tasks=await store.list(100);
          return json(200,{version:'0.1.0',policyVersion:POLICY_VERSION,capabilities:capabilities(),stats:{tasks:tasks.length,verified:tasks.filter(t=>t.status==='verified').length,unverified:tasks.filter(t=>t.status==='unverified').length,blocked:tasks.filter(t=>['blocked','failed','cancelled'].includes(t.status)).length},tasks});
        }
        if(path.startsWith('/api/tasks/')&&req.method==='GET'){
          try{return json(200,await store.get(path.slice('/api/tasks/'.length)));}catch{return json(404,{error:'Task not found.'});}
        }
        if(path==='/api/recommend'&&req.method==='POST'){
          if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'Use application/json.'});
          const {prompt,provider}=await body(req);
          return json(200,{...recommend({prompt,provider}),control:'advisory',applied:false});
        }
        return json(404,{error:'Not found.'});
      }
      const asset=assets.get(path);
      if(req.method!=='GET'||!asset)return json(404,{error:'Not found.'});
      const bytes=await readFile(fileURLToPath(new URL(`../web/${asset[0]}`,import.meta.url)));
      res.writeHead(200,{'Content-Type':asset[1]});res.end(bytes);
    }catch{return json(400,{error:'Request could not be processed.'});}
  });
  server.requestTimeout=10_000; server.headersTimeout=10_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:`http://127.0.0.1:${server.address().port}/#token=${token}`,token};
}
