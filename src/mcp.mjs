import { recommend, nextDecision } from './policy.mjs';
import { capabilities } from './registry.mjs';

const levels = ['low','medium','high','xhigh','max'];
const annotation = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
export const toolDefinitions = [
  {name:'effort_recommend',description:'Recommend reasoning effort for a task. Advisory only: does not change the host model, settings, or effort. Does not store the prompt. Heuristic, not trained.',annotations:annotation,inputSchema:{type:'object',properties:{prompt:{type:'string',minLength:1,maxLength:100000},provider:{type:'string',enum:['generic','codex','claude']},maxEffort:{type:'string',enum:levels}},required:['prompt'],additionalProperties:false}},
  {name:'effort_observe',description:'Suggest a next action after a verification failure. Does not execute actions or change effort. Repeated edits alone are not evidence. Stop on environment, access, permission, timeout or unclassified failures.',annotations:annotation,inputSchema:{type:'object',properties:{effort:{type:'string',enum:levels},kind:{type:'string',enum:['test','access','permission','environment','timeout','unknown']},repeatCount:{type:'integer',minimum:1,maximum:100},maxEffort:{type:'string',enum:levels}},required:['effort','kind'],additionalProperties:false}},
  {name:'effort_capabilities',description:'Explain which integrations really control effort and which provide advice. No network, execution, or settings changes.',annotations:annotation,inputSchema:{type:'object',properties:{},additionalProperties:false}}
];

export function handleRpc(message) {
  if (!message || typeof message!=='object' || message.jsonrpc!=='2.0' || typeof message.method!=='string' || (Object.hasOwn(message,'id') && !['number','string'].includes(typeof message.id))) return {jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:'Invalid request'}};
  if (!Object.hasOwn(message,'id')) return null;
  const response=result=>({jsonrpc:'2.0',id:message.id,result});
  if (message.method==='initialize') {
    const offered=message.params?.protocolVersion;
    const version=['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(offered)?offered:'2025-06-18';
    return response({protocolVersion:version,capabilities:{tools:{listChanged:false}},serverInfo:{name:'effort-project',version:'0.1.0'},instructions:'Effort recommendations are advice only. This server cannot change the host conversation effort. Use the host effort selector if you accept the recommendation. Never treat a recommendation or a reported success as verified reasoning quality.'});
  }
  if (message.method==='ping') return response({});
  if (message.method==='tools/list') return response({tools:toolDefinitions});
  if (message.method==='tools/call') {
    const name=message.params?.name,args=message.params?.arguments??{};
    const definition=toolDefinitions.find(t=>t.name===name);
    if (!definition) return {jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Unknown tool'}};
    try {
      if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).some(k=>!Object.hasOwn(definition.inputSchema.properties,k))) throw new Error('Unexpected tool arguments.');
      let result;
      if (name==='effort_recommend') result={...recommend(args),control:'advisory',applied:false};
      if (name==='effort_observe') result={...nextDecision(args),control:'advisory',applied:false};
      if (name==='effort_capabilities') result={capabilities:capabilities(),applied:false};
      return response({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});
    } catch(e) { return response({content:[{type:'text',text:e.message}],isError:true}); }
  }
  return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
}

export function serveMcp(input=process.stdin, output=process.stdout) {
  let buffer='', dropping=false;
  input.setEncoding('utf8');
  const send=x=>{if(x) output.write(JSON.stringify(x)+'\n');};
  input.on('data',chunk=>{
    buffer+=chunk;
    let at;
    while((at=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,at); buffer=buffer.slice(at+1);
      if(dropping){dropping=false;continue;}
      if(!line.trim())continue;
      if(Buffer.byteLength(line)>1_048_576){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Message too large'}});continue;}
      try{send(handleRpc(JSON.parse(line)));}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
    }
    if(Buffer.byteLength(buffer)>1_048_576){buffer='';dropping=true;send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Message too large'}});}
  });
}
