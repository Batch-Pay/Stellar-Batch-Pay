/**
 * Unit tests for lib/stellar/reconciliation.ts (#741).
 *
 * Before this suite, isTransportError and reconcileTransaction had zero
 * test references — the exact money-safety path (deciding whether a failed
 * Horizon submit might have actually landed on-chain) was unverified.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Horizon } from "stellar-sdk";
import { computeTransactionHash, isTransportError, reconcileTransaction } from "../lib/stellar/reconciliation";

describe("isTransportError", () => {
  test.each([
    ["FETCH_ERROR code", { code: "FETCH_ERROR" }],
    ["ECONNRESET code", { code: "ECONNRESET" }],
    ["ETIMEDOUT code", { code: "ETIMEDOUT" }],
    ["undici connect-timeout code", { code: "UND_ERR_CONNECT_TIMEOUT" }],
    ["undici socket code", { code: "UND_ERR_SOCKET" }],
    ["502 status", { response: { status: 502 } }],
    ["503 status", { response: { status: 503 } }],
    ["504 status", { response: { status: 504 } }],
  ])("classifies %s as a transport error", (_label, errorShape) => {
    const error = Object.assign(new Error("boom"), errorShape);
    expect(isTransportError(error)).toBe(true);
  });

  test.each([
    ["TimeoutError message", new Error("TimeoutError: the operation timed out")],
    ["network timeout message", new Error("network timeout at fetch")],
    ["connection reset message", new Error("connection reset by peer")],
    ["fetch failed message", new Error("fetch failed")],
    ["socket hang up message", new Error("socket hang up")],
  ])("classifies %s as a transport error", (_label, error) => {
    expect(isTransportError(error)).toBe(true);
  });

  test("does not classify a 400 Horizon validation error as a transport error", () => {
    const error = Object.assign(new Error("Bad Request"), {
      response: { status: 400 },
    });
    expect(isTransportError(error)).toBe(false);
  });

  test("does not classify a 404 not-found error as a transport error", () => {
    const error = Object.assign(new Error("Not Found"), {
      response: { status: 404 },
    });
    expect(isTransportError(error)).toBe(false);
  });

  test("does not classify a plain application error as a transport error", () => {
    expect(isTransportError(new Error("insufficient balance"))).toBe(false);
  });

  test("does not throw on non-object or nullish input", () => {
    expect(isTransportError(undefined)).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("just a string")).toBe(false);
    expect(isTransportError(42)).toBe(false);
  });
});

describe("reconcileTransaction", () => {
  function fakeServer(behavior: () => Promise<unknown>): Horizon.Server {
    return {
      transactions: () => ({
        transaction: () => ({ call: behavior }),
      }),
    } as unknown as Horizon.Server;
  }

  test("returns success on the first attempt when Horizon finds the transaction", async () => {
    const call = vi.fn().mockResolvedValue({ successful: true });
    const server = fakeServer(call);

    const result = await reconcileTransaction(server, "abc123");

    expect(result).toEqual({ status: "success", attempts: 1 });
    expect(call).toHaveBeenCalledOnce();
  });

  test("returns failed immediately on a 404 (transaction never landed)", async () => {
    const call = vi.fn().mockRejectedValue(
      Object.assign(new Error("Not Found"), { response: { status: 404 } }),
    );
    const server = fakeServer(call);

    const result = await reconcileTransaction(server, "abc123");

    expect(result).toEqual({ status: "failed", attempts: 1 });
    // A definitive 404 must not burn through retry attempts.
    expect(call).toHaveBeenCalledOnce();
  });

  test("returns unknown after exhausting all attempts on repeated non-404 errors", async () => {
    vi.useFakeTimers();
    try {
      const call = vi.fn().mockRejectedValue(new Error("network timeout"));
      const server = fakeServer(call);

      const resultPromise = reconcileTransaction(server, "abc123", 3);
      // Flush all backoff sleeps (250ms, 500ms) so the retry loop completes
      // without depending on real wall-clock time.
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ status: "unknown", attempts: 3 });
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("recovers to success if a later attempt finds the transaction", async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        .mockRejectedValueOnce(new Error("network timeout"))
        .mockResolvedValueOnce({ successful: true });
      const server = fakeServer(call);

      const resultPromise = reconcileTransaction(server, "abc123", 3);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ status: "success", attempts: 2 });
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("computeTransactionHash", () => {
  test("uses the transaction's own hash() when available", () => {
    const tx = { hash: () => Buffer.from("deadbeef", "hex") };
    expect(computeTransactionHash(tx)).toBe("deadbeef");
  });

  test("falls back to sha256 of the envelope XDR when hash() is unavailable", () => {
    const tx = { toEnvelope: () => ({ toXDR: () => "some-envelope-xdr" }) };
    // Deterministic — same input always produces the same digest.
    expect(computeTransactionHash(tx)).toBe(computeTransactionHash(tx));
    expect(computeTransactionHash(tx)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws when neither hash() nor a usable envelope is available", () => {
    expect(() => computeTransactionHash({})).toThrow(
      "Unable to compute transaction hash",
    );
  });
});
