import { describe, expect, test, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";

describe("Bearer Token Rate Limit Validation", () => {
  beforeEach(() => {
    vi.resetModules();
    // Use an in-memory or isolated DB path for tests to avoid state bleed
    process.env.RATE_LIMIT_DB_PATH = path.join(
      process.cwd(),
      "data",
      `test-rate-limit-${Math.random().toString(36).slice(2)}.db`
    );
  });

  test("rotating unknown Bearer tokens from the same IP share the same IP bucket and are rate limited", async () => {
    const { applyRateLimit, getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-submit"].free; // limit = 5

    const ip = "203.0.113.42";

    // Exhaust quota (5 requests) with rotating unknown tokens
    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest("http://localhost/api/batch-submit", {
        method: "POST",
        headers: {
          authorization: `Bearer random-token-${i}`,
          "x-forwarded-for": ip,
        },
      });
      const res = applyRateLimit(req, "batch-submit");
      expect(res.blocked).toBe(false);
      expect(res.remaining).toBe(limit - i);
    }

    // 6th request with a brand new unknown token MUST be blocked because IP quota is exhausted
    const blockedReq = new NextRequest("http://localhost/api/batch-submit", {
      method: "POST",
      headers: {
        authorization: `Bearer random-token-6`,
        "x-forwarded-for": ip,
      },
    });
    const blockedRes = applyRateLimit(blockedReq, "batch-submit");
    expect(blockedRes.blocked).toBe(true);
    expect(blockedRes.remaining).toBe(0);
    expect(blockedRes.response?.status).toBe(429);
  });

  test("valid Bearer tokens in apiKeyTierMap receive their own distinct bucket and tier limit", async () => {
    const { applyRateLimit, apiKeyTierMap, getEndpointLimits } = await import("../lib/api-rate-limit");
    const proLimit = getEndpointLimits()["batch-submit"].pro; // pro limit = 15

    const validToken = "secret-pro-token-999";
    apiKeyTierMap[validToken] = "pro";

    const req = new NextRequest("http://localhost/api/batch-submit", {
      method: "POST",
      headers: {
        authorization: `Bearer ${validToken}`,
        "x-forwarded-for": "203.0.113.42",
      },
    });

    const res = applyRateLimit(req, "batch-submit");
    expect(res.blocked).toBe(false);
    expect(res.limit).toBe(proLimit);
    expect(res.remaining).toBe(proLimit - 1);
  });

  test("unvalidated tokens without IP header fall back to ip:unknown bucket and get blocked", async () => {
    const { applyRateLimit, getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-submit"].free;

    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest("http://localhost/api/batch-submit", {
        method: "POST",
        headers: {
          authorization: `Bearer no-ip-token-${i}`,
        },
      });
      const res = applyRateLimit(req, "batch-submit");
      expect(res.blocked).toBe(false);
    }

    const blockedReq = new NextRequest("http://localhost/api/batch-submit", {
      method: "POST",
      headers: {
        authorization: `Bearer no-ip-token-overflow`,
      },
    });
    const blockedRes = applyRateLimit(blockedReq, "batch-submit");
    expect(blockedRes.blocked).toBe(true);
  });
});
