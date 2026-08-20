"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  Wallet,
  ShieldAlert,
} from "lucide-react";
import { useWallet } from "@/contexts/WalletContext";
import { useBalances } from "@/hooks/use-balances";
import { useTrustlines } from "@/hooks/use-trustlines";
import {
  aggregatePaymentsByAsset,
  type AssetAmount,
} from "@/utils/aggregateAssets";
import { validateBatchSubmission } from "@/utils/validation";
import type { PaymentInstruction } from "@/lib/stellar/types";

import { useBatchFlow } from "@/contexts/BatchFlowContext";

const BATCH_SIZE_WARN_BYTES = 90_000;
const MAX_TX_BYTES = 100_000;

interface BatchMetaEntry {
  ops: number;
  estimatedBytes: number;
  byteSize: number;
}

interface BatchReviewProps {
  payments?: PaymentInstruction[];
  network?: "testnet" | "mainnet";
  batchMeta?: BatchMetaEntry[];
  skippedIndices?: number[];
  convertedIndices?: number[];
  onSkipToggle?: (index: number) => void;
  onConvertToggle?: (index: number) => void;
  onSubmit?: (filteredPayments: PaymentInstruction[]) => Promise<void>;
  hasActiveJob?: boolean;
}

export function BatchReview(props: BatchReviewProps) {
  const context = useBatchFlow();
  const payments = props.payments ?? context.validationResult?.validPayments ?? [];
  const network = props.network ?? context.selectedNetwork;
  const batchMeta = props.batchMeta ?? context.batchMeta;
  const skippedIndices = props.skippedIndices ?? context.skippedIndices;
  const convertedIndices = props.convertedIndices ?? context.convertedIndices;
  const onSkipToggle = props.onSkipToggle ?? context.onSkipToggle;
  const onConvertToggle = props.onConvertToggle ?? context.onConvertToggle;
  const onSubmit = props.onSubmit ?? context.onSubmit;
  // Reflects the job's full lifecycle (queued -> processing -> terminal), not
  // just whether the initial /api/batch-submit request is in flight, so the
  // button stays locked until the background job actually finishes (#698).
  const isSubmitting = props.hasActiveJob ?? context.hasActiveJob;
  const { publicKey } = useWallet();
  const { balances, loading: balancesLoading } = useBalances();
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Determine unique assets in payments
  const uniqueAssets = useMemo(() => {
    const assets = new Set(payments.map((p) => p.asset));
    return Array.from(assets).sort();
  }, [payments]);

  // For trustline check, we need to check each recipient for each asset.
  // We'll focus on the selected asset (or first asset) for trustline warnings.
  const targetAsset = selectedAsset || uniqueAssets[0] || "";
  const assetParts = targetAsset.split(":");
  const assetCode = assetParts[0];
  const assetIssuer = assetParts.length > 1 ? assetParts[1] : undefined;

  // Get unique recipient addresses for the selected asset
  const recipientAddresses = useMemo(() => {
    const addresses = payments
      .filter((p) => p.asset === targetAsset)
      .map((p) => p.address);
    return Array.from(new Set(addresses));
  }, [payments, targetAsset]);

  const {
    results: trustlineResults,
    loading: trustlineLoading,
    error: trustlineError,
    refetch: refetchTrustlines,
  } = useTrustlines(assetCode, assetIssuer);

  // Map trustline results for quick lookup
  const trustlineMap = useMemo(() => {
    const map = new Map<string, boolean>();
    trustlineResults.forEach((r) => map.set(r.address, r.hasTrustline));
    return map;
  }, [trustlineResults]);

  // Identify payments missing trustlines (and not already skipped/converted)
  const missingTrustlinePayments = useMemo(() => {
    return payments.map((payment, index) => {
      if (skippedIndices.includes(index) || convertedIndices.includes(index))
        return false;
      if (payment.asset !== targetAsset) return false;
      return !trustlineMap.get(payment.address);
    });
  }, [payments, targetAsset, trustlineMap, skippedIndices, convertedIndices]);

  // Aggregate balances by asset
  const aggregatedBalances = useMemo(
    () => aggregatePaymentsByAsset(payments),
    [payments],
  );

  // Validate batch submission
  const missingTrustlineAddresses = useMemo(
    () =>
      payments
        .filter(
          (p, idx) =>
            !skippedIndices.includes(idx) &&
            !convertedIndices.includes(idx) &&
            !trustlineMap.get(p.address),
        )
        .map((p) => p.address),
    [payments, skippedIndices, convertedIndices, trustlineMap],
  );

  const mappedBalances = useMemo<AssetAmount[]>(() => {
    return balances.map((bal) => ({
      asset:
        bal.assetCode === "XLM" ? "XLM" : `${bal.assetCode}:${bal.assetIssuer}`,
      total: bal.balance,
      count: 1,
    }));
  }, [balances]);

  const largeBatches = useMemo(
    () =>
      (batchMeta ?? []).filter(
        (batch) => batch.estimatedBytes > BATCH_SIZE_WARN_BYTES,
      ),
    [batchMeta],
  );

  const validation = validateBatchSubmission(
    payments.filter(
      (_, idx) =>
        !skippedIndices.includes(idx) && !convertedIndices.includes(idx),
    ),
    mappedBalances,
    missingTrustlineAddresses,
    network,
  );

  const handleSubmit = async () => {
    if (!publicKey || isSubmitting) {
      return;
    }
    const filteredPayments = payments.filter(
      (_, idx) =>
        !skippedIndices.includes(idx) && !convertedIndices.includes(idx),
    );
    await onSubmit(filteredPayments);
  };

  // Debounced trustline refetch (300ms) when recipient list or asset changes
  useEffect(() => {
    // Clear existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Set new debounced timer
    if (recipientAddresses.length > 0) {
      debounceTimerRef.current = setTimeout(() => {
        refetchTrustlines(recipientAddresses, { forceRefresh: true });
      }, 300);
    }

    // Cleanup on unmount
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [targetAsset, recipientAddresses, refetchTrustlines]);

  if (!publicKey) {
    return (
      <Card className="bg-slate-900/50 border-slate-800">
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 text-slate-400">
            <Wallet className="w-5 h-5" />
            <span>Connect your wallet to review batch</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {largeBatches.length > 0 && (
        <Card className="bg-amber-500/10 border-amber-500/30">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-amber-200 font-medium">
                  {largeBatches.length} batch
                  {largeBatches.length > 1 ? "es" : ""} near the {MAX_TX_BYTES.toLocaleString()} byte
                  transaction limit
                </p>
                <p className="text-sm text-amber-100/80">
                  Largest estimate:{" "}
                  {Math.max(
                    ...largeBatches.map((b) => b.estimatedBytes),
                  ).toLocaleString()}{" "}
                  bytes ({(Math.max(...largeBatches.map((b) => b.estimatedBytes)) / MAX_TX_BYTES * 100).toFixed(0)}%
                  of limit). Long memos may require fewer payments per transaction.
                </p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {batchMeta?.map((b, i) => (
                    <span key={i} className={`text-xs px-2 py-0.5 rounded ${b.estimatedBytes > BATCH_SIZE_WARN_BYTES ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-700/50 text-slate-400'}`}>
                      Batch {i + 1}: {b.estimatedBytes.toLocaleString()} bytes
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Balances Summary */}
      <Card className="bg-slate-900/50 border-slate-800">
        <CardHeader>
          <CardTitle className="text-lg text-white flex items-center gap-2">
            <Wallet className="w-5 h-5" />
            Your Balances
          </CardTitle>
        </CardHeader>
        <CardContent>
          {balancesLoading ? (
            <div className="text-slate-400">Loading balances...</div>
          ) : balances.length === 0 ? (
            <div className="text-slate-500">No balances available</div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {balances.map((bal, idx) => (
                <div
                  key={idx}
                  className="bg-slate-800/50 rounded-lg px-4 py-2 border border-slate-700"
                >
                  <div className="text-xs text-slate-500 uppercase font-semibold">
                    {bal.assetCode}
                    {bal.assetIssuer && `:${bal.assetIssuer.slice(0, 4)}...`}
                  </div>
                  <div className="text-lg font-bold text-white">
                    {bal.balance}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Asset Selector & Trustline Warnings */}
      {uniqueAssets.length > 0 && (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="text-lg text-white flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" />
              Trustline Checks
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {uniqueAssets.map((asset) => (
                <Badge
                  key={asset}
                  variant={targetAsset === asset ? "default" : "outline"}
                  className="cursor-pointer"
                  onClick={() => setSelectedAsset(asset)}
                >
                  {asset}
                </Badge>
              ))}
            </div>
            {trustlineLoading && (
              <div className="text-slate-400">Checking trustlines...</div>
            )}
            {trustlineError && (
              <div className="text-red-400">{trustlineError}</div>
            )}
            {!trustlineLoading &&
              !trustlineError &&
              recipientAddresses.length > 0 && (
                <div className="space-y-2">
                  <div className="text-sm text-slate-300">
                    Missing trustlines for {targetAsset}:{" "}
                    {missingTrustlinePayments.filter(Boolean).length} recipients
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {missingTrustlinePayments.map((isMissing, idx) => {
                      if (!isMissing) return null;
                      const payment = payments[idx];
                      return (
                        <Badge
                          key={idx}
                          variant="destructive"
                          className="text-xs"
                        >
                          {payment.address.slice(0, 8)}... (index {idx})
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}
          </CardContent>
        </Card>
      )}

      {/* Payment Table with Actions */}
      <Card className="bg-slate-900/50 border-slate-800 overflow-hidden">
        <CardHeader className="border-b border-slate-800">
          <CardTitle className="text-lg text-white">
            Payments ({payments.length})
          </CardTitle>
        </CardHeader>
        <div className="max-h-[500px] overflow-auto">
          <table className="w-full">
            <thead className="bg-slate-900 sticky top-0 z-10">
              <tr className="border-slate-800 hover:bg-transparent">
                <th className="w-20 text-left p-3 text-sm text-slate-400 font-medium">
                  Index
                </th>
                <th className="text-left p-3 text-sm text-slate-400 font-medium">
                  Recipient
                </th>
                <th className="text-left p-3 text-sm text-slate-400 font-medium">
                  Amount
                </th>
                <th className="text-left p-3 text-sm text-slate-400 font-medium">
                  Asset
                </th>
                <th className="text-left p-3 text-sm text-slate-400 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment, idx) => (
                <tr
                  key={idx}
                  className="border-slate-800/50 border-b hover:bg-slate-800/20"
                >
                  <td className="p-3 font-mono text-sm text-slate-500">
                    {idx}
                  </td>
                  <td className="p-3 font-mono text-sm text-white truncate max-w-[200px]">
                    {payment.address}
                  </td>
                  <td className="p-3 font-bold text-sm text-white">
                    {payment.amount}
                  </td>
                  <td className="p-3">
                    <Badge
                      variant="outline"
                      className="bg-slate-800 border-slate-700 text-slate-300"
                    >
                      {payment.asset}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant={
                          skippedIndices.includes(idx) ? "default" : "outline"
                        }
                        onClick={() => onSkipToggle(idx)}
                      >
                        {skippedIndices.includes(idx) ? "Skipped" : "Skip"}
                      </Button>
                      <Button
                        size="sm"
                        variant={
                          convertedIndices.includes(idx)
                            ? "default"
                            : "secondary"
                        }
                        onClick={() => onConvertToggle(idx)}
                      >
                        {convertedIndices.includes(idx)
                          ? "Converted"
                          : "Claimable"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Validation Errors/Warnings */}
      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="text-lg text-white flex items-center gap-2">
              <Info className="w-5 h-5" />
              Validation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {validation.errors.length > 0 && (
              <div>
                <div className="text-red-400 font-medium mb-2">Errors:</div>
                <ul className="list-disc list-inside text-red-300 space-y-1">
                  {validation.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div>
                <div className="text-amber-400 font-medium mb-2">Warnings:</div>
                <ul className="list-disc list-inside text-amber-300 space-y-1">
                  {validation.warnings.map((warn, i) => (
                    <li key={i}>{warn}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Submit Button */}
      <div className="flex justify-end">
        <Button
          size="lg"
          className="bg-emerald-500 hover:bg-emerald-600 text-white px-8"
          disabled={!validation.valid || isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? "Submitting..." : "Submit Batch"}
        </Button>
      </div>
    </div>
  );
}
