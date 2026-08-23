/**
 * Durable job store backed by SQLite (better-sqlite3).
 *
 * Replaces the previous in-memory Map so that batch progress survives server
 * restarts and serverless cold-starts that recycle the execution context.
 *
 * Schema
 * ──────
 * jobs
 *   jobId       TEXT PRIMARY KEY
 *   publicKey   TEXT            -- Stellar wallet that owns the job
 *   status      TEXT NOT NULL
 *   totalBatches    INTEGER NOT NULL DEFAULT 0
 *   completedBatches INTEGER NOT NULL DEFAULT 0
 *   payments    TEXT NOT NULL   -- JSON-serialised PaymentInstruction[]
 *   network     TEXT NOT NULL
 *   result      TEXT            -- JSON-serialised BatchResult | NULL
 *   error       TEXT
 *   createdAt   TEXT NOT NULL
 *   updatedAt   TEXT NOT NULL
 *
 * Indexes on jobId (implicit via PRIMARY KEY) and createdAt for history queries.
 */

import Database from "better-sqlite3";
import path from "path";
import type {
  JobState,
  JobStatus,
  PaymentInstruction,
  BatchResult,
  BatchJobNetwork,
} from "./stellar/types";
import { escapeLikePattern } from "./history-filters";

export interface IdempotentJobResult<ResponseBody> {
  jobId: string;
  responseBody: ResponseBody;
  replayed: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key already exists for a different request body");
    this.name = "IdempotencyConflictError";
  }
}

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

// ---------------------------------------------------------------------------
// DB initialisation
// ---------------------------------------------------------------------------

const DB_PATH =
  process.env.JOB_STORE_PATH ?? path.join(process.cwd(), "data", "jobs.db");

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure the data directory exists at runtime
  const { mkdirSync } = require("fs") as typeof import("fs");
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);

  // WAL mode for better concurrent read performance
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

    -- Index for history queries ordered by creation time
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

    CREATE TABLE IF NOT EXISTS webhooks (
      id               TEXT PRIMARY KEY,
      url              TEXT NOT NULL,
      events           TEXT NOT NULL,
      createdAt        TEXT NOT NULL,
      secretHash       TEXT NOT NULL,
      secretCiphertext TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhooks_createdAt ON webhooks (createdAt DESC);
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

// ---------------------------------------------------------------------------
// Row ↔ JobState helpers
// ---------------------------------------------------------------------------

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
    signedTransactions: row.signedTransactions ? (JSON.parse(row.signedTransactions) as string[]) : undefined,
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

// ---------------------------------------------------------------------------
// Public API  (same surface as the old in-memory store)
// ---------------------------------------------------------------------------

/**
 * Create a new job and return its ID.
 * #300: Supports both payment-based (server-side signed) and pre-signed transaction modes.
 * #337: Persists signedTransactions in the database for recovery after restart.
 */
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

/**
 * Retrieve a job by ID. Returns undefined if not found.
 */
export function getJob(jobId: string, publicKey?: string): JobState | undefined {
  const db = getDb();
  const row = publicKey
    ? db.prepare("SELECT * FROM jobs WHERE jobId = ? AND publicKey = ?").get(jobId, publicKey) as JobRow | undefined
    : db.prepare("SELECT * FROM jobs WHERE jobId = ?").get(jobId) as JobRow | undefined;
  return row ? rowToJobState(row) : undefined;
}

/**
 * Atomic DB-side increment for completedBatches using optimistic version locking,
 * consistent with updateJob. Retries up to 3 times on concurrent modification.
 */
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

    // Version changed under us — retry unless last attempt
    if (attempt === maxAttempts - 1) {
      throw new Error(`incrementCompletedBatches: concurrent modification on job ${jobId}`);
    }
  }
}

const LEASE_MS = Number(process.env.IDEMPOTENCY_REPLAY_STALE_MS ?? 30000);

/**
 * Atomically claim a job for processing.
 * Transitions a job from 'queued' to 'processing', or reclaims a stranded job
 * whose status is 'processing' but updatedAt is older than the lease duration.
 * Returns true if the claim was successful, false otherwise.
 */
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

/**
 * Partially update a job's state.
 */
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
    } catch (error: any) {
      attempts++;
      
      // Check if it's an SQLITE_BUSY error
      const isSqliteBusy = 
        error.code === "SQLITE_BUSY" || 
        (typeof error.message === "string" && error.message.includes("SQLITE_BUSY"));
      
      if (!isSqliteBusy || attempts >= maxAttempts) {
        throw error;
      }
      
      // Wait with jitter before retrying
      const jitter = Math.random() * 100;
      const waitMs = 100 + jitter;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

export interface JobQueryFilters {
  status?: JobStatus;
  network?: BatchJobNetwork;
  publicKey?: string;
  /** Case-insensitive substring match on jobId, payments JSON, or result JSON. */
  search?: string;
  /** ISO timestamp — include jobs with createdAt >= from. */
  from?: string;
  /** ISO timestamp — include jobs with createdAt <= to. */
  to?: string;
  /** Column to sort by (whitelisted: createdAt, updatedAt, status). Default: createdAt. */
  sort?: "createdAt" | "updatedAt" | "status";
  /** Sort direction. Default: desc. */
  order?: "asc" | "desc";
}

export interface BatchHistorySummary {
  totalJobs: number;
  totalPayments: number;
  totalAmount: number;
  successfulPayments: number;
  failedPayments: number;
  failedJobs: number;
  successRate: string;
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

/**
 * Return all jobs ordered by creation time descending (newest first).
 * Accepts optional filters for the batch history endpoint.
 * Supports sort and order params with whitelist validation (#606).
 */
export function getAllJobs(opts?: JobQueryFilters & {
  limit?: number;
  offset?: number;
}): JobState[] {
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



/**
 * Return the total count of jobs (optionally filtered).
 */
export function countJobs(opts?: JobQueryFilters): number {
  const db = getDb();
  const { where, params } = buildJobQueryFilters(opts);
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM jobs ${where}`)
    .get(...params) as { cnt: number };
  return row.cnt;
}

/**
 * Return aggregate history metrics for the current filter set.
 * Uses SQL-level aggregation so callers don't need to load all pages.
 */
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

// ---------------------------------------------------------------------------
// Webhook delivery log
// ---------------------------------------------------------------------------

export interface WebhookDeliveryLog {
  webhookId: string;
  jobId?: string;
  event: string;
  status: "success" | "failed";
  responseCode?: number;
  retryCount: number;
  error?: string;
}

export interface WebhookDelivery extends WebhookDeliveryLog {
  id: string;
  deliveredAt: string;
}

/**
 * Record the outcome of a single webhook delivery attempt.
 * Called synchronously from triggerWebhooksWithRetry — uses better-sqlite3's
 * sync API so no await is required at the call site.
 */
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

/**
 * Retrieve webhook delivery records, optionally filtered by jobId or webhookId.
 * Returns newest-first, capped at `limit` rows (default 100).
 */
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
    .prepare(
      "SELECT * FROM webhook_deliveries ORDER BY deliveredAt DESC LIMIT ?",
    )
    .all(limit) as WebhookDelivery[];
}
