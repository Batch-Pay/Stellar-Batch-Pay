/**
 * Integration tests for wallet-authenticated batch read routes.
 *
 * Verifies that knowing a public G-address alone is insufficient to read
 * another wallet's batch payloads.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { Keypair, Networks } from "stellar-sdk";
import { NextRequest } from "next/server";

process.env.JOB_STORE_PATH = ":memory:";
process.env.WALLET_AUTH_SECRET = "test-wallet-auth-secret-read-routes";
process.env.WALLET_AUTH_HOME_DOMAIN = "localhost";
process.env.WALLET_AUTH_WEB_AUTH_DOMAIN = "stellar-batch-pay-read-test";
process.env.WALLET_AUTH_NETWORK_PASSPHRASE = Networks.TESTNET;

import { createJob, updateJob } from "@/lib/job-store";
import { GET as getBatchStatus } from "@/app/api/batch-status/[jobId]/route";
import { GET as getBatchHistory } from "@/app/api/batch-history/route";
import { GET as getBatchRecover } from "@/app/api/batch-recover/route";
import { createTestWalletSession } from "@/lib/wallet-auth";
import type { BatchResult } from "@/lib/stellar/types";

let OWNER_KEY: string;
const OTHER_KEY = Keypair.random().publicKey();

const completedResult: BatchResult = {
  batchId: "auth-test-batch",
  totalRecipients: 1,
  totalAmount: "10.0000000",
  totalTransactions: 1,
  network: "testnet",
  timestamp: new Date().toISOString(),
  results: [
    {
      recipient: "GAAA",
      amount: "10.0000000",
      asset: "XLM",
      status: "success",
      transactionHash: "abc",
    },
  ],
  summary: { successful: 1, failed: 0 },
};

function authHeaders(publicKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${createTestWalletSession(publicKey)}`,
  };
}

function makeStatusRequest(jobId: string, publicKey: string, headers?: HeadersInit) {
  const url = new URL(`http://localhost/api/batch-status/${jobId}`);
  url.searchParams.set("publicKey", publicKey);
  return new NextRequest(url.toString(), { headers });
}

function makeHistoryRequest(publicKey: string, headers?: HeadersInit) {
  const url = new URL("http://localhost/api/batch-history");
  url.searchParams.set("publicKey", publicKey);
  return new NextRequest(url.toString(), { headers });
}

function makeRecoverRequest(jobId: string, publicKey: string, headers?: HeadersInit) {
  const url = new URL("http://localhost/api/batch-recover");
  url.searchParams.set("jobId", jobId);
  url.searchParams.set("publicKey", publicKey);
  return new NextRequest(url.toString(), { headers });
}

describe("batch read route wallet auth", () => {
  let jobId: string;

  beforeEach(async () => {
    OWNER_KEY = Keypair.random().publicKey();
    jobId = await createJob([], "testnet", OWNER_KEY);
    await updateJob(jobId, { status: "completed", result: completedResult });
  });

  test("GET /api/batch-status rejects unauthenticated requests with a known publicKey", async () => {
    const res = await getBatchStatus(
      makeStatusRequest(jobId, OWNER_KEY) as never,
      { params: Promise.resolve({ jobId }) },
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/authentication/i);
  });

  test("GET /api/batch-status accepts a valid session for the job owner", async () => {
    const res = await getBatchStatus(
      makeStatusRequest(jobId, OWNER_KEY, authHeaders(OWNER_KEY)) as never,
      { params: Promise.resolve({ jobId }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jobId).toBe(jobId);
    expect(body.result).toBeDefined();
  });

  test("GET /api/batch-status rejects another wallet's session for the owner publicKey", async () => {
    const res = await getBatchStatus(
      makeStatusRequest(jobId, OWNER_KEY, authHeaders(OTHER_KEY)) as never,
      { params: Promise.resolve({ jobId }) },
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toMatch(/does not match/i);
  });

  test("GET /api/batch-history rejects unauthenticated requests", async () => {
    const res = await getBatchHistory(makeHistoryRequest(OWNER_KEY) as never);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/authentication/i);
  });

  test("GET /api/batch-history accepts a valid owner session", async () => {
    const res = await getBatchHistory(
      makeHistoryRequest(OWNER_KEY, authHeaders(OWNER_KEY)) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test("GET /api/batch-recover rejects unauthenticated requests", async () => {
    const res = await getBatchRecover(
      makeRecoverRequest(jobId, OWNER_KEY) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toMatch(/authentication/i);
  });

  test("GET /api/batch-recover accepts a valid owner session", async () => {
    const res = await getBatchRecover(
      makeRecoverRequest(jobId, OWNER_KEY, authHeaders(OWNER_KEY)) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.batch.jobId).toBe(jobId);
  });
});
