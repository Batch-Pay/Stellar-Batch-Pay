/**
 * Integration tests for #743: batch-retry, batch-recover, and batch-history
 * previously had no rate limiting at all, unlike every other mutating/read
 * endpoint in the API. These tests exercise the real sqlite-backed limiter
 * end-to-end against each route (no mocking of lib/api-rate-limit) and
 * assert that:
 *
 *  - each route returns 429 once its free-tier budget is exhausted
 *  - the 429 response carries the standard rate-limit headers
 *  - requests from a different caller are not affected by another
 *    caller's exhausted bucket
 *
 * Job-store setup is intentionally skipped: the rate limit check runs
 * before any body/auth validation in all three routes, so an
 * under-the-limit request never needs to be a *valid* one to prove the
 * limiter itself is wired in correctly. Route-specific success-path
 * behavior is already covered by tests/batch-retry.test.ts and
 * tests/batch-recover.test.ts.
 */

import { describe, expect, test, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";

// The worker would otherwise try to submit to the network from batch-retry's
// happy path; irrelevant here since every request in this file is expected
// to be blocked by the limiter before reaching that code, but stub it out
// defensively so a limit miscalculation can't cause a network call.
vi.mock("@/lib/stellar/batch-worker", () => ({
  processJobInBackground: vi.fn().mockResolvedValue(undefined),
}));

process.env.JOB_STORE_PATH = ":memory:";
process.env.ALLOW_SERVER_SIGNING = "true";

function freshRateLimitDb() {
  process.env.RATE_LIMIT_DB_PATH = path.join(
    process.cwd(),
    "data",
    `test-rate-limit-743-${Math.random().toString(36).slice(2)}.db`,
  );
}

beforeEach(() => {
  vi.resetModules();
  freshRateLimitDb();
});

describe("POST /api/batch-retry rate limiting (#743)", () => {
  test("returns 429 once the free-tier budget is exhausted, with rate-limit headers", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-retry"].free; // 5

    const { POST } = await import("@/app/api/batch-retry/route");
    const ip = "203.0.113.10";

    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest("http://localhost/api/batch-retry", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify({ jobId: "nonexistent", publicKey: "GBOGUS" }),
      });
      const res = await POST(req);
      expect(res.status).not.toBe(429);
    }

    const blockedReq = new NextRequest("http://localhost/api/batch-retry", {
      method: "POST",
      headers: { "x-forwarded-for": ip, "content-type": "application/json" },
      body: JSON.stringify({ jobId: "nonexistent", publicKey: "GBOGUS" }),
    });
    const blocked = await POST(blockedReq);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe(String(limit));
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");

    const body = await blocked.json();
    expect(body.error).toMatch(/too many requests/i);
  });

  test("a different caller's requests are not blocked by another caller's exhausted bucket", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-retry"].free;

    const { POST } = await import("@/app/api/batch-retry/route");

    for (let i = 1; i <= limit + 1; i++) {
      await POST(
        new NextRequest("http://localhost/api/batch-retry", {
          method: "POST",
          headers: { "x-forwarded-for": "203.0.113.20", "content-type": "application/json" },
          body: JSON.stringify({ jobId: "nonexistent", publicKey: "GBOGUS" }),
        }),
      );
    }

    const otherCaller = await POST(
      new NextRequest("http://localhost/api/batch-retry", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.21", "content-type": "application/json" },
        body: JSON.stringify({ jobId: "nonexistent", publicKey: "GBOGUS" }),
      }),
    );

    expect(otherCaller.status).not.toBe(429);
  });
});

describe("GET /api/batch-recover rate limiting (#743)", () => {
  test("returns 429 once the free-tier budget is exhausted, with rate-limit headers", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-recover"].free; // 30

    const { GET } = await import("@/app/api/batch-recover/route");
    const ip = "203.0.113.30";

    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest(
        `http://localhost/api/batch-recover?jobId=nonexistent&publicKey=GBOGUS`,
        { headers: { "x-forwarded-for": ip } },
      );
      const res = await GET(req);
      expect(res.status).not.toBe(429);
    }

    const blockedReq = new NextRequest(
      `http://localhost/api/batch-recover?jobId=nonexistent&publicKey=GBOGUS`,
      { headers: { "x-forwarded-for": ip } },
    );
    const blocked = await GET(blockedReq);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe(String(limit));

    const body = await blocked.json();
    expect(body.error).toMatch(/too many requests/i);
  });
});

describe("GET /api/batch-history rate limiting (#743)", () => {
  test("returns 429 once the free-tier budget is exhausted, with rate-limit headers", async () => {
    const { getEndpointLimits } = await import("../lib/api-rate-limit");
    const limit = getEndpointLimits()["batch-history"].free; // 20

    const { GET } = await import("@/app/api/batch-history/route");
    const publicKey = "GDQERHRWJYV7JHRP5V7DWJVI6Y5ABZP3YRH7DKYJRBEGJQKE6IQEOSY2";
    const ip = "203.0.113.40";

    for (let i = 1; i <= limit; i++) {
      const req = new NextRequest(
        `http://localhost/api/batch-history?publicKey=${publicKey}`,
        { headers: { "x-forwarded-for": ip } },
      );
      const res = await GET(req);
      expect(res.status).not.toBe(429);
    }

    const blockedReq = new NextRequest(
      `http://localhost/api/batch-history?publicKey=${publicKey}`,
      { headers: { "x-forwarded-for": ip } },
    );
    const blocked = await GET(blockedReq);

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe(String(limit));

    const body = await blocked.json();
    expect(body.error).toMatch(/too many requests/i);
  });
});
