"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWallet } from "@/contexts/WalletContext";
import { useNotifications } from "@/contexts/NotificationsContext";
import { batchHistoryKeys, dashboardMetricsKeys } from "@/lib/query-keys";
import { parsePaymentFile, analyzeParsedPayments } from "@/lib/stellar/parser";
import { getBatchSummary } from "@/lib/stellar/summary";
import { canonicalizeIdempotencyPayload } from "@/lib/idempotency";
import { isSubmissionBlocked } from "@/lib/stellar/job-lifecycle";
import type {
  ParsedPaymentFile,
  BatchResult,
  JobStatus,
  PaymentInstruction,
  BatchMetaEntry,
  UploadedPaymentInstruction,
} from "@/lib/stellar/types";

async function buildBatchSubmitIdempotencyKey(body: {
  payments?: PaymentInstruction[];
  network: "testnet" | "mainnet";
  publicKey: string;
}) {
  const canonicalBody = canonicalizeIdempotencyPayload({
    payments: body.payments ?? null,
    network: body.network,
    publicKey: body.publicKey,
  });

  const webCrypto = globalThis.crypto;

  if (!webCrypto?.subtle) {
    return webCrypto?.randomUUID() ?? `${Date.now()}-${Math.random()}`;
  }

  const encoded = new TextEncoder().encode(canonicalBody);
  const digest = await webCrypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface BatchFlowContextType {
  step: number;
  setStep: (step: number) => void;
  selectedNetwork: "testnet" | "mainnet";
  setSelectedNetwork: (network: "testnet" | "mainnet") => void;
  file: File | null;
  setFile: (file: File | null) => void;
  fileFormat: "json" | "csv" | null;
  setFileFormat: (format: "json" | "csv" | null) => void;
  validationResult: ParsedPaymentFile | null;
  setValidationResult: (res: ParsedPaymentFile | null) => void;
  validationError: string;
  setValidationError: (err: string) => void;
  summary: {
    recipientCount: number;
    validCount: number;
    invalidCount: number;
    totalAmount: string;
    assetBreakdown: Record<string, number>;
  } | null;
  setSummary: (summary: any) => void;
  isSubmitting: boolean;
  setIsSubmitting: (submitting: boolean) => void;
  hasActiveJob: boolean;
  result: BatchResult | null;
  setResult: (res: BatchResult | null) => void;
  jobId: string | null;
  setJobId: (id: string | null) => void;
  jobStatus: JobStatus;
  setJobStatus: (status: JobStatus) => void;
  completedBatches: number;
  setCompletedBatches: (count: number) => void;
  totalBatches: number;
  setTotalBatches: (count: number) => void;
  manualPayments: PaymentInstruction[];
  setManualPayments: React.Dispatch<React.SetStateAction<PaymentInstruction[]>>;
  entryMode: "upload" | "manual";
  setEntryMode: (mode: "upload" | "manual") => void;
  skippedIndices: number[];
  setSkippedIndices: React.Dispatch<React.SetStateAction<number[]>>;
  convertedIndices: number[];
  setConvertedIndices: React.Dispatch<React.SetStateAction<number[]>>;
  batchMeta: BatchMetaEntry[] | undefined;
  setBatchMeta: (meta: BatchMetaEntry[] | undefined) => void;
  batchMetaLoading: boolean;
  setBatchMetaLoading: (loading: boolean) => void;
  estimatedFees: string | null;
  setEstimatedFees: (fees: string | null) => void;

  // Actions
  onSkipToggle: (index: number) => void;
  onConvertToggle: (index: number) => void;
  handleRetryFailed: (failedPayments: UploadedPaymentInstruction[]) => void;
  handleFileSelect: (selectedFile: File, format: "json" | "csv") => Promise<void>;
  handleManualContinue: () => void;
  loadBatchMeta: (payments: PaymentInstruction[]) => Promise<void>;
  onSubmit: (filteredPayments: PaymentInstruction[]) => Promise<void>;
  handleRestore: (saved: any) => void;
}

const BatchFlowContext = createContext<BatchFlowContextType | undefined>(undefined);

export function BatchFlowProvider({ children }: { children: React.ReactNode }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [fileFormat, setFileFormat] = useState<"json" | "csv" | null>(null);
  const [validationResult, setValidationResult] = useState<ParsedPaymentFile | null>(null);
  const [validationError, setValidationError] = useState("");
  const [summary, setSummary] = useState<{
    recipientCount: number;
    validCount: number;
    invalidCount: number;
    totalAmount: string;
    assetBreakdown: Record<string, number>;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus>("queued");
  const [completedBatches, setCompletedBatches] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [manualPayments, setManualPayments] = useState<PaymentInstruction[]>([]);
  const [entryMode, setEntryMode] = useState<"upload" | "manual">("upload");
  const [skippedIndices, setSkippedIndices] = useState<number[]>([]);
  const [convertedIndices, setConvertedIndices] = useState<number[]>([]);
  const [batchMeta, setBatchMeta] = useState<BatchMetaEntry[] | undefined>();
  const [batchMetaLoading, setBatchMetaLoading] = useState(false);
  const [estimatedFees, setEstimatedFees] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollErrorCountRef = useRef(0);
  const queryClient = useQueryClient();
  const { publicKey, expectedNetwork, selectNetwork } = useWallet();
  const { pushBatchNotification } = useNotifications();

  const network = expectedNetwork === "mainnet" ? "mainnet" : "testnet";

  // Sync state to sessionStorage to prevent data loss on render crashes
  useEffect(() => {
    if (result || jobStatus === "completed") {
      sessionStorage.removeItem("new_batch_state");
      return;
    }

    const stateToSave = {
      step: jobId ? step : 1,
      selectedNetwork: network,
      entryMode,
      jobId,
      jobStatus,
    };

    sessionStorage.setItem("new_batch_state", JSON.stringify(stateToSave));
  }, [
    step,
    network,
    entryMode,
    jobId,
    jobStatus,
    result,
  ]);

  // Restore state from sessionStorage
  const handleRestore = useCallback((saved: any) => {
    if (saved.selectedNetwork) selectNetwork(saved.selectedNetwork);
    if (saved.entryMode) setEntryMode(saved.entryMode);
    if (saved.jobId) {
      setJobId(saved.jobId);
      setJobStatus(saved.jobStatus ?? "queued");
      setStep(saved.step ?? 4);
    } else {
      setStep(1);
      setValidationResult(null);
      setSummary(null);
      setManualPayments([]);
    }
  }, [selectNetwork]);

  useEffect(() => {
    const saved = sessionStorage.getItem("new_batch_state");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        handleRestore(parsed);
      } catch (e) {
        console.error("Failed to restore new_batch_state:", e);
        sessionStorage.removeItem("new_batch_state");
      }
    }
  }, [handleRestore]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    pollErrorCountRef.current = 0;
  }, []);

  const startPolling = useCallback(
    (id: string, ownerPublicKey: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          abortControllerRef.current = new AbortController();
          const params = new URLSearchParams({ publicKey: ownerPublicKey });
          const res = await fetch(
            `/api/batch-status/${id}?${params.toString()}`,
            { signal: abortControllerRef.current.signal }
          );
          if (!res.ok) {
            throw new Error(`HTTP error ${res.status}`);
          }
          const data = await res.json();
          pollErrorCountRef.current = 0;
          setJobStatus(data.status);
          setCompletedBatches(data.completedBatches ?? 0);
          setTotalBatches(data.totalBatches ?? 0);
          if (data.status === "completed") {
            stopPolling();
            setResult(data.result ?? null);
            setIsSubmitting(false);
            setStep(4);
            // Invalidate the batch-history parent key: partial matching
            // (exact: false default) refreshes every paginated/filtered list —
            // recent table, history page — for this account (#521).
            void queryClient.invalidateQueries({
              queryKey: batchHistoryKeys.all(ownerPublicKey),
            });
            // A completed batch also changes the dashboard metric cards, which
            // live in a separate namespace and would otherwise stay stale (#521 / #523).
            void queryClient.invalidateQueries({
              queryKey: dashboardMetricsKeys.all(ownerPublicKey),
            });
            pushBatchNotification({
              jobId: data.jobId ?? id,
              network,
              status: "completed",
              completedBatches: data.completedBatches ?? 0,
              totalBatches: data.totalBatches ?? 0,
            });
            toast.success("Batch submitted successfully");
          } else if (data.status === "failed") {
            stopPolling();
            setIsSubmitting(false);
            pushBatchNotification({
              jobId: data.jobId ?? id,
              network,
              status: "failed",
              error: data.error ?? "Batch processing failed",
              completedBatches: data.completedBatches ?? 0,
              totalBatches: data.totalBatches ?? 0,
            });
            toast.error(data.error ?? "Batch processing failed");
          }
        } catch (error: any) {
          if (error.name === "AbortError") return;
          pollErrorCountRef.current += 1;
          if (pollErrorCountRef.current >= 3) {
            toast.error("Failed to check batch status repeatedly.");
            stopPolling();
          }
        }
      }, 2000);
    },
    [pushBatchNotification, queryClient, network, stopPolling],
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  const loadBatchMeta = useCallback(
    async (payments: PaymentInstruction[]) => {
      if (!publicKey || payments.length === 0) {
        setBatchMeta(undefined);
        setEstimatedFees(null);
        return;
      }

      setBatchMetaLoading(true);
      try {
        const response = await fetch("/api/batch-build", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payments,
            network,
            publicKey,
          }),
        });
        const data = await response.json();
        if (response.ok) {
          setBatchMeta(data.batchMeta);
          setEstimatedFees(data.estimatedFees ?? null);
        } else {
          setBatchMeta(undefined);
          setEstimatedFees(null);
        }
      } catch {
        setBatchMeta(undefined);
        setEstimatedFees(null);
      } finally {
        setBatchMetaLoading(false);
      }
    },
    [publicKey, network],
  );

  const handleSkipToggle = useCallback((index: number) => {
    setSkippedIndices((prev) => {
      const next = [...prev];
      const idx = next.indexOf(index);
      if (idx >= 0) {
        next.splice(idx, 1);
      } else {
        next.push(index);
      }
      return next;
    });
  }, []);

  const handleConvertToggle = useCallback((index: number) => {
    setConvertedIndices((prev) => {
      const next = [...prev];
      const idx = next.indexOf(index);
      if (idx >= 0) {
        next.splice(idx, 1);
      } else {
        next.push(index);
      }
      return next;
    });
  }, []);

  const handleRetryFailed = useCallback((failedPayments: UploadedPaymentInstruction[]) => {
    const rows = failedPayments.map((instruction, index) => ({
      rowNumber: index + 1,
      instruction,
      valid: true,
    }));

    setValidationResult({
      rows,
      validPayments: failedPayments,
      invalidCount: 0,
    });
    setSummary(getBatchSummary(failedPayments));
    setSkippedIndices([]);
    setConvertedIndices([]);
    setStep(2);
    toast.success(
      "Loaded failed payments for retry. Review before resubmitting.",
    );
  }, []);

  const handleFileSelect = useCallback(async (
    selectedFile: File,
    format: "json" | "csv",
  ) => {
    setFile(selectedFile);
    setFileFormat(format);

    try {
      const content = await selectedFile.text();
      const parsed = parsePaymentFile(content, format);
      setValidationResult(parsed);
      setValidationError("");

      const instructions = parsed.rows.map((r) => r.instruction);
      const batchSummary = getBatchSummary(instructions);
      setSummary(batchSummary);

      toast.success("File parsed and validated successfully");
      setStep(2);
    } catch (error) {
      console.error("Failed to parse file:", error);
      setSummary(null);
      setValidationError(
        error instanceof Error ? error.message : "Failed to parse payment file",
      );
      toast.error(
        error instanceof Error ? error.message : "Failed to parse payment file",
      );
    }
  }, []);

  const handleManualContinue = useCallback(() => {
    if (manualPayments.length === 0) {
      toast.error("Please add at least one recipient");
      return;
    }

    const parsed = analyzeParsedPayments(manualPayments);
    setValidationResult(parsed);
    setValidationError("");

    try {
      const batchSummary = getBatchSummary(manualPayments);
      setSummary(batchSummary);
    } catch (error) {
      console.error("Failed to summarize manual batch:", error);
      setSummary(null);
      setValidationError(
        error instanceof Error ? error.message : "Failed to summarize payment batch",
      );
      toast.error(
        error instanceof Error ? error.message : "Failed to summarize payment batch",
      );
      return;
    }

    toast.success("Manual batch validated successfully");
    setStep(2);
  }, [manualPayments]);

  const hasActiveJob = useMemo(
    () => isSubmissionBlocked({ isSubmitting, jobId, jobStatus }),
    [isSubmitting, jobId, jobStatus],
  );

  const onSubmit = useCallback(async (filteredPayments: PaymentInstruction[]) => {
    if (!publicKey) return;
    if (isSubmissionBlocked({ isSubmitting, jobId, jobStatus })) {
      toast.error(
        "A batch submission is already in progress. Please wait for it to finish before submitting again.",
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/batch-submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": await buildBatchSubmitIdempotencyKey({
            payments: filteredPayments,
            network,
            publicKey,
          }),
        },
        body: JSON.stringify({
          payments: filteredPayments,
          network,
          publicKey,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to submit batch");
      }
      setJobId(data.jobId);
      setJobStatus("queued");
      setCompletedBatches(0);
      setTotalBatches(0);
      startPolling(data.jobId, publicKey);
    } catch (error) {
      console.error("Batch submission error:", error);
      setIsSubmitting(false);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to submit batch",
      );
    }
  }, [publicKey, network, startPolling, isSubmitting, jobId, jobStatus]);

  return (
    <BatchFlowContext.Provider
      value={{
        step,
        setStep,
        selectedNetwork: network,
        setSelectedNetwork: selectNetwork,
        file,
        setFile,
        fileFormat,
        setFileFormat,
        validationResult,
        setValidationResult,
        validationError,
        setValidationError,
        summary,
        setSummary,
        isSubmitting,
        setIsSubmitting,
        hasActiveJob,
        result,
        setResult,
        jobId,
        setJobId,
        jobStatus,
        setJobStatus,
        completedBatches,
        setCompletedBatches,
        totalBatches,
        setTotalBatches,
        manualPayments,
        setManualPayments,
        entryMode,
        setEntryMode,
        skippedIndices,
        setSkippedIndices,
        convertedIndices,
        setConvertedIndices,
        batchMeta,
        setBatchMeta,
        batchMetaLoading,
        setBatchMetaLoading,
        estimatedFees,
        setEstimatedFees,
        onSkipToggle: handleSkipToggle,
        onConvertToggle: handleConvertToggle,
        handleRetryFailed,
        handleFileSelect,
        handleManualContinue,
        loadBatchMeta,
        onSubmit,
        handleRestore,
      }}
    >
      {children}
    </BatchFlowContext.Provider>
  );
}

export function useBatchFlow() {
  const context = useContext(BatchFlowContext);
  if (context === undefined) {
    throw new Error("useBatchFlow must be used within a BatchFlowProvider");
  }
  return context;
}
