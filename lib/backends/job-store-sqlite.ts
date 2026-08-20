import Database from "better-sqlite3";
import path from "path";
import type {
  JobState,
  JobStatus,
  PaymentInstruction,
  BatchResult,
  BatchJobNetwork,
} from "../stellar/types";
import { escapeLikePattern } from "../history-filters";
import { resolveJobStorePath } from "../store-config";
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

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getSqliteDbPath(): string {
  return resolveJobStorePath();
}

export function getDb(): Database.Database {
  const dbPath = getSqliteDbPath();
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
  `);

  const columns = _db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "publicKey")) {
    _db.exec("ALTER TABLE jobs ADD COLUMN publicKey TEXT");
  }
  if (!columns.some((column) => column.name === "version")) {
    _db.exec("ALTER TABLE jobs ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.some((column) => column.name === "signedTransactions")) {
    _db.exec("ALTER TABLE jobs ADD COLUMN signedTransactions TEXT");
  }
  _db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_publicKey_createdAt ON jobs (publicKey, createdAt DESC)");

  return _db;
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

function insertJob(db: Database.Database, args: BatchJobArgs & { jobId: string }): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO jobs (jobId, publicKey, status, totalBatches, completedBatches, payments, signedTransactions, network, createdAt, updatedAt, version)
    VALUES (?, ?, 'queued', 0, 0, ?, ?, ?, ?, ?, 1)
  `).run(
    args.jobId,
    args.publicKey,
    JSON.stringify(args.payments),
    args.signedTransactions ? JSON.stringify(args.signedTransactions) : null,
    args.network,
    now,
    now,
  );
}

function pruneExpiredIdempotencyKeys(db: Database.Database, nowIso: string): void {
  db.prepare("DELETE FROM idempotency_keys WHERE expiresAt <= ?").run(nowIso);
}

const SORT_COLUMNS = new Set(["createdAt", "updatedAt", "status"]);

function buildJobQueryFilters(opts?: JobQueryFilters): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.status) {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts?.network) {
    conditions.push("network = ?");
    params.push(opts.network);
  }
  if (opts?.publicKey) {
    conditions.push("publicKey = ?");
    params.push(opts.publicKey);
  }
  if (opts?.from) {
    conditions.push("createdAt >= ?");
    params.push(opts.from);
  }
  if (opts?.to) {
    conditions.push("createdAt <= ?");
    params.push(opts.to);
  }
  if (opts?.search?.trim()) {
    const term = `%${escapeLikePattern(opts.search.trim())}%`;
    conditions.push(
      "(jobId LIKE ? ESCAPE '\\' OR COALESCE(result, '') LIKE ? ESCAPE '\\' OR payments LIKE ? ESCAPE '\\')",
    );
    params.push(term, term, term);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

export function createJob(
  payments: PaymentInstruction[],
  network: BatchJobNetwork,
  publicKey: string,
  signedTransactions?: string[],
): string {
  const db = getDb();
  const jobId = crypto.randomUUID();
  insertJob(db, { jobId, payments, network, publicKey, signedTransactions });
  return jobId;
}

export function createIdempotentJob<ResponseBody>(args: {
  idempotencyKey: string;
  requestHash: string;
  payments: PaymentInstruction[];
  network: BatchJobNetwork;
  publicKey: string;
  signedTransactions?: string[];
  buildResponseBody: (jobId: string) => ResponseBody;
}): IdempotentJobResult<ResponseBody> {
  const db = getDb();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS).toISOString();

  const run = db.transaction(() => {
    pruneExpiredIdempotencyKeys(db, now);

    const existing = db
      .prepare("SELECT * FROM idempotency_keys WHERE idempotencyKey = ?")
      .get(args.idempotencyKey) as IdempotencyRow | undefined;

    if (existing) {
      if (existing.requestHash !== args.requestHash) {
        throw new IdempotencyConflictError();
      }

      return {
        jobId: existing.jobId,
        responseBody: JSON.parse(existing.responseBody) as ResponseBody,
        replayed: true,
      } satisfies IdempotentJobResult<ResponseBody>;
    }

    const jobId = crypto.randomUUID();
    insertJob(db, {
      jobId,
      payments: args.payments,
      network: args.network,
      publicKey: args.publicKey,
      signedTransactions: args.signedTransactions,
    });

    const responseBody = args.buildResponseBody(jobId);

    db.prepare(`
      INSERT INTO idempotency_keys (idempotencyKey, requestHash, jobId, responseBody, createdAt, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      args.idempotencyKey,
      args.requestHash,
      jobId,
      JSON.stringify(responseBody),
      now,
      expiresAt,
    );

    return {
      jobId,
      responseBody,
      replayed: false,
    } satisfies IdempotentJobResult<ResponseBody>;
  });

  return run();
}

export function getJob(jobId: string, publicKey?: string): JobState | undefined {
  const db = getDb();
  const row = publicKey
    ? (db.prepare("SELECT * FROM jobs WHERE jobId = ? AND publicKey = ?").get(jobId, publicKey) as
        | JobRow
        | undefined)
    : (db.prepare("SELECT * FROM jobs WHERE jobId = ?").get(jobId) as JobRow | undefined);
  return row ? rowToJobState(row) : undefined;
}

export function incrementCompletedBatches(jobId: string): void {
  const db = getDb();
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const row = db.prepare("SELECT version FROM jobs WHERE jobId = ?").get(jobId) as
      | { version: number }
      | undefined;
    if (!row) return;

    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE jobs SET
        completedBatches = completedBatches + 1,
        updatedAt = ?,
        version = version + 1
      WHERE jobId = ? AND version = ?
    `).run(now, jobId, row.version);

    if (result.changes > 0) return;

    if (attempt === maxAttempts - 1) {
      throw new Error(`incrementCompletedBatches: concurrent modification on job ${jobId}`);
    }
  }
}

export function claimJobForProcessing(jobId: string): boolean {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const staleTimeIso = new Date(now.getTime() - LEASE_MS).toISOString();

  const result = db.prepare(`
    UPDATE jobs
    SET status = 'processing',
        updatedAt = ?,
        version = version + 1
    WHERE jobId = ? AND (
      status = 'queued' OR
      (status = 'processing' AND updatedAt < ?)
    )
  `).run(nowIso, jobId, staleTimeIso);

  return result.changes > 0;
}

export function updateJob(
  jobId: string,
  patch: Partial<Omit<JobState, "jobId" | "createdAt">>,
): void {
  const db = getDb();
  let attempts = 0;
  const maxAttempts = 2;

  while (attempts < maxAttempts) {
    try {
      const run = db.transaction(() => {
        const row = db.prepare("SELECT * FROM jobs WHERE jobId = ?").get(jobId) as
          | JobRow
          | undefined;
        if (!row) return;

        const now = new Date().toISOString();
        const nextVersion = row.version + 1;

        const result = db.prepare(
          `
          UPDATE jobs SET
            status           = ?,
            totalBatches     = ?,
            completedBatches = ?,
            result           = ?,
            error            = ?,
            updatedAt        = ?,
            version          = ?
          WHERE jobId = ? AND version = ?
        `,
        ).run(
          patch.status ?? row.status,
          patch.totalBatches ?? row.totalBatches,
          patch.completedBatches ?? row.completedBatches,
          patch.result !== undefined ? JSON.stringify(patch.result) : row.result,
          patch.error ?? row.error,
          now,
          nextVersion,
          jobId,
          row.version,
        );

        if (result.changes === 0) {
          throw new Error(`Concurrent modification error: job ${jobId} was updated by another process.`);
        }
      });

      run();
      return;
    } catch (error: unknown) {
      attempts++;

      const err = error as { code?: string; message?: string };
      const isSqliteBusy =
        err.code === "SQLITE_BUSY" ||
        (typeof err.message === "string" && err.message.includes("SQLITE_BUSY"));

      if (!isSqliteBusy || attempts >= maxAttempts) {
        throw error;
      }

      const jitter = Math.random() * 100;
      const waitMs = 100 + jitter;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export function getAllJobs(
  opts?: JobQueryFilters & {
    limit?: number;
    offset?: number;
  },
): JobState[] {
  const db = getDb();
  const { where, params } = buildJobQueryFilters(opts);
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const sortColumn = opts?.sort && SORT_COLUMNS.has(opts.sort) ? opts.sort : "createdAt";
  const sortOrder = opts?.order === "asc" ? "ASC" : "DESC";

  const rows = db
    .prepare(
      `SELECT * FROM jobs ${where} ORDER BY ${sortColumn} ${sortOrder} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as JobRow[];

  return rows.map(rowToJobState);
}

export function countJobs(opts?: JobQueryFilters): number {
  const db = getDb();
  const { where, params } = buildJobQueryFilters(opts);
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM jobs ${where}`).get(...params) as {
    cnt: number;
  };
  return row.cnt;
}

export function getBatchHistorySummary(opts?: JobQueryFilters): BatchHistorySummary {
  const db = getDb();
  const { where, params } = buildJobQueryFilters(opts);
  const row = db
    .prepare(`
      SELECT
        COUNT(*) AS totalJobs,
        COALESCE(SUM(json_array_length(payments)), 0) AS totalPayments,
        COALESCE(SUM(CAST(json_extract(result, '$.totalAmount') AS REAL)), 0) AS totalAmount,
        COALESCE(SUM(CAST(json_extract(result, '$.summary.successful') AS INTEGER)), 0) AS successfulPayments,
        COALESCE(SUM(CAST(json_extract(result, '$.summary.failed') AS INTEGER)), 0) AS failedPayments,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failedJobs
      FROM jobs
      ${where}
    `)
    .get(...params) as {
    totalJobs: number | null;
    totalPayments: number | null;
    totalAmount: number | null;
    successfulPayments: number | null;
    failedPayments: number | null;
    failedJobs: number | null;
  };

  const totalJobs = row.totalJobs ?? 0;
  const totalPayments = row.totalPayments ?? 0;
  const totalAmount = row.totalAmount ?? 0;
  const successfulPayments = row.successfulPayments ?? 0;
  const failedPayments = row.failedPayments ?? 0;
  const failedJobs = row.failedJobs ?? 0;
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

export function logWebhookDelivery(entry: WebhookDeliveryLog): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhookId, jobId, event, status, responseCode, retryCount, error, deliveredAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    entry.webhookId,
    entry.jobId ?? null,
    entry.event,
    entry.status,
    entry.responseCode ?? null,
    entry.retryCount,
    entry.error ?? null,
    new Date().toISOString(),
  );
}

export function getWebhookDeliveries(opts?: {
  jobId?: string;
  webhookId?: string;
  limit?: number;
}): WebhookDelivery[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;

  if (opts?.jobId) {
    return db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE jobId = ? ORDER BY deliveredAt DESC LIMIT ?",
      )
      .all(opts.jobId, limit) as WebhookDelivery[];
  }

  if (opts?.webhookId) {
    return db
      .prepare(
        "SELECT * FROM webhook_deliveries WHERE webhookId = ? ORDER BY deliveredAt DESC LIMIT ?",
      )
      .all(opts.webhookId, limit) as WebhookDelivery[];
  }

  return db
    .prepare("SELECT * FROM webhook_deliveries ORDER BY deliveredAt DESC LIMIT ?")
    .all(limit) as WebhookDelivery[];
}

export function checkSqliteJobStoreHealth(): { ok: boolean; error?: string } {
  try {
    const db = getDb();
    db.prepare("SELECT 1").get();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function resetSqliteJobStoreForTests(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}
