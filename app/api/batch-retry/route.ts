/**
 * API route for retrying only failed payments from a completed batch.
 *
 * POST /api/batch-retry
 * {
 *   jobId: string,
 *   publicKey: string
 * }
 *
 * Security: server-signed retry is gated on the caller supplying the public key
 * that matches the configured STELLAR_SECRET_KEY. This prevents an attacker from
 * using a job they own to drain the server wallet (#711).
 */

import { NextRequest, NextResponse } from "next/server";
import { Keypair, StrKey } from "stellar-sdk";
import {
  createIdempotentJob,
  getJob,
  IdempotencyConflictError,
} from "@/lib/job-store";
import { processJobInBackground } from "@/lib/stellar/batch-worker";
import { safeJsonResponse } from "@/lib/safe-json";
import { logger } from "@/lib/logger";
import { createHash } from "crypto";
import { validateServerSigningAuth } from "@/lib/server-signing-auth";
import { getRequestId, sanitizedErrorResponse } from "@/lib/api-error";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

/**
 * Derive the public key from a secret and return it, or return null if the
 * secret is not a valid Stellar secret seed. Avoids throwing across call sites.
 */
function derivePublicKey(secret: string): string | null {
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    return null;
  }
}

/**
 * Generate a SHA-256 hash of the request body for idempotency conflict
 * detection. The same idempotency key paired with a different body is rejected.
 */
function hashRequestBody(body: { jobId: string; publicKey: string }): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export async function POST(request: NextRequest) {
  // #743: retry can enqueue paid work (server-signed transactions), so it
  // gets the same rate-limit treatment as batch-submit before any other
  // processing happens. Every response path below — success, validation
  // error, or failure — carries the resulting rate-limit headers.
  const rate = await applyRateLimit(request, "batch-retry");
  if (rate.blocked) return rate.response!;

  const response = await handleRetry(request);
  return setRateLimitHeaders(response, rate);
}

async function handleRetry(request: NextRequest): Promise<NextResponse> {
  const requestId = getRequestId(request);
  // Declared here so the catch block can reference it for logging (#515).
  let jobId: string | undefined;

  try {
    const body = (await request.json()) as {
      jobId?: string;
      publicKey?: string;
    };
    jobId = body.jobId;
    const publicKey = body.publicKey;

    // Derive idempotency key early so it is available regardless of which
    // validation branch we hit. An explicit header takes precedence over the
    // derived fallback (#550).
    const idempotencyKey =
      request.headers.get("Idempotency-Key") ??
      createHash("sha256").update(`${jobId}-${publicKey}`).digest("hex");

    if (!jobId || typeof jobId !== "string") {
      logger.warn({ requestId }, "Missing jobId in retry request");
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }

    // Validate the public key format before any store lookups (#388).
    if (
      !publicKey ||
      typeof publicKey !== "string" ||
      !StrKey.isValidEd25519PublicKey(publicKey)
    ) {
      logger.warn(
        { requestId, jobId },
        "Missing or invalid publicKey in retry request",
      );
      return NextResponse.json(
        { error: "A valid publicKey is required" },
        { status: 400 },
      );
    }

    logger.info({ requestId, jobId }, "Batch retry handler started");

    if (process.env.ALLOW_SERVER_SIGNING !== "true") {
      logger.warn(
        { requestId, jobId },
        "Server-side signing is disabled for retry",
      );
      return NextResponse.json(
        {
          error:
            "Server-side retry is disabled. Enable ALLOW_SERVER_SIGNING=true in server configuration to retry failed payments from stored jobs.",
        },
        { status: 403 },
      );
    }

    // #696: Require cryptographic authorization for server-signing requests.
    const authResult = validateServerSigningAuth(
      request.headers.get("authorization"),
      requestId,
    );
    if (!authResult.valid) {
      logger.warn(
        { requestId, jobId },
        `Server-signing auth rejected: ${authResult.error}`,
      );
      return NextResponse.json(
        { error: authResult.error },
        { status: authResult.status ?? 403 },
      );
    }

    const secretKey = process.env.STELLAR_SECRET_KEY;
    if (!secretKey) {
      logger.error(
        { requestId, jobId },
        "STELLAR_SECRET_KEY is not configured for retry",
      );
      return NextResponse.json(
        {
          error:
            "STELLAR_SECRET_KEY is not configured. Retry cannot proceed without server-side signing credentials.",
        },
        { status: 500 },
      );
    }

    // Derive the server signing account's public key from the secret.
    // (#711) This must match the caller's publicKey before we touch the job
    // store. Trusting only the request body would let any wallet trigger a
    // server-funded retry for their own (foreign) failed job.
    const serverPublicKey = derivePublicKey(secretKey);
    if (!serverPublicKey) {
      logger.error(
        { requestId, jobId },
        "STELLAR_SECRET_KEY is malformed or invalid",
      );
      return NextResponse.json(
        { error: "Server signing key configuration is invalid." },
        { status: 500 },
      );
    }

    if (serverPublicKey !== publicKey) {
      logger.warn(
        { requestId, jobId, publicKey },
        "Retry publicKey does not match server signing account",
      );
      return NextResponse.json(
        {
          error:
            "Server-side signing is bound to the configured STELLAR_SECRET_KEY. " +
            "The publicKey in this request does not match the server signing account.",
        },
        { status: 403 },
      );
    }

    const job = await getJob(jobId, publicKey);
    if (!job || !job.result) {
      logger.warn({ requestId, jobId }, "Batch job not found or not completed");
      return NextResponse.json(
        { error: "Batch job not found or not completed yet" },
        { status: 404 },
      );
    }

    // Belt-and-suspenders: the server signing account must also be recorded
    // as the original job owner. Rejects any job submitted by a different
    // wallet even if it somehow passed the key check above (#711).
    if (job.publicKey !== serverPublicKey) {
      logger.warn(
        { requestId, jobId, jobOwner: job.publicKey },
        "Job owner does not match server signing account; refusing server-funded retry",
      );
      return NextResponse.json(
        {
          error:
            "Server-side retry is only permitted for jobs that were originally submitted by the server signing account.",
        },
        { status: 403 },
      );
    }

    // #697: Block retries for rows that are still waiting on Horizon
    // confirmation. Only rows with status=failed are safe to retry.
    const hasUnreconciledRows = job.result.results.some(
      (r) =>
        r.status === "unknown" ||
        r.error?.startsWith("UNRECONCILED_SUBMISSION_ERROR"),
    );
    if (hasUnreconciledRows) {
      logger.warn(
        { requestId, jobId },
        "Retry blocked because Horizon reconciliation is still pending",
      );
      return NextResponse.json(
        {
          error:
            "Retry is not available while Horizon reconciliation is pending",
        },
        { status: 400 },
      );
    }

    const failedResults = job.result.results.filter(
      (r) => r.status === "failed",
    );
    if (failedResults.length === 0) {
      logger.warn(
        { requestId, jobId },
        "No confirmed failed payments available to retry",
      );
      return NextResponse.json(
        {
          error:
            "No failed payments available for retry (or payments are pending Horizon reconciliation)",
        },
        { status: 400 },
      );
    }

    // #515: Pre-signed batches with preserved payment metadata can be
    // retried just like server-signed batches. Only block when there is
    // genuinely no stored payment list.
    if (!job.payments || job.payments.length === 0) {
      logger.warn(
        { requestId, jobId },
        "Retry not available - no payment metadata preserved",
      );
      return NextResponse.json(
        {
          error:
            "Retry is not available for this batch because no payment metadata was preserved. " +
            "Re-submit the original payments with signedTransactions to enable retry support.",
        },
        { status: 400 },
      );
    }

    // #397: Reconstruct the subset of payments that need to be retried.
    // Prefer rowIndex-based matching (stable even with repeated amounts or
    // addresses); fall back to triple-key matching for legacy jobs.
    const failedByRowIndex = new Set<number>();
    const failedPaymentsMap = new Map<string, number>();

    for (const result of failedResults) {
      if (result.rowIndex !== undefined) {
        failedByRowIndex.add(result.rowIndex);
      } else {
        const key = JSON.stringify({
          address: result.recipient,
          amount: result.amount,
          asset: result.asset,
        });
        failedPaymentsMap.set(key, (failedPaymentsMap.get(key) ?? 0) + 1);
      }
    }

    const failedPayments = job.payments.filter((payment) => {
      if (payment.rowIndex !== undefined) {
        return failedByRowIndex.has(payment.rowIndex);
      }
      const key = JSON.stringify({
        address: payment.address,
        amount: payment.amount,
        asset: payment.asset,
      });
      const count = failedPaymentsMap.get(key) ?? 0;
      if (count > 0) {
        failedPaymentsMap.set(key, count - 1);
        return true;
      }
      return false;
    });

    if (failedPayments.length === 0) {
      logger.error(
        { requestId, jobId },
        "Failed to map failed results to original payments",
      );
      return NextResponse.json(
        { error: "Could not map failed results back to original payments" },
        { status: 500 },
      );
    }

    const requestHash = hashRequestBody({ jobId, publicKey });

    // Create or replay the idempotent retry job (#550).
    const idempotentResult = await createIdempotentJob({
      idempotencyKey,
      requestHash,
      payments: failedPayments,
      network: job.network,
      publicKey: job.publicKey,
      buildResponseBody: (retryJobId) => ({
        jobId: retryJobId,
        originalJobId: job.jobId,
        failedPayments: failedPayments.length,
        message:
          "Retry job queued. Poll /api/batch-status/" +
          retryJobId +
          " for progress.",
      }),
    });

    if (!idempotentResult.replayed) {
      void processJobInBackground(
        idempotentResult.jobId,
        failedPayments,
        job.network,
        secretKey,
        undefined,
        requestId || undefined,
      );
      logger.info(
        { requestId, jobId, retryJobId: idempotentResult.jobId },
        "Retry job successfully created and triggered",
      );
    } else {
      logger.info(
        { requestId, jobId, retryJobId: idempotentResult.jobId },
        "Retry request replayed - returning existing job",
      );
    }

    return safeJsonResponse(idempotentResult.responseBody, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof IdempotencyConflictError) {
      logger.warn(
        { requestId, jobId },
        "Idempotency key reused with different body",
      );
      return NextResponse.json(
        {
          error: "Idempotency key already exists for a different request body",
          code: "CONFLICT",
          requestId,
        },
        { status: 409 },
      );
    }

    return sanitizedErrorResponse(error, {
      requestId,
      status: 500,
      logMessage: "Batch retry error",
      context: { jobId },
    });
  }
}