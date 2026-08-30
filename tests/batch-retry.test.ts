/**
 * Integration tests for POST /api/batch-retry (#388, #711).
 *
 * Covers:
 *  - Owner-scoped access: only the submitting wallet may retry its own job.
 *  - Server key binding: the server signing key must match the caller's
 *    publicKey before any funds can move (#711).
 *  - Idempotency: duplicate requests with the same key are collapsed (#550).
 *  - Pre-signed batch retry with preserved payment metadata (#515).
 *  - Horizon reconciliation guard (#697).
 */

import {
  beforeEach,
  afterEach,
  describe,
  expect,
  test,
  vi,
  beforeAll,
} from "vitest";
import { Keypair } from "stellar-sdk";

process.env.JOB_STORE_PATH = ":memory:";
process.env.ALLOW_SERVER_SIGNING = "true";
// #728: server-signing now fails closed without a configured API key, so
// every request in this file needs one — see the Authorization header
// baked into makeRequest() below.
const SERVER_SIGNING_API_KEY = "test-api-key-for-server-signing-batch-retry-728";
process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

// Use a deterministic, cryptographically valid server keypair so tests that
// assert on the derived public key remain stable across runs.
const SERVER_KEYPAIR = Keypair.fromSecret(
  "SAWKN5JE4TDHVIDHY6GDHWLSYA4VQRZ4SKNH7B4W2KIYAOP3Z7R7KA4P",
);
const SERVER_PUBLIC_KEY = SERVER_KEYPAIR.publicKey();

process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();

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
    createJob: vi.fn(
      (
        payments: any[],
        network: string,
        publicKey: string,
        signedTransactions?: string[],
      ) => {
        const jobId = `job-${Date.now()}-${Math.random()}`;
        jobs.set(jobId, {
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
        });
        return jobId;
      },
    ),
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
    createIdempotentJob: vi.fn(
      (args: {
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
        jobs.set(jobId, {
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
        });
        const responseBody = args.buildResponseBody(jobId);
        idempotencyKeys.set(args.idempotencyKey, {
          jobId,
          requestHash: args.requestHash,
          responseBody,
        });
        return { jobId, responseBody, replayed: false };
      },
    ),
    IdempotencyConflictError: MockIdempotencyConflictError,
  };
});

class FakeFileReaderSync {
  readAsText(blob: any): string {
    return blob._testContent || "";
  }
}
if (typeof globalThis !== "undefined" && !(globalThis as any).FileReaderSync) {
  (globalThis as any).FileReaderSync = FakeFileReaderSync;

  const originalSlice = Blob.prototype.slice;
  Blob.prototype.slice = function (
    this: any,
    start?: number,
    end?: number,
    contentType?: string,
  ) {
    const sliced = originalSlice.call(this, start, end, contentType) as any;
    if (this._testContent !== undefined) {
      sliced._testContent = this._testContent.slice(start, end);
    }
    return sliced;
  };
}

import { createJob, updateJob, getJob, createIdempotentJob } from "@/lib/job-store";
// #743: exercise batch-retry's own business logic without being throttled
// by the newly-added rate limit; 429 behavior is covered separately in
// tests/api-rate-limit-endpoints.test.ts.
vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: vi.fn(() => ({ blocked: false, response: undefined })),
  setRateLimitHeaders: vi.fn((response: Response) => response),
}));

import { POST } from "@/app/api/batch-retry/route";
import type { BatchResult, PaymentInstruction } from "@/lib/stellar/types";
import { parseFileStream } from "@/lib/stellar/parser";

// The server key is the job owner throughout these tests.
const OWNER = SERVER_PUBLIC_KEY;
// A completely separate wallet that has no relation to the server key.
const ATTACKER = "GBXR2LJHZWSW56XUIH35VPQMAP7BYKIUGWZJBP6HKSBSCRZSGD6XTY4N";
const RECIPIENT_OK = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const RECIPIENT_BAD =
  "GDX2CY6AP6MOZ5SBWOK2H43UCEWZJTQXXBI43RR5VMSY3O7HZHCTZAZL";

let payments: PaymentInstruction[] = [];

beforeAll(async () => {
  const csvContent = `address,amount,asset\n${RECIPIENT_OK},10.0000000,XLM\n${RECIPIENT_BAD},5.0000000,XLM`;

  const file = new File([csvContent], "test.csv", { type: "text/csv" }) as any;
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
    {
      recipient: RECIPIENT_OK,
      amount: "10.0000000",
      asset: "XLM",
      status: "success",
      transactionHash: "abc",
      rowIndex: 0,
    },
    {
      recipient: RECIPIENT_BAD,
      amount: "5.0000000",
      asset: "XLM",
      status: "failed",
      transactionHash: undefined,
      error: "op_no_destination",
      rowIndex: 1,
    },
  ],
  summary: { successful: 1, failed: 1 },
};

function makeRequest(
  body: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return new Request("http://localhost/api/batch-retry", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // #728: fail-closed default requires a valid credential; individual
      // tests can still override this via `headers` if they ever need to.
      Authorization: `Bearer ${SERVER_SIGNING_API_KEY}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/batch-retry (#388)", () => {
  let jobId: string;

  beforeEach(async () => {
    jobId = await createJob(payments, "testnet", OWNER);
    await updateJob(jobId, { status: "completed", result: completedResult });
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
    const res = await POST(
      makeRequest({ jobId, publicKey: "not-a-key" }) as never,
    );
    expect(res.status).toBe(400);
  });

  test("returns 403 when publicKey does not match the server signing account (#711)", async () => {
    // ATTACKER supplies their own valid-format public key but it is not the
    // server signing key, so the endpoint must reject before touching the job.
    const res = await POST(
      makeRequest({ jobId, publicKey: ATTACKER }) as never,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/STELLAR_SECRET_KEY/i);
  });

  test("returns 404 when jobId is unknown for the given publicKey", async () => {
    const res = await POST(
      makeRequest({ jobId: "nonexistent-job", publicKey: OWNER }) as never,
    );
    expect(res.status).toBe(404);
  });

  test("creates a retry job owned by and pollable with the same key", async () => {
    const res = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.jobId).toBeDefined();
    expect(body.failedPayments).toBe(1);

    // The retry job must be scoped to the owning wallet so the UI can poll
    // GET /api/batch-status with the same publicKey (the bug left it orphaned).
    const retryJob = await getJob(body.jobId, OWNER);
    expect(retryJob).toBeDefined();
    expect(retryJob?.publicKey).toBe(OWNER);
    expect(retryJob?.payments).toHaveLength(1);
    expect(retryJob?.payments[0].address).toBe(RECIPIENT_BAD);
  });

  test("rejects server-funded retry for a job owned by a foreign wallet (#711)", async () => {
    // Simulate the attack: a job that was originally submitted by ATTACKER
    // (e.g. a pre-signed batch with an intentionally stale sequence) ends up
    // with failed payments. The attacker then calls POST /api/batch-retry
    // supplying the server's public key in an attempt to have the server wallet
    // fund the retry.
    const attackerJobId = await createJob(payments, "testnet", ATTACKER);
    await updateJob(attackerJobId, { status: "completed", result: completedResult });

    // Attacker passes SERVER_PUBLIC_KEY to try to match the signing key,
    // but the job itself is owned by ATTACKER — the endpoint must reject.
    const res = await POST(
      makeRequest({
        jobId: attackerJobId,
        publicKey: SERVER_PUBLIC_KEY,
      }) as never,
    );

    // The job store returns null when the (jobId, publicKey) pair does not
    // match, so the caller sees 404 rather than a 403 revealing internals.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  test("duplicate retry requests with same idempotency key return same jobId (#550)", async () => {
    const idempotencyKey = "test-idempotency-key-123";

    const res1 = await POST(
      makeRequest(
        { jobId, publicKey: OWNER },
        { "Idempotency-Key": idempotencyKey },
      ) as never,
    );
    expect(res1.status).toBe(202);
    const body1 = await res1.json();
    const firstJobId = body1.jobId;
    expect(firstJobId).toBeDefined();

    const res2 = await POST(
      makeRequest(
        { jobId, publicKey: OWNER },
        { "Idempotency-Key": idempotencyKey },
      ) as never,
    );
    expect(res2.status).toBe(202);
    const body2 = await res2.json();
    expect(body2.jobId).toBe(firstJobId);
    expect(body2.failedPayments).toBe(1);

    const stored = await getJob(firstJobId, OWNER);
    expect(stored).toBeDefined();
  });

  test("idempotency key reused with different body returns 409 (#550)", async () => {
    const idempotencyKey = "retry-idemp-diff-body-" + Date.now();

    const res1 = await POST(
      makeRequest(
        { jobId, publicKey: OWNER },
        { "Idempotency-Key": idempotencyKey },
      ) as never,
    );
    expect(res1.status).toBe(202);

    const otherJobId = await createJob(payments, "testnet", OWNER);
    await updateJob(otherJobId, { status: "completed", result: completedResult });

    const res2 = await POST(
      makeRequest(
        { jobId: otherJobId, publicKey: OWNER },
        { "Idempotency-Key": idempotencyKey },
      ) as never,
    );
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toMatch(/idempotency/i);
  });

  test("derived idempotency key prevents duplicate retries without header (#550)", async () => {
    const res1 = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
    expect(res1.status).toBe(202);
    const firstJobId = (await res1.json()).jobId;

    const res2 = await POST(makeRequest({ jobId, publicKey: OWNER }) as never);
    expect(res2.status).toBe(202);
    expect((await res2.json()).jobId).toBe(firstJobId);
  });

  test("retries a pre-signed batch with stored payment metadata (#515)", async () => {
    const preSignedJobId = await createJob(payments, "testnet", OWNER, [
      "AAAA",
      "BBBB",
    ]);
    await updateJob(preSignedJobId, { status: "completed", result: completedResult });

    const res = await POST(
      makeRequest({ jobId: preSignedJobId, publicKey: OWNER }) as never,
    );
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.jobId).toBeDefined();
    expect(body.failedPayments).toBe(1);

    const retryJob = await getJob(body.jobId, OWNER);
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
    const unrecJobId = await createJob(payments, "testnet", OWNER);
    await updateJob(unrecJobId, { status: "completed", result: unreconciledResult });

    const res = await POST(
      makeRequest({ jobId: unrecJobId, publicKey: OWNER }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Horizon reconciliation is pending/i);
  });
});

describe("POST /api/batch-retry — sanitized error responses (#748)", () => {
  let jobId: string;

  beforeEach(async () => {
    jobId = await createJob(payments, "testnet", OWNER);
    await updateJob(jobId, { status: "completed", result: completedResult });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("a forced unexpected failure never leaks error.message or a stack trace", async () => {
    const sensitiveMessage =
      "EACCES: permission denied, open '/etc/stellar/server-signing-key'";
    vi.mocked(createIdempotentJob).mockImplementationOnce(() => {
      throw new Error(sensitiveMessage);
    });

    const res = await POST(
      makeRequest({ jobId, publicKey: OWNER }) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("EACCES");
    expect(raw).not.toContain("/etc/stellar");
    expect(raw).not.toContain("server-signing-key");
    expect(raw).not.toContain(".ts:");
    expect(body).not.toHaveProperty("stack");
  });

  test("echoes back a client-supplied x-request-id header on a forced throw", async () => {
    vi.mocked(createIdempotentJob).mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const res = await POST(
      makeRequest(
        { jobId, publicKey: OWNER },
        { "x-request-id": "trace-retry-1" },
      ) as never,
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.requestId).toBe("trace-retry-1");
  });
});
