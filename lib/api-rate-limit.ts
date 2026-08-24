import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getStoreConfig } from "./store-config";
import * as sqlite from "./backends/rate-limit-sqlite";

export type Tier = sqlite.Tier;
export type EndpointKey = sqlite.EndpointKey;
export type EndpointLimit = sqlite.EndpointLimit;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envKey(endpoint: EndpointKey): string {
  return endpoint.toUpperCase().replace(/-/g, "_");
}

function tunedLimit(endpoint: EndpointKey, defaults: EndpointLimit): EndpointLimit {
  const k = envKey(endpoint);
  return {
    free: intEnv(`RATE_LIMIT_${k}_FREE`, defaults.free),
    pro: intEnv(`RATE_LIMIT_${k}_PRO`, defaults.pro),
    enterprise: intEnv(`RATE_LIMIT_${k}_ENTERPRISE`, defaults.enterprise),
    windowMs: intEnv(`RATE_LIMIT_${k}_WINDOW_MS`, defaults.windowMs),
  };
}

const DEFAULT_LIMITS: Record<EndpointKey, EndpointLimit> = {
  "batch-build": { free: 8, pro: 20, enterprise: 60, windowMs: 60_000 },
  "batch-submit": { free: 5, pro: 15, enterprise: 45, windowMs: 60_000 },
  "batch-submit-signed": { free: 5, pro: 15, enterprise: 45, windowMs: 60_000 },
  "webhook-register": { free: 3, pro: 10, enterprise: 30, windowMs: 60_000 },
  "tx-status": { free: 30, pro: 100, enterprise: 300, windowMs: 60_000 },
  "dashboard-metrics": { free: 20, pro: 60, enterprise: 180, windowMs: 60_000 },
  "batch-status": { free: 60, pro: 200, enterprise: 600, windowMs: 60_000 },
  "batch-events": { free: 10, pro: 30, enterprise: 90, windowMs: 60_000 },
  // #743: batch-retry can enqueue paid work (server-signed retries move real
  // funds), so it is limited like batch-submit rather than a read endpoint.
  "batch-retry": { free: 5, pro: 15, enterprise: 45, windowMs: 60_000 },
  // #743: batch-recover exposes per-job success/failure detail and is
  // enumerable by jobId, so it gets the same budget as tx-status/batch-status
  // polling rather than the tighter write-endpoint limits.
  "batch-recover": { free: 30, pro: 100, enterprise: 300, windowMs: 60_000 },
  // #743: batch-history supports free-text search and aggregate summaries
  // across a wallet's full job history, so it is limited like the other
  // aggregation endpoint (dashboard-metrics) rather than a cheap status poll.
  "batch-history": { free: 20, pro: 60, enterprise: 180, windowMs: 60_000 },
  "webhook-deliveries": { free: 30, pro: 100, enterprise: 300, windowMs: 60_000 },
  health: { free: 30, pro: 100, enterprise: 300, windowMs: 60_000 },
};

const endpointLimits: Record<EndpointKey, EndpointLimit> = {
  "batch-build": tunedLimit("batch-build", DEFAULT_LIMITS["batch-build"]),
  "batch-submit": tunedLimit("batch-submit", DEFAULT_LIMITS["batch-submit"]),
  "batch-submit-signed": tunedLimit(
    "batch-submit-signed",
    DEFAULT_LIMITS["batch-submit-signed"],
  ),
  "webhook-register": tunedLimit("webhook-register", DEFAULT_LIMITS["webhook-register"]),
  "tx-status": tunedLimit("tx-status", DEFAULT_LIMITS["tx-status"]),
  "dashboard-metrics": tunedLimit("dashboard-metrics", DEFAULT_LIMITS["dashboard-metrics"]),
  "batch-status": tunedLimit("batch-status", DEFAULT_LIMITS["batch-status"]),
  "batch-events": tunedLimit("batch-events", DEFAULT_LIMITS["batch-events"]),
  "batch-retry": tunedLimit("batch-retry", DEFAULT_LIMITS["batch-retry"]),
  "batch-recover": tunedLimit("batch-recover", DEFAULT_LIMITS["batch-recover"]),
  "batch-history": tunedLimit("batch-history", DEFAULT_LIMITS["batch-history"]),
  "webhook-deliveries": tunedLimit(
    "webhook-deliveries",
    DEFAULT_LIMITS["webhook-deliveries"],
  ),
  health: tunedLimit("health", DEFAULT_LIMITS.health),
};

export const apiKeyTierMap: Record<string, Tier> = (() => {
  const raw = process.env.RATE_LIMIT_API_KEY_TIERS;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};

    return Object.entries(parsed).reduce<Record<string, Tier>>((map, [key, value]) => {
      if (typeof value === "string" && ["free", "pro", "enterprise"].includes(value)) {
        map[key] = value as Tier;
      }
      return map;
    }, {});
  } catch {
    return {};
  }
})();

export function getEndpointLimits(): Record<EndpointKey, EndpointLimit> {
  return endpointLimits;
}

function hashIdentifier(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getValidatedApiKey(request: NextRequest): { key: string; tier: Tier } | null {
  const auth = request.headers.get("authorization");
  let keyValue: string | undefined;

  if (auth?.startsWith("Bearer ")) {
    keyValue = auth.slice(7).trim();
  }

  const apiKey = request.headers.get("x-api-key");
  if (!keyValue && apiKey) {
    keyValue = apiKey.trim();
  }

  if (keyValue) {
    if (apiKeyTierMap[keyValue]) {
      return { key: keyValue, tier: apiKeyTierMap[keyValue] };
    }

    const hashed = hashIdentifier(keyValue);
    if (apiKeyTierMap[hashed]) {
      return { key: keyValue, tier: apiKeyTierMap[hashed] };
    }
  }

  return null;
}

function resolveTier(request: NextRequest): Tier {
  const validated = getValidatedApiKey(request);
  if (validated) {
    return validated.tier;
  }
  return "free";
}

function resolveIdentifier(request: NextRequest): string {
  const validated = getValidatedApiKey(request);
  if (validated) {
    return `auth:${hashIdentifier(validated.key)}`;
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const ip = forwarded.split(",")[0]?.trim();
    if (ip) return `ip:${hashIdentifier(ip)}`;
  }

  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return `ip:${hashIdentifier(cfIp)}`;

  return "ip:unknown";
}

async function consumeRateLimit(args: {
  key: string;
  tier: Tier;
  endpoint: EndpointKey;
  limit: number;
  windowMs: number;
}) {
  const backend = getStoreConfig().rateLimitBackend;
  if (backend === "redis") {
    const redis = await import("./backends/rate-limit-redis");
    return redis.consumeRateLimit(args);
  }
  if (backend === "postgres") {
    const postgres = await import("./backends/rate-limit-postgres");
    return postgres.consumeRateLimit(args);
  }
  return sqlite.consumeRateLimit(args);
}

export async function applyRateLimit(
  request: NextRequest,
  endpoint: EndpointKey,
): Promise<{
  blocked: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
  limit: number;
  response?: NextResponse;
}> {
  const tier = resolveTier(request);
  const policy = endpointLimits[endpoint];
  const limit = policy[tier];
  const key = `${endpoint}:${resolveIdentifier(request)}`;

  const state = await consumeRateLimit({
    key,
    tier,
    endpoint,
    limit,
    windowMs: policy.windowMs,
  });

  if (!state.blocked) {
    return state;
  }

  const response = NextResponse.json(
    { error: "Too Many Requests", detail: "Rate limit exceeded for this endpoint." },
    { status: 429 },
  );
  response.headers.set("Retry-After", String(state.retryAfterSec));
  response.headers.set("X-RateLimit-Remaining", "0");
  response.headers.set("X-RateLimit-Limit", String(limit));
  response.headers.set("X-RateLimit-Reset", String(state.resetAt));
  return { ...state, response };
}

export function setRateLimitHeaders(
  response: NextResponse,
  state: {
    blocked: boolean;
    remaining: number;
    retryAfterSec: number;
    resetAt: number;
    limit: number;
  },
) {
  response.headers.set("X-RateLimit-Remaining", String(Math.max(0, state.remaining)));
  response.headers.set("X-RateLimit-Limit", String(state.limit));
  response.headers.set("X-RateLimit-Reset", String(state.resetAt));
  if (state.blocked) {
    response.headers.set("Retry-After", String(state.retryAfterSec));
  }
  return response;
}
