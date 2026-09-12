import type { AgentSession, CreateSessionRequest, SendInputRequest } from "@agent-gateway/protocol";
export class AgentGatewayClient {
  constructor(private baseUrl:string, private apiKey?:string){}
  private async request<T>(path:string, init?:RequestInit):Promise<T>{
    const r=await fetch(`${this.baseUrl.replace(/\/$/,"")}${path}`,{...init,headers:{"content-type":"application/json",...(this.apiKey?{"authorization":`Bearer ${this.apiKey}`}:{}) ,...(init?.headers??{})}});
    const text=await r.text(); if(!r.ok) throw new Error(`Gateway ${r.status}: ${text}`); return text?JSON.parse(text):undefined as T;
  }
  providers(){ return this.request<any[]>("/v1/providers"); }
  createSession(body:CreateSessionRequest){ return this.request<AgentSession>("/v1/sessions",{method:"POST",body:JSON.stringify(body)}); }
  getSession(id:string){ return this.request<AgentSession>(`/v1/sessions/${encodeURIComponent(id)}`); }
  sendInput(id:string,body:SendInputRequest){ return this.request<void>(`/v1/sessions/${encodeURIComponent(id)}/input`,{method:"POST",body:JSON.stringify(body)}); }
  cancel(id:string){ return this.request<void>(`/v1/sessions/${encodeURIComponent(id)}/cancel`,{method:"POST"}); }
}
