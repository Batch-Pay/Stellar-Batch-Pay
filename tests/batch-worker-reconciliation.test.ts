/**
 * Integration tests for the Horizon reconciliation path inside
 * processJobInBackground (lib/stellar/batch-worker.ts ~177-215, using
 * lib/stellar/reconciliation.ts) — #741.
 *
 * Before this suite, reconcileTransaction / isTransportError had zero test
 * references. Retry tests only asserted against hand-built result fixtures,
 * never against a job actually produced by the worker's transport-error →
 * reconcile branch. Without this coverage, a regression here reintroduces
 * double-pay (marking a landed transaction as failed and letting it be
 * retried) or a false-fail (retrying a transaction that actually succeeded).
 *
 * Covers the three outcome paths from the issue:
 *   1. transport error on submit → reconcile resolves "success"
 *   2. transport error on submit → reconcile resolves "failed"
 *   3. transport error on submit → reconcile is unresolved ("unknown"),
 *      and that such rows block /api/batch-retry.
 *
 * No live network is used anywhere in this file: Horizon's submitTransaction
 * is mocked, and reconcileTransaction is mocked per-test while the real
 * isTransportError implementation classifies the thrown error.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { Keypair, TransactionBuilder } from "stellar-sdk";

process.env.JOB_STORE_PATH = ":memory:";

const mockSubmitTransaction = vi.fn();
const mockTriggerWebhooksWithRetry = vi.fn().mockResolvedValue(undefined);
const mockReconcileTransaction = vi.fn();

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
        toEnvelope: () => ({ toXDR: () => "mock-reconciliation-xdr" }),
      })),
    },
  };
});

vi.mock("../lib/webhooks", () => ({
  triggerWebhooksWithRetry: mockTriggerWebhooksWithRetry,
}));

// Keep the real isTransportError so the thrown submit error must genuinely
// classify as transport-level; only reconcileTransaction's outcome is
// controlled per test.
vi.mock("../lib/stellar/reconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stellar/reconciliation")>();
  return {
    ...actual,
    reconcileTransaction: mockReconcileTransaction,
  };
});

// A realistic transport-level failure: isTransportError() recognizes 503s.
function transportError(): Error {
  return Object.assign(new Error("Horizon temporarily unavailable"), {
    response: { status: 503 },
  });
}

describe("processJobInBackground — Horizon reconciliation (#741)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
    mockTriggerWebhooksWithRetry.mockReset();
    mockTriggerWebhooksWithRetry.mockResolvedValue(undefined);
    mockReconcileTransaction.mockReset();
    vi.mocked(TransactionBuilder.fromXDR).mockImplementation(
      () =>
        ({
          sign: vi.fn(),
          toEnvelope: () => ({ toXDR: () => "mock-reconciliation-xdr" }),
        }) as unknown as ReturnType<typeof TransactionBuilder.fromXDR>,
    );
  });

  test("transport error + reconcile success: job completes and the row is marked successful", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockResolvedValue({ status: "success", attempts: 2 });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RECONCILE_SUCCESS"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);

    expect(mockReconcileTransaction).toHaveBeenCalledOnce();
    expect(job?.status).toBe("completed");
    expect(job?.result?.summary.successful).toBe(1);
    expect(job?.result?.summary.failed).toBe(0);

    const row = job?.result?.results[0];
    expect(row?.status).toBe("success");
    expect(row?.recipient).toBe(recipient);
    // The reconciled row is attributed the hash computed at submit time,
    // since Horizon's own submit response was never received.
    expect(row?.transactionHash).toBeTruthy();
    expect(row?.error).toBeUndefined();
  });

  test("transport error + reconcile failed: job fails and the row is marked failed with the original error", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockResolvedValue({ status: "failed", attempts: 4 });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RECONCILE_FAILED"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);

    expect(mockReconcileTransaction).toHaveBeenCalledOnce();
    expect(job?.status).toBe("failed");
    expect(job?.result?.summary.successful).toBe(0);
    // A definitively failed reconciliation is a real failure and must count
    // toward the failed summary so it surfaces to the caller and is
    // retry-eligible.
    expect(job?.result?.summary.failed).toBe(1);

    const row = job?.result?.results[0];
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("Horizon temporarily unavailable");
    expect(row?.error).not.toMatch(/UNRECONCILED_SUBMISSION_ERROR/);
  });

  test("transport error + unresolved reconciliation: row is quarantined as unreconciled, not counted as a confirmed failure", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockResolvedValue({ status: "unknown", attempts: 4 });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RECONCILE_UNKNOWN"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);

    expect(mockReconcileTransaction).toHaveBeenCalledOnce();
    // successCount stays 0, so the job as a whole is reported failed …
    expect(job?.status).toBe("failed");
    expect(job?.result?.summary.successful).toBe(0);
    // … but this specific row must NOT be counted as a confirmed failure:
    // its true on-chain outcome is still unknown, so blindly retrying it
    // risks a double-pay if it actually landed.
    expect(job?.result?.summary.failed).toBe(0);

    const row = job?.result?.results[0];
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/^UNRECONCILED_SUBMISSION_ERROR:/);
  });

  test("reconcileTransaction itself throwing is treated the same as an unresolved outcome", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockRejectedValue(new Error("Horizon still down"));

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RECONCILE_THROWS"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);
    const row = job?.result?.results[0];

    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/^UNRECONCILED_SUBMISSION_ERROR:/);
    expect(job?.result?.summary.failed).toBe(0);
  });

  test("a non-transport submit error skips reconciliation entirely and fails immediately", async () => {
    mockSubmitTransaction.mockRejectedValue(new Error("op_underfunded"));

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["NON_TRANSPORT_ERROR"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);

    // reconcileTransaction must never be called for an application-level
    // error — reconciliation is reserved for genuine transport failures.
    expect(mockReconcileTransaction).not.toHaveBeenCalled();
    expect(job?.status).toBe("failed");
    expect(job?.result?.summary.failed).toBe(1);
    expect(job?.result?.results[0].status).toBe("failed");
    expect(job?.result?.results[0].error).toBe("op_underfunded");
  });
});

describe("processJobInBackground — unreconciled rows block retry end-to-end (#741, #697)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
    mockTriggerWebhooksWithRetry.mockReset();
    mockTriggerWebhooksWithRetry.mockResolvedValue(undefined);
    mockReconcileTransaction.mockReset();
    vi.mocked(TransactionBuilder.fromXDR).mockImplementation(
      () =>
        ({
          sign: vi.fn(),
          toEnvelope: () => ({ toXDR: () => "mock-reconciliation-xdr" }),
        }) as unknown as ReturnType<typeof TransactionBuilder.fromXDR>,
    );
  });

  test("a job produced by the unresolved-reconciliation path is rejected by the retry route's guard condition", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockResolvedValue({ status: "unknown", attempts: 4 });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RETRY_GUARD_UNKNOWN"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);
    const row = job?.result?.results[0];

    // This mirrors the exact guard condition used by
    // app/api/batch-retry/route.ts (#697): a row is unreconciled if its
    // status is "unknown" OR its error carries the UNRECONCILED prefix.
    // The worker takes the error-prefix path (see the "unresolved
    // reconciliation" test above) — assert the real produced row actually
    // trips that guard, rather than a hand-built fixture.
    const isUnreconciled =
      row?.status === "unknown" || Boolean(row?.error?.startsWith("UNRECONCILED_SUBMISSION_ERROR"));
    expect(isUnreconciled).toBe(true);
  });

  test("a job produced by the reconcile-failed path does NOT trip the unreconciled retry guard", async () => {
    mockSubmitTransaction.mockRejectedValue(transportError());
    mockReconcileTransaction.mockResolvedValue({ status: "failed", attempts: 4 });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const recipient = Keypair.random().publicKey();
    const payments = [{ address: recipient, amount: "10", asset: "XLM" }];
    const signedTransactions = ["RETRY_GUARD_FAILED"];

    const jobId = await createJob(payments, "testnet", owner, signedTransactions);
    await processJobInBackground(jobId, payments, "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);
    const row = job?.result?.results[0];

    const isUnreconciled =
      row?.status === "unknown" || Boolean(row?.error?.startsWith("UNRECONCILED_SUBMISSION_ERROR"));
    expect(isUnreconciled).toBe(false);
    expect(row?.status).toBe("failed");
  });
});
