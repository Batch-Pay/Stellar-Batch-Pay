import { NextRequest, NextResponse } from "next/server";
import { checkPersistenceHealth, checkDeepHealth } from "@/lib/persistence-health";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

export async function GET(request: NextRequest) {
  const rate = await applyRateLimit(request, "health");
  if (rate.blocked) return rate.response!;

  const { searchParams } = new URL(request.url);
  const shallow = searchParams.get("shallow") === "true" || searchParams.get("type") === "liveness";
  const deep = searchParams.get("deep") === "true" || searchParams.get("check") === "deep";

  const probeCredential = process.env.HEALTH_PROBE_CREDENTIAL;
  const requestCredential = request.headers.get("x-probe-credential") || searchParams.get("credential");
  const probeCredentialPresent = !!probeCredential && requestCredential === probeCredential;

  let health;
  if (deep) {
    health = await checkDeepHealth(probeCredentialPresent);
  } else if (shallow) {
    health = await checkPersistenceHealth(true);
  } else {
    health = await checkPersistenceHealth(false);
  }

  return setRateLimitHeaders(
    NextResponse.json(health, { status: health.ok ? 200 : 503 }),
    rate,
  );
}
