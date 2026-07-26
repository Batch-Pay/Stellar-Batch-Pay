"use client";

import { useMemo, useState } from "react";
import { CalendarRange, Download, FileText, Loader2, Wallet, Receipt } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useWallet } from "@/contexts/WalletContext";
import { useBatchHistory } from "@/hooks/use-batch-history";
import { fetchFullBatchResult } from "@/lib/batch-history-adapter";
import {
  filterClaimExportRowsByDateRange,
  toClaimExportCsv,
  toClaimExportRows,
  type ClaimExportRow,
} from "@/lib/dashboard/history-export";
import { downloadReceipt, downloadReceiptCsv } from "@/lib/receipt-generator";
import type { BatchResult } from "@/lib/stellar/types";
import { escapeHtml } from "@/lib/utils";

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// escapeHtml is imported from @/lib/utils (see issue #347)

function toPrintableHtml(rows: ClaimExportRow[], walletAddress: string, fromDate: string, toDate: string) {
  const rangeLabel = fromDate || toDate ? `${fromDate || "Any"} to ${toDate || "Any"}` : "All dates";
  const bodyRows = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.recipientAddress)}</td>
        <td>${escapeHtml(row.token)}</td>
        <td>${escapeHtml(row.amountClaimed)}</td>
        <td>${escapeHtml(new Date(row.timestamp).toLocaleString())}</td>
        <td>${escapeHtml(row.transactionHash)}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Vesting Claim Export</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0 0 6px; font-size: 12px; color: #374151; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; font-size: 11px; }
      th { background: #f3f4f6; }
    </style>
  </head>
  <body>
    <h1>Vesting Claim Export</h1>
    <p><strong>Wallet:</strong> ${escapeHtml(walletAddress)}</p>
    <p><strong>Date Range:</strong> ${escapeHtml(rangeLabel)}</p>
    <p><strong>Rows:</strong> ${rows.length}</p>
    <table>
      <thead>
        <tr>
          <th>Recipient Address</th>
          <th>Token</th>
          <th>Amount Claimed</th>
          <th>Timestamp</th>
          <th>Transaction Hash</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </body>
</html>`;
}

export function HistoryExportCenter() {
  const { publicKey } = useWallet();
  const { history, loading } = useBatchHistory(publicKey);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const scopedRows = useMemo(() => toClaimExportRows(history, publicKey), [history, publicKey]);
  const filteredRows = useMemo(
    () => filterClaimExportRowsByDateRange(scopedRows, { from: fromDate || undefined, to: toDate || undefined }),
    [scopedRows, fromDate, toDate]
  );

  const handleCsvExport = () => {
    if (!filteredRows.length) {
      toast.error("No claim data found for the selected date range.");
      return;
    }
    const csv = toClaimExportCsv(filteredRows);
    const dateTag = new Date().toISOString().slice(0, 10);
    downloadCsv(`vesting-claims-${dateTag}.csv`, csv);
    toast.success("CSV export generated.");
  };

  const handlePdfExport = () => {
    if (!filteredRows.length) {
      toast.error("No claim data found for the selected date range.");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast.error("Unable to open print window for PDF export.");
      return;
    }

    const printable = toPrintableHtml(
      filteredRows,
      publicKey || "Unknown (connect wallet for scoped exports)",
      fromDate,
      toDate
    );
    printWindow.document.open();
    printWindow.document.write(printable);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    toast.success("Print dialog opened for PDF export.");
  };

  const resolveFullBatchResult = async (batch: BatchResult): Promise<BatchResult | null> => {
    if (!publicKey) {
      toast.error("Connect a wallet to download batch receipts.");
      return null;
    }

    // History rows are summary-only (no per-payment results), so fetch the
    // full, owner-scoped job detail before generating a receipt/CSV.
    const full = await fetchFullBatchResult(batch.batchId, publicKey);
    if (!full) {
      toast.error("Could not load payment details for this batch.");
      return null;
    }
    return full;
  };

  const handleDownloadBatchReceipt = async (batch: BatchResult) => {
    setDownloadingId(batch.batchId);
    try {
      const full = await resolveFullBatchResult(batch);
      if (!full) return;
      downloadReceipt(full);
      toast.success("Receipt downloaded successfully.");
    } catch (error) {
      toast.error("Failed to generate receipt.");
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDownloadBatchCsv = async (batch: BatchResult) => {
    setDownloadingId(batch.batchId);
    try {
      const full = await resolveFullBatchResult(batch);
      if (!full) return;
      downloadReceiptCsv(full);
      toast.success("CSV downloaded successfully.");
    } catch (error) {
      toast.error("Failed to generate CSV.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Card className="border-[#1F2937] bg-[#121827] shadow-lg">
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-white text-xl flex items-center gap-2">
            <FileText className="h-5 w-5 text-[#00D98B]" />
            Export Center
          </CardTitle>
          <div className="text-xs text-gray-400 flex items-center gap-1">
            <Wallet className="h-3.5 w-3.5" />
            {publicKey ? `${publicKey.slice(0, 6)}...${publicKey.slice(-4)}` : "No wallet connected"}
          </div>
        </div>
        <p className="text-sm text-gray-400">
          Export claim history as CSV or PDF with date range filtering. You can also download receipts for past batch transactions.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto_auto]">
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-gray-400 flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" />
              From Date
            </label>
            <Input
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              className="bg-[#0E1526] border-[#1F2937] text-white"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-gray-400 flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" />
              To Date
            </label>
            <Input
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              className="bg-[#0E1526] border-[#1F2937] text-white"
            />
          </div>
          <Button onClick={handleCsvExport} className="self-end bg-[#00D98B] text-[#04120C] hover:bg-[#00D98B]/90">
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={handlePdfExport} variant="outline" className="self-end border-[#00D98B]/40 text-[#00D98B]">
            <FileText className="mr-2 h-4 w-4" />
            Export PDF
          </Button>
        </div>

        <div className="rounded-xl border border-[#1F2937] overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead className="bg-[#0E1526] text-xs text-gray-400 uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3">Recipient Address</th>
                <th className="px-4 py-3">Token</th>
                <th className="px-4 py-3">Amount Claimed</th>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Transaction Hash</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredRows.slice(0, 8).map((row) => (
                <tr key={`${row.transactionHash}-${row.recipientAddress}`} className="border-t border-[#1F2937]/70">
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{row.recipientAddress}</td>
                  <td className="px-4 py-3 text-gray-200">{row.token}</td>
                  <td className="px-4 py-3 text-white">{row.amountClaimed}</td>
                  <td className="px-4 py-3 text-gray-300">{new Date(row.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-300">{row.transactionHash}</td>
                </tr>
              ))}
              {!filteredRows.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                    No claim events found for the selected range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500">
          Showing {Math.min(filteredRows.length, 8)} of {filteredRows.length} rows.
        </p>

        {history.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <Receipt className="h-4 w-4" />
              Recent Batch Receipts
            </h3>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {history.slice(0, 10).map((batch, idx) => (
                <div key={idx} className="flex items-center justify-between bg-[#0E1526] p-3 rounded-lg border border-[#1F2937]">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-300 font-mono truncate">
                      {batch.totalRecipients} recipients • {batch.summary.successful} successful
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(batch.timestamp).toLocaleDateString()} • {batch.network}
                    </p>
                  </div>
                  <div className="flex gap-2 ml-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownloadBatchReceipt(batch)}
                      disabled={downloadingId === batch.batchId}
                      className="text-[#00D98B] hover:text-[#00D98B]/80 h-8 px-2"
                    >
                      {downloadingId === batch.batchId ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 mr-1" />
                      )}
                      Receipt
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDownloadBatchCsv(batch)}
                      disabled={downloadingId === batch.batchId}
                      className="text-gray-400 hover:text-white h-8 px-2"
                    >
                      {downloadingId === batch.batchId ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5 mr-1" />
                      )}
                      CSV
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
