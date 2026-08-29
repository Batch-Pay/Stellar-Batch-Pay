/**
 * Server-signing authorization utility (#696).
 *
 * When `ALLOW_SERVER_SIGNING=true`, callers must present a secret API key via
 * the `Authorization: Bearer <key>` header. The key is compared (timing-safe)
 * against the `SERVER_SIGNING_API_KEY` environment variable.
 *
 * Backward-compatibility: if `SERVER_SIGNING_API_KEY` is not set, the check
 * is skipped (returns valid) but a deprecation warning is logged. Operators
 * should set the env var in every deployment where server signing is enabled.
 */

import { timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

export interface ServerSigningAuthResult {
  /** Whether the caller is authorized. */
  valid: boolean;
  /** HTTP status code to return when `valid` is false. */
  status?: 401 | 403;
  /** Human-readable error message when `valid` is false. */
  error?: string;
}

/**
 * Extract the bearer token from the `Authorization` header.
 * Returns `null` when the header is missing or malformed.
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Validate the server-signing authorization credential on an incoming request.
 *
 * @param authHeader - The raw `Authorization` header value from the request.
 * @param requestId - Optional request ID for structured log correlation.
 * @returns An object indicating whether the caller is authorized.
 */
export function validateServerSigningAuth(
  authHeader: string | null,
  requestId?: string | null,
): ServerSigningAuthResult {
  const apiKey = process.env.SERVER_SIGNING_API_KEY;

  // Backward-compat: if the operator has not configured an API key, allow the
  // request through but log a deprecation warning so they know to upgrade.
  if (!apiKey) {
    logger.warn(
      { requestId },
      "SERVER_SIGNING_API_KEY is not set. Server-signing requests are accepted " +
        "without credential verification. Set SERVER_SIGNING_API_KEY to enable " +
        "cryptographic authorization (see DEPLOYMENT.md).",
    );
    return { valid: true };
  }

  const token = extractBearerToken(authHeader);

  if (!token) {
    return {
      valid: false,
      status: 401,
      error:
        "Missing or malformed Authorization header. " +
        "Server-signing requests require an 'Authorization: Bearer <SERVER_SIGNING_API_KEY>' header.",
    };
  }

  // Timing-safe comparison to prevent timing side-channel attacks.
  const keyBuffer = Buffer.from(apiKey, "utf8");
  const tokenBuffer = Buffer.from(token, "utf8");

  if (
    keyBuffer.length !== tokenBuffer.length ||
    !timingSafeEqual(keyBuffer, tokenBuffer)
  ) {
    return {
      valid: false,
      status: 403,
      error:
        "Invalid server-signing API key. " +
        "The provided Authorization token does not match the configured SERVER_SIGNING_API_KEY.",
    };
  }

  return { valid: true };
}
