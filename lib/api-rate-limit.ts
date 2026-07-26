import { NextRequest, NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";

type Tier = "free" | "pro" | "enterprise";
type EndpointKey = "batch-build" | "batch-submit" | "batch-submit-signed" | "webhook-register" | "tx-status" | "dashboard-metrics" | "batch-status" | "batch-events" | "health";

type EndpointLimit = {
  free: number;
  pro: number;
  enterprise: number;
  windowMs: number;
};

type RateBucketRow = {
  key: string;
  tier: Tier;
  endpoint: EndpointKey;
  remaining: number;
  limit: number;
  resetAt: number;
  windowMs: number;
  updatedAt: string;
};

const RATE_LIMIT_DB_PATH = process.env.RATE_LIMIT_DB_PATH ?? path.join(process.cwd(), "data", "rate-limit.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const { mkdirSync } = require("fs") as typeof import("fs");
  mkdirSync(path.dirname(RATE_LIMIT_DB_PATH), { recursive: true });

  _db = new Database(RATE_LIMIT_DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS rate_buckets (
      key TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      remaining INTEGER NOT NULL,
      "limit" INTEGER NOT NULL,
      resetAt INTEGER NOT NULL,
      windowMs INTEGER NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  return _db;
}

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
  "health": { free: 30, pro: 100, enterprise: 300, windowMs: 60_000 },
};

const endpointLimits: Record<EndpointKey, EndpointLimit> = {
  "batch-build": tunedLimit("batch-build", DEFAULT_LIMITS["batch-build"]),
  "batch-submit": tunedLimit("batch-submit", DEFAULT_LIMITS["batch-submit"]),
  "batch-submit-signed": tunedLimit(
    "batch-submit-signed",
    DEFAULT_LIMITS["batch-submit-signed"],
  ),
  "webhook-register": tunedLimit(
    "webhook-register",
    DEFAULT_LIMITS["webhook-register"],
  ),
  "tx-status": tunedLimit("tx-status", DEFAULT_LIMITS["tx-status"]),
  "dashboard-metrics": tunedLimit("dashboard-metrics", DEFAULT_LIMITS["dashboard-metrics"]),
  "batch-status": tunedLimit("batch-status", DEFAULT_LIMITS["batch-status"]),
  "batch-events": tunedLimit("batch-events", DEFAULT_LIMITS["batch-events"]),
  "health": tunedLimit("health", DEFAULT_LIMITS["health"]),
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

export function applyRateLimit(request: NextRequest, endpoint: EndpointKey): {
  blocked: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
  limit: number;
  response?: NextResponse;
} {
  const tier = resolveTier(request);
  const policy = endpointLimits[endpoint];
  const limit = policy[tier];
  const now = Date.now();
  const key = `${endpoint}:${resolveIdentifier(request)}`;

  const db = getDb();

  // Wrap new-window initialization in a transaction so concurrent requests at
  // window expiry can't both observe the expired row and each reset the counter.
  const initResult = db.transaction(() => {
    const row = db.prepare("SELECT * FROM rate_buckets WHERE key = ?").get(key) as RateBucketRow | undefined;
    if (!row || now >= row.resetAt) {
      const resetAtMs = now + policy.windowMs;
      const remaining = limit - 1;
      db.prepare(`
        INSERT OR REPLACE INTO rate_buckets
        (key, tier, endpoint, remaining, "limit", resetAt, windowMs, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(key, tier, endpoint, remaining, limit, resetAtMs, policy.windowMs, new Date().toISOString());
      return { newWindow: true, resetAtMs, remaining };
    }
    return { newWindow: false, row };
  })();

  if (initResult.newWindow) {
    const { resetAtMs, remaining } = initResult as { newWindow: true; resetAtMs: number; remaining: number };
    return {
      blocked: false,
      remaining: Math.max(0, remaining),
      retryAfterSec: Math.ceil(policy.windowMs / 1000),
      resetAt: Math.ceil(resetAtMs / 1000),
      limit,
    };
  }

  const row = (initResult as { newWindow: false; row: RateBucketRow }).row;

  if (row.remaining <= 0) {
    const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
    const resetAtSec = Math.ceil(row.resetAt / 1000);
    const response = NextResponse.json(
      { error: "Too Many Requests", detail: "Rate limit exceeded for this endpoint." },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(retryAfterSec));
    response.headers.set("X-RateLimit-Remaining", "0");
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Reset", String(resetAtSec));
    return { blocked: true, remaining: 0, retryAfterSec, resetAt: resetAtSec, limit, response };
  }

  // Atomic decrement: only decrements when remaining > 0, preventing races under concurrency
  const updateResult = db.prepare(`
    UPDATE rate_buckets SET remaining = remaining - 1, updatedAt = ? WHERE key = ? AND remaining > 0
  `).run(new Date().toISOString(), key);

  if (updateResult.changes === 0) {
    // Another concurrent request consumed the last token between our SELECT and UPDATE
    const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
    const resetAtSec = Math.ceil(row.resetAt / 1000);
    const response = NextResponse.json(
      { error: "Too Many Requests", detail: "Rate limit exceeded for this endpoint." },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(retryAfterSec));
    response.headers.set("X-RateLimit-Remaining", "0");
    response.headers.set("X-RateLimit-Limit", String(limit));
    response.headers.set("X-RateLimit-Reset", String(resetAtSec));
    return { blocked: true, remaining: 0, retryAfterSec, resetAt: resetAtSec, limit, response };
  }

  const newRemaining = row.remaining - 1;
  const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
  const resetAtSec = Math.ceil(row.resetAt / 1000);
  return {
    blocked: false,
    remaining: newRemaining,
    retryAfterSec,
    resetAt: resetAtSec,
    limit,
  };
}

export function setRateLimitHeaders(response: NextResponse, state: {
  blocked: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
  limit: number;
}) {
  response.headers.set("X-RateLimit-Remaining", String(Math.max(0, state.remaining)));
  response.headers.set("X-RateLimit-Limit", String(state.limit));
  response.headers.set("X-RateLimit-Reset", String(state.resetAt));
  if (state.blocked) {
    response.headers.set("Retry-After", String(state.retryAfterSec));
  }
  return response;
}

