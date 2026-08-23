"use client";

import { use, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useWallet } from "@/contexts/WalletContext";
import { useNotifications } from "@/contexts/NotificationsContext";
import { MotionSafe } from "@/components/motion-safe";
import { DashboardWalletEmpty } from "@/components/dashboard/dashboard-wallet-empty";
import { pageEnter } from "@/lib/motion-tokens";
import { ArrowLeft, Copy, ExternalLink, Download, FileText, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  buildBatchExportRows,
  toBatchExportCsv,
  toBatchExportHtml,
} from "@/lib/dashboard/batch-export";
import {
  mapBatchStatusToDetailView,
  type BatchDetailView,
} from "@/lib/dashboard/batch-detail";
import { authenticatedFetch } from "@/lib/wallet-session-client";
import { useWalletSessionContext } from "@/contexts/WalletSessionContext";

interface JobStatusResponse {
  status: string;
  summary?: { successful?: number; failed?: number };
  error?: string;
}

function explorerUrl(hash: string, network: "testnet" | "mainnet"): string {
  const base =
    network === "mainnet"
      ? "https://stellar.expert/explorer/public"
      : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${encodeURIComponent(hash)}`;
}

function downloadFile(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function fetchBatchDetail(jobId: string, publicKey: string): Promise<BatchDetailView> {
  const params = new URLSearchParams({ publicKey });
  const res = await authenticatedFetch(
    `/api/batch-status/${jobId}?${params.toString()}`,
    publicKey,
  );
  if (!res.ok) {
    throw new Error(`Failed to load batch (HTTP ${res.status})`);
  }
  const body = await res.json();
  return mapBatchStatusToDetailView(body);
}

export default function BatchDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const { publicKey } = useWallet();
  const { sessionToken } = useWalletSessionContext();
  const { pushBatchNotification } = useNotifications();
  const [retrying, setRetrying] = useState(false);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [retryPollError, setRetryPollError] = useState<string | null>(null);
  const [retryJobData, setRetryJobData] = useState<JobStatusResponse | null>(null);
  const retryNotificationRef = useRef<string | null>(null);
  const retryPollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryPollCancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      retryPollCancelledRef.current = true;
      if (retryPollTimeoutRef.current !== null) {
        clearTimeout(retryPollTimeoutRef.current);
        retryPollTimeoutRef.current = null;
      }
    };
  }, []);

  const { data, error, isLoading } = useQuery({
    queryKey: ["job", jobId, publicKey],
    queryFn: () => fetchBatchDetail(jobId, publicKey!),
    enabled: !!publicKey && !!sessionToken,
    staleTime: 5 * 1000,
    refetchInterval: (query) =>
      query.state.data?.status === "completed" || query.state.data?.status === "failed" ? false : 5000,
  });

  const handleRetry = async () => {
    if (!data?.summary?.failed) {
      return;
    }

    setRetrying(true);
    try {
      // Generate idempotency key to prevent duplicate retry jobs on double-click (#550)
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch("/api/batch-retry", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ jobId, publicKey }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || `Retry failed (${res.status})`);
      }

      // Start inline polling for the newly queued retry job
      const newJobId = body.jobId as string;
      setRetryJobId(newJobId);
      setRetryPollError(null);
      toast.success(`Retry job queued (${newJobId})`);

      const poll = async () => {
        try {
          const r = await authenticatedFetch(
            `/api/batch-status/${newJobId}?publicKey=${encodeURIComponent(publicKey!)}`,
            publicKey,
          );
          if (!r.ok) throw new Error(`Status fetch failed (${r.status})`);
          const jb = (await r.json()) as JobStatusResponse;
          if (retryPollCancelledRef.current) return;
          setRetryJobData(jb);
          if (jb.status === "queued" || jb.status === "processing") {
            retryPollTimeoutRef.current = setTimeout(poll, 2000);
          }
        } catch (err) {
          if (!retryPollCancelledRef.current) setRetryPollError((err as Error).message);
        }
      };

      poll();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const exportRows = data ? buildBatchExportRows(data) : [];

  useEffect(() => {
    if (!retryJobId || !retryJobData) {
      return;
    }

    const terminalStatus = retryJobData.status;
    if (terminalStatus !== "completed" && terminalStatus !== "failed") {
      return;
    }

    if (retryNotificationRef.current === retryJobId) {
      return;
    }

    pushBatchNotification({
      jobId: retryJobId,
      network: data?.network ?? "testnet",
      status: terminalStatus,
      error: retryJobData.error,
    });
    retryNotificationRef.current = retryJobId;
  }, [data?.network, pushBatchNotification, retryJobData, retryJobId]);

  return (
    <MotionSafe {...pageEnter} className="space-y-6">
      <Link
        href="/dashboard/history"
        className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to history
      </Link>

      <Card className="border-[#1F2937] bg-[#121827] shadow-lg">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-2xl text-white">Batch detail</CardTitle>
              <p className="font-mono text-xs text-gray-500 mt-1 break-all">{jobId}</p>
            </div>
            {data && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-gray-300 border-[#1F2937]">
                  {data.network === "mainnet" ? "Mainnet" : "Testnet"}
                </Badge>
                <Badge
                  className={
                    data.status === "completed"
                      ? "bg-[#00D98B]/20 text-[#00D98B] border-[#00D98B]/30"
                      : data.status === "failed"
                        ? "bg-red-500/20 text-red-300 border-red-500/30"
                        : "bg-yellow-500/20 text-yellow-200 border-yellow-500/30"
                  }
                >
                  {data.status}
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading job…
            </div>
          )}
          {!isLoading && !publicKey && <DashboardWalletEmpty className="border-none bg-transparent" />}
          {error && <p className="text-red-300">{(error as Error).message}</p>}
          {data && (
            <div className="grid sm:grid-cols-3 gap-4 text-sm">
              <Metric label="Recipients" value={data.recipients.length} />
              <Metric
                label="Successful"
                value={data.summary?.successful ?? 0}
                tone="success"
              />
              <Metric
                label="Failed"
                value={data.summary?.failed ?? 0}
                tone={data.summary?.failed ? "danger" : "neutral"}
              />
            </div>
          )}
          {retryJobId ? (
            <div className="mt-4 rounded-md border border-[#1F2937] bg-[#0B1220] px-3 py-2">
              <p className="text-sm text-gray-400">Retry job queued: <span className="font-mono text-xs text-white">{retryJobId}</span></p>
              {retryPollError && <p className="text-xs text-red-400">{retryPollError}</p>}
              {retryJobData ? (
                <div className="flex items-center gap-3 mt-2 text-sm">
                  <Badge className={
                    retryJobData.status === "completed"
                      ? "bg-[#00D98B]/20 text-[#00D98B]"
                      : retryJobData.status === "failed"
                        ? "bg-red-500/20 text-red-300"
                        : "bg-yellow-500/20 text-yellow-200"
                  }>{retryJobData.status}</Badge>
                  <div className="text-gray-400">{retryJobData.summary?.successful ?? 0} succeeded</div>
                  <div className="text-gray-400">{retryJobData.summary?.failed ?? 0} failed</div>
                  <Link href={`/dashboard/history/${retryJobId}`} className="text-sm text-gray-300 hover:underline">Open</Link>
                </div>
              ) : (
                <div className="mt-2 text-sm text-gray-400">Waiting for retry job status…</div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>


      {data && data.summary && data.summary.failed > 0 && (
        <Card className="border-red-950 bg-red-950/20 text-red-200 shadow-md">
          <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
            <div>
              <CardTitle className="text-base text-red-400">Failed Payments</CardTitle>
              <p className="text-xs text-gray-400 mt-1">
                Some payments failed. You can retry them using the server wallet, or rebuild and resign them using your own wallet.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRetry}
                disabled={retrying}
              >
                {retrying ? "Retrying…" : `Retry ${data.summary.failed} Failed`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-red-500/30 text-red-300 hover:bg-red-500/20"
                onClick={() => {
                  const failed = data.recipients
                    .filter(r => r.status === "failed")
                    .map(r => ({
                      address: r.address,
                      amount: r.amount,
                      asset: r.asset,
                    }));
                  sessionStorage.setItem("retry_failed_payments", JSON.stringify(failed));
                  window.location.href = "/dashboard/new-batch";
                }}
              >
                Rebuild & Resign
              </Button>
            </div>
          </CardHeader>
          <CardContent className="max-h-40 overflow-y-auto space-y-1 divide-y divide-red-900/20">
            {data.recipients
              .filter(r => r.status === "failed")
              .map((r, idx) => (
                <div key={idx} className="text-xs flex justify-between items-center gap-2 py-2">
                  <span className="font-mono text-gray-400">{r.address}</span>
                  <span className="text-red-400 font-mono font-semibold whitespace-nowrap ml-4">{r.amount} {r.asset}</span>
                  <span className="text-red-300/80 italic text-right flex-1 truncate max-w-xs ml-4">{r.error || "Unknown error"}</span>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {data && (
        <Card className="border-[#1F2937] bg-[#121827] shadow-lg">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-base">Per-recipient results</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadFile(
                    `batch-${jobId}.csv`,
                    toBatchExportCsv(exportRows),
                    "text/csv",
                  )
                }
                aria-label="Export this batch as CSV"
              >
                <Download className="h-4 w-4 mr-1.5" />
                Export CSV
              </Button>
              {data.summary?.failed ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleRetry}
                  disabled={retrying}
                >
                  {retrying ? "Retrying…" : `Retry ${data.summary.failed} Failed`}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadFile(
                    `batch-${jobId}.html`,
                    toBatchExportHtml(exportRows, jobId, data.network),
                    "text/html",
                  )
                }
                aria-label="Export this batch as a printable HTML receipt"
              >
                <FileText className="h-4 w-4 mr-1.5" />
                Export PDF (HTML)
              </Button>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-[#1F2937]">
                  <th className="py-2 pr-4">Address</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Tx hash</th>
                </tr>
              </thead>
              <tbody>
                {data.recipients.map((r, i) => (
                  <tr key={`${r.address}-${i}`} className="border-b border-[#1F2937]/50">
                    <td className="py-3 pr-4 font-mono text-xs text-gray-300 break-all">
                      {r.address}
                    </td>
                    <td className="py-3 pr-4 text-white">
                      {r.amount} {r.asset}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge
                        className={
                          r.status === "success"
                            ? "bg-[#00D98B]/20 text-[#00D98B]"
                            : r.status === "failed"
                              ? "bg-red-500/20 text-red-300"
                              : "bg-yellow-500/20 text-yellow-200"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4">
                      {r.transactionHash ? (
                        <div className="flex items-center gap-1.5">
                          <a
                            href={explorerUrl(r.transactionHash, data.network)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-[#00D98B] hover:underline"
                          >
                            {r.transactionHash.slice(0, 10)}…
                          </a>
                          <button
                            type="button"
                            aria-label="Copy transaction hash"
                            onClick={() => {
                              if (typeof navigator !== "undefined" && navigator.clipboard) {
                                navigator.clipboard.writeText(r.transactionHash!);
                              }
                            }}
                            className="text-gray-500 hover:text-white"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          <a
                            href={explorerUrl(r.transactionHash, data.network)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-500 hover:text-white"
                            aria-label="Open transaction on stellar.expert"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </MotionSafe>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "danger" | "neutral";
}) {
  const cls =
    tone === "success"
      ? "text-[#00D98B]"
      : tone === "danger"
        ? "text-red-300"
        : "text-white";
  return (
    <div className="rounded-md border border-[#1F2937] bg-[#0E1422] px-3 py-2">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-xl font-semibold ${cls}`}>{value}</p>
    </div>
  );
}
