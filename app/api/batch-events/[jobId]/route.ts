/**
 * Server-Sent Events endpoint for real-time batch job progress.
 *
 * GET /api/batch-events/:jobId?publicKey=...
 *
 * Streams job status updates as SSE events every second until the job
 * reaches a terminal state (completed/failed), then closes the stream.
 * The client falls back to polling /api/batch-status/:jobId if SSE is unavailable.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "stellar-sdk";
import { getJob } from "@/lib/job-store";
import { applyRateLimit } from "@/lib/api-rate-limit";

interface RouteParams {
  params: Promise<{ jobId: string }>;
}

const POLL_INTERVAL_MS = 1000;

function serializeJobEvent(job: Awaited<ReturnType<typeof getJob>>): string {
  if (!job) return "";
  const payload = JSON.stringify({
    jobId: job.jobId,
    status: job.status,
    totalBatches: job.totalBatches,
    completedBatches: job.completedBatches,
    totalPayments: job.payments.length,
    network: job.network,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  });
  return `data: ${payload}\n\n`;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const rate = await applyRateLimit(request, "batch-events");
  if (rate.blocked) return rate.response!;

  const { jobId } = await params;
  const publicKey = request.nextUrl.searchParams.get("publicKey");

  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(rate.remaining), "X-RateLimit-Limit": String(rate.limit), "X-RateLimit-Reset": String(rate.resetAt) },
    });
  }

  if (!publicKey || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return new Response(
      JSON.stringify({ error: "A valid publicKey query parameter is required" }),
      { status: 400, headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": String(rate.remaining), "X-RateLimit-Limit": String(rate.limit), "X-RateLimit-Reset": String(rate.resetAt) } },
    );
  }

  const encoder = new TextEncoder();
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const tick = async () => {
        try {
          const job = await getJob(jobId, publicKey);

          if (!job) {
            const errEvent = `data: ${JSON.stringify({ error: `Job not found: ${jobId}` })}\n\n`;
            controller.enqueue(encoder.encode(errEvent));
            if (intervalId) clearInterval(intervalId);
            controller.close();
            return;
          }

          const event = serializeJobEvent(job);
          controller.enqueue(encoder.encode(event));

          if (job.status === "completed" || job.status === "failed") {
            if (intervalId) clearInterval(intervalId);
            controller.close();
          }
        } catch {
          if (intervalId) clearInterval(intervalId);
          controller.close();
        }
      };

      tick();
      intervalId = setInterval(tick, POLL_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        if (intervalId) clearInterval(intervalId);
        controller.close();
      });
    },
    cancel() {
      if (intervalId) clearInterval(intervalId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
