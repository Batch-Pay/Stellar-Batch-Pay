import { NextRequest, NextResponse } from "next/server";
import { getWebhookDeliveries } from "@/lib/job-store";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";
import { requireWebhookAdminApiKey } from "@/lib/webhook-admin-auth";

export async function GET(request: NextRequest) {
  const authError = requireWebhookAdminApiKey(request);
  if (authError) return authError;

  const rate = await applyRateLimit(request, "webhook-deliveries");
  if (rate.blocked) return rate.response!;

  const { searchParams } = request.nextUrl;
  const jobId = searchParams.get("jobId") ?? undefined;
  const webhookId = searchParams.get("webhookId") ?? undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : 100;

  if (isNaN(limit) || limit < 1) {
    return setRateLimitHeaders(
      NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 }),
      rate,
    );
  }

  const deliveries = await getWebhookDeliveries({ jobId, webhookId, limit });
  return setRateLimitHeaders(NextResponse.json({ deliveries }), rate);
}
