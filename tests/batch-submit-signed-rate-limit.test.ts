/**
 * Route-level rate-limit test for POST /api/batch-submit-signed (#742).
 *
 * batch-submit-signed already calls applyRateLimit/setRateLimitHeaders (see
 * lib/api-rate-limit.ts), but that behavior was previously only exercised
 * indirectly (or not at all) at the HTTP boundary — every other test file
 * for this route mocks the limiter out entirely so its own logic can be
 * tested in isolation. This file does the opposite: it exercises the real,
 * sqlite-backed limiter end-to-end against the actual route handler and
 * confirms a 429 is returned, with the standard rate-limit headers, once the
 * endpoint's free-tier budget is exhausted — matching the acceptance
 * criteria's "rate-limit applied" requirement.
 *
 * Horizon submission itself is stubbed out (as in the other
 * batch-submit-signed test files) since it's irrelevant here: every request
 * in this file is expected to be blocked by the limiter before ever
 * reaching submission logic, once the budget runs out.
 */

import { describe, expect, test, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "stellar-sdk";

const { mockSubmitTransaction } = vi.hoisted(() => ({
  mockSubmitTransaction: vi.fn(),
}));

vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();
  class MockServer {
    serverURL = "https://horizon-testnet.stellar.org";
    submitTransaction = mockSubmitTransaction;
  }
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockServer },
  };
});

function buildSignedXdr(source: Keypair): string {
  const account = new Account(source.publicKey(), "0");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(source);
  return tx.toXDR();
}

beforeEach(() => {
  vi.resetModules();
  mockSubmitTransaction.mockReset();
  mockSubmitTransaction.mockResolvedValue({ hash: "h", ledger: 1 });
  // Isolated DB path per test so buckets from other tests/files never bleed
  // into these limit-exhaustion assertions.
  process.env.RATE_LIMIT_DB_PATH = path.join(
    process.cwd(),
    "data",
    `test-rate-limit-742-${Math.random().toString(36).slice(2)}.db`,
  );
});

describe("POST /api/batch-submit-signed rate limiting (#742)", () => {
  test("returns 429 once the free-tier budget is exhausted, with rate-limit headers", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-submit-signed"].free; // 5

    const { POST } = await import("@/app/api/batch-submit-signed/route");
    const ip = "203.0.113.50";

    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest("http://localhost/api/batch-submit-signed", {
        method: "POST",
        headers: {
          "x-forwarded-for": ip,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          signedXdr: buildSignedXdr(Keypair.random()),
          network: "testnet",
        }),
      });
      const res = await POST(req);
      expect(res.status).not.toBe(429);
    }

    const blockedReq = new NextRequest("http://localhost/api/batch-submit-signed", {
      method: "POST",
      headers: {
        "x-forwarded-for": ip,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        signedXdr: buildSignedXdr(Keypair.random()),
        network: "testnet",
      }),
    });
    const blocked = await POST(blockedReq);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe(String(limit));
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");

    // The route never reached Horizon for the blocked request.
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(limit);
  });

  test("a different caller's requests are not blocked by another caller's exhausted bucket", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-submit-signed"].free;

    const { POST } = await import("@/app/api/batch-submit-signed/route");

    for (let i = 1; i <= limit + 1; i++) {
      await POST(
        new NextRequest("http://localhost/api/batch-submit-signed", {
          method: "POST",
          headers: {
            "x-forwarded-for": "203.0.113.51",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            signedXdr: buildSignedXdr(Keypair.random()),
            network: "testnet",
          }),
        }),
      );
    }

    const otherCaller = await POST(
      new NextRequest("http://localhost/api/batch-submit-signed", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.52",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          signedXdr: buildSignedXdr(Keypair.random()),
          network: "testnet",
        }),
      }),
    );

    expect(otherCaller.status).not.toBe(429);
  });
});
