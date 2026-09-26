import * as codex from './adapters/codex.mjs';
import * as claude from './adapters/claude.mjs';
export const adapters = {codex,claude};
export const capabilities = () => [codex.capabilities,claude.capabilities,
  {id:'desktop',name:'Codex app / Claude app / other MCP hosts',levels:['low','medium','high'],control:'advisory',notes:'MCP recommendations only. The host must support local stdio MCP. This server cannot change the effort of the host conversation. No universal desktop control is claimed.'}];

export function getAdapter(name) {
  if (!Object.hasOwn(adapters,name)) throw new Error('Managed runs support codex or claude. Other hosts can use advisory MCP tools.');
  return adapters[name];
}
