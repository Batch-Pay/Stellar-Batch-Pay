export interface HistoricalBatch {
  jobId: string
  createdAt: string
  network: "testnet" | "mainnet"
  totalPayments: number
  totalAmount: string | null
  completedBatches: number
  totalBatches: number
  status: "queued" | "processing" | "completed" | "failed"
  summary: { successful: number; failed: number } | null
}

export interface BatchHistoryResponse {
  items: HistoricalBatch[]
  pagination: { totalPages: number; total: number }
  aggregateMetrics?: {
    totalBatches: number
    totalPayments: number
    successRate: string
    totalVolume: string
    failedJobs: number
    failedPayments: number
  }
}

import { BATCH_HISTORY_QUERY_KEY, batchHistoryKeys } from "@/lib/query-keys"
import { authenticatedFetch } from "@/lib/wallet-session-client"

// Re-exported from the central query-key factory (#521) so existing imports
// (`@/lib/dashboard/fetch-history`) keep working while there is one source of
// truth for the key structure.
export { BATCH_HISTORY_QUERY_KEY, batchHistoryKeys }

/**
 * Builds a specific (paginated/filtered) batch-history query key.
 * Thin wrapper over `batchHistoryKeys.list` kept for call-site brevity in the
 * dashboard tables; invalidation should always target `batchHistoryKeys.all`.
 */
export function batchHistoryQueryKey(
  publicKey: string | null | undefined,
  ...rest: unknown[]
) {
  return batchHistoryKeys.list(publicKey, ...rest)
}

export async function fetchHistory(params: {
  publicKey: string
  page?: number
  limit?: number
  statusFilter?: string
  networkFilter?: string
  searchFilter?: string
  fromFilter?: string
  sort?: string
  order?: string
}): Promise<BatchHistoryResponse> {
  const urlParams = new URLSearchParams({
    page: String(params.page ?? 1),
    limit: String(params.limit ?? 20),
    publicKey: params.publicKey,
  })
  if (params.statusFilter) urlParams.set("status", params.statusFilter)
  if (params.networkFilter) urlParams.set("network", params.networkFilter)
  if (params.searchFilter?.trim()) urlParams.set("search", params.searchFilter.trim())
  if (params.fromFilter) urlParams.set("from", params.fromFilter)
  if (params.sort) urlParams.set("sort", params.sort)
  if (params.order) urlParams.set("order", params.order)
  urlParams.set("includeSummary", "true")

  const res = await authenticatedFetch(
    `/api/batch-history?${urlParams.toString()}`,
    params.publicKey,
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
