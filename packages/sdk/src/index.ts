import type { CreateSessionRequest, GatewaySession, SessionEventBatch } from "@agent-gateway/protocol";

export interface SessionRouteOptions {
  provider?: string;
  channel?: string;
  requiredCapabilities?: string[];
  maxCostUsd?: number;
}

export class AgentGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(route?: SessionRouteOptions) {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...(route?.provider ? { "x-agent-gateway-provider": route.provider } : {}),
      ...(route?.channel ? { "x-agent-gateway-channel": route.channel } : {}),
      ...(route?.requiredCapabilities?.length
        ? { "x-agent-gateway-required-capabilities": route.requiredCapabilities.join(",") }
        : {}),
      ...(route?.maxCostUsd !== undefined
        ? { "x-agent-gateway-max-cost-usd": String(route.maxCostUsd) }
        : {}),
    };
  }

  private async request<T>(path: string, init?: RequestInit, route?: SessionRouteOptions): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { ...this.headers(route), ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Agent Gateway ${response.status}: ${text}`);
    return text ? JSON.parse(text) : (undefined as T);
  }

  channels() {
    return this.request<any[]>("/api/gateway/channels");
  }

  createSession(body: CreateSessionRequest, route?: SessionRouteOptions) {
    return this.request<GatewaySession>(
      "/agents/sessions",
      { method: "POST", body: JSON.stringify(body) },
      route,
    );
  }

  getSession(id: string) {
    return this.request<GatewaySession>(`/agents/sessions/${encodeURIComponent(id)}`);
  }

  sendEvents(id: string, body: SessionEventBatch) {
    return this.request<void>(`/agents/sessions/${encodeURIComponent(id)}/events`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  streamEvents(id: string) {
    return fetch(`${this.baseUrl.replace(/\/$/, "")}/agents/sessions/${encodeURIComponent(id)}/events`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "text/event-stream" },
    });
  }
}
