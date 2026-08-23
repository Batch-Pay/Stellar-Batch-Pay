/**
 * Tests for the env-configurable rate limits (#271).
 *
 * We `vi.resetModules()` before each assertion because the limits
 * are computed at module-load time, so we have to reload the module
 * after mutating process.env to observe new values.
 */

import { describe, expect, test, beforeEach, vi } from "vitest";

const ENV_KEYS = [
  "RATE_LIMIT_BATCH_BUILD_FREE",
  "RATE_LIMIT_BATCH_BUILD_PRO",
  "RATE_LIMIT_BATCH_BUILD_ENTERPRISE",
  "RATE_LIMIT_BATCH_BUILD_WINDOW_MS",
  "RATE_LIMIT_BATCH_SUBMIT_FREE",
  "RATE_LIMIT_BATCH_STATUS_FREE",
  "RATE_LIMIT_BATCH_EVENTS_FREE",
  "RATE_LIMIT_HEALTH_FREE",
  "RATE_LIMIT_BATCH_RETRY_FREE",
  "RATE_LIMIT_BATCH_RECOVER_FREE",
  "RATE_LIMIT_BATCH_HISTORY_FREE",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  vi.resetModules();
  clearEnv();
});

describe("getEndpointLimits (#271)", () => {
  test("uses the shipped defaults when no env vars are set", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits();
    expect(limits["batch-build"]).toEqual({
      free: 8,
      pro: 20,
      enterprise: 60,
      windowMs: 60_000,
    });
    expect(limits["batch-submit"].free).toBe(5);
  });

  test("RATE_LIMIT_BATCH_BUILD_FREE overrides the free-tier limit", async () => {
    process.env.RATE_LIMIT_BATCH_BUILD_FREE = "42";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-build"].free).toBe(42);
  });

  test("RATE_LIMIT_BATCH_BUILD_WINDOW_MS overrides the window", async () => {
    process.env.RATE_LIMIT_BATCH_BUILD_WINDOW_MS = "30000";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-build"].windowMs).toBe(30_000);
  });

  test("non-numeric env values fall back to the shipped default", async () => {
    process.env.RATE_LIMIT_BATCH_BUILD_PRO = "not-a-number";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-build"].pro).toBe(20);
  });

  test("zero / negative values fall back so a typo can't disable a tier", async () => {
    process.env.RATE_LIMIT_BATCH_SUBMIT_FREE = "0";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-submit"].free).toBe(5);
  });

  test("batch-status endpoint has default rate limits (#600)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["batch-status"];
    expect(limits).toBeDefined();
    expect(limits.free).toBe(60);
    expect(limits.pro).toBe(200);
    expect(limits.enterprise).toBe(600);
    expect(limits.windowMs).toBe(60_000);
  });

  test("batch-events endpoint has default rate limits (#600)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["batch-events"];
    expect(limits).toBeDefined();
    expect(limits.free).toBe(10);
    expect(limits.pro).toBe(30);
    expect(limits.enterprise).toBe(90);
    expect(limits.windowMs).toBe(60_000);
  });

  test("health endpoint has default rate limits (#600)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["health"];
    expect(limits).toBeDefined();
    expect(limits.free).toBe(30);
    expect(limits.pro).toBe(100);
    expect(limits.enterprise).toBe(300);
    expect(limits.windowMs).toBe(60_000);
  });

  test("RATE_LIMIT_BATCH_STATUS_FREE overrides the batch-status free tier (#600)", async () => {
    process.env.RATE_LIMIT_BATCH_STATUS_FREE = "99";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-status"].free).toBe(99);
  });

  // #743: batch-retry, batch-recover, batch-history previously had no rate
  // limit policy at all — they now use the same env-configurable mechanism
  // as every other endpoint.
  test("batch-retry endpoint has default rate limits (#743)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["batch-retry"];
    expect(limits).toEqual({ free: 5, pro: 15, enterprise: 45, windowMs: 60_000 });
  });

  test("batch-recover endpoint has default rate limits (#743)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["batch-recover"];
    expect(limits).toEqual({ free: 30, pro: 100, enterprise: 300, windowMs: 60_000 });
  });

  test("batch-history endpoint has default rate limits (#743)", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limits = getEndpointLimits()["batch-history"];
    expect(limits).toEqual({ free: 20, pro: 60, enterprise: 180, windowMs: 60_000 });
  });

  test("RATE_LIMIT_BATCH_RETRY_FREE overrides the batch-retry free tier (#743)", async () => {
    process.env.RATE_LIMIT_BATCH_RETRY_FREE = "77";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-retry"].free).toBe(77);
  });

  test("RATE_LIMIT_BATCH_RECOVER_FREE overrides the batch-recover free tier (#743)", async () => {
    process.env.RATE_LIMIT_BATCH_RECOVER_FREE = "77";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-recover"].free).toBe(77);
  });

  test("RATE_LIMIT_BATCH_HISTORY_FREE overrides the batch-history free tier (#743)", async () => {
    process.env.RATE_LIMIT_BATCH_HISTORY_FREE = "77";
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    expect(getEndpointLimits()["batch-history"].free).toBe(77);
  });
});
