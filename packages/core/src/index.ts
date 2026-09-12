import type { AgentCapability, AgentProvider, AgentSession, CreateSessionRequest, ProviderCapabilities, ProviderPlugin, SendInputRequest } from "@agent-gateway/protocol";

export class ProviderRegistry {
  private providers = new Map<string, AgentProvider>();
  register(provider: AgentProvider) {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider); return this;
  }
  get(id: string) { const p=this.providers.get(id); if(!p) throw new Error(`Unknown provider: ${id}`); return p; }
  list() { return [...this.providers.values()]; }
}

export interface PluginConfigEntry { module: string; enabled?: boolean; config?: Record<string, unknown>; }
export async function loadProviderPlugins(entries: PluginConfigEntry[], registry: ProviderRegistry, env: NodeJS.ProcessEnv = process.env) {
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const loaded = await import(entry.module) as { plugin?: ProviderPlugin; default?: ProviderPlugin };
    const plugin = loaded.plugin ?? loaded.default;
    if (!plugin?.manifest || typeof plugin.create !== "function") throw new Error(`Invalid provider plugin: ${entry.module}`);
    registry.register(await plugin.create(entry.config ?? {}, { env }));
  }
  return registry;
}

function supports(c: ProviderCapabilities, required: AgentCapability[] = []) { const s=new Set(c.supported); return required.every(x=>s.has(x)); }

export class AgentGateway {
  private sessionIndex = new Map<string, { provider: string; providerSessionId: string }>();
  constructor(private registry: ProviderRegistry, private defaultProvider?: string) {}
  async providers() { return Promise.all(this.registry.list().map(async p=>({id:p.id,displayName:p.displayName,capabilities:await p.capabilities(),health:await p.health()}))); }
  private async select(req: CreateSessionRequest) {
    if (req.provider) {
      const explicit=this.registry.get(req.provider);
      if (!supports(await explicit.capabilities(), req.requiredCapabilities)) throw new Error(`Provider ${req.provider} does not satisfy required capabilities`);
      return explicit;
    }
    const required=req.requiredCapabilities??[]; const candidates=this.registry.list();
    if(this.defaultProvider){ const preferred=candidates.find(p=>p.id===this.defaultProvider); if(preferred&&supports(await preferred.capabilities(),required)) return preferred; }
    for(const p of candidates) if(supports(await p.capabilities(),required)) return p;
    throw new Error(`No provider satisfies capabilities: ${required.join(", ")}`);
  }
  async createSession(req: CreateSessionRequest): Promise<AgentSession> {
    const provider=await this.select(req); const session=await provider.createSession(req);
    this.sessionIndex.set(session.id,{provider:provider.id,providerSessionId:session.providerSessionId}); return session;
  }
  private resolve(id:string) {
    const indexed=this.sessionIndex.get(id);
    if(indexed) return {...indexed,provider:this.registry.get(indexed.provider)};
    const separator=id.indexOf(":");
    if(separator>0){ const providerId=id.slice(0,separator); const providerSessionId=id.slice(separator+1); return {provider:this.registry.get(providerId),providerSessionId}; }
    throw new Error(`Session route not found: ${id}`);
  }
  async getSession(id:string){ const r=this.resolve(id); const s=await r.provider.getSession(r.providerSessionId); this.sessionIndex.set(s.id,{provider:r.provider.id,providerSessionId:s.providerSessionId}); return s; }
  async sendInput(id:string,input:SendInputRequest){ const r=this.resolve(id); await r.provider.sendInput(r.providerSessionId,input); }
  async cancel(id:string){ const r=this.resolve(id); if(!r.provider.cancel) throw new Error(`Provider ${r.provider.id} does not support cancel`); await r.provider.cancel(r.providerSessionId); }
}
