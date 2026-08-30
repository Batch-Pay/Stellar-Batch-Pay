/**
 * Durable job store with pluggable backends.
 *
 * - single-node: SQLite via better-sqlite3 (local filesystem)
 * - ha: Postgres via DATABASE_URL (shared across replicas)
 */

import { getStoreConfig } from "./store-config";
import * as sqlite from "./backends/job-store-sqlite";
import type {
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

function isPostgresBackend(): boolean {
  return getStoreConfig().jobStoreBackend === "postgres";
}

async function pg() {
  return import("./backends/job-store-postgres");
}

export function getDb() {
  if (isPostgresBackend()) {
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
  if (isPostgresBackend()) {
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
  if (isPostgresBackend()) {
    return (await pg()).createIdempotentJob(args);
  }
  return sqlite.createIdempotentJob(args);
}

export async function getJob(jobId: string, publicKey?: string): Promise<JobState | undefined> {
  if (isPostgresBackend()) {
    return (await pg()).getJob(jobId, publicKey);
  }
  return sqlite.getJob(jobId, publicKey);
}

export async function incrementCompletedBatches(jobId: string): Promise<void> {
  if (isPostgresBackend()) {
    return (await pg()).incrementCompletedBatches(jobId);
  }
  return sqlite.incrementCompletedBatches(jobId);
}

export async function claimJobForProcessing(jobId: string): Promise<boolean> {
  if (isPostgresBackend()) {
    return (await pg()).claimJobForProcessing(jobId);
  }
  return sqlite.claimJobForProcessing(jobId);
}

export async function updateJob(
  jobId: string,
  patch: Partial<Omit<JobState, "jobId" | "createdAt">>,
): Promise<void> {
  if (isPostgresBackend()) {
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
  if (isPostgresBackend()) {
    return (await pg()).getAllJobs(opts);
  }
  return sqlite.getAllJobs(opts);
}

export async function countJobs(opts?: JobQueryFilters): Promise<number> {
  if (isPostgresBackend()) {
    return (await pg()).countJobs(opts);
  }
  return sqlite.countJobs(opts);
}

export async function getBatchHistorySummary(opts?: JobQueryFilters): Promise<BatchHistorySummary> {
  if (isPostgresBackend()) {
    return (await pg()).getBatchHistorySummary(opts);
  }
  return sqlite.getBatchHistorySummary(opts);
}

export async function logWebhookDelivery(entry: WebhookDeliveryLog): Promise<void> {
  if (isPostgresBackend()) {
    return (await pg()).logWebhookDelivery(entry);
  }
  return sqlite.logWebhookDelivery(entry);
}

export async function getWebhookDeliveries(opts?: {
  jobId?: string;
  webhookId?: string;
  limit?: number;
}): Promise<WebhookDelivery[]> {
  if (isPostgresBackend()) {
    return (await pg()).getWebhookDeliveries(opts);
  }
  return sqlite.getWebhookDeliveries(opts);
}
