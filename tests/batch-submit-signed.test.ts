/**
 * Tests for POST /api/batch-submit-signed error handling (#748).
 *
 * The route previously forwarded raw `error.message` (and ad hoc-extracted
 * Horizon `result_codes`) straight to the client on any unclassified
 * submission failure. Classified Horizon failures (bad sequence, insufficient
 * fee) already return curated, safe messages and are unaffected by this fix;
 * this file focuses on the previously-leaking generic/unknown-error path.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
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

vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: vi.fn(() => ({ blocked: false, response: undefined })),
  setRateLimitHeaders: vi.fn((response: Response) => response),
}));

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

function makeRequest(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/api/batch-submit-signed", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/batch-submit-signed — sanitized error responses (#748)", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
  });

  test("an unclassified submission failure never leaks error.message or a stack trace", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const sensitiveMessage =
      "connect ETIMEDOUT 10.20.30.40:443 (horizon-internal-lb)";
    mockSubmitTransaction.mockRejectedValue(new Error(sensitiveMessage));

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    const res = await POST(
      makeRequest({ signedXdr, network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe("BAD_REQUEST");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ETIMEDOUT");
    expect(raw).not.toContain("10.20.30.40");
    expect(raw).not.toContain("horizon-internal-lb");
    expect(raw).not.toContain(".ts:");
    expect(body).not.toHaveProperty("stack");
  });

  test("echoes back a client-supplied x-request-id header on a forced throw", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockRejectedValue(new Error("boom"));

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    const res = await POST(
      makeRequest(
        { signedXdr, network: "testnet" },
        { "x-request-id": "trace-submit-signed-1" },
      ) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.requestId).toBe("trace-submit-signed-1");
  });

  test("a classified Horizon tx_bad_seq failure keeps its curated message and code (unaffected by sanitization)", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockRejectedValue({
      response: {
        data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
      },
    });

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    const res = await POST(
      makeRequest({ signedXdr, network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("BAD_SEQ");
    expect(body.action).toBe("rebuild");
    expect(body.error).toMatch(/sequence/i);
  });
});
