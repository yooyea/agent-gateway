import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentSession, CreateSessionRequest, ProviderCapabilities, ProviderPlugin, SendInputRequest } from "@agent-gateway/protocol";
export class MockProvider implements AgentProvider {
  readonly id="mock"; readonly displayName="Mock Agent Provider"; private sessions=new Map<string,AgentSession>();
  capabilities():ProviderCapabilities { return {supported:["durable_session","streaming","tools"],native:["durable_session","streaming","tools"]}; }
  async health(){ return {ok:true}; }
  async createSession(_req:CreateSessionRequest){ const providerSessionId=randomUUID(); const s:AgentSession={id:`${this.id}:${providerSessionId}`,provider:this.id,providerSessionId,status:"idle",createdAt:new Date().toISOString()}; this.sessions.set(providerSessionId,s); return s; }
  async getSession(id:string){ const s=this.sessions.get(id); if(!s) throw new Error("mock session not found"); return s; }
  async sendInput(id:string,_req:SendInputRequest){ const s=await this.getSession(id); s.status="idle"; s.lastActiveAt=new Date().toISOString(); }
  async cancel(id:string){ const s=await this.getSession(id); s.status="cancelled"; }
}
export const plugin:ProviderPlugin={manifest:{id:"mock",name:"Mock Agent Provider",version:"0.1.0",protocolVersion:"1"},create(){return new MockProvider();}};
export default plugin;
