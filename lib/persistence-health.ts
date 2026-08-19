import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from "fs";
import path from "path";
import { getStoreConfig } from "./store-config";
import * as sqliteJobStore from "./backends/job-store-sqlite";
import * as sqliteRateLimit from "./backends/rate-limit-sqlite";

export interface PersistenceBackendHealth {
  backend: string;
  ok: boolean;
  path?: string;
  error?: string;
}

export interface PersistenceHealthResult {
  ok: boolean;
  deploymentMode: string;
  jobStore: PersistenceBackendHealth;
  rateLimit: PersistenceBackendHealth;
  configIssues: Array<{ field: string; message: string }>;
  checks: Array<{ name: string; path?: string; ok: boolean; error?: string }>;
}

function checkDirectoryWritable(dbPath: string): { ok: boolean; error?: string } {
  if (dbPath === ":memory:") {
    return { ok: true };
  }

  const dir = path.dirname(dbPath);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function checkPersistenceHealth(): Promise<PersistenceHealthResult> {
  const config = getStoreConfig();
  const { validateStoreConfig } = await import("./store-config");
  const configIssues = validateStoreConfig(config);

  const checks: PersistenceHealthResult["checks"] = [];
  let jobStoreHealth: PersistenceBackendHealth = {
    backend: config.jobStoreBackend,
    ok: false,
  };
  let rateLimitHealth: PersistenceBackendHealth = {
    backend: config.rateLimitBackend,
    ok: false,
  };

  if (configIssues.length > 0) {
    for (const issue of configIssues) {
      checks.push({
        name: `config:${issue.field}`,
        ok: issue.severity !== "error",
        error: issue.message,
      });
    }
  }

  if (config.jobStoreBackend === "sqlite") {
    const writable = checkDirectoryWritable(config.jobStorePath);
    const connectivity = sqliteJobStore.checkSqliteJobStoreHealth();
    jobStoreHealth = {
      backend: "sqlite",
      path: config.jobStorePath,
      ok: writable.ok && connectivity.ok,
      error: writable.error ?? connectivity.error,
    };
    checks.push({
      name: "job_store",
      path: config.jobStorePath,
      ok: jobStoreHealth.ok,
      error: jobStoreHealth.error,
    });
  } else {
    const postgresJobStore = await import("./backends/job-store-postgres");
    const connectivity = await postgresJobStore.checkPostgresJobStoreHealth();
    jobStoreHealth = {
      backend: "postgres",
      ok: connectivity.ok,
      error: connectivity.error,
    };
    checks.push({
      name: "job_store",
      ok: jobStoreHealth.ok,
      error: jobStoreHealth.error,
    });
  }

  if (config.rateLimitBackend === "sqlite") {
    const writable = checkDirectoryWritable(config.rateLimitDbPath);
    const connectivity = sqliteRateLimit.checkSqliteRateLimitHealth();
    rateLimitHealth = {
      backend: "sqlite",
      path: config.rateLimitDbPath,
      ok: writable.ok && connectivity.ok,
      error: writable.error ?? connectivity.error,
    };
    checks.push({
      name: "rate_limit",
      path: config.rateLimitDbPath,
      ok: rateLimitHealth.ok,
      error: rateLimitHealth.error,
    });
  } else if (config.rateLimitBackend === "redis") {
    const redisRateLimit = await import("./backends/rate-limit-redis");
    const connectivity = await redisRateLimit.checkRedisRateLimitHealth();
    rateLimitHealth = {
      backend: "redis",
      ok: connectivity.ok,
      error: connectivity.error,
    };
    checks.push({
      name: "rate_limit",
      ok: rateLimitHealth.ok,
      error: rateLimitHealth.error,
    });
  } else {
    const postgresRateLimit = await import("./backends/rate-limit-postgres");
    const connectivity = await postgresRateLimit.checkPostgresRateLimitHealth();
    rateLimitHealth = {
      backend: "postgres",
      ok: connectivity.ok,
      error: connectivity.error,
    };
    checks.push({
      name: "rate_limit",
      ok: rateLimitHealth.ok,
      error: rateLimitHealth.error,
    });
  }

  const hasBlockingIssues = configIssues.some((i) => i.severity === "error");

  const ok =
    !hasBlockingIssues &&
    checks.every((check) => check.ok) &&
    jobStoreHealth.ok &&
    rateLimitHealth.ok;

  return {
    ok,
    deploymentMode: config.deploymentMode,
    jobStore: jobStoreHealth,
    rateLimit: rateLimitHealth,
    configIssues,
    checks,
  };
}
