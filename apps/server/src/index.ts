import http from "node:http";
import { readFile } from "node:fs/promises";
import { AgentGateway, loadProviderPlugins, ProviderRegistry, type PluginConfigEntry } from "@agent-gateway/core";

interface GatewayConfig { defaultProvider?:string; providers:PluginConfigEntry[]; }
async function config():Promise<GatewayConfig>{
  if(process.env.AGENT_GATEWAY_CONFIG){ return JSON.parse(await readFile(process.env.AGENT_GATEWAY_CONFIG,"utf8")); }
  const providers:PluginConfigEntry[]=[{module:"@agent-gateway/provider-mock",enabled:true}];
  if(process.env.OPENAI_API_KEY) providers.unshift({module:"@agent-gateway/provider-openai-agents",enabled:true});
  return {defaultProvider:process.env.DEFAULT_PROVIDER??(process.env.OPENAI_API_KEY?"openai-agents":"mock"),providers};
}
const cfg=await config(); const registry=await loadProviderPlugins(cfg.providers,new ProviderRegistry()); const gateway=new AgentGateway(registry,cfg.defaultProvider); const port=Number(process.env.PORT??8787);
async function body(req:http.IncomingMessage){ let raw=""; for await(const c of req) raw+=c; return raw?JSON.parse(raw):{}; }
function json(res:http.ServerResponse,status:number,data:unknown){ res.writeHead(status,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(data)); }
http.createServer(async(req,res)=>{ try{
  const url=new URL(req.url??"/",`http://${req.headers.host??"localhost"}`); const path=url.pathname;
  if(req.method==="GET"&&path==="/health") return json(res,200,{ok:true});
  if(req.method==="GET"&&path==="/v1/providers") return json(res,200,await gateway.providers());
  if(req.method==="POST"&&path==="/v1/sessions") return json(res,201,await gateway.createSession(await body(req)));
  let m=path.match(/^\/v1\/sessions\/([^/]+)$/); if(req.method==="GET"&&m) return json(res,200,await gateway.getSession(decodeURIComponent(m[1])));
  m=path.match(/^\/v1\/sessions\/([^/]+)\/input$/); if(req.method==="POST"&&m){await gateway.sendInput(decodeURIComponent(m[1]),await body(req));return json(res,202,{accepted:true});}
  m=path.match(/^\/v1\/sessions\/([^/]+)\/cancel$/); if(req.method==="POST"&&m){await gateway.cancel(decodeURIComponent(m[1]));return json(res,202,{accepted:true});}
  return json(res,404,{error:"not_found"});
}catch(e){ return json(res,500,{error:e instanceof Error?e.message:String(e)}); }}).listen(port,()=>console.log(`agent-gateway listening on :${port}`));
