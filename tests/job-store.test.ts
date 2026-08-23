/**
 * Unit tests for the durable SQLite job store.
 *
 * We point the store at an in-memory SQLite database by setting the
 * JOB_STORE_PATH env var to ":memory:" before importing the module.
 * Each describe block re-imports the module so the DB is fresh.
 */

import { describe, test, expect, beforeAll } from "vitest";

// Use an in-memory DB so tests don't touch the filesystem
process.env.JOB_STORE_PATH = ":memory:";

import { createJob, getJob, updateJob, getAllJobs, countJobs } from "../lib/job-store";

const OWNER_PUBLIC_KEY = "GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2";
const OTHER_PUBLIC_KEY = "GB7QNDHSBQZENWGZUBJ4KLSZFRNHN5ATQXZSC3ZHZ5ZBQ6Y6X3TOBQ7S";

const samplePayments = [
  {
    address: "GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER",
    amount: "100",
    asset: "XLM",
  },
  {
    address: "GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67",
    amount: "50",
    asset: "XLM",
  },
];

describe("Job Store — createJob", () => {
  test("returns a non-empty UUID string", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("returns unique IDs for each call", async () => {
    const id1 = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const id2 = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    expect(id1).not.toBe(id2);
  });

  test("initial job has status queued", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job?.status).toBe("queued");
  });

  test("initial job has completedBatches of 0", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job?.completedBatches).toBe(0);
  });

  test("stores the payments array on the job", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job?.payments).toEqual(samplePayments);
  });

  test("stores the network on the job", async () => {
    const jobId = await createJob(samplePayments, "mainnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job?.network).toBe("mainnet");
  });

  test("stores the owner public key on the job", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job?.publicKey).toBe(OWNER_PUBLIC_KEY);
  });

  test("hydrates signedTransactions from the stored row", async () => {
    const signedTransactions = ["AAAA", "BBBB"];
    const jobId = await createJob(
      samplePayments,
      "testnet",
      OWNER_PUBLIC_KEY,
      signedTransactions,
    );
    const job = await getJob(jobId);
    expect(job?.signedTransactions).toEqual(signedTransactions);
  });

  test("sets createdAt and updatedAt as ISO strings", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(() => new Date(job!.createdAt)).not.toThrow();
    expect(() => new Date(job!.updatedAt)).not.toThrow();
  });
});

describe("Job Store — getJob", () => {
  test("returns undefined for unknown jobId", async () => {
    const job = await getJob("00000000-0000-0000-0000-000000000000");
    expect(job).toBeUndefined();
  });

  test("retrieves an existing job", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const job = await getJob(jobId);
    expect(job).toBeDefined();
    expect(job?.jobId).toBe(jobId);
  });

  test("scopes lookup by public key", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    expect(await getJob(jobId, OWNER_PUBLIC_KEY)).toBeDefined();
    expect(await getJob(jobId, OTHER_PUBLIC_KEY)).toBeUndefined();
  });
});

describe("Job Store — updateJob", () => {
  test("updates status to processing", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    await updateJob(jobId, { status: "processing", totalBatches: 5 });
    const job = await getJob(jobId);
    expect(job?.status).toBe("processing");
    expect(job?.totalBatches).toBe(5);
  });

  test("increments completedBatches", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    await updateJob(jobId, { status: "processing", totalBatches: 3 });
    await updateJob(jobId, { completedBatches: 1 });
    await updateJob(jobId, { completedBatches: 2 });
    const job = await getJob(jobId);
    expect(job?.completedBatches).toBe(2);
  });

  test("does not throw for unknown jobId", async () => {
    await expect(updateJob("nonexistent", { status: "failed" })).resolves.not.toThrow();
  });

  test("preserves existing fields when partially updating", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    await updateJob(jobId, { status: "processing" });
    const job = await getJob(jobId);
    expect(job?.network).toBe("testnet");
    expect(job?.payments).toEqual(samplePayments);
  });

  test("updates updatedAt on each updateJob call", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const before = (await getJob(jobId))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateJob(jobId, { completedBatches: 1 });
    const after = (await getJob(jobId))!.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });

  test("sets completed status and attaches result", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const fakeResult = {
      batchId: jobId,
      totalRecipients: 2,
      totalAmount: "150",
      totalTransactions: 1,
      network: "testnet" as const,
      timestamp: new Date().toISOString(),
      results: [],
      summary: { successful: 2, failed: 0 },
    };
    await updateJob(jobId, { status: "completed", result: fakeResult });
    const job = await getJob(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.result?.batchId).toBe(jobId);
  });
});

describe("Job Store — getAllJobs / countJobs", () => {
  test("returns an array", async () => {
    const jobs = await getAllJobs();
    expect(Array.isArray(jobs)).toBe(true);
  });

  test("includes newly created jobs", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const jobs = await getAllJobs();
    const found = jobs.find((j) => j.jobId === jobId);
    expect(found).toBeDefined();
  });

  test("countJobs returns a non-negative integer", async () => {
    const count = await countJobs();
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("status filter works", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    await updateJob(jobId, { status: "failed" });
    const failed = await getAllJobs({ status: "failed" });
    expect(failed.every((j) => j.status === "failed")).toBe(true);
  });

  test("network filter works", async () => {
    await createJob(samplePayments, "mainnet", OWNER_PUBLIC_KEY);
    const mainnet = await getAllJobs({ network: "mainnet" });
    expect(mainnet.every((j) => j.network === "mainnet")).toBe(true);
  });

  test("publicKey filter isolates tenant history", async () => {
    const ownerJobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const otherJobId = await createJob(samplePayments, "testnet", OTHER_PUBLIC_KEY);

    const ownerJobs = await getAllJobs({ publicKey: OWNER_PUBLIC_KEY });
    const ownerIds = ownerJobs.map((job) => job.jobId);
    const ownerCount = await countJobs({ publicKey: OWNER_PUBLIC_KEY });

    expect(ownerIds).toContain(ownerJobId);
    expect(ownerIds).not.toContain(otherJobId);
    expect(ownerCount).toBeGreaterThanOrEqual(ownerJobs.length);
  });

  test("pagination limit is respected", async () => {
    for (let i = 0; i < 5; i++) await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const page = await getAllJobs({ limit: 3, offset: 0 });
    expect(page.length).toBeLessThanOrEqual(3);
  });

  test("search filter matches jobId substring", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const matches = await getAllJobs({ search: jobId.slice(0, 8), publicKey: OWNER_PUBLIC_KEY });
    expect(matches.some((job) => job.jobId === jobId)).toBe(true);
  });

  test("search filter matches recipient address in payments JSON", async () => {
    const address = samplePayments[0]?.address ?? "GSEARCHMATCH";
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const matches = await getAllJobs({ search: address, publicKey: OWNER_PUBLIC_KEY });
    expect(matches.some((job) => job.jobId === jobId)).toBe(true);
  });

  test("from date filter excludes older jobs", async () => {
    const jobId = await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const futureFrom = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const matches = await getAllJobs({ from: futureFrom, publicKey: OWNER_PUBLIC_KEY });
    expect(matches.some((job) => job.jobId === jobId)).toBe(false);
  });

  test("sort by status asc returns jobs ordered by status (#606)", async () => {
    await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const jobs = await getAllJobs({ sort: "status", order: "asc" });
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i - 1].status.localeCompare(jobs[i].status)).toBeLessThanOrEqual(0);
    }
  });

  test("sort by updatedAt desc returns jobs ordered by updatedAt descending (#606)", async () => {
    await createJob(samplePayments, "testnet", OWNER_PUBLIC_KEY);
    const jobs = await getAllJobs({ sort: "updatedAt", order: "desc" });
    for (let i = 1; i < jobs.length; i++) {
      expect(new Date(jobs[i - 1].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(jobs[i].updatedAt).getTime(),
      );
    }
  });
});
