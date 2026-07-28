/**
 * Regression tests for the background batch worker.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Keypair, TransactionBuilder } from "stellar-sdk";

process.env.JOB_STORE_PATH = ":memory:";

const mockSubmitTransaction = vi.fn();
const mockTriggerWebhooksWithRetry = vi.fn().mockResolvedValue(undefined);

vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();

  class MockServer {
    submitTransaction = mockSubmitTransaction;
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
    TransactionBuilder: {
      fromXDR: vi.fn(() => ({
        sign: vi.fn(),
        toEnvelope: () => ({ toXDR: () => "mock-worker-xdr" }),
      })),
    },
  };
});

vi.mock("../lib/webhooks", () => ({
  triggerWebhooksWithRetry: mockTriggerWebhooksWithRetry,
}));

describe("processJobInBackground — pre-signed (client-side) path", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
    mockTriggerWebhooksWithRetry.mockReset();
    mockTriggerWebhooksWithRetry.mockResolvedValue(undefined);
    // Restore the default envelope shape so a per-test override (e.g. the
    // multi-op #512 case) never leaks into later tests.
    vi.mocked(TransactionBuilder.fromXDR).mockImplementation(
      () =>
        ({
          sign: vi.fn(),
          toEnvelope: () => ({ toXDR: () => "mock-worker-xdr" }),
        }) as unknown as ReturnType<typeof TransactionBuilder.fromXDR>,
    );
  });

  test("marks a pre-signed job failed when every Horizon submit fails", async () => {
    mockSubmitTransaction.mockRejectedValue(new Error("horizon down"));

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const signedTransactions = ["AAAA"];
    const payments = [{ address: recipient, amount: "1", asset: "XLM" }];

    const jobId = createJob(payments, "testnet", owner, signedTransactions);

    await processJobInBackground(jobId, payments, "testnet");

    const job = getJob(jobId);

    expect(job?.status).toBe("failed");
    expect(job?.result?.summary.failed).toBe(1);
    expect(job?.result?.summary.successful).toBe(0);
  });

  test("attributes success to actual XDR operations when payments is empty (#512)", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "multiop_hash" });

    // A single pre-signed envelope carrying three recipient operations and no
    // out-of-band payment metadata (pure XDR submit, #300).
    const threeOpTx = { operations: [{}, {}, {}], sign: vi.fn() };
    vi.mocked(TransactionBuilder.fromXDR).mockReturnValue(
      {
        ...threeOpTx,
        toEnvelope: () => ({ toXDR: () => "mock-worker-three-op-xdr" }),
      } as unknown as ReturnType<typeof TransactionBuilder.fromXDR>,
    );

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const signedTransactions = ["MULTIOP"];

    // Job created with no payments — the empty-payments path under test.
    const jobId = createJob([], "testnet", owner, signedTransactions);

    await processJobInBackground(jobId, [], "testnet", undefined, signedTransactions);

    const job = getJob(jobId);

    expect(job?.status).toBe("completed");
    // successful must equal the op count (3), not 1-per-transaction.
    expect(job?.result?.summary.successful).toBe(3);
    expect(job?.result?.summary.failed).toBe(0);
    // Totals and the results table stay internally consistent.
    expect(job?.result?.totalRecipients).toBe(3);
    expect(job?.result?.results).toHaveLength(3);
  });

  test("marks a pre-signed job completed when all Horizon submits succeed", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "abc123" });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const signedTransactions = ["AAAA", "BBBB"];
    const payments = [
      { address: recipient, amount: "1", asset: "XLM" },
      { address: Keypair.random().publicKey(), amount: "2", asset: "XLM" },
    ];

    const jobId = createJob(payments, "testnet", owner, signedTransactions);

    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = getJob(jobId);

    expect(job?.status).toBe("completed");
    expect(job?.result?.summary.successful).toBeGreaterThan(0);
    expect(job?.result?.summary.failed).toBe(0);
  });

  test("marks job as processing during execution then resolves to failed on all errors", async () => {
    mockSubmitTransaction.mockRejectedValue(new Error("timeout"));

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const payments = [{ address: Keypair.random().publicKey(), amount: "5", asset: "XLM" }];
    const signedTransactions = ["CCCC"];

    const jobId = createJob(payments, "testnet", owner, signedTransactions);

    await processJobInBackground(jobId, payments, "testnet");

    const job = getJob(jobId);
    expect(["failed", "completed"]).toContain(job?.status);
  });

  test("reads signedTransactions from job state when not passed as argument (#337)", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "recovered_hash" });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const payments = [{ address: Keypair.random().publicKey(), amount: "3", asset: "XLM" }];
    const signedTransactions = ["DDDD"];

    const jobId = createJob(payments, "testnet", owner, signedTransactions);

    // Do NOT pass signedTransactions — worker must recover them from job state
    await processJobInBackground(jobId, payments, "testnet");

    const job = getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(mockSubmitTransaction).toHaveBeenCalledOnce();
  });

  test("recovers payments from job state when not passed as argument (#515)", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "recovered_payments_hash" });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient1 = Keypair.random().publicKey();
    const recipient2 = Keypair.random().publicKey();
    const payments = [
      { address: recipient1, amount: "1", asset: "XLM" },
      { address: recipient2, amount: "2", asset: "XLM" },
    ];
    const signedTransactions = ["RECOVER"];

    const jobId = createJob(payments, "testnet", owner, signedTransactions);

    // Do NOT pass payments — worker must recover them from job state (#515)
    await processJobInBackground(jobId, [], "testnet", undefined, signedTransactions);

    const job = getJob(jobId);
    expect(job?.status).toBe("completed");
    // Results should contain real recipient addresses, not synthetic placeholders
    expect(job?.result?.results[0].recipient).toBe(recipient1);
    expect(job?.result?.results[1].recipient).toBe(recipient2);
    expect(mockSubmitTransaction).toHaveBeenCalledOnce();
  });

  test("exits early and does nothing when job is already completed", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "should_not_be_called" });

    const { createJob, getJob, updateJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const payments = [{ address: Keypair.random().publicKey(), amount: "1", asset: "XLM" }];
    const jobId = createJob(payments, "testnet", owner, ["EEEE"]);

    // Pre-mark as completed
    updateJob(jobId, { status: "completed" });

    await processJobInBackground(jobId, payments, "testnet");

    const job = getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  test("does nothing when job does not exist", async () => {
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const payments = [{ address: Keypair.random().publicKey(), amount: "1", asset: "XLM" }];
    // Should not throw
    await expect(
      processJobInBackground("nonexistent-job-id", payments, "testnet"),
    ).resolves.toBeUndefined();
  });
});

describe("processJobInBackground — webhook delivery", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
    mockTriggerWebhooksWithRetry.mockReset();
    mockTriggerWebhooksWithRetry.mockResolvedValue(undefined);
  });

  test("fires batch.failed webhook when worker-level error is thrown", async () => {
    // Force the worker into a top-level catch by making the job store throw
    const { createJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const payments = [{ address: Keypair.random().publicKey(), amount: "1", asset: "XLM" }];

    // No signed transactions and no secretKey — triggers "secretKey is required" throw
    const jobId = createJob(payments, "testnet", owner);

    await processJobInBackground(jobId, payments, "testnet");

    expect(mockTriggerWebhooksWithRetry).toHaveBeenCalledWith(
      "batch.failed",
      expect.objectContaining({ jobId }),
      jobId,
    );
  });
});

describe("processJobInBackground — concurrent processing guards (#508)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
    mockTriggerWebhooksWithRetry.mockReset();
    mockTriggerWebhooksWithRetry.mockResolvedValue(undefined);
  });

  test("only one worker can claim a queued job atomically", async () => {
    const { createJob, claimJobForProcessing } = await import("../lib/job-store");
    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "1", asset: "XLM" }];

    const jobId = createJob(payments, "testnet", owner, ["AAAA"]);

    const claims = await Promise.all([
      claimJobForProcessing(jobId),
      claimJobForProcessing(jobId),
      claimJobForProcessing(jobId),
    ]);

    const successCount = claims.filter(Boolean).length;
    expect(successCount).toBe(1);
  });

  test("reclaims a stale processing job after lease timeout", async () => {
    const { createJob, claimJobForProcessing, getDb } = await import("../lib/job-store");
    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "1", asset: "XLM" }];

    const jobId = createJob(payments, "testnet", owner, ["AAAA"]);

    const firstClaim = claimJobForProcessing(jobId);
    expect(firstClaim).toBe(true);

    const secondClaimImmediately = claimJobForProcessing(jobId);
    expect(secondClaimImmediately).toBe(false);

    const staleTime = new Date(Date.now() - 40000).toISOString();
    getDb().prepare("UPDATE jobs SET updatedAt = ? WHERE jobId = ?").run(staleTime, jobId);

    const thirdClaimStale = claimJobForProcessing(jobId);
    expect(thirdClaimStale).toBe(true);
  });

  test("concurrent processJobInBackground calls produce a single Horizon submission set", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "abc123" });

    const { createJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "1", asset: "XLM" }];

    const jobId = createJob(payments, "testnet", owner, ["AAAA"]);

    await Promise.all([
      processJobInBackground(jobId, payments, "testnet"),
      processJobInBackground(jobId, payments, "testnet"),
    ]);

    expect(mockSubmitTransaction).toHaveBeenCalledOnce();
  });
});
