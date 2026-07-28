/**
 * Integration tests for POST /api/batch-retry (#388).
 *
 * Verifies that retry requires the owning wallet's publicKey, rejects
 * mismatches, and creates a retry job that is pollable by that same key
 * (i.e. not orphaned from the submitting account).
 */

import { beforeEach, afterEach, describe, expect, test, vi, beforeAll } from "vitest";

process.env.JOB_STORE_PATH = ":memory:";
process.env.ALLOW_SERVER_SIGNING = "true";
process.env.STELLAR_SECRET_KEY =
    "SAEZSI6DY7AXJFIYA4PM6SIBONESDAFDIE2WBJ7B6Y4AZG3RB5HEYZJK";

// The worker would otherwise submit to the network; stub it out.
vi.mock("@/lib/stellar/batch-worker", () => ({
    processJobInBackground: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/job-store", () => {
  class MockIdempotencyConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "IdempotencyConflictError";
    }
  }

  const jobs = new Map<string, any>();
  const idempotencyKeys = new Map<string, any>();

  return {
    createJob: vi.fn((payments: any[], network: string, publicKey: string, signedTransactions?: string[]) => {
      const jobId = `job-${Date.now()}-${Math.random()}`;
      const job = {
        jobId,
        publicKey,
        status: "queued" as const,
        totalBatches: 0,
        completedBatches: 0,
        payments,
        network,
        signedTransactions,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      return jobId;
    }),
    getJob: vi.fn((jobId: string, publicKey?: string) => {
      const job = jobs.get(jobId);
      if (!job) return null;
      if (publicKey && job.publicKey !== publicKey) return null;
      return job;
    }),
    updateJob: vi.fn((jobId: string, updates: any) => {
      const job = jobs.get(jobId);
      if (!job) return false;
      Object.assign(job, updates, { updatedAt: new Date().toISOString() });
      return true;
    }),
    createIdempotentJob: vi.fn((args: {
      idempotencyKey: string;
      requestHash: string;
      payments: any[];
      network: any;
      publicKey: string;
      signedTransactions?: string[];
      buildResponseBody: (jobId: string) => any;
    }) => {
      const existing = idempotencyKeys.get(args.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== args.requestHash) {
          throw new MockIdempotencyConflictError("Idempotency key conflict");
        }
        return {
          jobId: existing.jobId,
          responseBody: existing.responseBody,
          replayed: true,
        };
      }
      const jobId = `job-${Date.now()}-${Math.random()}`;
      const job = {
        jobId,
        publicKey: args.publicKey,
        status: "queued" as const,
        totalBatches: 0,
        completedBatches: 0,
        payments: args.payments,
        network: args.network,
        signedTransactions: args.signedTransactions,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      const responseBody = args.buildResponseBody(jobId);
      idempotencyKeys.set(args.idempotencyKey, { jobId, requestHash: args.requestHash, responseBody });
      return {
        jobId,
        responseBody,
        replayed: false,
      };
    }),
    IdempotencyConflictError: MockIdempotencyConflictError,
  };
});

class FakeFileReaderSync {
  readAsText(blob: any, encoding?: string): string {
    return blob._testContent || '';
  }
}
if (typeof globalThis !== 'undefined' && !(globalThis as any).FileReaderSync) {
  (globalThis as any).FileReaderSync = FakeFileReaderSync;

  const originalSlice = Blob.prototype.slice;
  Blob.prototype.slice = function(this: any, start?: number, end?: number, contentType?: string) {
    const sliced = originalSlice.call(this, start, end, contentType) as any;
    if (this._testContent !== undefined) {
      sliced._testContent = this._testContent.slice(start, end);
    }
    return sliced;
  };
}

import { createJob, updateJob, getJob } from "@/lib/job-store";
import { POST } from "@/app/api/batch-retry/route";
import type { BatchResult, PaymentInstruction } from "@/lib/stellar/types";
import { parseFileStream } from "@/lib/stellar/parser";

const OWNER = "GBI5V7T3FEBDBV3DX23WHGHHXI6QYFWNUS7FGJU2WSQKFDGARW2HVAYA";
const OTHER = "GBXR2LJHZWSW56XUIH35VPQMAP7BYKIUGWZJBP6HKSBSCRZSGD6XTY4N";
const RECIPIENT_OK = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const RECIPIENT_BAD = "GDX2CY6AP6MOZ5SBWOK2H43UCEWZJTQXXBI43RR5VMSY3O7HZHCTZAZL";

let payments: PaymentInstruction[] = [];

beforeAll(async () => {
  const csvContent = `address,amount,asset
${RECIPIENT_OK},10.0000000,XLM
${RECIPIENT_BAD},5.0000000,XLM`;

  const file = new File([csvContent], 'test.csv', { type: 'text/csv' }) as any;
  file._testContent = csvContent;

  payments = await new Promise((resolve, reject) => {
    parseFileStream(file, {
      onComplete: (result) => resolve(result.payments),
      onError: (err) => reject(err),
    });
  });
});

const completedResult: BatchResult = {
    batchId: "test-batch",
    totalRecipients: 2,
    totalAmount: "15.0000000",
    totalTransactions: 1,
    network: "testnet",
    timestamp: new Date().toISOString(),
    results: [
        { recipient: RECIPIENT_OK, amount: "10.0000000", asset: "XLM", status: "success", transactionHash: "abc", rowIndex: 0 },
        { recipient: RECIPIENT_BAD, amount: "5.0000000", asset: "XLM", status: "failed", transactionHash: undefined, error: "op_no_destination", rowIndex: 1 },
    ],
    summary: { successful: 1, failed: 1 },
};

function makeRequest(body: Record<string, unknown>, headers?: Record<string, string>) {
    return new Request("http://localhost/api/batch-retry", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
}

describe("POST /api/batch-retry (#388)", () => {
    let jobId: string;

    beforeEach(() => {
        jobId = createJob(payments, "testnet", OWNER);
        updateJob(jobId, { status: "completed", result: completedResult });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    test("returns 400 when publicKey is missing", async () => {
        const res = await POST(makeRequest({ jobId }) as never);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/publicKey/i);
    });

    test("returns 400 when publicKey is malformed", async () => {
        const res = await POST(makeRequest({ jobId, publicKey: "not-a-key" }) as never);
        expect(res.status).toBe(400);
    });

    test("returns 404 when publicKey does not match the job owner", async () => {
        const res = await POST(makeRequest({ jobId, publicKey: OTHER }) as never);
        expect(res.status).toBe(404);
    });

    test("creates a retry job owned by — and pollable with — the same key", async () => {
        const res = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
        expect(res.status).toBe(202);

        const body = await res.json();
        expect(body.jobId).toBeDefined();
        expect(body.failedPayments).toBe(1);

        // The retry job must be scoped to the owning wallet so the UI can poll
        // GET /api/batch-status with the same publicKey (the bug left it orphaned).
        const retryJob = getJob(body.jobId, OWNER);
        expect(retryJob).toBeDefined();
        expect(retryJob?.publicKey).toBe(OWNER);
        expect(retryJob?.payments).toHaveLength(1);
        expect(retryJob?.payments[0].address).toBe(RECIPIENT_BAD);
    });

    test("duplicate retry requests with same idempotency key return same jobId (#550)", async () => {
        const idempotencyKey = "test-idempotency-key-123";
        
        const res1 = await POST(makeRequest(
            { jobId, publicKey: OWNER },
            { "Idempotency-Key": idempotencyKey }
        ) as never);
        expect(res1.status).toBe(202);
        const body1 = await res1.json();
        const firstJobId = body1.jobId;
        expect(firstJobId).toBeDefined();

        // Second request with same idempotency key should return same job
        const res2 = await POST(makeRequest(
            { jobId, publicKey: OWNER },
            { "Idempotency-Key": idempotencyKey }
        ) as never);
        expect(res2.status).toBe(202);
        const body2 = await res2.json();
        expect(body2.jobId).toBe(firstJobId);
        expect(body2.failedPayments).toBe(1);

        // Only one job should exist in the store
        const allJobs = getJob(firstJobId, OWNER);
        expect(allJobs).toBeDefined();
    });

    test("idempotency key reused with different body returns 409 (#550)", async () => {
        const idempotencyKey = "retry-idemp-diff-body-" + Date.now();

        // First request
        const res1 = await POST(makeRequest(
            { jobId, publicKey: OWNER },
            { "Idempotency-Key": idempotencyKey }
        ) as never);
        expect(res1.status).toBe(202);

        // Second request with same key but different jobId (same owner) should return 409
        const otherJobId = createJob(payments, "testnet", OWNER);
        updateJob(otherJobId, { status: "completed", result: completedResult });

        const res2 = await POST(makeRequest(
            { jobId: otherJobId, publicKey: OWNER },
            { "Idempotency-Key": idempotencyKey }
        ) as never);
        expect(res2.status).toBe(409);
        const body2 = await res2.json();
        expect(body2.error).toMatch(/idempotency/i);
    });

    test("derived idempotency key prevents duplicate retries without header (#550)", async () => {
        // When no Idempotency-Key header is provided, the endpoint derives one from jobId+publicKey
        const res1 = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
        expect(res1.status).toBe(202);
        const body1 = await res1.json();
        const firstJobId = body1.jobId;

        // Second request without header should still be idempotent due to derived key
        const res2 = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
        expect(res2.status).toBe(202);
        const body2 = await res2.json();
        expect(body2.jobId).toBe(firstJobId);
    });

    test("retries a pre-signed batch with stored payment metadata (#515)", async () => {
        const preSignedJobId = createJob(payments, "testnet", OWNER, ["AAAA", "BBBB"]);
        updateJob(preSignedJobId, { status: "completed", result: completedResult });

        const res = await POST(makeRequest({ jobId: preSignedJobId, publicKey: OWNER }) as never);
        expect(res.status).toBe(202);

        const body = await res.json();
        expect(body.jobId).toBeDefined();
        expect(body.failedPayments).toBe(1);

        const retryJob = getJob(body.jobId, OWNER);
        expect(retryJob).toBeDefined();
        expect(retryJob?.payments).toHaveLength(1);
        expect(retryJob?.payments[0].address).toBe(RECIPIENT_BAD);
    });

    test("blocks retry when failed row is pending Horizon reconciliation (#697)", async () => {
        const unreconciledResult: BatchResult = {
            batchId: "batch-unrec",
            totalRecipients: 1,
            totalAmount: "5.0000000",
            totalTransactions: 1,
            network: "testnet",
            timestamp: new Date().toISOString(),
            results: [
                {
                    recipient: RECIPIENT_BAD,
                    amount: "5.0000000",
                    asset: "XLM",
                    status: "unknown",
                    error: "UNRECONCILED_SUBMISSION_ERROR: Transport failure occurred",
                    rowIndex: 1,
                },
            ],
            summary: { successful: 0, failed: 1 },
        };
        const unrecJobId = createJob(payments, "testnet", OWNER);
        updateJob(unrecJobId, { status: "completed", result: unreconciledResult });

        const res = await POST(makeRequest({ jobId: unrecJobId, publicKey: OWNER }) as never);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toMatch(/Horizon reconciliation is pending/i);
    });
});
