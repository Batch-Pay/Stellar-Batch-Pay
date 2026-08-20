/**
 * API route for recovering failed batch operations (#276).
 *
 * GET /api/batch-recover?jobId=...
 *
 * Returns information about a previously submitted batch and identifies which
 * transactions failed or are still pending, allowing the user to retry only
 * the failed operations without risking double payments.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "stellar-sdk";
import { getJob } from "@/lib/job-store";
import { safeJsonResponse } from "@/lib/safe-json";
import { requireWalletAuth } from "@/lib/wallet-auth";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");

    if (!jobId || typeof jobId !== "string") {
      return NextResponse.json(
        { error: "jobId is required" },
        { status: 400 },
      );
    }

    const publicKey = searchParams.get("publicKey");
    if (!publicKey) {
      return NextResponse.json(
        { error: "publicKey is required" },
        { status: 400 },
      );
    }

    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return NextResponse.json(
        { error: "A valid publicKey is required" },
        { status: 400 },
      );
    }

    const auth = requireWalletAuth(request, publicKey);
    if (!auth.valid) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status ?? 401 },
      );
    }

    // Always scope lookup to the owning wallet — return 404 on mismatch to
    // avoid leaking whether a jobId exists at all (IDOR prevention, #538).
    const job = await getJob(jobId, publicKey);

    if (!job || !job.result) {
      return safeJsonResponse(
        {
          error: "Batch not found or not completed yet",
          jobId,
        },
        { status: 404 },
      );
    }

    const failedTransactions = job.result.results.filter((t) => t.status === "failed");
    const successfulTransactions = job.result.results.filter(
      (t) => t.status === "success",
    );

    return safeJsonResponse({
      success: true,
      batch: {
        jobId: job.jobId,
        network: job.network,
        createdAt: job.createdAt,
        totalPayments: job.result.results.length,
      },
      progress: {
        total: job.result.results.length,
        successful: successfulTransactions.length,
        failed: failedTransactions.length,
        percentComplete: Math.round(
          (successfulTransactions.length / job.result.results.length) * 100,
        ),
      },
      successfulTransactions,
      failedTransactions,
      ready: failedTransactions.length > 0,
    });
  } catch (error: unknown) {
    console.error("Batch recovery error:", error);

    return safeJsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to recover batch information",
      },
      { status: 500 },
    );
  }
}
