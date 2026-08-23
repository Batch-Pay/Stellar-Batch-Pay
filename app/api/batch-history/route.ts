/**
 * GET /api/batch-history
 *
 * Returns paginated batch job history from the durable SQLite store.
 *
 * Query params:
 *   page      – 1-based page number (default 1)
 *   limit     – rows per page (default 20, max 100)
 *   status    – filter by job status (queued | processing | completed | failed)
 *   network   – filter by network (testnet | mainnet)
 *   search    – substring match on jobId, payments JSON, or result JSON
 *   from      – ISO timestamp; include jobs with createdAt >= from
 *   to        – ISO timestamp; include jobs with createdAt <= to
 *   includeSummary – when true, include aggregate metrics for the full filtered set
 *   sort      – column to sort by: createdAt (default), updatedAt, status
 *   order     – sort direction: desc (default) or asc
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "stellar-sdk";
import { getAllJobs, countJobs, getBatchHistorySummary } from "@/lib/job-store";
import { safeJsonResponse } from "@/lib/safe-json";
import type { JobStatus, BatchJobNetwork } from "@/lib/stellar/types";
import { requireWalletAuth } from "@/lib/wallet-auth";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

function parseIsoTimestamp(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

export async function GET(request: NextRequest) {
  // #743: history supports free-text search and aggregate summaries across a
  // wallet's full job set, which is enumerable and heavier than a single
  // status poll, so it's rate-limited before running any query.
  const rate = await applyRateLimit(request, "batch-history");
  if (rate.blocked) return rate.response!;

  const response = await handleHistory(request);
  return setRateLimitHeaders(response, rate);
}

async function handleHistory(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  const page   = Math.max(1, parseInt(searchParams.get("page")  ?? "1", 10));
  const limit  = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const rawStatus  = searchParams.get("status");
  const rawNetwork = searchParams.get("network");
  const publicKey  = searchParams.get("publicKey");
  const search     = searchParams.get("search")?.trim() || undefined;
  const from       = parseIsoTimestamp(searchParams.get("from"));
  const to         = parseIsoTimestamp(searchParams.get("to"));
  const includeSummary = searchParams.get("includeSummary") === "true";
  const sort       = searchParams.get("sort") as "createdAt" | "updatedAt" | "status" | null;
  const order      = searchParams.get("order") as "asc" | "desc" | null;

  if (!publicKey || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json(
      { error: "A valid publicKey query parameter is required" },
      { status: 400 },
    );
  }

  const auth = requireWalletAuth(request, publicKey);
  if (!auth.valid) {
    return NextResponse.json(
      { error: auth.error },
      { status: auth.status ?? 401 },
    );
  }

  const validStatuses: JobStatus[] = ["queued", "processing", "completed", "failed"];
  const status  = validStatuses.includes(rawStatus as JobStatus) ? (rawStatus as JobStatus) : undefined;
  const network: BatchJobNetwork | undefined =
    rawNetwork === "testnet" || rawNetwork === "mainnet" ? rawNetwork : undefined;

  try {
    const filters = { status, network, publicKey, search, from, to, sort: sort ?? undefined, order: order ?? undefined };

    const [jobs, total] = await Promise.all([
      getAllJobs({ limit, offset, ...filters }),
      countJobs(filters),
    ]);

    const summary = includeSummary
      ? await (async () => {
          const stats = await getBatchHistorySummary(filters);
          return {
            totalJobs: stats.totalJobs,
            totalPayments: stats.totalPayments,
            totalAmount: `${stats.totalAmount.toFixed(2)} XLM`,
            successRate: stats.successRate,
            failedJobs: stats.failedJobs,
            failedPayments: stats.failedPayments,
          };
        })()
      : undefined;

    // Strip the full payments array from the list response to keep payloads small.
    // Callers that need the full payment list should use GET /api/batch-status/:jobId.
    const items = jobs.map((j) => ({
      jobId:            j.jobId,
      status:           j.status,
      network:          j.network,
      totalBatches:     j.totalBatches,
      completedBatches: j.completedBatches,
      totalPayments:    j.payments.length,
      createdAt:        j.createdAt,
      updatedAt:        j.updatedAt,
      // Include summary from result if available
      summary:          j.result?.summary ?? null,
      totalAmount:      j.result?.totalAmount ?? null,
    }));

    return safeJsonResponse({
      items,
      summary,
      // Backward-compatible alias for legacy clients.
      aggregateMetrics: summary
        ? {
            totalBatches: summary.totalJobs,
            totalPayments: summary.totalPayments,
            successRate: summary.successRate,
            totalVolume: summary.totalAmount,
            failedJobs: summary.failedJobs,
            failedPayments: summary.failedPayments,
          }
        : undefined,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("batch-history error:", error);
    return NextResponse.json(
      { error: "Failed to fetch batch history" },
      { status: 500 },
    );
  }
}
