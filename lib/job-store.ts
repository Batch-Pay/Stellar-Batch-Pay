/**
 * Durable job store with pluggable backends.
 *
 * - single-node: SQLite via better-sqlite3 (local filesystem)
 * - ha: Postgres via DATABASE_URL (shared across replicas)
 */

import { getStoreConfig } from "./store-config";
import * as sqlite from "./backends/job-store-sqlite";
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
  BatchHistorySummary,
  IdempotentJobResult,
  JobQueryFilters,
  WebhookDelivery,
  WebhookDeliveryLog,
} from "./job-store-types";
import type { JobState, PaymentInstruction, BatchJobNetwork } from "./stellar/types";

export {
  IdempotencyConflictError,
  type IdempotentJobResult,
  type JobQueryFilters,
  type BatchHistorySummary,
  type WebhookDeliveryLog,
  type WebhookDelivery,
} from "./job-store-types";

function usePostgres(): boolean {
  return getStoreConfig().jobStoreBackend === "postgres";
}

async function pg() {
  return import("./backends/job-store-postgres");
}

export function getDb() {
  if (usePostgres()) {
    throw new Error("getDb() is only available for the SQLite job store backend.");
  }
  return sqlite.getDb();
}

export async function createJob(
  payments: PaymentInstruction[],
  network: BatchJobNetwork,
  publicKey: string,
  signedTransactions?: string[],
): Promise<string> {
  if (usePostgres()) {
    return (await pg()).createJob(payments, network, publicKey, signedTransactions);
  }
  return sqlite.createJob(payments, network, publicKey, signedTransactions);
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
  if (usePostgres()) {
    return (await pg()).createIdempotentJob(args);
  }
  return sqlite.createIdempotentJob(args);
}

export async function getJob(jobId: string, publicKey?: string): Promise<JobState | undefined> {
  if (usePostgres()) {
    return (await pg()).getJob(jobId, publicKey);
  }
  return sqlite.getJob(jobId, publicKey);
}

export async function incrementCompletedBatches(jobId: string): Promise<void> {
  if (usePostgres()) {
    return (await pg()).incrementCompletedBatches(jobId);
  }
  return sqlite.incrementCompletedBatches(jobId);
}

export async function claimJobForProcessing(jobId: string): Promise<boolean> {
  if (usePostgres()) {
    return (await pg()).claimJobForProcessing(jobId);
  }
  return sqlite.claimJobForProcessing(jobId);
}

export async function updateJob(
  jobId: string,
  patch: Partial<Omit<JobState, "jobId" | "createdAt">>,
): Promise<void> {
  if (usePostgres()) {
    return (await pg()).updateJob(jobId, patch);
  }
  return sqlite.updateJob(jobId, patch);
}

export async function getAllJobs(
  opts?: JobQueryFilters & {
    limit?: number;
    offset?: number;
  },
): Promise<JobState[]> {
  if (usePostgres()) {
    return (await pg()).getAllJobs(opts);
  }
  return sqlite.getAllJobs(opts);
}

export async function countJobs(opts?: JobQueryFilters): Promise<number> {
  if (usePostgres()) {
    return (await pg()).countJobs(opts);
  }
  return sqlite.countJobs(opts);
}

export async function getBatchHistorySummary(opts?: JobQueryFilters): Promise<BatchHistorySummary> {
  if (usePostgres()) {
    return (await pg()).getBatchHistorySummary(opts);
  }
  return sqlite.getBatchHistorySummary(opts);
}

export async function logWebhookDelivery(entry: WebhookDeliveryLog): Promise<void> {
  if (usePostgres()) {
    return (await pg()).logWebhookDelivery(entry);
  }
  return sqlite.logWebhookDelivery(entry);
}

export async function getWebhookDeliveries(opts?: {
  jobId?: string;
  webhookId?: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  if (usePostgres()) {
    return (await pg()).getWebhookDeliveries(opts);
  }
  return sqlite.getWebhookDeliveries(opts);
}
