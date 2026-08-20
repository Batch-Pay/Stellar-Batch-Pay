import { NextRequest, NextResponse } from "next/server";
import { getWebhookDeliveries } from "@/lib/job-store";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const jobId = searchParams.get("jobId") ?? undefined;
  const webhookId = searchParams.get("webhookId") ?? undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 500) : 100;

  if (isNaN(limit) || limit < 1) {
    return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 });
  }

  const deliveries = await getWebhookDeliveries({ jobId, webhookId, limit });
  return NextResponse.json({ deliveries });
}
