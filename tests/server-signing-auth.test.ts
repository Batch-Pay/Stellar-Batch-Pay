/**
 * Unit tests for server-signing authorization utility (#696).
 *
 * Verifies that the HMAC-based API key check works correctly:
 * - Missing env var → backward-compat pass with deprecation warning
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
  vi.clearAllMocks();
});

describe("validateServerSigningAuth (#696)", () => {
  test("allows requests when SERVER_SIGNING_API_KEY is not set (backward-compat)", () => {
    const result = validateServerSigningAuth(null);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBeUndefined();
    // Should log a deprecation warning
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.stringContaining("SERVER_SIGNING_API_KEY is not set"),
    );
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

    // No API key set → backward-compat path logs a warning with requestId
    const result = validateServerSigningAuth(null, requestId);

    expect(result.valid).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId }),
      expect.stringContaining("SERVER_SIGNING_API_KEY is not set"),
    );
  });
});
