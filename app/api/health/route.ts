import { NextRequest, NextResponse } from "next/server";
import { checkPersistenceHealth } from "@/lib/persistence-health";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

export async function GET(request: NextRequest) {
  const rate = await applyRateLimit(request, "health");
  if (rate.blocked) return rate.response!;

  const health = await checkPersistenceHealth();
  return setRateLimitHeaders(
    NextResponse.json(health, { status: health.ok ? 200 : 503 }),
    rate,
  );
}
