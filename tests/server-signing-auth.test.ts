/**
 * Unit tests for server-signing authorization utility (#696, fail-closed #728).
 *
 * Verifies that the HMAC-based API key check works correctly:
 * - Missing env var → fail closed (403), unless the narrow local-demo opt-in
 *   is set (and even then, refused in production)
 * - Correct key → pass
 * - Missing Authorization header → 401
 * - Wrong key → 403
 * - Length-mismatched key → 403 (timing-safe)
 */

import { describe, expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { validateServerSigningAuth } from "@/lib/server-signing-auth";
import { logger } from "@/lib/logger";

const TEST_API_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

beforeEach(() => {
  delete process.env.SERVER_SIGNING_API_KEY;
  delete process.env.SERVER_SIGNING_ALLOW_UNAUTHENTICATED;
  delete process.env.BATCHPAY_ENV;
  // NODE_ENV is typed read-only by @types/node; vi.stubEnv is the
  // vitest-supported way to override it per-test (auto-restored below).
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("validateServerSigningAuth (#728 fail-closed)", () => {
  test("refuses (403) when SERVER_SIGNING_API_KEY is not set", () => {
    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/SERVER_SIGNING_API_KEY is not configured/i);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.stringContaining("Refusing server-signing request"),
    );
  });

  test("refuses (403) even when a Bearer token is present, if no key is configured", () => {
    // A caller can't talk their way past "no key configured" by guessing a
    // header value — there's nothing to compare it against.
    const result = validateServerSigningAuth("Bearer some-guessed-value");

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  test("allows requests when SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true outside production", () => {
    process.env.SERVER_SIGNING_ALLOW_UNAUTHENTICATED = "true";
    vi.stubEnv("NODE_ENV", "development");

    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.stringContaining("SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true"),
    );
  });

  test("refuses (403) even with SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true when NODE_ENV=production", () => {
    process.env.SERVER_SIGNING_ALLOW_UNAUTHENTICATED = "true";
    vi.stubEnv("NODE_ENV", "production");

    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  test("refuses (403) even with SERVER_SIGNING_ALLOW_UNAUTHENTICATED=true when BATCHPAY_ENV=production", () => {
    process.env.SERVER_SIGNING_ALLOW_UNAUTHENTICATED = "true";
    process.env.BATCHPAY_ENV = "production";

    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
  });

  test("allows requests with a correct API key", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth(`Bearer ${TEST_API_KEY}`);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  test("rejects requests with missing Authorization header (401)", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/Missing or malformed Authorization header/i);
  });

  test("rejects requests with empty Authorization header (401)", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth("");

    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/Missing or malformed Authorization header/i);
  });

  test("rejects requests with malformed Authorization header (401)", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    // Missing "Bearer " prefix
    const result = validateServerSigningAuth(TEST_API_KEY);

    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/Missing or malformed Authorization header/i);
  });

  test("rejects requests with wrong API key (403)", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth("Bearer wrong-key-value");

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/Invalid server-signing API key/i);
  });

  test("rejects requests with a key of different length (403, timing-safe)", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth("Bearer short");

    expect(result.valid).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toMatch(/Invalid server-signing API key/i);
  });

  test("handles case-insensitive Bearer scheme", () => {
    process.env.SERVER_SIGNING_API_KEY = TEST_API_KEY;

    const result = validateServerSigningAuth(`bearer ${TEST_API_KEY}`);

    expect(result.valid).toBe(true);
  });

  test("passes requestId through for log correlation", () => {
    const requestId = "test-request-id-123";

    // No API key set → fail-closed path logs an error with requestId
    const result = validateServerSigningAuth(null, requestId);

    expect(result.valid).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
      expect.stringContaining("SERVER_SIGNING_API_KEY is not set"),
    );
  });
});
