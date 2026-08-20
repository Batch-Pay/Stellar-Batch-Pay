import Redis from "ioredis";
import { getStoreConfig } from "../store-config";
import type { EndpointKey, RateLimitState, Tier } from "./rate-limit-sqlite";

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local remaining = redis.call('HGET', key, 'remaining')
local resetAt = redis.call('HGET', key, 'resetAt')

if not remaining or not resetAt or now >= tonumber(resetAt) then
  local resetAtMs = now + windowMs
  local newRemaining = limit - 1
  redis.call('HSET', key, 'remaining', newRemaining, 'resetAt', resetAtMs, 'limit', limit)
  redis.call('PEXPIRE', key, windowMs + 1000)
  return {0, newRemaining, resetAtMs}
end

remaining = tonumber(remaining)
resetAt = tonumber(resetAt)

if remaining <= 0 then
  return {1, 0, resetAt}
end

local newRemaining = remaining - 1
redis.call('HSET', key, 'remaining', newRemaining)
return {0, newRemaining, resetAt}
`;

let _redis: Redis | null = null;

function getRedis(): Redis {
  const { redisUrl } = getStoreConfig();
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for Redis rate limit backend.");
  }
  if (!_redis) {
    _redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  }
  return _redis;
}

export async function consumeRateLimit(args: {
  key: string;
  tier: Tier;
  endpoint: EndpointKey;
  limit: number;
  windowMs: number;
}): Promise<RateLimitState> {
  const redis = getRedis();
  const now = Date.now();
  const result = (await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,
    args.key,
    String(args.limit),
    String(args.windowMs),
    String(now),
  )) as [number, number, number];

  const [blockedFlag, remaining, resetAtMs] = result;
  const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - now) / 1000));

  return {
    blocked: blockedFlag === 1,
    remaining: Math.max(0, remaining),
    retryAfterSec,
    resetAt: Math.ceil(resetAtMs / 1000),
    limit: args.limit,
  };
}

export async function checkRedisRateLimitHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    return { ok: pong === "PONG" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function resetRedisRateLimitForTests(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
