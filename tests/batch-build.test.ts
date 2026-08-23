/**
 * Regression tests for POST /api/batch-build omitted-row reporting (#510).
 *
 * When a row fails per-row validation while XDRs are built, the route must
 * report the *original* row index (the parser's `rowIndex`) so duplicate rows
 * — same address/amount/asset — resolve to distinct positions instead of
 * collapsing onto the first value-equal match via `Array.indexOf`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Account, Keypair } from "stellar-sdk";
import type { PaymentInstruction } from "@/lib/stellar/types";

const { mockLoadAccount } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
}));

// Keep the real stellar-sdk (TransactionBuilder, Memo, Asset, …) and only
// stub the Horizon network call.
vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();
  class MockServer {
    loadAccount = mockLoadAccount;
  }
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockServer },
  };
});

vi.mock("@/lib/stellar/fee-service", () => ({
  getRecommendedFee: vi.fn().mockResolvedValue(100),
}));

vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: vi.fn(() => ({ blocked: false, response: undefined })),
  setRateLimitHeaders: vi.fn((response: Response) => response),
}));

// Let top-level validation pass so execution reaches the per-row build loop,
// then fail exactly the row whose memo is the poison marker. This isolates the
// omission branch, which the shared top-level guard would otherwise 400 first.
vi.mock("@/lib/stellar/validator", () => ({
  validatePaymentInstructions: vi.fn(() => ({
    valid: true,
    errors: new Map(),
    duplicateIndices: new Set(),
  })),
  validatePaymentInstruction: vi.fn((p: PaymentInstruction) =>
    p.memo === "__BAD__"
      ? { valid: false, error: "Invalid memo" }
      : { valid: true },
  ),
  buildBalancesMap: vi.fn(() => ({})),
  validateBalances: vi.fn(() => ({ all_sufficient: true, checks: [] })),
}));

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/batch-build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/batch-build — omitted rows (#510)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAccount.mockImplementation((publicKey: string) =>
      Promise.resolve(new Account(publicKey, "0")),
    );
  });

  test("reports the failing row's original rowIndex, not its array position", async () => {
    const { POST } = await import("@/app/api/batch-build/route");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();

    // Two value-equal duplicate rows. The second is invalid. Their rowIndex
    // values deliberately differ from their array positions so a positional /
    // indexOf resolution would report the wrong row.
    const payments: PaymentInstruction[] = [
      { address: recipient, amount: "1", asset: "XLM", rowIndex: 5 },
      { address: recipient, amount: "1", asset: "XLM", memo: "__BAD__", rowIndex: 2 },
    ];

    const response = await POST(
      makeRequest({ payments, network: "testnet", publicKey: owner }) as never,
    );

    expect(response.status).toBe(422);
    const json = await response.json();

    // rowIndex (2), not the array position (1), is reported.
    expect(json.omittedRows).toEqual([2]);
    expect(json.omittedRows).not.toContain(1);
    expect(json.omittedReasons["2"]).toBe("Invalid memo");
  });

  test("duplicate rows resolve to distinct indices", async () => {
    const { POST } = await import("@/app/api/batch-build/route");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();

    // Three identical rows; the last two both fail validation but carry
    // distinct rowIndex values — they must not collapse to one index.
    const payments: PaymentInstruction[] = [
      { address: recipient, amount: "10", asset: "XLM", rowIndex: 0 },
      { address: recipient, amount: "10", asset: "XLM", memo: "__BAD__", rowIndex: 1 },
      { address: recipient, amount: "10", asset: "XLM", memo: "__BAD__", rowIndex: 2 },
    ];

    const response = await POST(
      makeRequest({ payments, network: "testnet", publicKey: owner }) as never,
    );

    expect(response.status).toBe(422);
    const json = await response.json();

    expect(new Set(json.omittedRows)).toEqual(new Set([1, 2]));
    expect(json.omittedRows).toHaveLength(2);
  });

  test("falls back to positional index for legacy payloads without rowIndex", async () => {
    const { POST } = await import("@/app/api/batch-build/route");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();

    const payments: PaymentInstruction[] = [
      { address: recipient, amount: "1", asset: "XLM" },
      { address: recipient, amount: "1", asset: "XLM", memo: "__BAD__" },
    ];

    const response = await POST(
      makeRequest({ payments, network: "testnet", publicKey: owner }) as never,
    );

    expect(response.status).toBe(422);
    const json = await response.json();

    // No rowIndex → fall back to the array position (1) via indexOf.
    expect(json.omittedRows).toEqual([1]);
  });
});

describe("POST /api/batch-build — sanitized error responses (#748)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("a forced Horizon/loadAccount failure never leaks error.message or a stack trace", async () => {
    const { POST } = await import("@/app/api/batch-build/route");

    const sensitiveMessage =
      "getaddrinfo ENOTFOUND horizon-internal.batchpay.svc.cluster.local";
    mockLoadAccount.mockImplementation(() =>
      Promise.reject(new Error(sensitiveMessage)),
    );

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments: PaymentInstruction[] = [
      { address: recipient, amount: "1", asset: "XLM", rowIndex: 0 },
    ];

    const response = await POST(
      makeRequest({ payments, network: "testnet", publicKey: owner }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ENOTFOUND");
    expect(raw).not.toContain("batchpay.svc.cluster.local");
    expect(raw).not.toContain(".ts:");
    expect(body).not.toHaveProperty("stack");
  });

  test("echoes back a client-supplied x-request-id header on a forced throw", async () => {
    const { POST } = await import("@/app/api/batch-build/route");

    mockLoadAccount.mockImplementation(() =>
      Promise.reject(new Error("boom")),
    );

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments: PaymentInstruction[] = [
      { address: recipient, amount: "1", asset: "XLM", rowIndex: 0 },
    ];

    const req = new Request("http://localhost/api/batch-build", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "trace-build-1",
      },
      body: JSON.stringify({ payments, network: "testnet", publicKey: owner }),
    });

    const response = await POST(req as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.requestId).toBe("trace-build-1");
  });
});
