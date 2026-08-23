import Database from "better-sqlite3";
import path from "path";
import { resolveRateLimitDbPath } from "../store-config";

export type Tier = "free" | "pro" | "enterprise";
export type EndpointKey =
  | "batch-build"
  | "batch-submit"
  | "batch-submit-signed"
  | "webhook-register"
  | "tx-status"
  | "dashboard-metrics"
  | "batch-status"
  | "batch-events"
  | "batch-retry"
  | "batch-recover"
  | "batch-history"
  | "webhook-deliveries"
  | "health";

export type EndpointLimit = {
  free: number;
  pro: number;
  enterprise: number;
  windowMs: number;
};

export type RateLimitState = {
  blocked: boolean;
  remaining: number;
  retryAfterSec: number;
  resetAt: number;
  limit: number;
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

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getSqliteRateLimitDbPath(): string {
  return resolveRateLimitDbPath();
}

function getDb(): Database.Database {
  const dbPath = getSqliteRateLimitDbPath();
  if (_db && _dbPath === dbPath) return _db;

  const { mkdirSync } = require("fs") as typeof import("fs");
  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  _db = new Database(dbPath);
  _dbPath = dbPath;

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

export function consumeRateLimit(args: {
  key: string;
  tier: Tier;
  endpoint: EndpointKey;
  limit: number;
  windowMs: number;
}): RateLimitState {
  const db = getDb();
  const now = Date.now();

  const initResult = db.transaction(() => {
    const row = db.prepare("SELECT * FROM rate_buckets WHERE key = ?").get(args.key) as
      | RateBucketRow
      | undefined;
    if (!row || now >= row.resetAt) {
      const resetAtMs = now + args.windowMs;
      const remaining = args.limit - 1;
      db.prepare(`
        INSERT OR REPLACE INTO rate_buckets
        (key, tier, endpoint, remaining, "limit", resetAt, windowMs, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.key,
        args.tier,
        args.endpoint,
        remaining,
        args.limit,
        resetAtMs,
        args.windowMs,
        new Date().toISOString(),
      );
      return { newWindow: true as const, resetAtMs, remaining };
    }
    return { newWindow: false as const, row };
  })();

  if (initResult.newWindow) {
    const { resetAtMs, remaining } = initResult;
    return {
      blocked: false,
      remaining: Math.max(0, remaining),
      retryAfterSec: Math.ceil(args.windowMs / 1000),
      resetAt: Math.ceil(resetAtMs / 1000),
      limit: args.limit,
    };
  }

  const row = initResult.row;

  if (row.remaining <= 0) {
    const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
    return {
      blocked: true,
      remaining: 0,
      retryAfterSec,
      resetAt: Math.ceil(row.resetAt / 1000),
      limit: args.limit,
    };
  }

  const updateResult = db.prepare(`
    UPDATE rate_buckets SET remaining = remaining - 1, updatedAt = ? WHERE key = ? AND remaining > 0
  `).run(new Date().toISOString(), args.key);

  if (updateResult.changes === 0) {
    const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
    return {
      blocked: true,
      remaining: 0,
      retryAfterSec,
      resetAt: Math.ceil(row.resetAt / 1000),
      limit: args.limit,
    };
  }

  const newRemaining = row.remaining - 1;
  const retryAfterSec = Math.max(1, Math.ceil((row.resetAt - now) / 1000));
  return {
    blocked: false,
    remaining: newRemaining,
    retryAfterSec,
    resetAt: Math.ceil(row.resetAt / 1000),
    limit: args.limit,
  };
}

export function checkSqliteRateLimitHealth(): { ok: boolean; error?: string } {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function resetSqliteRateLimitForTests(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}
