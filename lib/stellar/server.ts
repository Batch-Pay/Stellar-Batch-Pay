/**
 * Server-only utilities for Stellar operations
 * This file is only executed on the server and should never be imported in client components
 */

import {
  Account,
  Keypair,
  TransactionBuilder,
  Networks,
  Asset as StellarAsset,
  Operation,
  Horizon,
  Memo,
} from "stellar-sdk";

import {
  PaymentInstruction,
  BatchResult,
  PaymentResult,
  BatchConfig,
} from "./types";

import { createBatches } from "./batcher";
import {
  validatePaymentInstruction,
  validateBatchConfig,
} from "./validator";
import { getRecommendedFee } from "./fee-service";
import { isBadSequenceError } from "./submit-errors";
import { computeTransactionHash, isTransportError, reconcileTransaction } from "./reconciliation";
import { horizonUrl } from "./network-config";
import Big from "big.js";
import { parseStellarAmount, formatStellarAmount, parseAsset, truncateMemoToBytes } from "./utils";
export { parseAsset };

const BAD_SEQUENCE_RETRY_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.STELLAR_BAD_SEQUENCE_RETRY_LIMIT ?? "3", 10) || 3,
);

export class StellarService {
  private keypair: Keypair;
  private server: Horizon.Server;
  private network: "testnet" | "mainnet";
  private maxOperationsPerTransaction: number;

  constructor(config: BatchConfig) {
    const validation = validateBatchConfig(config);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    this.keypair = Keypair.fromSecret(config.secretKey);
    if (config.network !== "testnet" && config.network !== "mainnet") {
      throw new Error("StellarService only supports testnet and mainnet");
    }
    this.network = config.network;
    this.maxOperationsPerTransaction = config.maxOperationsPerTransaction;

    this.server = new Horizon.Server(horizonUrl(config.network));
  }

  /**
   * Build the memo for a single transaction. Uses the first payment that
   * carries a memo, otherwise falls back to a system-generated tracking memo.
   * Stellar supports only one memo per transaction.
   */
  private buildBatchMemo(batchPayments: PaymentInstruction[], txIndex: number): Memo {
    const firstMemoPayment = batchPayments.find((p) => p.memo);
    if (firstMemoPayment?.memo) {
      const memoType = firstMemoPayment.memoType ?? "text";
      return memoType === "id"
        ? Memo.id(firstMemoPayment.memo)
        : Memo.text(truncateMemoToBytes(firstMemoPayment.memo));
    }
    const memoId = `bp-${Date.now()}-${txIndex}`;
    return Memo.text(truncateMemoToBytes(memoId));
  }

  /**
   * Build, sign, and submit exactly ONE Stellar transaction for the given
   * payments — performs NO further batching. The caller supplies an already
   * loaded source account and fee. On success the source account's local
   * sequence number is incremented so it can be reused for the next
   * transaction. (#503)
   *
   * Returns the per-payment results, the total amount of the operations that
   * were added to the envelope, whether a transaction was actually submitted,
   * and whether the source account must be reloaded before the next submission
   * (after a bad-sequence error).
   */
  private async submitOneTransaction(
    batchPayments: PaymentInstruction[],
    sourceAccount: Account,
    fee: number,
    txIndex: number,
  ): Promise<{
    results: PaymentResult[];
    submitted: boolean;
    totalAmount: Big;
    needsReload: boolean;
  }> {
    const results: PaymentResult[] = [];
    // Indices into `results` of placeholders for operations actually added to
    // this transaction. Validation/asset-parse failures are pushed to `results`
    // too but are NOT added to the builder, so they must be excluded from the
    // success/error updates below (#389).
    const addedResultIndices: number[] = [];
    let totalAmountBig = new Big(0);

    let builder = new TransactionBuilder(sourceAccount, {
      fee: String(fee),
      networkPassphrase:
        this.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC,
    }).addMemo(this.buildBatchMemo(batchPayments, txIndex));

    for (const payment of batchPayments) {
      const validation = validatePaymentInstruction(payment);

      if (!validation.valid) {
        results.push({
          recipient: payment.address,
          amount: payment.amount,
          asset: payment.asset,
          status: "failed",
          transactionHash: undefined,
          error: validation.error,
          rowIndex: payment.rowIndex,
        });
        continue;
      }

      // Parse Stellar asset correctly
      let asset: StellarAsset;
      try {
        asset = parseAsset(payment.asset);
      } catch (err) {
        results.push({
          recipient: payment.address,
          amount: payment.amount,
          asset: payment.asset,
          status: "failed",
          transactionHash: undefined,
          error: err instanceof Error ? err.message : "Invalid asset",
          rowIndex: payment.rowIndex,
        });
        continue;
      }

      builder = builder.addOperation(
        Operation.payment({
          destination: payment.address,
          asset,
          amount: payment.amount,
        }),
      );

      totalAmountBig = totalAmountBig.plus(parseStellarAmount(payment.amount));

      // Add a placeholder result (status updated after submission)
      results.push({
        recipient: payment.address,
        amount: payment.amount,
        asset: payment.asset,
        status: "failed",
        transactionHash: undefined,
        rowIndex: payment.rowIndex,
      });
      addedResultIndices.push(results.length - 1);
    }

    // Every payment in this batch was invalid — nothing to submit.
    // (TransactionBuilder.build() throws with zero operations.)
    if (addedResultIndices.length === 0) {
      return { results, submitted: false, totalAmount: totalAmountBig, needsReload: false };
    }

    // Pre-compute transaction hash before sending to Horizon (#697)
    const transaction = builder.setTimeout(300).build();
    transaction.sign(this.keypair);
    const txHash = computeTransactionHash(transaction);

    // Assign transactionHash to all operations in this batch upfront
    for (const i of addedResultIndices) {
      results[i].transactionHash = txHash;
    }

    try {
      const result = await this.server.submitTransaction(transaction);
      sourceAccount.incrementSequenceNumber();

      // Mark only the operations that were actually included in this
      // transaction as successful. Validation failures keep their own
      // status/error and must never be flipped to success (#389).
      for (const i of addedResultIndices) {
        results[i].status = "success";
        results[i].transactionHash = result.hash || txHash;
      }

      return { results, submitted: true, totalAmount: totalAmountBig, needsReload: false };
    } catch (error) {
      // #697: Handle transport-level errors by reconciling transaction status against Horizon
      const isTransport = isTransportError(error);
      let reconciledStatus: "success" | "failed" | "unknown" = "failed";

      if (isTransport) {
        try {
          const rec = await reconcileTransaction(this.server, txHash);
          reconciledStatus = rec.status;
          if (rec.status === "success") {
            sourceAccount.incrementSequenceNumber();
          }
        } catch {
          reconciledStatus = "unknown";
        }
      }

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      for (const i of addedResultIndices) {
        results[i].status = reconciledStatus;
        results[i].error =
          reconciledStatus === "unknown"
            ? `UNRECONCILED_SUBMISSION_ERROR: ${errorMessage}`
            : errorMessage;
      }

      return {
        results,
        submitted: reconciledStatus === "success",
        totalAmount: totalAmountBig,
        needsReload: isBadSequenceError(error),
      };
    }
  }

  /**
   * Assemble a BatchResult envelope from accumulated per-transaction state.
   */
  private buildBatchResult(
    instructionCount: number,
    results: PaymentResult[],
    txCount: number,
    totalAmountBig: Big,
    startTime: Date,
  ): BatchResult {
    return {
      batchId: `batch-${Date.now()}`,
      totalRecipients: instructionCount,
      totalAmount: formatStellarAmount(totalAmountBig),
      totalTransactions: txCount,
      results,
      summary: {
        successful: results.filter((r) => r.status === "success").length,
        failed: results.filter((r) => r.status === "failed").length,
      },
      timestamp: startTime.toISOString(),
      submittedAt: new Date().toISOString(),
      network: this.network,
    };
  }

  /**
   * Submit a batch of payments to the Stellar network.
   *
   * Convenience wrapper that performs its own batching: splits `instructions`
   * into transaction-sized chunks via createBatches and submits each as one
   * transaction. Intended for the CLI and tests. The background worker, which
   * already batches up-front, must use {@link submitSingleBatch} instead to
   * avoid double-batching. (#503)
   */
  async submitBatch(
    instructions: PaymentInstruction[],
  ): Promise<BatchResult> {
    const startTime = new Date();

    try {
      // Load source account
      let sourceAccount: Account = await this.server.loadAccount(
        this.keypair.publicKey(),
      );

      // Fetch dynamic fee from Horizon
      const fee = await getRecommendedFee(this.server);

      // Create batches
      const batches = await createBatches(
        instructions,
        this.maxOperationsPerTransaction,
        { network: this.network, server: this.server },
      );

      const results: PaymentResult[] = [];
      let txCount = 0;
      let totalAmountBig = new Big(0);

      for (const batch of batches) {
        let retries = 0;
        let outcome;

        while (true) {
          outcome = await this.submitOneTransaction(
            batch.payments,
            sourceAccount,
            fee,
            txCount,
          );

          if (outcome.needsReload && retries < BAD_SEQUENCE_RETRY_LIMIT) {
            retries++;
            sourceAccount = await this.server.loadAccount(this.keypair.publicKey());
            continue;
          }
          break;
        }

        results.push(...outcome.results);
        totalAmountBig = totalAmountBig.plus(outcome.totalAmount);
        if (outcome.submitted) {
          txCount++;
        }
      }

      return this.buildBatchResult(
        instructions.length,
        results,
        txCount,
        totalAmountBig,
        startTime,
      );
    } catch (error) {
      throw new Error(
        `Batch submission failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /**
   * Submit a single, pre-sized batch as exactly ONE Stellar transaction.
   *
   * Unlike {@link submitBatch}, this performs NO internal re-batching — the
   * caller is responsible for ensuring `payments` already fits within Stellar's
   * per-transaction limits (e.g. via createBatches). The background worker uses
   * this so that the number of Horizon submissions matches the job's
   * totalBatches and fees are not inflated by a second batching pass. (#503)
   */
  async submitSingleBatch(
    payments: PaymentInstruction[],
  ): Promise<BatchResult> {
    const startTime = new Date();

    try {
      const sourceAccount: Account = await this.server.loadAccount(
        this.keypair.publicKey(),
      );
      const fee = await getRecommendedFee(this.server);

      const outcome = await this.submitOneTransaction(
        payments,
        sourceAccount,
        fee,
        0,
      );

      return this.buildBatchResult(
        payments.length,
        outcome.results,
        outcome.submitted ? 1 : 0,
        outcome.totalAmount,
        startTime,
      );
    } catch (error) {
      throw new Error(
        `Batch submission failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  /**
   * Get the public key of the account
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }
}
