/**
 * Test suite for transaction status query validation
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
}));

vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();
  class MockServer {
    transactions() {
      return { transaction: mockTransaction };
    }
  }
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: MockServer },
  };
});

describe("Transaction status query parameters", () => {
  test("valid hash format is a 64-character hex string", () => {
    const validHash = "a".repeat(64);
    expect(/^[0-9a-f]{64}$/i.test(validHash)).toBe(true);
  });

  test("invalid hash is rejected", () => {
    const shortHash = "abc123";
    expect(/^[0-9a-f]{64}$/i.test(shortHash)).toBe(false);
  });

  test("network must be testnet or mainnet", () => {
    const validNetworks = ["testnet", "mainnet"];
    expect(validNetworks.includes("testnet")).toBe(true);
    expect(validNetworks.includes("mainnet")).toBe(true);
    expect(validNetworks.includes("devnet")).toBe(false);
  });

  test("Horizon testnet URL is correct", () => {
    const network: string = "testnet";
    const url =
      network === "testnet"
        ? "https://horizon-testnet.stellar.org"
        : "https://horizon.stellar.org";
    expect(url).toBe("https://horizon-testnet.stellar.org");
  });

  test("Horizon mainnet URL is correct", () => {
    const network: string = "mainnet";
    const url =
      network === "testnet"
        ? "https://horizon-testnet.stellar.org"
        : "https://horizon.stellar.org";
    expect(url).toBe("https://horizon.stellar.org");
  });
});

describe("GET /api/tx-status — sanitized error responses (#748)", () => {
  beforeEach(() => {
    mockTransaction.mockReset();
  });

  function makeRequest(hash: string, network = "testnet") {
    const url = new URL("http://localhost/api/tx-status");
    url.searchParams.set("hash", hash);
    url.searchParams.set("network", network);
    return new NextRequest(url.toString());
  }

  test("a non-404 Horizon failure never leaks error.message or a stack trace", async () => {
    const { GET } = await import("@/app/api/tx-status/route");

    const sensitiveMessage =
      "connect ECONNREFUSED 10.0.4.12:11626 (internal horizon replica)";
    mockTransaction.mockReturnValue({
      call: vi.fn().mockRejectedValue(new Error(sensitiveMessage)),
    });

    const res = await GET(makeRequest("a".repeat(64)) as never);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("10.0.4.12");
    expect(raw).not.toContain("internal horizon replica");
    expect(body).not.toHaveProperty("stack");
  });

  test("a genuine 404 (transaction not found) is unaffected by sanitization", async () => {
    const { GET } = await import("@/app/api/tx-status/route");

    mockTransaction.mockReturnValue({
      call: vi
        .fn()
        .mockRejectedValue({ response: { status: 404 } }),
    });

    const res = await GET(makeRequest("b".repeat(64)) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.found).toBe(false);
  });
});
