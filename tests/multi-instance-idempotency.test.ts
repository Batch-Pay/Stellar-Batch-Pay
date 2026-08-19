/**
 * Multi-instance idempotency integration test harness.
 *
 * Simulates two "instances" sharing the same SQLite database and verifies that
 * createIdempotentJob is globally idempotent — the same idempotency key always
 * returns the same jobId, regardless of which instance handles the request.
 *
 * For a true HA deployment with Postgres, run this test with:
 *   DEPLOYMENT_MODE=ha DATABASE_URL=... npm test -- tests/multi-instance-idempotency.test.ts
 *
 * For single-node verification (default), both instances share the same SQLite
 * file on disk, which proves convergence within a single filesystem.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
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

let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(tmpdir(), "batchpay-multi-"));
  process.env.JOB_STORE_PATH = path.join(tempDir, "shared-jobs.db");
  delete process.env.DEPLOYMENT_MODE;
  delete process.env.JOB_STORE_BACKEND;
});

afterEach(() => {
  delete process.env.JOB_STORE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("multi-instance idempotent submit", () => {
  test("two instances sharing the same DB file produce a single job for the same idempotency key", async () => {
    // Simulate instance 1
    vi.resetModules();
    const instance1 = await import("../lib/job-store");

    const outcome1 = await instance1.createIdempotentJob({
      idempotencyKey: "global-key-1",
      requestHash: "hash-1",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId: string) => ({ jobId, instance: 1 }),
    });

    expect(outcome1.replayed).toBe(false);
    const jobId = outcome1.jobId;

    // Simulate instance 2 (re-import, same DB path)
    vi.resetModules();
    const instance2 = await import("../lib/job-store");

    const outcome2 = await instance2.createIdempotentJob({
      idempotencyKey: "global-key-1",
      requestHash: "hash-1",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId: string) => ({ jobId, instance: 2 }),
    });

    expect(outcome2.replayed).toBe(true);
    expect(outcome2.jobId).toBe(jobId);
  });

  test("different idempotency keys on different instances produce separate jobs", async () => {
    vi.resetModules();
    const instance1 = await import("../lib/job-store");
    const outcome1 = await instance1.createIdempotentJob({
      idempotencyKey: "key-a",
      requestHash: "hash-a",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId: string) => ({ jobId }),
    });

    vi.resetModules();
    const instance2 = await import("../lib/job-store");
    const outcome2 = await instance2.createIdempotentJob({
      idempotencyKey: "key-b",
      requestHash: "hash-b",
      payments,
      network: "testnet",
      publicKey: OWNER_PUBLIC_KEY,
      buildResponseBody: (jobId: string) => ({ jobId }),
    });

    expect(outcome1.jobId).not.toBe(outcome2.jobId);
    expect(outcome1.replayed).toBe(false);
    expect(outcome2.replayed).toBe(false);
  });

  test("job created on instance 1 is visible on instance 2", async () => {
    vi.resetModules();
    const instance1 = await import("../lib/job-store");
    const jobId = await instance1.createJob(payments, "testnet", OWNER_PUBLIC_KEY);

    vi.resetModules();
    const instance2 = await import("../lib/job-store");
    const job = await instance2.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.jobId).toBe(jobId);
    expect(job!.status).toBe("queued");
  });

  test("rate limits converge across instances sharing the same DB", async () => {
    process.env.RATE_LIMIT_DB_PATH = path.join(tempDir, "shared-rate-limit.db");

    vi.resetModules();
    const { consumeRateLimit: consume1 } = await import(
      "../lib/backends/rate-limit-sqlite"
    );

    vi.resetModules();
    const { consumeRateLimit: consume2 } = await import(
      "../lib/backends/rate-limit-sqlite"
    );

    const args = {
      key: "test:ip:1.2.3.4",
      tier: "free" as const,
      endpoint: "batch-submit" as const,
      limit: 3,
      windowMs: 60_000,
    };

    const r1 = consume1(args);
    expect(r1.blocked).toBe(false);
    expect(r1.remaining).toBe(2);

    const r2 = consume2(args);
    expect(r2.blocked).toBe(false);
    expect(r2.remaining).toBe(1);

    const r3 = consume1(args);
    expect(r3.blocked).toBe(false);
    expect(r3.remaining).toBe(0);

    // 4th request should be blocked (fleet-wide)
    const r4 = consume2(args);
    expect(r4.blocked).toBe(true);

    delete process.env.RATE_LIMIT_DB_PATH;
  });
});
