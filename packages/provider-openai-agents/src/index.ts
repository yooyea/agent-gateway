import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentSession, CreateSessionRequest, ProviderCapabilities, ProviderPlugin, SendInputRequest, SessionStatus } from "@agent-gateway/protocol";

export interface OpenAIAgentsProviderOptions { apiKey: string; baseUrl?: string; defaultModel?: string; }
export class OpenAIAgentsProvider implements AgentProvider {
  readonly id="openai-agents"; readonly displayName="OpenAI Agents API"; private baseUrl:string;
  constructor(private options:OpenAIAgentsProviderOptions){ this.baseUrl=(options.baseUrl??"https://api.openai.com/v1").replace(/\/$/,""); }
  capabilities():ProviderCapabilities { const all=["durable_session","streaming","sandbox","mcp","tools","artifacts","subagents","approvals","secrets","files"] as const; return {supported:[...all],native:[...all]}; }
  async health(){ return {ok:Boolean(this.options.apiKey),detail:this.options.apiKey?undefined:"OPENAI_API_KEY is missing"}; }
  private headers(){ return {"Authorization":`Bearer ${this.options.apiKey}`,"Content-Type":"application/json"}; }
  private async json(path:string,init?:RequestInit){ const res=await fetch(`${this.baseUrl}${path}`,{...init,headers:{...this.headers(),...(init?.headers??{})}}); const text=await res.text(); if(!res.ok) throw new Error(`OpenAI Agents API ${res.status}: ${text}`); return text?JSON.parse(text):undefined; }
  private map(raw:any):AgentSession { return {id:`${this.id}:${raw.id}`,provider:this.id,providerSessionId:raw.id,status:this.mapStatus(raw.status),createdAt:new Date((raw.created_at??Date.now()/1000)*1000).toISOString(),lastActiveAt:raw.last_active_at?new Date(raw.last_active_at*1000).toISOString():undefined,metadata:raw.metadata,requiredActions:raw.required_actions,usage:raw.usage,raw}; }
  private mapStatus(s:string):SessionStatus { return s==="idle"||s==="in_progress"||s==="requires_action"||s==="failed"?s:"idle"; }
  async createSession(req:CreateSessionRequest){
    const agent:Record<string,unknown>={model:req.agent.model??this.options.defaultModel,instructions:req.agent.instructions,name:req.agent.name,tools:req.agent.tools,multi_agent:req.agent.multiAgent?{enabled:req.agent.multiAgent.enabled,max_concurrent_subagents:req.agent.multiAgent.maxConcurrentSubagents}:undefined,...(req.agent.vendor??{})};
    Object.keys(agent).forEach(k=>agent[k]===undefined&&delete agent[k]);
    const environment=req.environment?.type==="none"||!req.environment?{type:"none"}:req.environment.config??{type:req.environment.type};
    return this.map(await this.json("/agents/sessions",{method:"POST",body:JSON.stringify({agent,environment,input:req.input,metadata:req.metadata,stream:false})}));
  }
  async getSession(id:string){ return this.map(await this.json(`/agents/sessions/${encodeURIComponent(id)}`)); }
  async sendInput(id:string,req:SendInputRequest){
    const input=typeof req.input==="string"?[{role:"user",content:[{type:"input_text",text:req.input}]}]:req.input.map(m=>({role:m.role,content:[{type:"input_text",text:m.content}]}));
    await this.json(`/agents/sessions/${encodeURIComponent(id)}/events`,{method:"POST",body:JSON.stringify({idempotency_key:req.idempotencyKey??randomUUID(),events:[{type:"agent.session.input.message",input}]})});
  }
}

export const plugin:ProviderPlugin={
  manifest:{id:"openai-agents",name:"OpenAI Agents API",version:"0.1.0",protocolVersion:"1"},
  create(config,context){
    const apiKey=String(config.apiKey??context.env.OPENAI_API_KEY??"");
    return new OpenAIAgentsProvider({apiKey,baseUrl:String(config.baseUrl??context.env.OPENAI_BASE_URL??"https://api.openai.com/v1"),defaultModel:config.defaultModel?String(config.defaultModel):(context.env.OPENAI_AGENT_MODEL||undefined)});
  }
};
export default plugin;
