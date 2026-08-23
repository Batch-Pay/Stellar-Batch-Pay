/**
 * Tests for POST /api/batch-submit-signed (#748, #742).
 *
 * #748 covers sanitized error responses: the route previously forwarded raw
 * `error.message` (and ad hoc-extracted Horizon `result_codes`) straight to
 * the client on any unclassified submission failure. Classified Horizon
 * failures (bad sequence, insufficient fee) already return curated, safe
 * messages and are unaffected by that fix.
 *
 * #742 adds the route-level coverage this file was missing for the money
 * path itself: a valid signed XDR is accepted and submitted, a signed XDR
 * whose source account doesn't match the caller's declared publicKey is
 * rejected with 403 (#504) — for both a plain envelope and a fee-bump
 * envelope, whose *inner* source is the one that must match — and a
 * malformed/unparseable XDR is rejected with a sanitized 400 rather than a
 * raw parser exception. Rate-limit application itself (a real 429 once the
 * endpoint's budget is exhausted) is covered separately in
 * tests/batch-submit-signed-rate-limit.test.ts, since it needs the real
 * applyRateLimit implementation rather than the always-allow mock this file
 * uses for its other tests.
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
import { applyRateLimit } from "@/lib/api-rate-limit";

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

// Mirrors the fee-bump construction in tests/xdr-source-verification.test.ts
// (the existing XDR test helper for this exact concern) so both files agree
// on what a fee-bumped envelope looks like: the *inner* transaction's source
// is the account whose funds actually move and is what publicKey must match,
// not the (possibly different) account paying the bumped fee.
function buildFeeBumpXdr(innerSource: Keypair, feeSource: Keypair): string {
  const account = new Account(innerSource.publicKey(), "0");
  const innerTx = new TransactionBuilder(account, {
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
  innerTx.sign(innerSource);

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    (Number(BASE_FEE) * 2).toString(),
    innerTx,
    Networks.TESTNET,
  );
  feeBump.sign(feeSource);
  return feeBump.toXDR();
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

describe("POST /api/batch-submit-signed — happy path (#742)", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
    vi.mocked(applyRateLimit).mockClear();
  });

  test("accepts a valid signed XDR, submits it, and returns hash/ledger", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockResolvedValue({
      hash: "abc123hash",
      ledger: 12345,
    });

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    const res = await POST(
      makeRequest({ signedXdr, network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.hash).toBe("abc123hash");
    expect(body.ledger).toBe(12345);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  test("accepts a valid signed XDR when publicKey matches the transaction source", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockResolvedValue({
      hash: "matched-hash",
      ledger: 999,
    });

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    const res = await POST(
      makeRequest({
        signedXdr,
        network: "testnet",
        publicKey: source.publicKey(),
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  test("checks the rate limit for the batch-submit-signed endpoint before submitting", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockResolvedValue({ hash: "h", ledger: 1 });

    const source = Keypair.random();
    const signedXdr = buildSignedXdr(source);

    await POST(makeRequest({ signedXdr, network: "testnet" }) as never);

    expect(applyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "batch-submit-signed",
    );
  });
});

describe("POST /api/batch-submit-signed — source account verification (#504, #742)", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
  });

  test("rejects with 403 when publicKey does not match the transaction source", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const owner = Keypair.random();
    const attacker = Keypair.random();
    // Signed by `owner`, but the caller claims to be `attacker`.
    const signedXdr = buildSignedXdr(owner);

    const res = await POST(
      makeRequest({
        signedXdr,
        network: "testnet",
        publicKey: attacker.publicKey(),
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/does not match publicKey/i);
    // Must be rejected before ever reaching Horizon.
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  test("rejects with 403 when a fee-bump's inner source does not match publicKey, even though the fee source does", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const owner = Keypair.random();
    const attacker = Keypair.random();
    // Attacker signs the inner (money-moving) transaction; owner merely pays
    // the fee. The inner source is what must match publicKey (#504), so
    // this must still be rejected even though `owner` funded the fee bump.
    const signedXdr = buildFeeBumpXdr(attacker, owner);

    const res = await POST(
      makeRequest({
        signedXdr,
        network: "testnet",
        publicKey: owner.publicKey(),
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  test("accepts a fee-bump whose inner source matches publicKey, regardless of who pays the fee", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockResolvedValue({
      hash: "feebump-hash",
      ledger: 42,
    });

    const owner = Keypair.random();
    const feeSponsor = Keypair.random();
    const signedXdr = buildFeeBumpXdr(owner, feeSponsor);

    const res = await POST(
      makeRequest({
        signedXdr,
        network: "testnet",
        publicKey: owner.publicKey(),
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  test("skips the source check entirely when publicKey is not supplied (#300 pure-XDR submit)", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    mockSubmitTransaction.mockResolvedValue({ hash: "no-key-hash", ledger: 7 });

    // No publicKey field at all — some clients submit a bare signed XDR
    // without declaring an owning wallet.
    const signedXdr = buildSignedXdr(Keypair.random());

    const res = await POST(
      makeRequest({ signedXdr, network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe("POST /api/batch-submit-signed — malformed input (#742)", () => {
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
  });

  test("returns 400 without leaking internals for an unparseable XDR string", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const res = await POST(
      makeRequest({
        signedXdr: "not-a-real-xdr",
        network: "testnet",
      }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain(".ts:");
    expect(raw).not.toContain("at Transaction");
    expect(body).not.toHaveProperty("stack");
    // Never reached Horizon with garbage input.
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  test("returns 400 when signedXdr is missing", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const res = await POST(makeRequest({ network: "testnet" }) as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/signedXdr/i);
  });

  test("returns 400 when signedXdr is not a string", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const res = await POST(
      makeRequest({ signedXdr: 12345, network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/signedXdr/i);
  });

  test("returns 400 when network is missing or invalid", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const signedXdr = buildSignedXdr(Keypair.random());

    const resMissing = await POST(makeRequest({ signedXdr }) as never);
    expect(resMissing.status).toBe(400);
    const bodyMissing = await resMissing.json();
    expect(bodyMissing.error).toMatch(/network/i);

    const resInvalid = await POST(
      makeRequest({ signedXdr, network: "devnet" }) as never,
    );
    expect(resInvalid.status).toBe(400);
    const bodyInvalid = await resInvalid.json();
    expect(bodyInvalid.error).toMatch(/network/i);
  });

  test("returns 400 for a syntactically valid but empty XDR string", async () => {
    const { POST } = await import("@/app/api/batch-submit-signed/route");

    const res = await POST(
      makeRequest({ signedXdr: "", network: "testnet" }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/signedXdr/i);
  });
});
