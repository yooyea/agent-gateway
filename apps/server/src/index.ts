import http from "node:http";
import { readFile } from "node:fs/promises";
import {
  AgentGateway,
  InMemorySessionStore,
  loadProviderPlugins,
  ProviderRegistry,
  StaticVirtualKeyAuthenticator,
  type PluginConfigEntry,
  type RouteHints,
  type VirtualKeyRecord,
} from "@agent-gateway/core";
import type { AgentCapability, CreateSessionRequest, SessionEventBatch } from "@agent-gateway/protocol";

interface GatewayConfig {
  defaultProvider?: string;
  channels: PluginConfigEntry[];
}

async function loadConfig(): Promise<GatewayConfig> {
  if (process.env.AGENT_GATEWAY_CONFIG) {
    return JSON.parse(await readFile(process.env.AGENT_GATEWAY_CONFIG, "utf8"));
  }

  const channels: PluginConfigEntry[] = [
    {
      id: "mock-default",
      module: "@agent-gateway/provider-mock",
      enabled: true,
      priority: 1000,
    },
  ];

  if (process.env.OPENAI_API_KEY) {
    channels.unshift({
      id: "openai-default",
      module: "@agent-gateway/provider-openai-agents",
      enabled: true,
      priority: 100,
    });
  }

  return {
    defaultProvider: process.env.DEFAULT_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai-agents" : "mock"),
    channels,
  };
}

function loadKeys(): VirtualKeyRecord[] {
  const configured = process.env.AGENT_GATEWAY_KEYS;
  if (configured) return JSON.parse(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("AGENT_GATEWAY_KEYS is required in production");
  }
  return [{ id: "vk_dev", key: "ag_dev_local", tenantId: "tenant_dev", projectId: "project_dev" }];
}

const cfg = await loadConfig();
const registry = await loadProviderPlugins(cfg.channels, new ProviderRegistry());
const gateway = new AgentGateway(registry, new InMemorySessionStore(), cfg.defaultProvider);
const authenticator = new StaticVirtualKeyAuthenticator(loadKeys());
const port = Number(process.env.PORT ?? 8787);

async function readJson(req: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function errorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Missing bearer token|Invalid API key/.test(message)) return 401;
  if (/Session not found/.test(message)) return 404;
  if (/Unknown channel|does not satisfy|No healthy channel/.test(message)) return 400;
  return 500;
}

function routeHints(req: http.IncomingMessage): RouteHints {
  const provider = req.headers["x-agent-gateway-provider"];
  const channel = req.headers["x-agent-gateway-channel"];
  const capabilityHeader = req.headers["x-agent-gateway-required-capabilities"];
  const maxCostHeader = req.headers["x-agent-gateway-max-cost-usd"];

  const requiredCapabilities = typeof capabilityHeader === "string"
    ? capabilityHeader
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean) as AgentCapability[]
    : undefined;

  const maxCostUsd = typeof maxCostHeader === "string" ? Number(maxCostHeader) : undefined;

  return {
    provider: typeof provider === "string" ? provider : undefined,
    channel: typeof channel === "string" ? channel : undefined,
    requiredCapabilities,
    budget: Number.isFinite(maxCostUsd) ? { max_cost_usd: maxCostUsd } : undefined,
  };
}

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, service: "agent-gateway" });
      }

      const context = authenticator.authenticate(req.headers.authorization);

      if (req.method === "GET" && path === "/api/gateway/channels") {
        return json(res, 200, await gateway.channels());
      }

      if (req.method === "POST" && path === "/agents/sessions") {
        const body = (await readJson(req)) as CreateSessionRequest;
        if (body.stream === true) {
          return json(res, 501, {
            error: {
              type: "gateway_not_implemented",
              message: "Streaming session creation is not implemented yet; create the session with stream=false then use the events stream endpoint.",
            },
          });
        }
        return json(res, 201, await gateway.createSession(body, context, routeHints(req)));
      }

      let match = path.match(/^\/agents\/sessions\/([^/]+)$/);
      if (req.method === "GET" && match) {
        return json(res, 200, await gateway.getSession(decodeURIComponent(match[1]), context));
      }

      match = path.match(/^\/agents\/sessions\/([^/]+)\/events$/);
      if (req.method === "POST" && match) {
        await gateway.sendEvents(
          decodeURIComponent(match[1]),
          (await readJson(req)) as SessionEventBatch,
          context,
        );
        res.writeHead(204);
        return res.end();
      }

      if (req.method === "GET" && match) {
        const stream = await gateway.streamEvents(decodeURIComponent(match[1]), context);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for await (const chunk of stream) res.write(chunk);
        return res.end();
      }

      return json(res, 404, { error: { type: "not_found", message: "Route not found" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(res, errorStatus(error), { error: { type: "gateway_error", message } });
    }
  })
  .listen(port, () => console.log(`agent-gateway listening on :${port}`));
