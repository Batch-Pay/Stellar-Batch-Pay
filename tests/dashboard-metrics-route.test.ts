/**
 * Regression tests for GET /api/dashboard-metrics — activeBatches job-store fix.
 *
 * Verifies that:
 *  1. Queued/processing jobs are counted in activeBatches (scoped by publicKey + network).
 *  2. Completed jobs do NOT inflate activeBatches.
 *  3. Unrelated on-chain payments show up in paymentsLast24h but not activeBatches.
 *  4. Cross-tenant leakage is prevented (different publicKey/network are excluded).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Keypair } from "stellar-sdk";
import { NextRequest } from "next/server";

process.env.JOB_STORE_PATH = ":memory:";

const mockOperations = {
  forAccount: vi.fn(function (this: any, _accountId: string) {
    return this;
  }),
  limit: vi.fn(function (this: any) {
    return this;
  }),
  order: vi.fn(function (this: any) {
    return this;
  }),
  call: vi.fn(),
};

vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: vi.fn(() => ({ blocked: false, response: undefined })),
  setRateLimitHeaders: vi.fn((response: Response) => response),
}));

vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class {
        constructor() {}
        operations() {
          return mockOperations;
        }
      },
    },
  };
});

const now = Date.now();
const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

function makePaymentRecord(createdAt: string, source: string) {
  return {
    type: "payment",
    source_account: source,
    asset_type: "native",
    amount: "10",
    created_at: createdAt,
  };
}

function makeHorizonPages(pages: any[][]) {
  let index = 0;
  const records = pages[index] ?? [];

  return {
    records,
    next: async () => {
      index += 1;
      const nextRecords = pages[index];
      if (!nextRecords || nextRecords.length === 0) return undefined;
      return {
        records: nextRecords,
        next: async () => undefined,
      };
    },
  };
}

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/dashboard-metrics");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url.toString());
}

describe("GET /api/dashboard-metrics — activeBatches job-store integration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test("counts a queued job with zero on-chain operations as active", async () => {
    const { createJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    await createJob([], "testnet", publicKeyA);
    mockOperations.call.mockResolvedValue(makeHorizonPages([[]]));

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(1);
    expect(body.paymentsLast24h).toBe(0);
  });

  test("does not inflate activeBatches from an unrelated completed payment", async () => {
    const { createJob, updateJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    const jobId = await createJob([], "testnet", publicKeyA);
    await updateJob(jobId, { status: "completed" });

    mockOperations.call.mockResolvedValue(
      makeHorizonPages([[makePaymentRecord(new Date(Date.now() - 3600000).toISOString(), publicKeyA)]]),
    );

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(0);
    expect(body.paymentsLast24h).toBe(1);
  });

  test("includes paymentsLast24h in the response", async () => {
    const { createJob, updateJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    const jobId = await createJob([], "testnet", publicKeyA);
    await updateJob(jobId, { status: "completed" });

    mockOperations.call.mockResolvedValue(
      makeHorizonPages([
        [makePaymentRecord(new Date(Date.now() - 3600000).toISOString(), publicKeyA)],
        [makePaymentRecord(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), publicKeyA)],
      ]),
    );

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.paymentsLast24h).toBe(1);
    expect(body.totalPayments).toBe(2);
  });

  test("excludes jobs belonging to a different publicKey", async () => {
    const { createJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();
    const publicKeyB = Keypair.random().publicKey();

    await createJob([], "testnet", publicKeyB);

    mockOperations.call.mockResolvedValue(makeHorizonPages([[]]));

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(0);
  });

  test("excludes jobs on a different network", async () => {
    const { createJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    await createJob([], "mainnet", publicKeyA);

    mockOperations.call.mockResolvedValue(makeHorizonPages([[]]));

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(0);
  });

  test("counts queued and processing jobs together", async () => {
    const { createJob, updateJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    await createJob([], "testnet", publicKeyA);
    const processingJobId = await createJob([], "testnet", publicKeyA);
    await updateJob(processingJobId, { status: "processing" });

    mockOperations.call.mockResolvedValue(makeHorizonPages([[]]));

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(2);
  });

  test("does not count failed jobs as active batches", async () => {
    const { createJob, updateJob } = await import("@/lib/job-store");
    const { GET } = await import("@/app/api/dashboard-metrics/route");
    const publicKeyA = Keypair.random().publicKey();

    const jobId = await createJob([], "testnet", publicKeyA);
    await updateJob(jobId, { status: "failed" });

    mockOperations.call.mockResolvedValue(makeHorizonPages([[]]));

    const res = await GET(makeRequest({ publicKey: publicKeyA, network: "testnet" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeBatches).toBe(0);
  });
});
