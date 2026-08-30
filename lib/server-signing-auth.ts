/**
 * Server-signing authorization utility (#696, fail-closed hardening #728).
 *
 * When `ALLOW_SERVER_SIGNING=true`, callers must present a secret API key via
 * the `Authorization: Bearer <key>` header. The key is compared (timing-safe)
 * against the `SERVER_SIGNING_API_KEY` environment variable.
 *
 * Fail closed (#728): if `SERVER_SIGNING_API_KEY` is not set, requests are
 * REFUSED (403) rather than let through. Server-signing moves real funds from
 * a hot wallet, so an unset credential must never mean "no credential
 * required" — that previously let any caller who could reach the route
 * authorize spends with nothing but network access.
 *
 * The only way around that refusal is an explicit, narrow opt-in intended for
 * local demos: `SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true`. That opt-in is
 * itself refused whenever the process is running in production (see
 * `isProductionEnv` in `lib/secrets/index.ts`), so it can't accidentally ship
 * to a real deployment.
 */

import { timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";
import { isProductionEnv } from "@/lib/secrets/index";

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

  if (!apiKey) {
    // Narrow, explicit opt-in for local demos only. Refused outright in
    // production so it can never become an accidental production posture.
    const allowUnauthenticated =
      process.env.SERVER_SIGNING_ALLOW_UNAUTHENTICATED === "true" &&
      !isProductionEnv();

    if (allowUnauthenticated) {
      logger.warn(
        { requestId },
        "SERVER_SIGNING_API_KEY is not set. Accepting this server-signing " +
          "request WITHOUT credential verification because " +
          "SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true. This is intended for " +
          "local demos only — never set this in a deployed environment. " +
          "See DEPLOYMENT.md.",
      );
      return { valid: true };
    }

    // Fail closed (#728): server-signing moves real funds from a hot wallet,
    // so an unconfigured credential must refuse requests, not accept them.
    logger.error(
      { requestId },
      "SERVER_SIGNING_API_KEY is not set. Refusing server-signing request " +
        "(fail closed). Set SERVER_SIGNING_API_KEY to enable server-signing, " +
        "or, for local demos only, set " +
        "SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true (refused in production). " +
        "See DEPLOYMENT.md.",
    );
    return {
      valid: false,
      status: 403,
      error:
        "Server-signing is not authorized: SERVER_SIGNING_API_KEY is not " +
        "configured on the server. Refusing this request.",
    };
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
