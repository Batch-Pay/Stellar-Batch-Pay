import { Pool } from "pg";
import { getStoreConfig } from "../store-config";
import type { EndpointKey, RateLimitState, Tier } from "./rate-limit-sqlite";

let _pool: Pool | null = null;
let _schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  const { databaseUrl } = getStoreConfig();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Postgres rate limit backend.");
  }
  if (!_pool) {
    _pool = new Pool({ connectionString: databaseUrl });
  }
  return _pool;
}

async function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = (async () => {
      const pool = getPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rate_buckets (
          key TEXT PRIMARY KEY,
          tier TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          remaining INTEGER NOT NULL,
          "limit" INTEGER NOT NULL,
          resetAt BIGINT NOT NULL,
          windowMs INTEGER NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `);
    })();
  }
  await _schemaReady;
}

export async function consumeRateLimit(args: {
  key: string;
  tier: Tier;
  endpoint: EndpointKey;
  limit: number;
  windowMs: number;
}): Promise<RateLimitState> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  const now = Date.now();

  try {
    await client.query("BEGIN");

    const existing = await client.query<{
      remaining: number;
      resetAt: string;
      limit: number;
    }>("SELECT remaining, resetAt, \"limit\" FROM rate_buckets WHERE key = $1 FOR UPDATE", [
      args.key,
    ]);

    const row = existing.rows[0];
    if (!row || now >= Number(row.resetAt)) {
      const resetAtMs = now + args.windowMs;
      const remaining = args.limit - 1;
      await client.query(
        `
          INSERT INTO rate_buckets (key, tier, endpoint, remaining, "limit", resetAt, windowMs, updatedAt)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (key) DO UPDATE SET
            tier = EXCLUDED.tier,
            endpoint = EXCLUDED.endpoint,
            remaining = EXCLUDED.remaining,
            "limit" = EXCLUDED."limit",
            resetAt = EXCLUDED.resetAt,
            windowMs = EXCLUDED.windowMs,
            updatedAt = EXCLUDED.updatedAt
        `,
        [
          args.key,
          args.tier,
          args.endpoint,
          remaining,
          args.limit,
          resetAtMs,
          args.windowMs,
          new Date().toISOString(),
        ],
      );
      await client.query("COMMIT");
      return {
        blocked: false,
        remaining: Math.max(0, remaining),
        retryAfterSec: Math.ceil(args.windowMs / 1000),
        resetAt: Math.ceil(resetAtMs / 1000),
        limit: args.limit,
      };
    }

    if (row.remaining <= 0) {
      await client.query("COMMIT");
      const retryAfterSec = Math.max(1, Math.ceil((Number(row.resetAt) - now) / 1000));
      return {
        blocked: true,
        remaining: 0,
        retryAfterSec,
        resetAt: Math.ceil(Number(row.resetAt) / 1000),
        limit: args.limit,
      };
    }

    const updateResult = await client.query(
      `UPDATE rate_buckets SET remaining = remaining - 1, updatedAt = $1 WHERE key = $2 AND remaining > 0`,
      [new Date().toISOString(), args.key],
    );

    await client.query("COMMIT");

    if (!updateResult.rowCount) {
      const retryAfterSec = Math.max(1, Math.ceil((Number(row.resetAt) - now) / 1000));
      return {
        blocked: true,
        remaining: 0,
        retryAfterSec,
        resetAt: Math.ceil(Number(row.resetAt) / 1000),
        limit: args.limit,
      };
    }

    const newRemaining = row.remaining - 1;
    const retryAfterSec = Math.max(1, Math.ceil((Number(row.resetAt) - now) / 1000));
    return {
      blocked: false,
      remaining: newRemaining,
      retryAfterSec,
      resetAt: Math.ceil(Number(row.resetAt) / 1000),
      limit: args.limit,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function checkPostgresRateLimitHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureSchema();
    const pool = getPool();
    await pool.query("SELECT key FROM rate_buckets LIMIT 1");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function resetPostgresRateLimitForTests(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _schemaReady = null;
  }
}
