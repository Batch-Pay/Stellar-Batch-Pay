import { NextRequest } from "next/server";
import {
  getWebhooksRedacted,
  registerWebhook,
  unregisterWebhook,
  validateWebhookUrl,
} from "@/lib/webhooks";
import { safeJsonResponse } from "@/lib/safe-json";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

/**
 * Require an API key on every webhook CRUD operation (Issue #336).
 *
 * Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 * Returns a 401 response when no key is present.
 */
function requireApiKey(request: NextRequest): Response | null {
  const bearer = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  const hasKey =
    (bearer && bearer.startsWith("Bearer ") && bearer.slice(7).trim().length > 0) ||
    (apiKey && apiKey.trim().length > 0);

  if (!hasKey) {
    return safeJsonResponse(
      { error: "Unauthorized. An API key is required for webhook management." },
      { status: 401 },
    );
  }
  return null;
}

/**
 * GET /api/webhooks/register
 *
 * Returns registered webhooks with secrets stripped to an 8-char prefix.
 * Requires an API key so anonymous callers cannot enumerate registrations.
 */
export async function GET(request: NextRequest) {
  const authError = requireApiKey(request);
  if (authError) return authError;

  return safeJsonResponse({ webhooks: getWebhooksRedacted() });
}

/**
 * POST /api/webhooks/register
 *
 * Register a new webhook. Validates:
 *  - Rate limit (existing)
 *  - API key auth
 *  - URL is HTTPS and not RFC1918/localhost
 *  - `url` and `events` fields present
 *
 * Returns the full secret only on initial creation — it is never returned again.
 */
export async function POST(request: NextRequest) {
  const authError = requireApiKey(request);
  if (authError) return authError;

  const rate = await applyRateLimit(request, "webhook-register");
  if (rate.blocked) return rate.response!;

  try {
    const { url, events, secret } = await request.json();

    if (!url || !Array.isArray(events)) {
      return safeJsonResponse(
        { error: "Invalid request. 'url' and 'events' (array) are required." },
        { status: 400 },
      );
    }

    const urlError = validateWebhookUrl(url);
    if (urlError) {
      return setRateLimitHeaders(
        safeJsonResponse({ error: urlError }, { status: 422 }),
        rate,
      );
    }

    const webhook = registerWebhook(url, events, secret);

    // Return the full secret only here — it is never exposed via GET again.
    return setRateLimitHeaders(
      safeJsonResponse({ message: "Webhook registered successfully", webhook }, { status: 201 }),
      rate,
    );
  } catch {
    return setRateLimitHeaders(
      safeJsonResponse({ error: "Internal server error" }, { status: 500 }),
      rate,
    );
  }
}

/**
 * DELETE /api/webhooks/register?id=<webhook-id>
 *
 * Unregister a webhook by ID. Rate-limited to prevent enumeration attacks.
 * Requires an API key.
 */
export async function DELETE(request: NextRequest) {
  const authError = requireApiKey(request);
  if (authError) return authError;

  const rate = await applyRateLimit(request, "webhook-register");
  if (rate.blocked) return rate.response!;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return setRateLimitHeaders(
      safeJsonResponse({ error: "Missing webhook ID" }, { status: 400 }),
      rate,
    );
  }

  const success = unregisterWebhook(id);
  if (success) {
    return setRateLimitHeaders(
      safeJsonResponse({ message: "Webhook unregistered successfully" }),
      rate,
    );
  }

  return setRateLimitHeaders(
    safeJsonResponse({ error: "Webhook not found" }, { status: 404 }),
    rate,
  );
}
