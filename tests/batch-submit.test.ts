/**
 * Regression tests for POST /api/batch-submit idempotency handling.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "stellar-sdk";

const { mockProcessJobInBackground } = vi.hoisted(() => ({
  mockProcessJobInBackground: vi.fn(),
}));

const { mockCreateIdempotentJob } = vi.hoisted(() => ({
  mockCreateIdempotentJob: vi.fn(),
}));

const { mockGetJob, jobStates, jobPayments } = vi.hoisted(() => ({
  mockGetJob: vi.fn(),
  jobStates: new Map<string, { status: string; updatedAt: string }>(),
  jobPayments: new Map<string, unknown[]>(),
}));

vi.mock("@/lib/stellar/batch-worker", () => ({
  processJobInBackground: mockProcessJobInBackground,
}));

vi.mock("@/lib/job-store", async () => {
  class MockIdempotencyConflictError extends Error {
    constructor() {
      super("Idempotency key already exists for a different request body");
      this.name = "IdempotencyConflictError";
    }
  }

  const entries = new Map<string, { requestHash: string; jobId: string; responseBody: unknown }>();

  mockCreateIdempotentJob.mockImplementation((args: {
    idempotencyKey: string;
    requestHash: string;
    buildResponseBody: (jobId: string) => unknown;
  }) => {
    const existing = entries.get(args.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== args.requestHash) {
        throw new MockIdempotencyConflictError();
      }

      return {
        jobId: existing.jobId,
        responseBody: existing.responseBody,
        replayed: true,
      };
    }

    const jobId = `job-${entries.size + 1}`;
    const responseBody = args.buildResponseBody(jobId);
    entries.set(args.idempotencyKey, {
      requestHash: args.requestHash,
      jobId,
      responseBody,
    });
        // #515: Store payments alongside the job so tests can verify persistence
    const storedPayments = (args as any).payments ?? [];
    jobPayments.set(jobId, storedPayments);
    // Mirror the durable store: a fresh job starts "queued" with a current timestamp.
    jobStates.set(jobId, { status: "queued", updatedAt: new Date().toISOString() });

    return {
      jobId,
      responseBody,
      replayed: false,
    };
  });

  mockGetJob.mockImplementation((jobId: string) => {
    const state = jobStates.get(jobId);
    return state ? { jobId, ...state } : undefined;
  });

  return {
    createIdempotentJob: mockCreateIdempotentJob,
    getJob: mockGetJob,
    IdempotencyConflictError: MockIdempotencyConflictError,
  };
});

vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: vi.fn(() => ({ blocked: false, response: undefined })),
  setRateLimitHeaders: vi.fn((response: Response) => response),
}));

import { POST } from "@/app/api/batch-submit/route";

const OWNER_KEYPAIR = Keypair.random();
const OWNER_PUBLIC_KEY = OWNER_KEYPAIR.publicKey();
const SERVER_KEYPAIR = Keypair.random();
const OTHER_PUBLIC_KEY = Keypair.random().publicKey();
const SERVER_SIGNING_API_KEY = "test-api-key-for-server-signing-696";

const baseBody = {
  network: "testnet" as const,
  publicKey: OWNER_PUBLIC_KEY,
  signedTransactions: ["AAAA"],
};

beforeEach(() => {
  mockProcessJobInBackground.mockClear();
  mockCreateIdempotentJob.mockClear();
  mockGetJob.mockClear();
  delete process.env.ALLOW_SERVER_SIGNING;
  delete process.env.STELLAR_SECRET_KEY;
  delete process.env.SERVER_SIGNING_API_KEY;
});

/** Force a job into a given status with a chosen age (ms in the past). */
function setJobState(jobId: string, status: string, ageMs: number) {
  jobStates.set(jobId, {
    status,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });
}

function buildSignedXdr(sourceKeypair: Keypair): string {
  const account = new Account(sourceKeypair.publicKey(), "0");
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
    .setTimeout(300)
    .build();
  tx.sign(sourceKeypair);
  return tx.toEnvelope().toXDR("base64");
}

function makeRequest(body: object, idempotencyKey: string, extraHeaders?: Record<string, string>) {
  return new Request("http://localhost/api/batch-submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/batch-submit idempotency", () => {
  test("returns the same jobId for a replayed request and only starts one worker", async () => {
    const idempotencyKey = "stable-idempotency-key";

    const firstResponse = await POST(makeRequest(baseBody, idempotencyKey) as never);
    const firstJson = await firstResponse.json();

    const secondResponse = await POST(makeRequest(baseBody, idempotencyKey) as never);
    const secondJson = await secondResponse.json();

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstJson.jobId).toBe(secondJson.jobId);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });

  test("rejects server signing when the configured secret does not match the request public key", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

    const response = await POST(
      makeRequest(
        {
          network: "testnet",
          publicKey: OTHER_PUBLIC_KEY,
          payments: [
            {
              address: OWNER_PUBLIC_KEY,
              amount: "1",
              asset: "XLM",
            },
          ],
          idempotencyKey: "mismatch-key",
        },
        "mismatch-key",
        { Authorization: `Bearer ${SERVER_SIGNING_API_KEY}` },
      ) as never,
    );

    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toMatch(/publicKey/i);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(0);
  });

  test("rejects a conflicting body that reuses the same key", async () => {
    const idempotencyKey = "conflicting-key";

    await POST(makeRequest(baseBody, idempotencyKey) as never);

    const conflictingBody = {
      ...baseBody,
      signedTransactions: ["BBBB"],
    };

    const response = await POST(makeRequest(conflictingBody, idempotencyKey) as never);
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toMatch(/idempotency key/i);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/batch-submit stranded-worker replay (#502)", () => {
  test("restarts the worker when a replayed job is still queued and stale", async () => {
    const idempotencyKey = "stranded-queued-key";

    const firstResponse = await POST(makeRequest(baseBody, idempotencyKey) as never);
    const firstJson = await firstResponse.json();
    expect(firstJson.replayed).toBe(false);
    expect(firstJson.workerRestarted).toBe(false);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);

    // Simulate a server restart: the original fire-and-forget worker never ran,
    // so the job is still "queued" with a stale updatedAt.
    setJobState(firstJson.jobId, "queued", 60_000);

    const secondResponse = await POST(makeRequest(baseBody, idempotencyKey) as never);
    const secondJson = await secondResponse.json();

    expect(secondResponse.status).toBe(202);
    expect(secondJson.jobId).toBe(firstJson.jobId);
    expect(secondJson.replayed).toBe(true);
    expect(secondJson.workerRestarted).toBe(true);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(2);
  });

  test("restarts the worker for a replayed job stuck in stale processing", async () => {
    const idempotencyKey = "stranded-processing-key";

    const firstJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();
    setJobState(firstJson.jobId, "processing", 60_000);

    const secondJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();

    expect(secondJson.replayed).toBe(true);
    expect(secondJson.workerRestarted).toBe(true);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(2);
  });

  test("does not restart the worker for a completed replayed job (no double payout)", async () => {
    const idempotencyKey = "completed-replay-key";

    const firstJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();
    setJobState(firstJson.jobId, "completed", 60_000);

    const secondJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();

    expect(secondJson.replayed).toBe(true);
    expect(secondJson.workerRestarted).toBe(false);
    // Only the original (fresh) submission started a worker.
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });

  test("does not restart the worker while a fresh job is still actively processing", async () => {
    const idempotencyKey = "fresh-processing-key";

    const firstJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();
    // Recent update — the worker is presumed to be running; don't race it.
    setJobState(firstJson.jobId, "processing", 1_000);

    const secondJson = await (await POST(makeRequest(baseBody, idempotencyKey) as never)).json();

    expect(secondJson.replayed).toBe(true);
    expect(secondJson.workerRestarted).toBe(false);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });

  test("restarts a stranded server-signed job on replay", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

    const serverBody = {
      network: "testnet" as const,
      publicKey: SERVER_KEYPAIR.publicKey(),
      payments: [{ address: OWNER_PUBLIC_KEY, amount: "1", asset: "XLM" }],
    };
    const idempotencyKey = "server-signed-stranded-key";

    const firstJson = await (await POST(makeRequest(serverBody, idempotencyKey, { Authorization: `Bearer ${SERVER_SIGNING_API_KEY}` }) as never)).json();
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);

    setJobState(firstJson.jobId, "queued", 60_000);

    const secondJson = await (await POST(makeRequest(serverBody, idempotencyKey, { Authorization: `Bearer ${SERVER_SIGNING_API_KEY}` }) as never)).json();

    expect(secondJson.replayed).toBe(true);
    expect(secondJson.workerRestarted).toBe(true);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(2);
    // The restarted worker is invoked with the original payments + secret key.
    const lastCall = mockProcessJobInBackground.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe(firstJson.jobId);
    expect(lastCall[3]).toBe(SERVER_KEYPAIR.secret());
  });
});

describe("POST /api/batch-submit pre-signed source verification (#504)", () => {
  test("rejects an XDR whose source does not match publicKey with 403", async () => {
    const attacker = Keypair.random();
    const body = {
      network: "testnet" as const,
      publicKey: OWNER_PUBLIC_KEY,
      signedTransactions: [buildSignedXdr(attacker)],
    };

    const response = await POST(makeRequest(body, "mismatched-source-key") as never);
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toMatch(/source account does not match/i);
    // Rejected before the job is ever created or a worker started.
    expect(mockCreateIdempotentJob).not.toHaveBeenCalled();
    expect(mockProcessJobInBackground).not.toHaveBeenCalled();
  });

  test("accepts payments alongside signedTransactions and passes them to createIdempotentJob (#515)", async () => {
    const payments = [
      { address: OWNER_PUBLIC_KEY, amount: "10", asset: "XLM" },
      { address: OTHER_PUBLIC_KEY, amount: "5", asset: "XLM" },
    ];
    // Use a real signed XDR so the op-count validation passes (1 op per XDR,
    // but we have 2 payments... so we use 2 single-op XDRs to match).
    const body = {
      network: "testnet" as const,
      publicKey: OWNER_PUBLIC_KEY,
      signedTransactions: [buildSignedXdr(OWNER_KEYPAIR), buildSignedXdr(OWNER_KEYPAIR)],
      payments,
    };

    const response = await POST(makeRequest(body, "payments-with-xdrs-key") as never);
    expect(response.status).toBe(202);

    // Verify payments were passed to createIdempotentJob
    const lastCall = mockCreateIdempotentJob.mock.calls.at(-1)!;
    const args = lastCall[0];
    expect(args.payments).toEqual(payments);
    expect(args.payments).not.toEqual([]);
  });

  test("rejects payments count mismatch with XDR operations (#515)", async () => {
    const payments = [{ address: OWNER_PUBLIC_KEY, amount: "10", asset: "XLM" }];
    // One signed XDR but only one payment — a single-op XDR should match one payment.
    // Use a real signed XDR so operationCountOf returns a count.
    const signedXdr = buildSignedXdr(OWNER_KEYPAIR);

    // Pass 2 payments vs 1 operation in the XDR
    const body = {
      network: "testnet" as const,
      publicKey: OWNER_PUBLIC_KEY,
      signedTransactions: [signedXdr],
      payments: [
        { address: OWNER_PUBLIC_KEY, amount: "10", asset: "XLM" },
        { address: OTHER_PUBLIC_KEY, amount: "5", asset: "XLM" },
      ],
    };

    const response = await POST(makeRequest(body, "mismatch-ops-key") as never);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toMatch(/Payment count/i);
    expect(mockProcessJobInBackground).not.toHaveBeenCalled();
  });

  test("rejects a fee-bump whose inner source is a different wallet with 403", async () => {
    const attacker = Keypair.random();
    const innerAccount = new Account(attacker.publicKey(), "0");
    const innerTx = new TransactionBuilder(innerAccount, {
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
      .setTimeout(300)
      .build();
    innerTx.sign(attacker);

    // OWNER pays the fee but the inner payment is the attacker's — must reject.
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      OWNER_KEYPAIR,
      (Number(BASE_FEE) * 2).toString(),
      innerTx,
      Networks.TESTNET,
    );
    feeBump.sign(OWNER_KEYPAIR);

    const body = {
      network: "testnet" as const,
      publicKey: OWNER_PUBLIC_KEY,
      signedTransactions: [feeBump.toEnvelope().toXDR("base64")],
    };

    const response = await POST(makeRequest(body, "feebump-mismatch-key") as never);
    expect(response.status).toBe(403);
    expect(mockProcessJobInBackground).not.toHaveBeenCalled();
  });

  test("accepts an XDR whose source matches publicKey and starts the worker", async () => {
    const body = {
      network: "testnet" as const,
      publicKey: OWNER_PUBLIC_KEY,
      signedTransactions: [buildSignedXdr(OWNER_KEYPAIR)],
    };

    const response = await POST(makeRequest(body, "matching-source-key") as never);

    expect(response.status).toBe(202);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/batch-submit server-signing auth (#696)", () => {
  test("rejects server-signing request with correct publicKey but no API key (401)", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

    const body = {
      network: "testnet" as const,
      publicKey: SERVER_KEYPAIR.publicKey(),
      payments: [{ address: OWNER_PUBLIC_KEY, amount: "1", asset: "XLM" }],
    };

    // No Authorization header
    const response = await POST(makeRequest(body, "no-auth-key") as never);
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toMatch(/Authorization/i);
    expect(mockProcessJobInBackground).not.toHaveBeenCalled();
  });

  test("rejects server-signing request with wrong API key (403)", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

    const body = {
      network: "testnet" as const,
      publicKey: SERVER_KEYPAIR.publicKey(),
      payments: [{ address: OWNER_PUBLIC_KEY, amount: "1", asset: "XLM" }],
    };

    const response = await POST(
      makeRequest(body, "wrong-auth-key", { Authorization: "Bearer wrong-key" }) as never,
    );
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json.error).toMatch(/Invalid server-signing API key/i);
    expect(mockProcessJobInBackground).not.toHaveBeenCalled();
  });

  test("allows server-signing request when SERVER_SIGNING_API_KEY is not configured (backward-compat)", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    // SERVER_SIGNING_API_KEY is intentionally NOT set

    const body = {
      network: "testnet" as const,
      publicKey: SERVER_KEYPAIR.publicKey(),
      payments: [{ address: OWNER_PUBLIC_KEY, amount: "1", asset: "XLM" }],
    };

    const response = await POST(makeRequest(body, "backward-compat-key") as never);

    expect(response.status).toBe(202);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });

  test("allows server-signing request with valid API key", async () => {
    process.env.ALLOW_SERVER_SIGNING = "true";
    process.env.STELLAR_SECRET_KEY = SERVER_KEYPAIR.secret();
    process.env.SERVER_SIGNING_API_KEY = SERVER_SIGNING_API_KEY;

    const body = {
      network: "testnet" as const,
      publicKey: SERVER_KEYPAIR.publicKey(),
      payments: [{ address: OWNER_PUBLIC_KEY, amount: "1", asset: "XLM" }],
    };

    const response = await POST(
      makeRequest(body, "valid-auth-key", { Authorization: `Bearer ${SERVER_SIGNING_API_KEY}` }) as never,
    );

    expect(response.status).toBe(202);
    expect(mockProcessJobInBackground).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/batch-submit — sanitized error responses (#748)", () => {
  test("a forced unexpected failure never leaks error.message or a stack trace", async () => {
    const sensitiveMessage =
      "connect ECONNREFUSED /var/run/postgres/.s.PGSQL.5432";
    mockCreateIdempotentJob.mockImplementationOnce(() => {
      throw new Error(sensitiveMessage);
    });

    const response = await POST(
      makeRequest(baseBody, "sanitize-test-key") as never,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("/var/run/postgres");
    expect(raw).not.toContain(".ts:");
    expect(body).not.toHaveProperty("stack");
  });

  test("echoes back a client-supplied x-request-id header on a forced throw", async () => {
    mockCreateIdempotentJob.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    const response = await POST(
      makeRequest(baseBody, "sanitize-test-key-2", {
        "x-request-id": "trace-submit-1",
      }) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.requestId).toBe("trace-submit-1");
  });

  test("an idempotency conflict (409) still includes a requestId but keeps its curated message", async () => {
    const idempotencyKey = "conflict-key";
    await POST(makeRequest(baseBody, idempotencyKey) as never);

    const conflictingBody = { ...baseBody, signedTransactions: ["BBBB"] };
    const response = await POST(
      makeRequest(conflictingBody, idempotencyKey) as never,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("CONFLICT");
    expect(typeof body.requestId).toBe("string");
    expect(body.error).toMatch(/idempotency key/i);
  });
});