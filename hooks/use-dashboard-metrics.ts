"use client";

import { useQuery } from "@tanstack/react-query";
import type { BatchJobNetwork } from "@/lib/stellar/types";
import { dashboardMetricsKeys } from "@/lib/query-keys";

export interface DashboardMetricsTimeSeriesPoint {
  date: string;
  amount: number;
}

export interface DashboardMetrics {
  totalPayments: number;
  totalAmountSent: string;
  successRate: string;
  activeBatches: number;
  paymentsLast24h?: number;
  totalPaymentsTrend?: string;
  totalAmountSentTrend?: string;
  successRateTrend?: string;
  activeBatchesTrend?: string;
  timeSeries?: DashboardMetricsTimeSeriesPoint[];
}

async function fetchDashboardMetrics(
  publicKey: string,
  network: BatchJobNetwork,
  range?: "7d" | "30d" | "90d",
): Promise<DashboardMetrics> {
  const params = new URLSearchParams({ publicKey, network });
  if (range) params.set("range", range);

  const response = await fetch(`/api/dashboard-metrics?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.statusText}`);
  }

  return response.json();
}

export function useDashboardMetrics(
  publicKey: string | null,
  network: BatchJobNetwork,
  range?: "7d" | "30d" | "90d",
) {
  const queryKey = dashboardMetricsKeys.detail(publicKey, network, range);

  const { data: metrics, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => fetchDashboardMetrics(publicKey!, network, range),
    enabled: !!publicKey,
    staleTime: 30 * 1000,
  });

  const showZeroDefaults = !publicKey;

    return {
    metrics: showZeroDefaults
      ? {
          totalPayments: 0,
          totalAmountSent: "0 XLM",
          successRate: "0.0%",
          activeBatches: 0,
          paymentsLast24h: 0,
        }
      : (metrics ?? null),
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : "Unknown error") : null,
    refetch,
  };
}
