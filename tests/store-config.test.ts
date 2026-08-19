/**
 * Tests for store-config validation and deployment mode enforcement.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("store-config", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetModules();
    envBackup.DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE;
    envBackup.JOB_STORE_BACKEND = process.env.JOB_STORE_BACKEND;
    envBackup.RATE_LIMIT_BACKEND = process.env.RATE_LIMIT_BACKEND;
    envBackup.DATABASE_URL = process.env.DATABASE_URL;
    envBackup.REDIS_URL = process.env.REDIS_URL;
    envBackup.JOB_STORE_PATH = process.env.JOB_STORE_PATH;
    envBackup.RATE_LIMIT_DB_PATH = process.env.RATE_LIMIT_DB_PATH;

    delete process.env.DEPLOYMENT_MODE;
    delete process.env.JOB_STORE_BACKEND;
    delete process.env.RATE_LIMIT_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("defaults to single-node with SQLite when no env vars are set", async () => {
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    expect(config.deploymentMode).toBe("single-node");
    expect(config.jobStoreBackend).toBe("sqlite");
    expect(config.rateLimitBackend).toBe("sqlite");
    expect(validateStoreConfig(config)).toEqual([]);
  });

  test("ha mode defaults to postgres job store and redis rate limits", async () => {
    process.env.DEPLOYMENT_MODE = "ha";
    process.env.DATABASE_URL = "postgres://localhost/test";
    process.env.REDIS_URL = "redis://localhost";
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    expect(config.deploymentMode).toBe("ha");
    expect(config.jobStoreBackend).toBe("postgres");
    expect(config.rateLimitBackend).toBe("redis");
    expect(validateStoreConfig(config)).toEqual([]);
  });

  test("ha mode with sqlite backends produces validation issues", async () => {
    process.env.DEPLOYMENT_MODE = "ha";
    process.env.JOB_STORE_BACKEND = "sqlite";
    process.env.RATE_LIMIT_BACKEND = "sqlite";
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    const issues = validateStoreConfig(config);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.field === "JOB_STORE_BACKEND")).toBe(true);
    expect(issues.some((i) => i.field === "RATE_LIMIT_BACKEND")).toBe(true);
  });

  test("ha mode with postgres but no DATABASE_URL produces validation issue", async () => {
    process.env.DEPLOYMENT_MODE = "ha";
    process.env.REDIS_URL = "redis://localhost";
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    const issues = validateStoreConfig(config);
    expect(issues.some((i) => i.field === "DATABASE_URL")).toBe(true);
  });

  test("ha mode with redis but no REDIS_URL produces validation issue", async () => {
    process.env.DEPLOYMENT_MODE = "ha";
    process.env.DATABASE_URL = "postgres://localhost/test";
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    const issues = validateStoreConfig(config);
    expect(issues.some((i) => i.field === "REDIS_URL")).toBe(true);
  });

  test("single-node mode warns about ephemeral /tmp paths", async () => {
    process.env.JOB_STORE_PATH = "/tmp/jobs.db";
    process.env.RATE_LIMIT_DB_PATH = "/tmp/rate-limit.db";
    const { getStoreConfig, validateStoreConfig } = await import("../lib/store-config");
    const config = getStoreConfig();
    const issues = validateStoreConfig(config);
    expect(issues.some((i) => i.field === "JOB_STORE_PATH")).toBe(true);
    expect(issues.some((i) => i.field === "RATE_LIMIT_DB_PATH")).toBe(true);
  });

  test("invalid DEPLOYMENT_MODE throws", async () => {
    process.env.DEPLOYMENT_MODE = "invalid";
    const { getStoreConfig } = await import("../lib/store-config");
    expect(() => getStoreConfig()).toThrow(/Invalid DEPLOYMENT_MODE/);
  });
});
