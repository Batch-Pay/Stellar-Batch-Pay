import path from "path";

export type DeploymentMode = "single-node" | "ha";
export type JobStoreBackend = "sqlite" | "postgres";
export type RateLimitBackend = "sqlite" | "postgres" | "redis";

export interface StoreConfig {
  deploymentMode: DeploymentMode;
  jobStoreBackend: JobStoreBackend;
  rateLimitBackend: RateLimitBackend;
  jobStorePath: string;
  rateLimitDbPath: string;
  databaseUrl?: string;
  redisUrl?: string;
}

export interface StoreConfigIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

function parseDeploymentMode(raw: string | undefined): DeploymentMode {
  if (!raw || raw === "single-node") return "single-node";
  if (raw === "ha") return "ha";
  throw new Error(`Invalid DEPLOYMENT_MODE "${raw}". Expected "single-node" or "ha".`);
}

function parseJobStoreBackend(raw: string | undefined, mode: DeploymentMode): JobStoreBackend {
  if (!raw) return mode === "ha" ? "postgres" : "sqlite";
  if (raw === "sqlite" || raw === "postgres") return raw;
  throw new Error(`Invalid JOB_STORE_BACKEND "${raw}". Expected "sqlite" or "postgres".`);
}

function parseRateLimitBackend(
  raw: string | undefined,
  mode: DeploymentMode,
): RateLimitBackend {
  if (!raw) return mode === "ha" ? "redis" : "sqlite";
  if (raw === "sqlite" || raw === "postgres" || raw === "redis") return raw;
  throw new Error(
    `Invalid RATE_LIMIT_BACKEND "${raw}". Expected "sqlite", "postgres", or "redis".`,
  );
}

export function resolveJobStorePath(): string {
  return process.env.JOB_STORE_PATH ?? path.join(process.cwd(), "data", "jobs.db");
}

export function resolveRateLimitDbPath(): string {
  return (
    process.env.RATE_LIMIT_DB_PATH ?? path.join(process.cwd(), "data", "rate-limit.db")
  );
}

export function getStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const deploymentMode = parseDeploymentMode(env.DEPLOYMENT_MODE);
  const jobStoreBackend = parseJobStoreBackend(env.JOB_STORE_BACKEND, deploymentMode);
  const rateLimitBackend = parseRateLimitBackend(env.RATE_LIMIT_BACKEND, deploymentMode);

  return {
    deploymentMode,
    jobStoreBackend,
    rateLimitBackend,
    jobStorePath: env.JOB_STORE_PATH ?? path.join(process.cwd(), "data", "jobs.db"),
    rateLimitDbPath:
      env.RATE_LIMIT_DB_PATH ?? path.join(process.cwd(), "data", "rate-limit.db"),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  };
}

export function validateStoreConfig(config: StoreConfig): StoreConfigIssue[] {
  const issues: StoreConfigIssue[] = [];

  if (config.deploymentMode === "ha") {
    if (config.jobStoreBackend === "sqlite") {
      issues.push({
        field: "JOB_STORE_BACKEND",
        message:
          'SQLite job store is not safe for HA. Set JOB_STORE_BACKEND=postgres and provide DATABASE_URL.',
        severity: "error",
      });
    }
    if (config.rateLimitBackend === "sqlite") {
      issues.push({
        field: "RATE_LIMIT_BACKEND",
        message:
          'SQLite rate limits are not fleet-wide. Set RATE_LIMIT_BACKEND=redis (or postgres) for HA.',
        severity: "error",
      });
    }
    if (config.jobStoreBackend === "postgres" && !config.databaseUrl) {
      issues.push({
        field: "DATABASE_URL",
        message: "DATABASE_URL is required when JOB_STORE_BACKEND=postgres in HA mode.",
        severity: "error",
      });
    }
    if (config.rateLimitBackend === "postgres" && !config.databaseUrl) {
      issues.push({
        field: "DATABASE_URL",
        message: "DATABASE_URL is required when RATE_LIMIT_BACKEND=postgres in HA mode.",
        severity: "error",
      });
    }
    if (config.rateLimitBackend === "redis" && !config.redisUrl) {
      issues.push({
        field: "REDIS_URL",
        message: "REDIS_URL is required when RATE_LIMIT_BACKEND=redis in HA mode.",
        severity: "error",
      });
    }
  }

  if (config.deploymentMode === "single-node") {
    if (config.jobStoreBackend !== "sqlite") {
      issues.push({
        field: "JOB_STORE_BACKEND",
        message:
          'Single-node mode expects JOB_STORE_BACKEND=sqlite. Use DEPLOYMENT_MODE=ha for shared stores.',
        severity: "error",
      });
    }
    if (config.rateLimitBackend !== "sqlite") {
      issues.push({
        field: "RATE_LIMIT_BACKEND",
        message:
          'Single-node mode expects RATE_LIMIT_BACKEND=sqlite. Use DEPLOYMENT_MODE=ha for shared stores.',
        severity: "error",
      });
    }
    if (config.jobStorePath.startsWith("/tmp/")) {
      issues.push({
        field: "JOB_STORE_PATH",
        message:
          "JOB_STORE_PATH points at ephemeral /tmp storage; in-flight jobs are lost on restart.",
        severity: "warning",
      });
    }
    if (config.rateLimitDbPath.startsWith("/tmp/")) {
      issues.push({
        field: "RATE_LIMIT_DB_PATH",
        message:
          "RATE_LIMIT_DB_PATH points at ephemeral /tmp storage; rate limits reset on restart.",
        severity: "warning",
      });
    }
  }

  return issues;
}

export function isEphemeralSqlitePath(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.startsWith("/tmp/");
}
