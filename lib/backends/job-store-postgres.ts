import { Pool, type PoolClient } from "pg";
import type {
  JobState,
  JobStatus,
  PaymentInstruction,
  BatchResult,
  BatchJobNetwork,
} from "../stellar/types";
import { escapeLikePattern } from "../history-filters";
import { getStoreConfig } from "../store-config";
import {
  IdempotencyConflictError,
  type BatchHistorySummary,
  type IdempotentJobResult,
  type JobQueryFilters,
  type WebhookDelivery,
  type WebhookDeliveryLog,
} from "../job-store-types";

export { IdempotencyConflictError } from "../job-store-types";

interface BatchJobArgs {
  payments: PaymentInstruction[];
  signedTransactions?: string[];
  network: BatchJobNetwork;
  publicKey: string;
}

interface IdempotencyRow {
  idempotencyKey: string;
  requestHash: string;
  jobId: string;
  responseBody: string;
  createdAt: string;
  expiresAt: string;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = Number(process.env.IDEMPOTENCY_REPLAY_STALE_MS ?? 30000);

let _pool: Pool | null = null;
let _schemaReady: Promise<void> | null = null;

function getPool(): Pool {
  const { databaseUrl } = getStoreConfig();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Postgres job store backend.");
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
        CREATE TABLE IF NOT EXISTS jobs (
          jobId            TEXT PRIMARY KEY,
          publicKey        TEXT,
          status           TEXT NOT NULL,
          totalBatches     INTEGER NOT NULL DEFAULT 0,
          completedBatches INTEGER NOT NULL DEFAULT 0,
          payments         TEXT NOT NULL,
          signedTransactions TEXT,
          network          TEXT NOT NULL,
          result           TEXT,
          error            TEXT,
          createdAt        TEXT NOT NULL,
          updatedAt        TEXT NOT NULL,
          version          INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_createdAt ON jobs (createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_publicKey_createdAt ON jobs (publicKey, createdAt DESC);

        CREATE TABLE IF NOT EXISTS idempotency_keys (
          idempotencyKey   TEXT PRIMARY KEY,
          requestHash      TEXT NOT NULL,
          jobId            TEXT NOT NULL,
          responseBody     TEXT NOT NULL,
          createdAt        TEXT NOT NULL,
          expiresAt        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiresAt ON idempotency_keys (expiresAt);

        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id           TEXT PRIMARY KEY,
          webhookId    TEXT NOT NULL,
          jobId        TEXT,
          event        TEXT NOT NULL,
          status       TEXT NOT NULL,
          responseCode INTEGER,
          retryCount   INTEGER NOT NULL DEFAULT 0,
          error        TEXT,
          deliveredAt  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhookId ON webhook_deliveries (webhookId);
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_jobId ON webhook_deliveries (jobId);

        CREATE TABLE IF NOT EXISTS webhooks (
          id               TEXT PRIMARY KEY,
          url              TEXT NOT NULL,
          events           TEXT NOT NULL,
          createdAt        TEXT NOT NULL,
          secretHash       TEXT NOT NULL,
          secretCiphertext TEXT NOT NULL
        );
      `);
    })();
  }
  await _schemaReady;
}

interface JobRow {
  jobId: string;
  publicKey: string | null;
  status: JobStatus;
  totalBatches: number;
  completedBatches: number;
  payments: string;
  signedTransactions: string | null;
  network: BatchJobNetwork;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

function rowToJobState(row: JobRow): JobState {
  return {
    jobId: row.jobId,
    publicKey: row.publicKey,
    status: row.status,
    totalBatches: row.totalBatches,
    completedBatches: row.completedBatches,
    payments: JSON.parse(row.payments) as PaymentInstruction[],
    signedTransactions: row.signedTransactions
      ? (JSON.parse(row.signedTransactions) as string[])
      : undefined,
    network: row.network,
    result: row.result ? (JSON.parse(row.result) as BatchResult) : undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function insertJob(client: PoolClient, args: BatchJobArgs & { jobId: string }): Promise<void> {
  const now = new Date().toISOString();
  await client.query(
    `
      INSERT INTO jobs (jobId, publicKey, status, totalBatches, completedBatches, payments, signedTransactions, network, createdAt, updatedAt, version)
      VALUES ($1, $2, 'queued', 0, 0, $3, $4, $5, $6, $7, 1)
    `,
    [
      args.jobId,
      args.publicKey,
      JSON.stringify(args.payments),
      args.signedTransactions ? JSON.stringify(args.signedTransactions) : null,
      args.network,
      now,
      now,
    ],
  );
}

async function pruneExpiredIdempotencyKeys(client: PoolClient, nowIso: string): Promise<void> {
  await client.query("DELETE FROM idempotency_keys WHERE expiresAt <= $1", [nowIso]);
}

const SORT_COLUMNS = new Set(["createdAt", "updatedAt", "status"]);

function buildJobQueryFilters(opts?: JobQueryFilters): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let paramIndex = 1;

  const push = (value: string | number): string => {
    params.push(value);
    return `$${paramIndex++}`;
  };

  if (opts?.status) {
    conditions.push(`status = ${push(opts.status)}`);
  }
  if (opts?.network) {
    conditions.push(`network = ${push(opts.network)}`);
  }
  if (opts?.publicKey) {
    conditions.push(`publicKey = ${push(opts.publicKey)}`);
  }
  if (opts?.from) {
    conditions.push(`createdAt >= ${push(opts.from)}`);
  }
  if (opts?.to) {
    conditions.push(`createdAt <= ${push(opts.to)}`);
  }
  if (opts?.search?.trim()) {
    const term = `%${escapeLikePattern(opts.search.trim())}%`;
    const p1 = push(term);
    const p2 = push(term);
    const p3 = push(term);
    conditions.push(
      `(jobId LIKE ${p1} ESCAPE '\\' OR COALESCE(result, '') LIKE ${p2} ESCAPE '\\' OR payments LIKE ${p3} ESCAPE '\\')`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

export async function createJob(
  payments: PaymentInstruction[],
  network: BatchJobNetwork,
  publicKey: string,
  signedTransactions?: string[],
): Promise<string> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();
  const jobId = crypto.randomUUID();

  try {
    await insertJob(client, { jobId, payments, network, publicKey, signedTransactions });
    return jobId;
  } finally {
    client.release();
  }
}

export async function createIdempotentJob<ResponseBody>(args: {
  idempotencyKey: string;
  requestHash: string;
  payments: PaymentInstruction[];
  network: BatchJobNetwork;
  publicKey: string;
  signedTransactions?: string[];
  buildResponseBody: (jobId: string) => ResponseBody;
}): Promise<IdempotentJobResult<ResponseBody>> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();

    await pruneExpiredIdempotencyKeys(client, now);

    const existingResult = await client.query<IdempotencyRow>(
      "SELECT * FROM idempotency_keys WHERE idempotencyKey = $1",
      [args.idempotencyKey],
    );
    const existing = existingResult.rows[0];

    if (existing) {
      if (existing.requestHash !== args.requestHash) {
        throw new IdempotencyConflictError();
      }

      await client.query("COMMIT");
      return {
        jobId: existing.jobId,
        responseBody: JSON.parse(existing.responseBody) as ResponseBody,
        replayed: true,
      };
    }

    const jobId = crypto.randomUUID();
    await insertJob(client, {
      jobId,
      payments: args.payments,
      network: args.network,
      publicKey: args.publicKey,
      signedTransactions: args.signedTransactions,
    });

    const responseBody = args.buildResponseBody(jobId);

    await client.query(
      `
        INSERT INTO idempotency_keys (idempotencyKey, requestHash, jobId, responseBody, createdAt, expiresAt)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        args.idempotencyKey,
        args.requestHash,
        jobId,
        JSON.stringify(responseBody),
        now,
        expiresAt,
      ],
    );

    await client.query("COMMIT");
    return { jobId, responseBody, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getJob(jobId: string, publicKey?: string): Promise<JobState | undefined> {
  await ensureSchema();
  const pool = getPool();
  const result = publicKey
    ? await pool.query<JobRow>("SELECT * FROM jobs WHERE jobId = $1 AND publicKey = $2", [
        jobId,
        publicKey,
      ])
    : await pool.query<JobRow>("SELECT * FROM jobs WHERE jobId = $1", [jobId]);
  const row = result.rows[0];
  return row ? rowToJobState(row) : undefined;
}

export async function incrementCompletedBatches(jobId: string): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const versionResult = await pool.query<{ version: number }>(
      "SELECT version FROM jobs WHERE jobId = $1",
      [jobId],
    );
    const row = versionResult.rows[0];
    if (!row) return;

    const now = new Date().toISOString();
    const updateResult = await pool.query(
      `
        UPDATE jobs SET
          completedBatches = completedBatches + 1,
          updatedAt = $1,
          version = version + 1
        WHERE jobId = $2 AND version = $3
      `,
      [now, jobId, row.version],
    );

    if (updateResult.rowCount && updateResult.rowCount > 0) return;

    if (attempt === maxAttempts - 1) {
      throw new Error(`incrementCompletedBatches: concurrent modification on job ${jobId}`);
    }
  }
}

export async function claimJobForProcessing(jobId: string): Promise<boolean> {
  await ensureSchema();
  const pool = getPool();
  const now = new Date();
  const nowIso = now.toISOString();
  const staleTimeIso = new Date(now.getTime() - LEASE_MS).toISOString();

  const result = await pool.query(
    `
      UPDATE jobs
      SET status = 'processing',
          updatedAt = $1,
          version = version + 1
      WHERE jobId = $2 AND (
        status = 'queued' OR
        (status = 'processing' AND updatedAt < $3)
      )
    `,
    [nowIso, jobId, staleTimeIso],
  );

  return Boolean(result.rowCount && result.rowCount > 0);
}

export async function updateJob(
  jobId: string,
  patch: Partial<Omit<JobState, "jobId" | "createdAt">>,
): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const rowResult = await client.query<JobRow>("SELECT * FROM jobs WHERE jobId = $1", [jobId]);
    const row = rowResult.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return;
    }

    const now = new Date().toISOString();
    const nextVersion = row.version + 1;
    const updateResult = await client.query(
      `
        UPDATE jobs SET
          status           = $1,
          totalBatches     = $2,
          completedBatches = $3,
          result           = $4,
          error            = $5,
          updatedAt        = $6,
          version          = $7
        WHERE jobId = $8 AND version = $9
      `,
      [
        patch.status ?? row.status,
        patch.totalBatches ?? row.totalBatches,
        patch.completedBatches ?? row.completedBatches,
        patch.result !== undefined ? JSON.stringify(patch.result) : row.result,
        patch.error ?? row.error,
        now,
        nextVersion,
        jobId,
        row.version,
      ],
    );

    if (!updateResult.rowCount) {
      throw new Error(`Concurrent modification error: job ${jobId} was updated by another process.`);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getAllJobs(
  opts?: JobQueryFilters & {
    limit?: number;
    offset?: number;
  },
): Promise<JobState[]> {
  await ensureSchema();
  const pool = getPool();
  const { where, params } = buildJobQueryFilters(opts);
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const sortColumn = opts?.sort && SORT_COLUMNS.has(opts.sort) ? opts.sort : "createdAt";
  const sortOrder = opts?.order === "asc" ? "ASC" : "DESC";
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const result = await pool.query<JobRow>(
    `SELECT * FROM jobs ${where} ORDER BY ${sortColumn} ${sortOrder} LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, limit, offset],
  );

  return result.rows.map(rowToJobState);
}

export async function countJobs(opts?: JobQueryFilters): Promise<number> {
  await ensureSchema();
  const pool = getPool();
  const { where, params } = buildJobQueryFilters(opts);
  const result = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text as cnt FROM jobs ${where}`,
    params,
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

export async function getBatchHistorySummary(opts?: JobQueryFilters): Promise<BatchHistorySummary> {
  await ensureSchema();
  const pool = getPool();
  const { where, params } = buildJobQueryFilters(opts);
  const result = await pool.query<{
    totalJobs: string | null;
    totalPayments: string | null;
    totalAmount: string | null;
    successfulPayments: string | null;
    failedPayments: string | null;
    failedJobs: string | null;
  }>(
    `
      SELECT
        COUNT(*)::text AS totalJobs,
        COALESCE(SUM(jsonb_array_length(payments::jsonb)), 0)::text AS totalPayments,
        COALESCE(SUM((result::jsonb ->> 'totalAmount')::double precision), 0)::text AS totalAmount,
        COALESCE(SUM((result::jsonb -> 'summary' ->> 'successful')::integer), 0)::text AS successfulPayments,
        COALESCE(SUM((result::jsonb -> 'summary' ->> 'failed')::integer), 0)::text AS failedPayments,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::text AS failedJobs
      FROM jobs
      ${where}
    `,
    params,
  );

  const row = result.rows[0];
  const totalJobs = Number(row?.totalJobs ?? 0);
  const totalPayments = Number(row?.totalPayments ?? 0);
  const totalAmount = Number(row?.totalAmount ?? 0);
  const successfulPayments = Number(row?.successfulPayments ?? 0);
  const failedPayments = Number(row?.failedPayments ?? 0);
  const failedJobs = Number(row?.failedJobs ?? 0);
  const totalProcessedPayments = successfulPayments + failedPayments;
  const successRate =
    totalProcessedPayments > 0
      ? `${((successfulPayments / totalProcessedPayments) * 100).toFixed(1)}%`
      : "0.0%";

  return {
    totalJobs,
    totalPayments,
    totalAmount,
    successfulPayments,
    failedPayments,
    failedJobs,
    successRate,
  };
}

export async function logWebhookDelivery(entry: WebhookDeliveryLog): Promise<void> {
  await ensureSchema();
  const pool = getPool();
  await pool.query(
    `
      INSERT INTO webhook_deliveries (id, webhookId, jobId, event, status, responseCode, retryCount, error, deliveredAt)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      crypto.randomUUID(),
      entry.webhookId,
      entry.jobId ?? null,
      entry.event,
      entry.status,
      entry.responseCode ?? null,
      entry.retryCount,
      entry.error ?? null,
      new Date().toISOString(),
    ],
  );
}

export async function getWebhookDeliveries(opts?: {
  jobId?: string;
  webhookId?: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  await ensureSchema();
  const pool = getPool();
  const limit = opts?.limit ?? 100;

  if (opts?.jobId) {
    const result = await pool.query<WebhookDelivery>(
      "SELECT * FROM webhook_deliveries WHERE jobId = $1 ORDER BY deliveredAt DESC LIMIT $2",
      [opts.jobId, limit],
    );
    return result.rows;
  }

  if (opts?.webhookId) {
    const result = await pool.query<WebhookDelivery>(
      "SELECT * FROM webhook_deliveries WHERE webhookId = $1 ORDER BY deliveredAt DESC LIMIT $2",
      [opts.webhookId, limit],
    );
    return result.rows;
  }

  const result = await pool.query<WebhookDelivery>(
    "SELECT * FROM webhook_deliveries ORDER BY deliveredAt DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}

export async function checkPostgresJobStoreHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureSchema();
    const pool = getPool();
    await pool.query("SELECT jobId FROM jobs LIMIT 1");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function resetPostgresJobStoreForTests(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _schemaReady = null;
  }
}
