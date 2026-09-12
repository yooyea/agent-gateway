import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import type { ChannelRuntimeState, SessionRecord, SessionStore } from "@agent-gateway/core";

export interface RedisRuntimeOptions {
  keyPrefix?: string;
  circuitFailureThreshold?: number;
  circuitFailureWindowSeconds?: number;
  circuitOpenSeconds?: number;
}

export interface RateLimitInput {
  key: string;
  limit: number;
  windowSeconds: number;
  cost?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  current: number;
  remaining: number;
  resetAfterSeconds: number;
}

export interface ConcurrencyInput {
  key: string;
  limit: number;
  ttlSeconds: number;
}

export interface ConcurrencyLease {
  key: string;
  id: string;
  expiresAt: number;
}

export type ConcurrencyDecision =
  | { acquired: true; current: number; lease: ConcurrencyLease }
  | { acquired: false; current: number; retryAfterSeconds: number };

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if current == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

const CONCURRENCY_ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local expires_at = tonumber(ARGV[3])
local lease_id = ARGV[4]
local key_ttl_ms = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local current = redis.call('ZCARD', KEYS[1])
if current >= limit then
  local earliest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry_at = tonumber(earliest[2]) or now
  return { 0, current, retry_at }
end
redis.call('ZADD', KEYS[1], expires_at, lease_id)
redis.call('PEXPIRE', KEYS[1], key_ttl_ms)
return { 1, current + 1, expires_at }
`;

const CONCURRENCY_RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) == false then
  return 0
end
redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

const CIRCUIT_FAILURE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
if count >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
end
return count
`;

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeComponent(value: string) {
  return encodeURIComponent(value);
}

export class RedisCachedSessionStore implements SessionStore {
  constructor(
    private readonly runtime: RedisRuntimeControls,
    private readonly base: SessionStore,
    private readonly ttlSeconds: number,
  ) {
    positiveInteger(ttlSeconds, "session cache ttlSeconds");
  }

  async create(record: SessionRecord) {
    await this.base.create(record);
    await this.runtime.cacheSessionBestEffort(record, this.ttlSeconds);
  }

  async get(id: string) {
    const cached = await this.runtime.getCachedSessionBestEffort(id);
    if (cached) return cached;
    const record = await this.base.get(id);
    if (record) await this.runtime.cacheSessionBestEffort(record, this.ttlSeconds);
    return record;
  }

  async update(record: SessionRecord) {
    await this.base.update(record);
    await this.runtime.cacheSessionBestEffort(record, this.ttlSeconds);
  }
}

export class RedisRuntimeControls implements ChannelRuntimeState {
  private constructor(
    private readonly client: ReturnType<typeof createClient>,
    private readonly options: Required<RedisRuntimeOptions>,
  ) {}

  static async connect(url: string, options: RedisRuntimeOptions = {}) {
    const client = createClient({ url });
    client.on("error", () => undefined);
    await client.connect();
    return new RedisRuntimeControls(client, {
      keyPrefix: options.keyPrefix ?? "agent-gateway",
      circuitFailureThreshold: options.circuitFailureThreshold ?? 3,
      circuitFailureWindowSeconds: options.circuitFailureWindowSeconds ?? 60,
      circuitOpenSeconds: options.circuitOpenSeconds ?? 30,
    });
  }

  private key(kind: string, value: string) {
    return `${this.options.keyPrefix}:${kind}:${safeComponent(value)}`;
  }

  async health() {
    try {
      const pong = await this.client.ping();
      return { ok: pong === "PONG" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }

  createCachedSessionStore(base: SessionStore, ttlSeconds = 300): SessionStore {
    return new RedisCachedSessionStore(this, base, ttlSeconds);
  }

  private sessionKey(id: string) {
    return this.key("session", id);
  }

  async cacheSessionBestEffort(record: SessionRecord, ttlSeconds: number) {
    try {
      await this.client.set(this.sessionKey(record.id), JSON.stringify(record), { EX: ttlSeconds });
    } catch {
      // Postgres or the wrapped base store remains the source of truth.
    }
  }

  async getCachedSessionBestEffort(id: string): Promise<SessionRecord | undefined> {
    try {
      const raw = await this.client.get(this.sessionKey(id));
      if (!raw) return undefined;
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  async checkRateLimit(input: RateLimitInput): Promise<RateLimitDecision> {
    const limit = positiveInteger(input.limit, "rate limit");
    const windowSeconds = positiveInteger(input.windowSeconds, "rate limit windowSeconds");
    const cost = positiveInteger(input.cost ?? 1, "rate limit cost");
    const result = await this.client.eval(RATE_LIMIT_SCRIPT, {
      keys: [this.key("rate", input.key)],
      arguments: [String(cost), String(windowSeconds)],
    }) as unknown as [number | string, number | string];
    const current = Number(result[0]);
    const ttl = Math.max(0, Number(result[1]));
    return {
      allowed: current <= limit,
      limit,
      current,
      remaining: Math.max(0, limit - current),
      resetAfterSeconds: ttl,
    };
  }

  async acquireConcurrency(input: ConcurrencyInput): Promise<ConcurrencyDecision> {
    const limit = positiveInteger(input.limit, "concurrency limit");
    const ttlSeconds = positiveInteger(input.ttlSeconds, "concurrency ttlSeconds");
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const leaseId = randomUUID();
    const redisKey = this.key("concurrency", input.key);
    const result = await this.client.eval(CONCURRENCY_ACQUIRE_SCRIPT, {
      keys: [redisKey],
      arguments: [
        String(now),
        String(limit),
        String(expiresAt),
        leaseId,
        String(ttlSeconds * 1000 + 1000),
      ],
    }) as unknown as [number | string, number | string, number | string];
    const acquired = Number(result[0]) === 1;
    const current = Number(result[1]);
    const retryAt = Number(result[2]);
    if (!acquired) {
      return {
        acquired: false,
        current,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }
    return {
      acquired: true,
      current,
      lease: { key: redisKey, id: leaseId, expiresAt },
    };
  }

  async renewConcurrency(lease: ConcurrencyLease, ttlSeconds: number) {
    positiveInteger(ttlSeconds, "concurrency ttlSeconds");
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const renewed = Number(await this.client.eval(CONCURRENCY_RENEW_SCRIPT, {
      keys: [lease.key],
      arguments: [lease.id, String(expiresAt), String(ttlSeconds * 1000 + 1000)],
    })) === 1;
    if (renewed) lease.expiresAt = expiresAt;
    return renewed;
  }

  async releaseConcurrency(lease: ConcurrencyLease) {
    await this.client.zRem(lease.key, lease.id);
  }

  private circuitFailureKey(channelId: string) {
    return this.key("channel-failures", channelId);
  }

  private circuitOpenKey(channelId: string) {
    return this.key("channel-open", channelId);
  }

  async isChannelAvailable(channelId: string) {
    return (await this.client.exists(this.circuitOpenKey(channelId))) === 0;
  }

  async recordChannelFailure(channelId: string) {
    await this.client.eval(CIRCUIT_FAILURE_SCRIPT, {
      keys: [this.circuitFailureKey(channelId), this.circuitOpenKey(channelId)],
      arguments: [
        String(this.options.circuitFailureWindowSeconds),
        String(this.options.circuitFailureThreshold),
        String(this.options.circuitOpenSeconds),
      ],
    });
  }

  async recordChannelSuccess(channelId: string) {
    await this.client.del([this.circuitFailureKey(channelId), this.circuitOpenKey(channelId)]);
  }
}
