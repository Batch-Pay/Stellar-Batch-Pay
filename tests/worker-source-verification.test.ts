/**
 * Defense-in-depth tests (#504): the background worker must never submit a
 * stored pre-signed envelope whose source account differs from the job's
 * publicKey, even if the submit-time gate was somehow bypassed.
 *
 * Only Horizon.Server is mocked here so that TransactionBuilder.fromXDR and the
 * source extraction run against real, freshly-built signed envelopes.
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

process.env.JOB_STORE_PATH = ":memory:";

const mockSubmitTransaction = vi.fn();

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
  };
});

vi.mock("../lib/webhooks", () => ({
  triggerWebhooksWithRetry: vi.fn().mockResolvedValue(undefined),
}));

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

describe("processJobInBackground — pre-signed source verification (#504)", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSubmitTransaction.mockReset();
  });

  test("fails the job without submitting when the XDR source != job.publicKey", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "should-not-happen" });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random().publicKey();
    const attacker = Keypair.random();
    // Job attributed to `owner`, but the envelope is signed by `attacker`.
    const signedTransactions = [buildSignedXdr(attacker)];

    const jobId = await createJob([], "testnet", owner, signedTransactions);

    await processJobInBackground(jobId, [], "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);
    expect(job?.status).toBe("failed");
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
    expect(job?.error).toMatch(/does not match job publicKey/i);
  });

  test("submits normally when the XDR source matches job.publicKey", async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: "ok-hash" });

    const { createJob, getJob } = await import("../lib/job-store");
    const { processJobInBackground } = await import("../lib/stellar/batch-worker");

    const owner = Keypair.random();
    const signedTransactions = [buildSignedXdr(owner)];

    const jobId = await createJob([], "testnet", owner.publicKey(), signedTransactions);

    await processJobInBackground(jobId, [], "testnet", undefined, signedTransactions);

    const job = await getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });
});
