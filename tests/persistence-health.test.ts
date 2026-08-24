import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let mockHorizonOk = true;
let mockRpcStatus = "healthy";
let mockSecretsFetch = async (name: string): Promise<string> => "mock-secret";
let mockReadFile = async (path: string, options: any): Promise<string> => JSON.stringify({ nextMaintenanceIndex: {}, lastRunAt: new Date().toISOString() });
let mockIsProductionEnv = false;

vi.mock("stellar-sdk", () => {
  class MockServer {
    async getHealth() {
      if (mockRpcStatus !== "healthy") {
        throw new Error(`RPC status is ${mockRpcStatus}`);
      }
      return { status: mockRpcStatus };
    }
  }
  return {
    rpc: {
      Server: MockServer,
    },
  };
});

vi.mock("../lib/secrets/index", () => {
  return {
    createSecretsProvider: vi.fn().mockResolvedValue({
      fetchSecret: vi.fn().mockImplementation((name: string) => mockSecretsFetch(name)),
    }),
    isProductionEnv: vi.fn().mockImplementation(() => mockIsProductionEnv),
  };
});

vi.mock("node:fs/promises", () => {
  return {
    readFile: vi.fn().mockImplementation((path: string, options: any) => mockReadFile(path, options)),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

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

    mockHorizonOk = true;
    mockRpcStatus = "healthy";
    mockSecretsFetch = async () => "mock-secret";
    mockReadFile = async () => JSON.stringify({ nextMaintenanceIndex: {}, lastRunAt: new Date().toISOString() });
    mockIsProductionEnv = false;
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
    vi.unstubAllGlobals();
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

  test("shallow mode skips DB queries and reports ok", async () => {
    vi.resetModules();
    const { checkPersistenceHealth } = await import("../lib/persistence-health");

    const sqliteJobStore = await import("../lib/backends/job-store-sqlite");
    vi.spyOn(sqliteJobStore, "checkSqliteJobStoreHealth").mockReturnValue({ ok: false, error: "DB Locked" });

    const result = await checkPersistenceHealth(true);
    expect(result.ok).toBe(true);
    expect(result.jobStore.ok).toBe(true);
  });

  test("readiness mode fails when database query fails", async () => {
    vi.resetModules();
    const { checkPersistenceHealth } = await import("../lib/persistence-health");

    const sqliteJobStore = await import("../lib/backends/job-store-sqlite");
    vi.spyOn(sqliteJobStore, "checkSqliteJobStoreHealth").mockReturnValue({ ok: false, error: "Readiness failed" });

    const result = await checkPersistenceHealth(false);
    expect(result.ok).toBe(false);
    expect(result.jobStore.ok).toBe(false);
  });

  test("deep health check reports ok and skips secrets without credential", async () => {
    vi.resetModules();
    mockHorizonOk = true;
    mockRpcStatus = "healthy";

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth(false);

    expect(result.ok).toBe(true);
    expect(result.horizon?.ok).toBe(true);
    expect(result.sorobanRpc?.ok).toBe(true);
    expect(result.secrets?.ok).toBe(true);
    expect(result.secrets?.backend).toBe("skipped");
    expect(result.keeper?.ok).toBe(true);
  });

  test("deep health check performs secrets check when credential present", async () => {
    vi.resetModules();
    mockHorizonOk = true;
    mockRpcStatus = "healthy";

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth(true);

    expect(result.ok).toBe(true);
    expect(result.secrets?.ok).toBe(true);
    expect(result.secrets?.backend).not.toBe("skipped");
  });

  test("deep health check fails when secrets check fails and credential present", async () => {
    vi.resetModules();
    mockIsProductionEnv = true;
    mockSecretsFetch = async () => {
      throw new Error("AWS Credentials Error");
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth(true);

    expect(result.ok).toBe(false);
    expect(result.secrets?.ok).toBe(false);
  });

  test("deep health check fails when keeper file is missing", async () => {
    vi.resetModules();
    mockReadFile = async () => {
      const err = new Error("File not found") as any;
      err.code = "ENOENT";
      throw err;
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth();

    expect(result.ok).toBe(false);
    expect(result.keeper?.ok).toBe(false);
    expect(result.keeper?.error).toBe("Keeper state file not found");
  });

  test("deep health check fails when keeper heartbeat is stale", async () => {
    vi.resetModules();
    // 10 hours ago (cron interval is 6h, default max age is 7h)
    const staleTime = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    mockReadFile = async () => JSON.stringify({ nextMaintenanceIndex: {}, lastRunAt: staleTime });

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: true };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth();

    expect(result.ok).toBe(false);
    expect(result.keeper?.ok).toBe(false);
    expect(result.keeper?.ageSeconds).toBeGreaterThan(25200);
  });

  test("deep health check fails when integration points fail", async () => {
    vi.resetModules();
    mockHorizonOk = false;
    mockRpcStatus = "unhealthy";
    mockIsProductionEnv = true;
    mockSecretsFetch = async () => {
      throw new Error("AWS Credentials Error");
    };
    mockReadFile = async () => {
      throw new Error("Disk read error");
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      return { ok: false, status: 500, statusText: "Internal Error" };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkDeepHealth } = await import("../lib/persistence-health");
    const result = await checkDeepHealth(true);

    expect(result.ok).toBe(false);
    expect(result.horizon?.ok).toBe(false);
    expect(result.sorobanRpc?.ok).toBe(false);
    expect(result.secrets?.ok).toBe(false);
    expect(result.keeper?.ok).toBe(false);
  });
});
