import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("checkPersistenceHealth", () => {
  let tempDir: string;
  const previousJobPath = process.env.JOB_STORE_PATH;
  const previousRatePath = process.env.RATE_LIMIT_DB_PATH;

  beforeEach(() => {
    vi.resetModules();
    tempDir = mkdtempSync(path.join(tmpdir(), "batchpay-health-"));
    process.env.JOB_STORE_PATH = path.join(tempDir, "jobs.db");
    process.env.RATE_LIMIT_DB_PATH = path.join(tempDir, "rate-limit.db");
    delete process.env.DEPLOYMENT_MODE;
    delete process.env.JOB_STORE_BACKEND;
    delete process.env.RATE_LIMIT_BACKEND;
  });

  afterEach(() => {
    if (previousJobPath === undefined) {
      delete process.env.JOB_STORE_PATH;
    } else {
      process.env.JOB_STORE_PATH = previousJobPath;
    }
    if (previousRatePath === undefined) {
      delete process.env.RATE_LIMIT_DB_PATH;
    } else {
      process.env.RATE_LIMIT_DB_PATH = previousRatePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reports ok when database directories are writable", async () => {
    vi.resetModules();
    const { checkPersistenceHealth } = await import("../lib/persistence-health");
    const result = await checkPersistenceHealth();
    expect(result.ok).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.deploymentMode).toBe("single-node");
    expect(result.jobStore.backend).toBe("sqlite");
    expect(result.rateLimit.backend).toBe("sqlite");
  });

  test("reports config issues when HA mode uses sqlite", async () => {
    process.env.DEPLOYMENT_MODE = "ha";
    process.env.JOB_STORE_BACKEND = "sqlite";
    process.env.RATE_LIMIT_BACKEND = "sqlite";
    const { checkPersistenceHealth } = await import("../lib/persistence-health");
    const result = await checkPersistenceHealth();
    expect(result.ok).toBe(false);
    expect(result.configIssues.length).toBeGreaterThan(0);
  });
});
