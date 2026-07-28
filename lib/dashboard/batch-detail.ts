import type {
  BatchResult,
  PaymentResult,
  BatchJobNetwork,
} from "@/lib/stellar/types";

export interface BatchDetailRecipient {
  address: string;
  amount: string;
  asset: string;
  status: "pending" | "success" | "failed" | "unknown";
  transactionHash?: string;
  error?: string;
}

export interface BatchDetailView {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  network: BatchJobNetwork;
  createdAt?: string;
  completedAt?: string;
  totalBatches?: number;
  completedBatches?: number;
  summary?: {
    successful: number;
    failed: number;
  };
  recipients: BatchDetailRecipient[];
}

interface BatchStatusApiResponse {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  network: BatchJobNetwork;
  createdAt?: string;
  updatedAt?: string;
  totalBatches?: number;
  completedBatches?: number;
  result?: BatchResult;
}

function mapPaymentResult(result: PaymentResult): BatchDetailRecipient {
  return {
    address: result.recipient,
    amount: result.amount,
    asset: result.asset,
    status: result.status,
    transactionHash: result.transactionHash,
    error: result.error,
  };
}

/** Normalise GET /api/batch-status/:jobId into the dashboard detail view shape. */
export function mapBatchStatusToDetailView(body: BatchStatusApiResponse): BatchDetailView {
  return {
    jobId: body.jobId,
    status: body.status,
    network: body.network,
    createdAt: body.createdAt,
    completedAt: body.updatedAt,
    totalBatches: body.totalBatches,
    completedBatches: body.completedBatches,
    summary: body.result?.summary,
    recipients: (body.result?.results ?? []).map(mapPaymentResult),
  };
}
