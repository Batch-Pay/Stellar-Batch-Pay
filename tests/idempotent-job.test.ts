/**
 * Unit tests for createIdempotentJob branching logic.
 *
 * Uses an in-memory SQLite DB by setting JOB_STORE_PATH=:memory: before each
 * module import so every test starts from a clean durable store instance.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PaymentInstruction } from "../lib/stellar/types";

const OWNER_PUBLIC_KEY =
  "GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2";

const payments: PaymentInstruction[] = [
  {
    address: "GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER",
    amount: "10.0000000",
    asset: "XLM",
  },
];

async function loadJobStore() {
  vi.resetModules();
  process.env.JOB_STORE_PATH = ":memory:";
  return import("../lib/job-store");
}

beforeEach(() => {
  process.env.JOB_STORE_PATH = ":memory:";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIdempotentJob", () => {
  test("creates a new job and persists response body on first call", async () => {
    const { createIdempotentJob, getJob, countJobs } = await loadJobStore();

    const buildResponseBody = vi.fn((jobId: string) => ({
      jobId,
      status: "queued" as const,
      message: "created",
    }));

    const outcome = await createIdempotentJob({
      idempotencyKey: "idem-key-1",
      requestHash: "hash-1",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody,
    });

    expect(outcome.replayed).toBe(false);
    expect(buildResponseBody).toHaveBeenCalledTimes(1);
    expect(outcome.responseBody).toEqual({
      jobId: outcome.jobId,
      status: "queued",
      message: "created",
    });

    const storedJob = await getJob(outcome.jobId);
    expect(storedJob).toBeDefined();
    expect(storedJob?.network).toBe("testnet");
    expect(storedJob?.publicKey).toBe(OWNER_PUBLIC_KEY);
    expect(storedJob?.payments).toEqual(payments);
    expect(await countJobs({ publicKey: OWNER_PUBLIC_KEY })).toBe(1);
  });

  test("replays existing response for same key and request hash", async () => {
    const { createIdempotentJob, countJobs } = await loadJobStore();

    const firstBuilder = vi.fn((jobId: string) => ({
      jobId,
      status: "queued" as const,
      marker: "first",
    }));
    const first = await createIdempotentJob({
      idempotencyKey: "idem-key-2",
      requestHash: "hash-2",
      payments,
      network: "mainnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: firstBuilder,
    });

    const replayBuilder = vi.fn((jobId: string) => ({
      jobId,
      status: "queued" as const,
      marker: "replay-builder-should-not-run",
    }));
    const replay = await createIdempotentJob({
      idempotencyKey: "idem-key-2",
      requestHash: "hash-2",
      payments,
      network: "mainnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: replayBuilder,
    });

    expect(firstBuilder).toHaveBeenCalledTimes(1);
    expect(replayBuilder).not.toHaveBeenCalled();
    expect(replay.replayed).toBe(true);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.responseBody).toEqual(first.responseBody);
    expect(await countJobs({ publicKey: OWNER_PUBLIC_KEY })).toBe(1);
  });

  test("throws IdempotencyConflictError for same key with different hash", async () => {
    const { createIdempotentJob, IdempotencyConflictError, countJobs } =
      await loadJobStore();

    await createIdempotentJob({
      idempotencyKey: "idem-key-3",
      requestHash: "hash-3",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId) => ({ jobId }),
    });

    await expect(
      createIdempotentJob({
        idempotencyKey: "idem-key-3",
        requestHash: "hash-3-different",
        payments,
        network: "testnet",
        publicKey: OWNER_PUBLIC_KEY,
        buildResponseBody: (jobId) => ({ jobId }),
      }),
    ).rejects.toThrow(IdempotencyConflictError);

    expect(await countJobs({ publicKey: OWNER_PUBLIC_KEY })).toBe(1);
  });

  test("prunes expired idempotency key and allows key reuse", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);

    const { createIdempotentJob, countJobs } = await loadJobStore();

    const first = await createIdempotentJob({
      idempotencyKey: "idem-key-4",
      requestHash: "hash-4",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId) => ({ jobId, version: "first" }),
    });

    // TTL is 24h in the store; step just beyond it.
    vi.setSystemTime(new Date(start.getTime() + 24 * 60 * 60 * 1000 + 1));

    const reused = await createIdempotentJob({
      idempotencyKey: "idem-key-4",
      requestHash: "hash-4-different-after-expiry",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId) => ({ jobId, version: "second" }),
    });

    expect(first.replayed).toBe(false);
    expect(reused.replayed).toBe(false);
    expect(reused.jobId).not.toBe(first.jobId);
    expect(reused.responseBody).toEqual({ jobId: reused.jobId, version: "second" });
    expect(await countJobs({ publicKey: OWNER_PUBLIC_KEY })).toBe(2);
  });

  test("serializes concurrent identical calls to one job record", async () => {
    const { createIdempotentJob, countJobs } = await loadJobStore();

    const buildResponseBody = vi.fn((jobId: string) => ({
      jobId,
      status: "queued" as const,
    }));

    const [a, b] = await Promise.all([
      Promise.resolve().then(() =>
        createIdempotentJob({
          idempotencyKey: "idem-key-5",
          requestHash: "hash-5",
          payments,
          network: "mainnet",
          publicKey: OWNER_PUBLIC_KEY,
          buildResponseBody,
        }),
      ),
      Promise.resolve().then(() =>
        createIdempotentJob({
          idempotencyKey: "idem-key-5",
          requestHash: "hash-5",
          payments,
          network: "mainnet",
          publicKey: OWNER_PUBLIC_KEY,
          buildResponseBody,
        }),
      ),
    ]);

    expect(a.jobId).toBe(b.jobId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(buildResponseBody).toHaveBeenCalledTimes(1);
    expect(await countJobs({ publicKey: OWNER_PUBLIC_KEY })).toBe(1);
  });
});
