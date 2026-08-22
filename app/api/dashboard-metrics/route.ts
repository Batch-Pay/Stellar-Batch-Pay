/**
 * API route for fetching dashboard metrics for a connected wallet.
 *
 * GET /api/dashboard-metrics?publicKey=<publicKey>&network=<testnet|mainnet>
 *
 * Optional query: range=7d|30d|90d adds a `timeSeries` field bucketing the
 * account's payment volume into daily buckets for the requested window. The
 * `/dashboard/analytics` page consumes this for the PaymentVolumeChart.
 *
 * Queries Horizon for the account's operations and aggregates metrics.
 */

import { NextRequest, NextResponse } from "next/server";
import { Horizon, StrKey } from "stellar-sdk";
import { horizonUrl } from "@/lib/stellar/network-config";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";
import { countJobs } from "@/lib/job-store";
import type { BatchJobNetwork } from "@/lib/stellar/types";

type TimeRange = "7d" | "30d" | "90d";

interface TimeSeriesPoint {
  date: string; // ISO yyyy-mm-dd
  amount: number; // XLM amount sent on that day
}

function rangeToDays(range: TimeRange | null): number | null {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return null;
}

export async function GET(request: NextRequest) {
  const rateLimit = await applyRateLimit(request, "dashboard-metrics");
  if (rateLimit.blocked) return rateLimit.response!;

  const { searchParams } = request.nextUrl;
  const publicKey = searchParams.get("publicKey");
  const network = searchParams.get("network");
  const rangeParam = searchParams.get("range") as TimeRange | null;

  if (!publicKey || typeof publicKey !== "string") {
    return NextResponse.json(
      { error: "Missing required query parameter: publicKey" },
      { status: 400 },
    );
  }

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json(
      { error: "Invalid public key" },
      { status: 400 },
    );
  }

  if (network !== "testnet" && network !== "mainnet") {
    return NextResponse.json(
      { error: "network must be 'testnet' or 'mainnet'" },
      { status: 400 },
    );
  }

  if (rangeParam && rangeToDays(rangeParam) === null) {
    return NextResponse.json(
      { error: "range must be one of: 7d, 30d, 90d" },
      { status: 400 },
    );
  }

  const server = new Horizon.Server(horizonUrl(network));

  try {
    // Get account operations (limit to recent 200 per page, up to 2000 total)
    let operationsPage = await server
      .operations()
      .forAccount(publicKey)
      .limit(200)
      .order("desc")
      .call();

    const allRecords: any[] = [];
    let truncated = false;

    while (operationsPage && operationsPage.records && operationsPage.records.length > 0) {
      allRecords.push(...operationsPage.records);
      if (allRecords.length >= 2000) {
        allRecords.length = 2000;
        truncated = true;
        break;
      }
      try {
        operationsPage = await operationsPage.next();
      } catch (err) {
        break;
      }
    }

    let totalPayments = 0;
    let totalAmountSent = 0; // in XLM display units (Horizon returns decimal strings)
    let assetCounts: { [key: string]: number } = {};
    let successfulPayments = 0;
    let currentWindowPayments = 0;
    let previousWindowPayments = 0;
    let currentWindowAmount = 0;
    let previousWindowAmount = 0;
    let currentWindowSuccessful = 0;
    let previousWindowSuccessful = 0;

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const currentWindowStart = now - 7 * 24 * 60 * 60 * 1000;
    const previousWindowStart = now - 14 * 24 * 60 * 60 * 1000;

    // Process operations
    for (const op of allRecords) {
      if (op.type === "payment" && op.source_account === publicKey) {
        const opTime = new Date(op.created_at).getTime();
        const nativeAmount = op.asset_type === "native" ? parseFloat(op.amount) : 0;

        totalPayments += 1;
        successfulPayments += 1; // All operations in the response are successful

        if (opTime >= currentWindowStart) {
          currentWindowPayments += 1;
          currentWindowAmount += nativeAmount;
          currentWindowSuccessful += 1;
        } else if (opTime >= previousWindowStart && opTime < currentWindowStart) {
          previousWindowPayments += 1;
          previousWindowAmount += nativeAmount;
          previousWindowSuccessful += 1;
        }

        // Handle amount based on asset type
        if (op.asset_type === "native") {
          // Horizon returns amount as a human-readable decimal (e.g. "10.5000000") — no conversion needed
          totalAmountSent += parseFloat(op.amount);
          assetCounts["XLM"] = (assetCounts["XLM"] || 0) + parseFloat(op.amount);
        } else {
          // Issued asset
          const assetKey = `${op.asset_code}:${op.asset_issuer}`;
          assetCounts[assetKey] = (assetCounts[assetKey] || 0) + parseFloat(op.amount);
          // For total amount, we could convert to USD, but for now just count
        }
      }
    }

    // Calculate success rate
    const successRate = totalPayments > 0 ? (successfulPayments / totalPayments) * 100 : 0;

    // Active batches: query the durable job store for queued + processing jobs
    // scoped to the requesting owner and network.
    const activeBatches =
      (await countJobs({ status: "queued", network: network as BatchJobNetwork, publicKey })) +
      (await countJobs({ status: "processing", network: network as BatchJobNetwork, publicKey }));

    // Preserve the ledger-activity signal: count recent on-chain payments over 24h
    // as a separate field. Do NOT derive activeBatches from this.
    let paymentsLast24h = 0;

    for (const op of allRecords) {
      if (op.type === "payment" && op.source_account === publicKey) {
        const opTime = new Date(op.created_at).getTime();
        if (opTime > oneDayAgo) {
          paymentsLast24h += 1;
        }
      }
    }

    // Format total amount (prioritize XLM, otherwise show asset breakdown)
    let totalAmountDisplay = "";
    if (assetCounts["XLM"]) {
      totalAmountDisplay = `${assetCounts["XLM"].toFixed(2)} XLM`;
    } else {
      // Show first asset
      const firstAsset = Object.keys(assetCounts)[0];
      if (firstAsset) {
        totalAmountDisplay = `${assetCounts[firstAsset].toFixed(2)} ${firstAsset}`;
      } else {
        totalAmountDisplay = "0 XLM";
      }
    }

    // Optional time-series for the analytics chart (#359)
    let timeSeries: TimeSeriesPoint[] | undefined;
    const days = rangeToDays(rangeParam);
    if (days !== null) {
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      const buckets = new Map<string, number>();
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        buckets.set(key, 0);
      }
      for (const op of allRecords) {
        if (op.type !== "payment" || op.source_account !== publicKey) continue;
        const ts = new Date(op.created_at).getTime();
        if (ts < cutoff) continue;
        const key = new Date(op.created_at).toISOString().slice(0, 10);
        if (!buckets.has(key)) continue;
        const amount = op.asset_type === "native" ? parseFloat(op.amount) : 0;
        buckets.set(key, (buckets.get(key) ?? 0) + amount);
      }
      timeSeries = Array.from(buckets.entries()).map(([date, amount]) => ({
        date,
        amount: Number(amount.toFixed(7)),
      }));
    }

    return setRateLimitHeaders(
      NextResponse.json({
        totalPayments,
        totalAmountSent: totalAmountDisplay,
        successRate: successRate.toFixed(1) + "%",
        activeBatches,
        paymentsLast24h,
        totalPaymentsTrend: formatTrend(currentWindowPayments, previousWindowPayments),
        totalAmountSentTrend: formatTrend(currentWindowAmount, previousWindowAmount),
        successRateTrend: formatTrend(
          rate(currentWindowSuccessful, currentWindowPayments),
          rate(previousWindowSuccessful, previousWindowPayments),
          "pp",
        ),
        activeBatchesTrend: activeBatches > 0 ? "Active" : "No active batches",
        truncated,
        ...(timeSeries && { timeSeries }),
      }),
      rateLimit,
    );
  } catch (error) {
    console.error("Error fetching dashboard metrics:", error);
    return NextResponse.json(
      { error: "Failed to fetch metrics from Horizon" },
      { status: 500 },
    );
  }
}

function rate(successful: number, total: number): number {
  return total > 0 ? (successful / total) * 100 : 0;
}

function formatTrend(current: number, previous: number, unit: "%" | "pp" = "%"): string {
  if (current === 0 && previous === 0) return "No trend";
  if (previous === 0) return unit === "pp" ? `+${current.toFixed(1)} pp` : "New activity";

  const delta = unit === "pp" ? current - previous : ((current - previous) / previous) * 100;
  const sign = delta > 0 ? "+" : "";
  return unit === "pp" ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}%`;
}
