import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { safeJsonResponse } from "@/lib/safe-json";

/**
 * Require the configured admin credential for webhook management and auditing.
 * Supports the same credential headers as the webhook management API.
 */
export function requireWebhookAdminApiKey(request: NextRequest): Response | null {
  const configuredKey = process.env.WEBHOOK_ADMIN_API_KEY;
  const authorization = request.headers.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(\S+)$/i);
  const providedKey = bearerMatch?.[1] ?? request.headers.get("x-api-key")?.trim();

  const configuredBuffer = configuredKey ? Buffer.from(configuredKey, "utf8") : null;
  const providedBuffer = providedKey ? Buffer.from(providedKey, "utf8") : null;
  const valid =
    configuredBuffer !== null &&
    providedBuffer !== null &&
    configuredBuffer.length === providedBuffer.length &&
    timingSafeEqual(configuredBuffer, providedBuffer);

  if (!valid) {
    return safeJsonResponse(
      { error: "Unauthorized. A valid webhook admin API key is required." },
      { status: configuredKey && providedKey ? 403 : 401 },
    );
  }

  return null;
}