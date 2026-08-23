import type { JobState, JobStatus, BatchJobNetwork } from "./stellar/types";
import type { PaymentInstruction } from "./stellar/types";

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

export interface JobQueryFilters {
  status?: JobStatus;
  network?: BatchJobNetwork;
  publicKey?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: "createdAt" | "updatedAt" | "status";
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

export type {
  JobState,
  JobStatus,
  PaymentInstruction,
  BatchJobNetwork,
};
