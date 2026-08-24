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

export async function checkPersistenceHealth(shallow: boolean = false): Promise<PersistenceHealthResult> {
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
    const connectivity = shallow
      ? { ok: true, error: undefined }
      : sqliteJobStore.checkSqliteJobStoreHealth();
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
    const connectivity = shallow
      ? { ok: true, error: undefined }
      : await postgresJobStore.checkPostgresJobStoreHealth();
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
    const connectivity = shallow
      ? { ok: true, error: undefined }
      : sqliteRateLimit.checkSqliteRateLimitHealth();
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
    const connectivity = shallow
      ? { ok: true, error: undefined }
      : await redisRateLimit.checkRedisRateLimitHealth();
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
    const connectivity = shallow
      ? { ok: true, error: undefined }
      : await postgresRateLimit.checkPostgresRateLimitHealth();
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

export interface DeepHealthResult extends PersistenceHealthResult {
  horizon?: {
    ok: boolean;
    url: string;
    error?: string;
  };
  sorobanRpc?: {
    ok: boolean;
    url: string;
    status?: string;
    error?: string;
  };
  secrets?: {
    ok: boolean;
    backend: string;
    error?: string;
  };
  keeper?: {
    ok: boolean;
    statePath?: string;
    lastRunAt?: string;
    ageSeconds?: number;
    error?: string;
  };
}

export async function checkDeepHealth(probeCredentialPresent: boolean = false): Promise<DeepHealthResult> {
  const result = await checkPersistenceHealth(false);
  const { horizonUrl, sorobanRpcUrl } = await import("./stellar/network-config");
  const { createSecretsProvider, isProductionEnv } = await import("./secrets/index");
  const fs = await import("node:fs/promises");

  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK as any) ?? "testnet";
  const hzUrl = horizonUrl(network);
  const rpcUrl = sorobanRpcUrl(network);

  const checkHorizon = async () => {
    try {
      const res = await fetch(hzUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }
      return { ok: true, url: hzUrl };
    } catch (err) {
      return {
        ok: false,
        url: hzUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const checkSorobanRpc = async () => {
    try {
      const { rpc: SorobanRpc } = await import("stellar-sdk");
      const server = new SorobanRpc.Server(rpcUrl);
      const health = await server.getHealth();
      return {
        ok: health.status === "healthy",
        url: rpcUrl,
        status: health.status,
        error: health.status !== "healthy" ? `RPC status is ${health.status}` : undefined,
      };
    } catch (err) {
      return {
        ok: false,
        url: rpcUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const checkSecrets = async () => {
    if (!probeCredentialPresent) {
      return { ok: true, backend: "skipped" };
    }
    const backend = process.env.SECRET_BACKEND ?? "env";
    try {
      const provider = await createSecretsProvider();
      if (backend === "env" && !isProductionEnv()) {
        try {
          await provider.fetchSecret("KEEPER_SECRET");
        } catch {
          // ignore missing secret in local dev env backend
        }
      } else {
        await provider.fetchSecret("KEEPER_SECRET");
      }
      return { ok: true, backend };
    } catch (err) {
      return {
        ok: false,
        backend,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const checkKeeper = async () => {
    const statePath = process.env.KEEPER_STATE_PATH || "./data/keeper-state.json";
    const maxAgeSeconds = Number(process.env.KEEPER_MAX_AGE_SECONDS || "25200"); // 7 hours default (cron interval is 6h)
    try {
      const content = await fs.readFile(statePath, "utf-8");
      const state = JSON.parse(content);
      if (state.lastRunAt) {
        const lastRunMs = Date.parse(state.lastRunAt);
        if (!isNaN(lastRunMs)) {
          const ageSeconds = Math.floor((Date.now() - lastRunMs) / 1000);
          const ok = ageSeconds <= maxAgeSeconds;
          return {
            ok,
            statePath,
            lastRunAt: state.lastRunAt,
            ageSeconds,
            error: ok ? undefined : `Keeper heartbeat is stale (${ageSeconds}s old, max ${maxAgeSeconds}s)`,
          };
        }
        return {
          ok: false,
          statePath,
          error: "Invalid lastRunAt timestamp format in keeper state file",
        };
      }
      return {
        ok: false,
        statePath,
        error: "No lastRunAt timestamp recorded in keeper state file",
      };
    } catch (err: any) {
      return {
        ok: false,
        statePath,
        error: err.code === "ENOENT"
          ? "Keeper state file not found"
          : err.message || String(err),
      };
    }
  };

  const [hz, rpc, sec, keep] = await Promise.all([
    checkHorizon(),
    checkSorobanRpc(),
    checkSecrets(),
    checkKeeper(),
  ]);

  const deepOk = hz.ok && rpc.ok && sec.ok && keep.ok;

  result.checks.push({
    name: "horizon",
    ok: hz.ok,
    error: hz.error,
  });
  result.checks.push({
    name: "soroban_rpc",
    ok: rpc.ok,
    error: rpc.error,
  });
  result.checks.push({
    name: "secrets",
    ok: sec.ok,
    error: sec.error,
  });
  result.checks.push({
    name: "keeper",
    ok: keep.ok,
    error: keep.error,
  });

  return {
    ...result,
    ok: result.ok && deepOk,
    horizon: hz,
    sorobanRpc: rpc,
    secrets: sec,
    keeper: keep,
  };
}
