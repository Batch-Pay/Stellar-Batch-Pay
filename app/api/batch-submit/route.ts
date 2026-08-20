/**
 * API route for submitting batch payments to Stellar (async / non-blocking).
 *
 * Supports two modes:
 * 1. Server-side signing: Provide payments + STELLAR_SECRET_KEY env var
 * 2. Client-side signing: Provide pre-signed transaction envelopes (XDRs)
 *
 * Returns 202 Accepted immediately with a jobId.
 * Frontend polls /api/batch-status/:jobId for progress.
 *
 * Idempotency semantics (#502)
 * ────────────────────────────
 * Duplicate submissions are deduplicated by Idempotency-Key (or a request-body
 * hash) via createIdempotentJob. A replay does NOT just return the cached
 * response — it also *resumes processing* when the original job is stranded.
 *
 * If the original worker never ran (the fire-and-forget promise was lost on a
 * server restart) or crashed mid-job, the job is left "queued"/"processing"
 * with a stale updatedAt. On replay we reload the job and, when it is stranded,
 * re-invoke processJobInBackground so the batch actually executes. Terminal
 * jobs (completed/failed) are never re-processed, so a replay can never trigger
 * a double payout. The 202 body reports `replayed` and `workerRestarted` so the
 * client can tell whether processing was resumed.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { Keypair, StrKey } from "stellar-sdk";
import { validatePaymentInstructions } from "@/lib/stellar";
import { BatchMemoConflictError, createBatches } from "@/lib/stellar/batcher";
import { MAX_UPLOAD_ROWS } from "@/lib/stellar/parser";
import { safeJsonResponse } from "@/lib/safe-json";
import { createIdempotentJob, IdempotencyConflictError, getJob } from "@/lib/job-store";
import { processJobInBackground } from "@/lib/stellar/batch-worker";
import { findSourceMismatch, operationCountOf, networkPassphraseFor } from "@/lib/stellar/xdr-source";
import { TransactionBuilder } from "stellar-sdk";
import type {
  JobState,
  PaymentInstruction,
  BatchJobNetwork,
} from "@/lib/stellar/types";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";
import { canonicalizeIdempotencyPayload } from "@/lib/idempotency";
import { logger } from "@/lib/logger";
import { validateServerSigningAuth } from "@/lib/server-signing-auth";
import { getRequestId, sanitizedErrorResponse } from "@/lib/api-error";

interface RequestBody {
  payments?: PaymentInstruction[];
  network: BatchJobNetwork;
  publicKey: string;
  // #300: Support for client-side signed transactions (XDR format)
  signedTransactions?: string[];
  // Client-generated UUID; prevents duplicate batch creation on retries.
  idempotencyKey: string;
}

type BatchSubmitAcceptedResponse = {
  jobId: string;
  status: "queued";
  totalPayments?: number;
  totalTransactions?: number;
  message: string;
  // #502: present on every 202 so clients can tell whether this was a fresh
  // submission, a cached replay, and whether a stranded worker was resumed.
  replayed?: boolean;
  workerRestarted?: boolean;
};

const MAX_OPS = 100;

/**
 * A replayed job is "stranded" when it never reached a terminal state but its
 * worker is no longer making progress: either it is still "queued" (the
 * fire-and-forget worker was lost on a restart) or it has been "processing"
 * without any update for longer than the staleness window (the worker crashed
 * mid-job). A short window keeps us from racing a worker that is actively
 * running, while still recovering genuinely stuck batches. (#502)
 */
const REPLAY_STALE_MS = Number(
  process.env.IDEMPOTENCY_REPLAY_STALE_MS ?? 30_000,
);

function isStrandedJob(job: JobState | undefined): boolean {
  if (!job) return false;
  if (job.status !== "queued" && job.status !== "processing") return false;

  const age = Date.now() - new Date(job.updatedAt).getTime();
  return Number.isFinite(age) && age >= REPLAY_STALE_MS;
}

/**
 * On idempotent replay, resume processing when the original job is stranded.
 * Returns true when the worker was re-invoked.
 */
async function resumeStrandedReplay(
  jobId: string,
  restartWorker: () => void,
): Promise<boolean> {
  const job = await getJob(jobId);

  if (!isStrandedJob(job)) return false;

  restartWorker();
  return true;
}

function buildIdempotencyKey(body: RequestBody, headerKey: string | null): { idempotencyKey: string; requestHash: string } {
  const canonicalBody = canonicalizeIdempotencyPayload({
    payments: body.payments ?? null,
    network: body.network,
    publicKey: body.publicKey,
    signedTransactions: body.signedTransactions ?? null,
  });
  const requestHash = createHash("sha256").update(canonicalBody).digest("hex");
  return {
    idempotencyKey: headerKey?.trim() || requestHash,
    requestHash,
  };
}

export async function POST(request: NextRequest) {
  const rate = await applyRateLimit(request, "batch-submit");
  if (rate.blocked) return rate.response!;

  const requestId = getRequestId(request);

  try {
    // Parse request body
    const body = (await request.json()) as RequestBody;
    const { payments, signedTransactions, network, publicKey } = body;
    
    logger.info({ requestId, publicKey, network }, "API batch-submit handler started");

    const { idempotencyKey, requestHash } = buildIdempotencyKey(
      body,
      request.headers.get("Idempotency-Key"),
    );

    if (!publicKey || typeof publicKey !== "string") {
      logger.warn({ requestId }, "Missing publicKey in request");
      return NextResponse.json(
        { error: "publicKey is required" },
        { status: 400 },
      );
    }

    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      logger.warn({ requestId, publicKey }, "Invalid Stellar public key checksum provided");
      return NextResponse.json(
        { error: "Invalid Stellar public key checksum" },
        { status: 400 },
      );
    }

    // Validate network
    if (!["testnet", "mainnet"].includes(network)) {
      logger.warn({ requestId, network }, "Invalid network provided");
      return NextResponse.json(
        { error: "Invalid network: must be 'testnet' or 'mainnet'" },
        { status: 400 },
      );
    }

    // #300: Support two submission modes:
    // Mode 1: Client-side signed transactions (pre-signed XDRs)
    if (signedTransactions && signedTransactions.length > 0) {
      if (!Array.isArray(signedTransactions)) {
        logger.warn({ requestId }, "signedTransactions must be an array");
        return NextResponse.json(
          { error: "signedTransactions must be an array of XDR strings" },
          { status: 400 },
        );
      }

      if (signedTransactions.length > MAX_UPLOAD_ROWS) {
        logger.warn({ requestId, count: signedTransactions.length }, "signedTransactions exceeds MAX_UPLOAD_ROWS");
        return NextResponse.json(
          { error: `Batch exceeds the maximum of ${MAX_UPLOAD_ROWS} transactions per upload.` },
          { status: 400 },
        );
      }

      // #515: When payments are provided alongside signed XDRs, validate that
      // the payment count aligns with the total operations across all XDRs.
      // This ensures recipient-level metadata stays consistent with what the
      // network will execute.
      if (payments && payments.length > 0) {
        let totalOps = 0;
        for (const xdr of signedTransactions) {
          let tx;
          try {
            tx = TransactionBuilder.fromXDR(xdr, networkPassphraseFor(network));
          } catch {
            // If an XDR can't be parsed, skip op counting — the worker will
            // handle it. Don't fail the whole batch for one unparseable XDR.
            continue;
          }
          const count = operationCountOf(tx);
          totalOps += count ?? 1;
        }

        if (payments.length !== totalOps) {
          logger.warn(
            { requestId, paymentCount: payments.length, totalOps },
            "Payment count does not match total operations across signed XDRs",
          );
          return NextResponse.json(
            {
              error:
                `Payment count (${payments.length}) does not match total operations across signed XDRs (${totalOps}). ` +
                "When providing both payments and signedTransactions, the payment array must have one entry per operation.",
            },
            { status: 400 },
          );
        }
      }

      // #504: A pre-signed envelope must be signed by the wallet the job is
      // attributed to. Reject any XDR whose source account (or fee-bump inner
      // source) differs from publicKey before creating the job, so a client
      // cannot attribute another wallet's signed transaction to publicKey.
      const mismatch = findSourceMismatch(signedTransactions, publicKey, network);
      if (mismatch) {
        logger.warn(
          { requestId, publicKey, index: mismatch.index, source: mismatch.source },
          "Pre-signed transaction source does not match request publicKey",
        );
        return NextResponse.json(
          {
            error:
              "Signed transaction source account does not match publicKey. Pre-signed batches must be signed by the authenticated wallet.",
          },
          { status: 403 },
        );
      }

      // #515: Persist payments alongside signedTransactions so job history
      // shows real recipient addresses and retry/export flows have metadata.
      const storedPayments = payments ?? [];

      const outcome = await createIdempotentJob<BatchSubmitAcceptedResponse>({
        idempotencyKey,
        requestHash,
        payments: storedPayments,
        network,
        publicKey,
        signedTransactions,
        buildResponseBody: (jobId) => ({
          jobId,
          status: "queued",
          totalPayments: storedPayments.length > 0 ? storedPayments.length : undefined,
          totalTransactions: signedTransactions.length,
          message:
            "Pre-signed batch queued for processing. Poll /api/batch-status/" +
            jobId +
            " for progress.",
        }),
      });

      if (outcome.replayed) {
        const workerRestarted = await resumeStrandedReplay(outcome.jobId, () => {
          void processJobInBackground(outcome.jobId, storedPayments, network, undefined, signedTransactions, requestId || undefined);
        });
        logger.info({ requestId, jobId: outcome.jobId, publicKey, network, replayed: true, workerRestarted }, "Batch submit job replayed (pre-signed mode)");
        return setRateLimitHeaders(safeJsonResponse(
          { ...outcome.responseBody, replayed: true, workerRestarted },
          { status: 202 },
        ), rate);
      }

      void processJobInBackground(outcome.jobId, storedPayments, network, undefined, signedTransactions, requestId || undefined);

      logger.info({ requestId, jobId: outcome.jobId, publicKey, network, replayed: false }, "Batch submit job queued and background worker triggered (pre-signed mode)");
      return setRateLimitHeaders(safeJsonResponse(
        { ...outcome.responseBody, replayed: false, workerRestarted: false },
        { status: 202 },
      ), rate);
    }

    // Mode 2: Server-side signing (legacy, requires STELLAR_SECRET_KEY)
    if (!payments || payments.length === 0) {
      logger.warn({ requestId }, "Either payments or signedTransactions must be provided");
      return NextResponse.json(
        { error: "Either 'payments' or 'signedTransactions' must be provided" },
        { status: 400 },
      );
    }

    const allowServerSigning = process.env.ALLOW_SERVER_SIGNING === "true";
    if (!allowServerSigning) {
      logger.warn({ requestId }, "Server-side signing is disabled by server configuration");
      return NextResponse.json(
        {
          error:
            "Server-side signing is disabled. Use client-side signing with a connected wallet, or enable ALLOW_SERVER_SIGNING=true in server configuration.",
        },
        { status: 403 },
      );
    }

    // #696: Require cryptographic authorization for server-signing requests.
    // The caller must present a valid API key via the Authorization header.
    const authResult = validateServerSigningAuth(
      request.headers.get("authorization"),
      requestId,
    );
    if (!authResult.valid) {
      logger.warn({ requestId }, `Server-signing auth rejected: ${authResult.error}`);
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status ?? 403 },
      );
    }

    // Get secret key from environment
    const secretKey = process.env.STELLAR_SECRET_KEY;
    if (!secretKey) {
      logger.error({ requestId }, "STELLAR_SECRET_KEY is not configured on server");
      return NextResponse.json(
        { error: "STELLAR_SECRET_KEY is not configured. Please configure server-side signing or use client-side signing." },
        { status: 500 },
      );
    }

    const signingPublicKey = Keypair.fromSecret(secretKey).publicKey();
    if (signingPublicKey !== publicKey) {
      logger.warn({ requestId, publicKey, signingPublicKey }, "Request publicKey does not match server signing key");
      return NextResponse.json(
        {
          error:
            "Server-side signing is bound to the configured STELLAR_SECRET_KEY and must match the request publicKey.",
        },
        { status: 403 },
      );
    }

    // Validate input
    if (!Array.isArray(payments) || payments.length === 0) {
      logger.warn({ requestId }, "payments must be a non-empty array");
      return NextResponse.json(
        { error: "Invalid request: payments must be a non-empty array" },
        { status: 400 },
      );
    }

    if (payments.length > MAX_UPLOAD_ROWS) {
      logger.warn({ requestId, count: payments.length }, "payments exceeds MAX_UPLOAD_ROWS");
      return NextResponse.json(
        { error: `Batch exceeds the maximum of ${MAX_UPLOAD_ROWS} payments per upload.` },
        { status: 400 },
      );
    }

    // Validate payments
    const validation = validatePaymentInstructions(payments);
    if (!validation.valid) {
      const errors = Array.from(validation.errors.entries())
        .map(([idx, err]) => `Row ${idx + 1}: ${err}`)
        .slice(0, 5);
      logger.warn({ requestId, validationErrors: errors }, "Invalid payment instructions validation failure");
      return NextResponse.json(
        { error: `Invalid payment instructions: ${errors.join("; ")}` },
        { status: 400 },
      );
    }

    try {
      await createBatches(payments, MAX_OPS, { network });
    } catch (error) {
      if (error instanceof BatchMemoConflictError) {
        logger.warn({ requestId, error: error.message }, "Batch memo validation failure");
        return NextResponse.json(
          { error: error.message },
          { status: 400 },
        );
      }

      throw error;
    }

    const outcome = await createIdempotentJob<BatchSubmitAcceptedResponse>({
      idempotencyKey,
      requestHash,
      payments,
      network,
      publicKey,
      buildResponseBody: (jobId) => ({
        jobId,
        status: "queued",
        totalPayments: payments.length,
        message:
          "Batch queued for processing. Poll /api/batch-status/" +
          jobId +
          " for progress.",
      }),
    });

    if (outcome.replayed) {
      const workerRestarted = await resumeStrandedReplay(outcome.jobId, () => {
        void processJobInBackground(outcome.jobId, payments, network, secretKey, undefined, requestId || undefined);
      });
      logger.info({ requestId, jobId: outcome.jobId, publicKey, network, replayed: true, workerRestarted }, "Batch submit job replayed (server-signed mode)");
      return setRateLimitHeaders(safeJsonResponse(
        { ...outcome.responseBody, replayed: true, workerRestarted },
        { status: 202 },
      ), rate);
    }

    // Fire-and-forget: start background processing without awaiting
    void processJobInBackground(outcome.jobId, payments, network, secretKey, undefined, requestId || undefined);

    logger.info({ requestId, jobId: outcome.jobId, publicKey, network, replayed: false }, "Batch submit job queued and background worker triggered (server-signed mode)");
    // Return 202 Accepted with the job ID for polling
    return setRateLimitHeaders(safeJsonResponse(
      { ...outcome.responseBody, replayed: false, workerRestarted: false },
      { status: 202 },
    ), rate);
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      logger.warn({ requestId }, `Idempotency conflict: ${error.message}`);
      return setRateLimitHeaders(safeJsonResponse(
        { error: error.message, code: "CONFLICT", requestId },
        { status: 409 },
      ), rate);
    }

    return setRateLimitHeaders(
      sanitizedErrorResponse(error, {
        requestId,
        status: 500,
        logMessage: "Batch submission error",
      }),
      rate,
    );
  }
}
