/**
 * #341: Unified batch history adapter
 * 
 * Provides a single source of truth for batch history by using the server-side
 * SQLite job store as the primary data source, with localStorage as an offline
 * cache with TTL.
 */

import type { BatchResult, JobState, BatchJobNetwork } from "./stellar/types";
import { authenticatedFetch } from "./wallet-session-client";

const CACHE_KEY = "stellar_batch_history_cache";
const CACHE_VERSION_KEY = "stellar_batch_history_version";
const CACHE_VERSION = "1.0";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedHistory {
  timestamp: number;
  version: string;
  items: BatchResult[];
}

/**
 * Convert a JobState from the server to a BatchResult for the UI.
 * This adapter ensures consistent data shape across server and client.
 */
export function jobStateToBatchResult(job: JobState): BatchResult | null {
  // Only return completed jobs with results
  if (job.status !== "completed" || !job.result) {
    return null;
  }

  return job.result;
}

/**
 * Fetch batch history from the server API.
 * Returns an array of BatchResult objects.
 */
export async function fetchBatchHistory(
  publicKey: string,
  options?: {
    page?: number;
    limit?: number;
    status?: string;
    network?: BatchJobNetwork;
  }
): Promise<BatchResult[]> {
  const params = new URLSearchParams({
    publicKey,
    page: String(options?.page ?? 1),
    limit: String(options?.limit ?? 50),
  });

  if (options?.status) params.set("status", options.status);
  if (options?.network) params.set("network", options.network);

  const response = await authenticatedFetch(`/api/batch-history?${params.toString()}`, publicKey);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch batch history: ${response.statusText}`);
  }

  const data = await response.json();
  
  // The API returns job summaries, we need to fetch full results for completed jobs
  // For now, we'll construct BatchResult objects from the summary data
  return data.items
    .filter((item: any) => item.status === "completed" && item.summary)
    .map((item: any) => ({
      batchId: item.jobId,
      totalRecipients: item.totalPayments,
      totalAmount: item.totalAmount ?? "0",
      totalTransactions: item.totalBatches,
      network: item.network,
      timestamp: item.createdAt,
      submittedAt: item.updatedAt,
      results: [], // Summary view doesn't include individual results
      summary: item.summary,
    }));
}

/**
 * Fetch the full, owner-scoped result for a single job — including the
 * per-payment results array (recipients, amounts, statuses, tx hashes).
 *
 * The list returned by fetchBatchHistory/getBatchHistory only carries a
 * summary (see `results: []` above), so receipt/CSV downloads must call
 * this before generating a file for a specific historical batch.
 */
export async function fetchFullBatchResult(
  jobId: string,
  publicKey: string
): Promise<BatchResult | null> {
  const params = new URLSearchParams({ publicKey });
  const response = await authenticatedFetch(
    `/api/batch-status/${encodeURIComponent(jobId)}?${params.toString()}`,
    publicKey,
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch batch details: ${response.statusText}`);
  }

  const data = await response.json();

  if (data.status !== "completed" || !data.result) {
    return null;
  }

  return data.result as BatchResult;
}

/**
 * Get cached batch history from localStorage.
 * Returns null if cache is invalid, expired, or version mismatch.
 */
export function getCachedHistory(): BatchResult[] | null {
  if (typeof window === "undefined") return null;

  try {
    const version = localStorage.getItem(CACHE_VERSION_KEY);
    if (version !== CACHE_VERSION) {
      // Version mismatch, clear cache
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_VERSION_KEY);
      return null;
    }

    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    const data: CachedHistory = JSON.parse(cached);
    const now = Date.now();

    // Check if cache is expired
    if (now - data.timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }

    return data.items;
  } catch (error) {
    console.error("Failed to read cached history:", error);
    return null;
  }
}

/**
 * Save batch history to localStorage cache.
 */
export function setCachedHistory(items: BatchResult[]): void {
  if (typeof window === "undefined") return;

  try {
    const data: CachedHistory = {
      timestamp: Date.now(),
      version: CACHE_VERSION,
      items: items.slice(0, 50), // Keep last 50 batches
    };

    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(CACHE_VERSION_KEY, CACHE_VERSION);
  } catch (error) {
    console.error("Failed to cache history:", error);
  }
}

/**
 * Clear the localStorage cache.
 */
export function clearCachedHistory(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_VERSION_KEY);
  } catch (error) {
    console.error("Failed to clear cached history:", error);
  }
}

/**
 * Get batch history with automatic caching.
 * Tries cache first, falls back to server, then updates cache.
 */
export async function getBatchHistory(
  publicKey: string,
  options?: {
    page?: number;
    limit?: number;
    status?: string;
    network?: BatchJobNetwork;
    forceRefresh?: boolean;
  }
): Promise<BatchResult[]> {
  // Try cache first unless force refresh
  if (!options?.forceRefresh) {
    const cached = getCachedHistory();
    if (cached) {
      return cached;
    }
  }

  // Fetch from server
  const items = await fetchBatchHistory(publicKey, options);

  // Update cache
  setCachedHistory(items);

  return items;
}
