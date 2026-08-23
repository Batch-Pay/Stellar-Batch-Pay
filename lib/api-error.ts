/**
 * Shared error-sanitization helpers for API routes (#748).
 *
 * Several money routes (batch-submit, batch-build, batch-retry,
 * batch-recover, batch-submit-signed, tx-status) used to catch arbitrary
 * Horizon/SDK exceptions and return `error.message` — and sometimes a raw
 * stack trace — straight to the client. That's an information-disclosure
 * risk: it hands an attacker Horizon/SDK internals, and occasionally
 * filesystem paths, useful for mapping out infrastructure and failure modes.
 *
 * The fix: routes must never forward a caught error's `message` or `stack`
 * to the client. Instead:
 *   - Full error detail (message, stack) is logged server-side via
 *     `logger.error`, tagged with a `requestId`.
 *   - The client only ever receives a stable public `code`, a generic
 *     `error` message, and that same `requestId` so support can correlate
 *     the report with the corresponding server-side log line.
 */

import { logger, type LogContext } from "@/lib/logger";
import { safeJsonResponse } from "@/lib/safe-json";

/** Stable, client-facing error codes. Never derived from the caught error. */
export type PublicErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

const PUBLIC_MESSAGE: Record<PublicErrorCode, string> = {
  BAD_REQUEST: "The request could not be processed.",
  UNAUTHORIZED: "Authentication is required.",
  FORBIDDEN: "You are not permitted to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  CONFLICT: "The request conflicts with existing state.",
  RATE_LIMITED: "Too many requests. Please try again later.",
  INTERNAL_ERROR:
    "An unexpected error occurred. Please try again or contact support.",
};

const STATUS_TO_CODE: Record<number, PublicErrorCode> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
};

/**
 * Resolve the request ID used for both the log line and the response body.
 *
 * Honors a caller-supplied `x-request-id` header (so a client-generated ID
 * threads end-to-end through logs) and otherwise mints a fresh UUID. Call
 * this once near the top of a route handler and reuse the same value for
 * every log call and error response in that handler.
 */
export function getRequestId(request: Request): string {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}

export interface SanitizedErrorOptions {
  /** The request ID to log alongside the error and echo back to the client. */
  requestId: string;
  /** HTTP status to respond with. Defaults to 500. */
  status?: number;
  /** Short, human-readable message for the server-side log line only. */
  logMessage: string;
  /** Override the stable public code (defaults to a mapping from `status`). */
  code?: PublicErrorCode;
  /** Override the public-facing message (defaults to a mapping from `code`). */
  publicMessage?: string;
  /** Extra structured log context (e.g. jobId, publicKey, network). */
  context?: LogContext;
  /**
   * Extra fields to merge into the response body alongside `error`, `code`,
   * and `requestId` (e.g. `{ success: false }` to match a route's existing
   * shape). Never put raw error detail here — it defeats the sanitization.
   */
  extraFields?: Record<string, unknown>;
}

/**
 * Log the full error server-side and return a sanitized client response.
 *
 * The response body is always exactly `{ error, code, requestId }` — never
 * the caught error's `message` or `stack`, and never a filesystem path.
 */
export function sanitizedErrorResponse(
  error: unknown,
  options: SanitizedErrorOptions,
) {
  const status = options.status ?? 500;
  const code = options.code ?? STATUS_TO_CODE[status] ?? "INTERNAL_ERROR";
  const publicMessage = options.publicMessage ?? PUBLIC_MESSAGE[code];

  logger.error(
    { requestId: options.requestId, ...options.context },
    options.logMessage,
    error,
  );

  return safeJsonResponse(
    {
      ...options.extraFields,
      error: publicMessage,
      code,
      requestId: options.requestId,
    },
    { status },
  );
}
