/**
 * Integration tests for GET /api/batch-recover (#320, #538).
 *
 * Verifies that the route reads from SQLite (job-store) — not IndexedDB —
 * and returns the correct HTTP status codes. Also covers the IDOR fix (#538):
 * publicKey is now required and job lookup is always ownership-scoped.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Keypair, Networks } from "stellar-sdk";
import { NextRequest } from "next/server";

process.env.JOB_STORE_PATH = ":memory:";
process.env.WALLET_AUTH_SECRET = "test-wallet-auth-secret-recover";
process.env.WALLET_AUTH_HOME_DOMAIN = "localhost";
process.env.WALLET_AUTH_WEB_AUTH_DOMAIN = "stellar-batch-pay-recover-test";
process.env.WALLET_AUTH_NETWORK_PASSPHRASE = Networks.TESTNET;

import { createJob, updateJob } from "@/lib/job-store";
import { GET } from "@/app/api/batch-recover/route";
import { createTestWalletSession } from "@/lib/wallet-auth";
import type { BatchResult } from "@/lib/stellar/types";

let PUBLIC_KEY: string;

const completedResult: BatchResult = {
  batchId: "test-batch",
  totalRecipients: 2,
  totalAmount: "30.0000000",
  totalTransactions: 1,
  network: "testnet",
  timestamp: new Date().toISOString(),
  results: [
    { recipient: "GAAA", amount: "10.0000000", asset: "XLM", status: "success", transactionHash: "abc" },
    { recipient: "GBBB", amount: "20.0000000", asset: "XLM", status: "failed",  transactionHash: undefined, error: "op_no_destination" },
  ],
  summary: { successful: 1, failed: 1 },
};

function makeRequest(params: Record<string, string>, publicKeyForAuth?: string) {
  const url = new URL("http://localhost/api/batch-recover");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const authKey = publicKeyForAuth ?? params.publicKey;
  const headers: HeadersInit | undefined = authKey
    ? { Authorization: `Bearer ${createTestWalletSession(authKey)}` }
    : undefined;
  return new NextRequest(url.toString(), { headers });
}

describe("GET /api/batch-recover", () => {
  let jobId: string;

  beforeEach(async () => {
    PUBLIC_KEY = Keypair.random().publicKey();
    jobId = await createJob([], "testnet", PUBLIC_KEY);
    await updateJob(jobId, { status: "completed", result: completedResult });
  });

  test("returns 200 with recovery data for a completed SQLite job", async () => {
    const res = await GET(makeRequest({ jobId, publicKey: PUBLIC_KEY }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.batch.jobId).toBe(jobId);
    expect(body.progress.total).toBe(2);
    expect(body.progress.successful).toBe(1);
    expect(body.progress.failed).toBe(1);
    expect(body.failedTransactions).toHaveLength(1);
    expect(body.successfulTransactions).toHaveLength(1);
    expect(body.ready).toBe(true);
  });

  test("returns 404 for an unknown jobId", async () => {
    const res = await GET(makeRequest({ jobId: "does-not-exist", publicKey: PUBLIC_KEY }) as never);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBeDefined();
  });

  test("returns 400 when jobId is missing", async () => {
    const res = await GET(makeRequest({}) as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/jobId/i);
  });

  test("returns 400 when publicKey is missing (#538 IDOR fix)", async () => {
    const res = await GET(makeRequest({ jobId }) as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/publicKey/i);
  });

  test("returns 401 when publicKey is supplied without wallet authentication", async () => {
    const url = new URL("http://localhost/api/batch-recover");
    url.searchParams.set("jobId", jobId);
    url.searchParams.set("publicKey", PUBLIC_KEY);
    const res = await GET(new NextRequest(url.toString()) as never);

    expect(res.status).toBe(401);
  });

  test("returns 404 when publicKey does not match the job owner", async () => {
    const otherKey = Keypair.random().publicKey();
    const res = await GET(makeRequest({ jobId, publicKey: otherKey }, otherKey) as never);

    expect(res.status).toBe(404);
  });

  test("returns 200 when publicKey matches the job owner", async () => {
    const res = await GET(makeRequest({ jobId, publicKey: PUBLIC_KEY }) as never);

    expect(res.status).toBe(200);
  });

  test("does not leak job data for a valid jobId with wrong publicKey (#538)", async () => {
    const otherKey = Keypair.random().publicKey();
    const res = await GET(makeRequest({ jobId, publicKey: otherKey }, otherKey) as never);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).not.toHaveProperty("successfulTransactions");
    expect(body).not.toHaveProperty("failedTransactions");
  });

  test("includes a requestId on the 404 not-found response", async () => {
    const res = await GET(
      makeRequest({ jobId: "does-not-exist", publicKey: PUBLIC_KEY }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});

describe("GET /api/batch-recover — sanitized error responses (#748)", () => {
  test("forced throw returns a sanitized body with no leaked internals", async () => {
    const sensitiveMessage =
      "ENOENT: no such file or directory, open '/var/data/batch-pay.sqlite'";
    const jobStore = await import("@/lib/job-store");
    const getJobSpy = vi
      .spyOn(jobStore, "getJob")
      .mockRejectedValueOnce(new Error(sensitiveMessage));

    const res = await GET(
      makeRequest({ jobId: "some-job", publicKey: PUBLIC_KEY }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ENOENT");
    expect(raw).not.toContain("/var/data");
    expect(raw).not.toContain("batch-pay.sqlite");
    expect(raw).not.toContain(".ts:");
    expect(body).not.toHaveProperty("stack");

    getJobSpy.mockRestore();
  });

  test("echoes back a client-supplied x-request-id header on a forced throw", async () => {
    const jobStore = await import("@/lib/job-store");
    const getJobSpy = vi
      .spyOn(jobStore, "getJob")
      .mockRejectedValueOnce(new Error("boom"));

    const url = new URL("http://localhost/api/batch-recover");
    url.searchParams.set("jobId", "some-job");
    url.searchParams.set("publicKey", PUBLIC_KEY);
    const req = new Request(url.toString(), {
      headers: { "x-request-id": "trace-abc-123" },
    });

    const res = await GET(req as never);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.requestId).toBe("trace-abc-123");

    getJobSpy.mockRestore();
  });
});
