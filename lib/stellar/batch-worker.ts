/**
 * Background worker for processing Stellar batch payments asynchronously.
 *
 * Called fire-and-forget from the batch-submit route. Updates job state
 * in the job store so the polling endpoint can track progress.
 * 
 * #337: Reads signedTransactions from job state for recovery after restart.
 */

import { StellarService } from "./server";
import { updateJob, getJob, incrementCompletedBatches, claimJobForProcessing } from "../job-store";
import { createBatches } from "./batcher";
import { getXdrSourceAccount, operationCountOf } from "./xdr-source";
import type {
  PaymentInstruction,
  BatchResult,
  PaymentResult,
  BatchJobNetwork,
} from "./types";
import { Horizon, TransactionBuilder, Networks } from "stellar-sdk";
import { sumStellarAmounts, formatStellarAmount } from "./utils";
import { computeTransactionHash, isTransportError, reconcileTransaction } from "./reconciliation";
import { horizonUrl } from "./network-config";
import { logger } from "../logger";
import { triggerWebhooksWithRetry } from "../webhooks";

/**
 * Process a batch job in the background. This function must NOT be awaited
 * by the caller — it runs asynchronously and updates job state via the store.
 * #300: Supports both server-side signing (via secretKey) and client-side signing (via signedTransactions).
 * #337: If signedTransactions are not provided, attempts to read them from the job state.
 */
export async function processJobInBackground(
  jobId: string,
  payments: PaymentInstruction[],
  network: BatchJobNetwork,
  secretKey?: string,
  signedTransactions?: string[],
  requestId?: string,
): Promise<void> {
  const MAX_OPS = 100;

  try {
    const job = await getJob(jobId);
    if (!job) {
      logger.warn({ requestId, jobId }, "Background worker: Job not found");
      return;
    }
    // Atomically claim the job. If claim fails, it means another worker is actively processing it or it is finished.
    const claimed = await claimJobForProcessing(jobId);
    if (!claimed) {
      logger.warn({ requestId, jobId, status: job.status }, "Background worker: Duplicate worker run detected. Job is already claimed, processing, or completed. Exiting early.");
      return;
    }

    logger.info({ requestId, jobId, publicKey: job.publicKey, network }, "Background job processing started");

    // #337: If signedTransactions not provided, try to load from job state
    let xdrs = signedTransactions;
    if (!xdrs || xdrs.length === 0) {
      if (job.signedTransactions && job.signedTransactions.length > 0) {
        xdrs = job.signedTransactions;
      }
    }

    // #515: If payments not provided or empty, try to recover from job state.
    // This ensures that restart-recovered pre-signed jobs still have recipient
    // metadata for history, retry, and export flows.
    if ((!payments || payments.length === 0) && job.payments && job.payments.length > 0) {
      payments = job.payments;
    }

    // Create server instance for fee fetching
    const server = new Horizon.Server(horizonUrl(network));

    // #300: Handle pre-signed transactions (client-side signing)
    if (xdrs && xdrs.length > 0) {
      await updateJob(jobId, {
        status: "processing",
        totalBatches: xdrs.length,
        completedBatches: 0,
      });

      const allResults: PaymentResult[] = [];
      let successCount = 0;
      let failCount = 0;
      // #512: track the real number of recipient operations across all XDRs so
      // totals reflect actual ops, not a "1 per transaction" heuristic.
      let totalOps = 0;
      const paymentsPerBatch = payments.length > 0 ? Math.min(MAX_OPS, payments.length) : 0;

      for (let i = 0; i < xdrs.length; i++) {
        const xdr = xdrs[i];
        const batchPayments = paymentsPerBatch
          ? payments.slice(i * paymentsPerBatch, Math.min((i + 1) * paymentsPerBatch, payments.length))
          : [];

        // Parse the envelope once. Done outside the submit try/catch so an
        // unparseable XDR is attributed as a single failed op rather than
        // crashing the loop.
        let tx;
        try {
          tx = TransactionBuilder.fromXDR(xdr, network === 'testnet' ? Networks.TESTNET : Networks.PUBLIC);
        } catch (error) {
          logger.error({ requestId, jobId, batchIndex: i }, "Failed to parse pre-signed XDR", error);
          failCount += 1;
          totalOps += 1;
          allResults.push({
            recipient: `tx-${i}`,
            amount: "0",
            asset: "XLM",
            status: "failed",
            error: error instanceof Error ? error.message : "Unparseable transaction XDR",
          });
          await incrementCompletedBatches(jobId);
          continue;
        }

        // #512: Attribute success/failure to the actual recipient operations.
        // When payment metadata is provided we count one result per payment;
        // otherwise (pure XDR submit, #300) we count the envelope's operations
        // so empty `payments` no longer collapses a multi-op tx to a single
        // success. Fall back to the payment slice (or 1) when the op count can
        // not be derived — e.g. older SDK shapes or mocked transactions.
        const opCount = operationCountOf(tx) ?? (batchPayments.length || 1);
        const recipientCount = batchPayments.length > 0 ? batchPayments.length : opCount;
        totalOps += recipientCount;

        // #504: Defense-in-depth — never submit an envelope whose source
        // account differs from the wallet that owns this job. The submit
        // route enforces this up-front, but a job recovered from storage is
        // re-checked here. Skipped when the source can't be determined (older
        // jobs without a publicKey, or unparseable XDR handled above).
        if (job.publicKey) {
          const source = getXdrSourceAccount(xdr, network);
          if (source !== undefined && source !== job.publicKey) {
            const mismatchError = `Transaction source account ${source} does not match job publicKey ${job.publicKey}`;
            if (batchPayments.length > 0) {
              for (const payment of batchPayments) {
                allResults.push({
                  recipient: payment.address,
                  amount: payment.amount,
                  asset: payment.asset,
                  status: "failed",
                  transactionHash: undefined,
                  error: mismatchError,
                });
              }
            } else {
              for (let j = 0; j < recipientCount; j++) {
                allResults.push({
                  recipient: `tx-${i}-op-${j}`,
                  amount: "0",
                  asset: "XLM",
                  status: "failed",
                  transactionHash: undefined,
                  error: mismatchError,
                });
              }
            }
            failCount += recipientCount;
            incrementCompletedBatches(jobId);
            continue;
          }
        }

        const txHash = computeTransactionHash(tx);

        try {
          const result = await server.submitTransaction(tx);
          const finalHash = result.hash || txHash;

          logger.info({ requestId, jobId, batchIndex: i, transactionHash: finalHash, operations: recipientCount }, "Batch transaction submitted successfully (pre-signed mode)");

          successCount += recipientCount;
          if (batchPayments.length > 0) {
            for (const payment of batchPayments) {
              allResults.push({
                recipient: payment.address,
                amount: payment.amount,
                asset: payment.asset,
                status: "success",
                transactionHash: finalHash,
              });
            }
          } else {
            for (let j = 0; j < recipientCount; j++) {
              allResults.push({
                recipient: `tx-${i}-op-${j}`,
                amount: "0",
                asset: "XLM",
                status: "success",
                transactionHash: finalHash,
              });
            }
          }
        } catch (error) {
          logger.error({ requestId, jobId, batchIndex: i }, "Batch transaction failed (pre-signed mode)", error);

          let reconciledStatus: "success" | "failed" | "unknown" = "failed";
          if (isTransportError(error)) {
            try {
              const rec = await reconcileTransaction(server, txHash);
              reconciledStatus = rec.status;
            } catch {
              reconciledStatus = "unknown";
            }
          }

          if (reconciledStatus === "success") {
            successCount += recipientCount;
            if (batchPayments.length > 0) {
              for (const payment of batchPayments) {
                allResults.push({
                  recipient: payment.address,
                  amount: payment.amount,
                  asset: payment.asset,
                  status: "success",
                  transactionHash: txHash,
                });
              }
            } else {
              for (let j = 0; j < recipientCount; j++) {
                allResults.push({
                  recipient: `tx-${i}-op-${j}`,
                  amount: "0",
                  asset: "XLM",
                  status: "success",
                  transactionHash: txHash,
                });
              }
            }
          } else {
            if (reconciledStatus !== "unknown") {
              failCount += recipientCount;
            }
            const errText =
              reconciledStatus === "unknown"
                ? `UNRECONCILED_SUBMISSION_ERROR: ${error instanceof Error ? error.message : "Unknown error"}`
                : (error instanceof Error ? error.message : "Unknown error");

            if (batchPayments.length > 0) {
              for (const payment of batchPayments) {
                allResults.push({
                  recipient: payment.address,
                  amount: payment.amount,
                  asset: payment.asset,
                  status: "failed",
                  transactionHash: txHash,
                  error: errText,
                });
              }
            } else {
              for (let j = 0; j < recipientCount; j++) {
                allResults.push({
                  recipient: `tx-${i}-op-${j}`,
                  amount: "0",
                  asset: "XLM",
                  status: "failed",
                  transactionHash: txHash,
                  error: errText,
                });
              }
            }
          }
        }

        await incrementCompletedBatches(jobId);
      }

      const finalStatus = successCount > 0 ? "completed" : "failed";
      const finalResult = {
        batchId: `batch-${Date.now()}`,
        // #512: when no payment metadata is supplied, recipients = real ops.
        totalRecipients: payments.length > 0 ? payments.length : totalOps,
        totalAmount: payments.length > 0
          ? formatStellarAmount(sumStellarAmounts(payments.map(p => p.amount)))
          : "0",
        totalTransactions: xdrs.length,
        network,
        timestamp: new Date().toISOString(),
        results: allResults,
        summary: {
          successful: successCount,
          failed: failCount,
        },
      };

      await updateJob(jobId, {
        status: finalStatus,
        result: finalResult,
      });

      logger.info({ requestId, jobId, status: finalStatus, summary: finalResult.summary }, "Background job processing finished (pre-signed mode)");

      if (finalStatus === "completed") {
        void triggerWebhooksWithRetry("batch.completed", {
          jobId,
          network,
          batchId: finalResult.batchId,
          summary: finalResult.summary,
        }, jobId);
      } else {
        void triggerWebhooksWithRetry("batch.failed", {
          jobId,
          network,
          batchId: finalResult.batchId,
          summary: finalResult.summary,
        }, jobId);
      }
      return;
    }

    // Standard payment-based flow (server-side signing)
    if (!secretKey) {
      throw new Error("secretKey is required for payment-based submissions");
    }

    // Compute batches up-front so we know totalBatches immediately
    const batches = await createBatches(payments, MAX_OPS, { network, server });

    await updateJob(jobId, {
      status: "processing",
      totalBatches: batches.length,
      completedBatches: 0,
    });

    const service = new StellarService({
      secretKey,
      network,
      maxOperationsPerTransaction: MAX_OPS,
    });

    const allResults: PaymentResult[] = [];
    let successCount = 0;
    let failCount = 0;
    const startTime = new Date().toISOString();

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      try {
        // Submit this pre-computed batch as exactly one Stellar transaction.
        // Must NOT call submitBatch here — that would re-run createBatches and
        // double-batch the payments, inflating fees and desyncing progress with
        // totalBatches (#503).
        const batchResult = await service.submitSingleBatch(batch.payments);

        let txHash: string | undefined;
        for (const r of batchResult.results) {
          allResults.push(r);
          if (r.status === "success") {
            successCount++;
            txHash = r.transactionHash;
          } else {
            failCount++;
          }
        }

        logger.info({ requestId, jobId, batchIndex: i, transactionHash: txHash }, "Batch transaction processed (server-signed mode)");
      } catch (error) {
        logger.error({ requestId, jobId, batchIndex: i }, "Batch transaction failed (server-signed mode)", error);
        for (const p of batch.payments) {
          allResults.push({
            recipient: p.address,
            amount: p.amount,
            asset: p.asset,
            status: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
          });
          failCount++;
        }
      }

      // Update progress after each batch completes
      await incrementCompletedBatches(jobId);
    }

    const totalAmount = formatStellarAmount(sumStellarAmounts(payments.map(p => p.amount)));

    const finalResult: BatchResult = {
      batchId: jobId,
      totalRecipients: payments.length,
      totalAmount: totalAmount,
      totalTransactions: batches.length,
      network,
      timestamp: startTime,
      submittedAt: new Date().toISOString(),
      results: allResults,
      summary: {
        successful: successCount,
        failed: failCount,
      },
    };

    const finalStatus = successCount > 0 ? "completed" : "failed";
    await updateJob(jobId, {
      status: finalStatus,
      result: finalResult,
    });

    logger.info({ requestId, jobId, status: finalStatus, summary: finalResult.summary }, "Background job processing finished (server-signed mode)");

    if (finalStatus === "completed") {
      void triggerWebhooksWithRetry("batch.completed", {
        jobId,
        network,
        batchId: finalResult.batchId,
        summary: finalResult.summary,
      }, jobId);
    } else {
      void triggerWebhooksWithRetry("batch.failed", {
        jobId,
        network,
        batchId: finalResult.batchId,
        summary: finalResult.summary,
      }, jobId);
    }
  } catch (error) {
    logger.error({ requestId, jobId }, "Background worker encountered error", error);
    await updateJob(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown worker error",
    });
    void triggerWebhooksWithRetry("batch.failed", {
      jobId,
      network,
      error: error instanceof Error ? error.message : "Unknown worker error",
    }, jobId);
  }
}
