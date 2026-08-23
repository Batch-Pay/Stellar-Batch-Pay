import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import path from "path";

const { mockGetWebhookDeliveries } = vi.hoisted(() => ({
  mockGetWebhookDeliveries: vi.fn(),
}));

const { mockApplyRateLimit, mockSetRateLimitHeaders } = vi.hoisted(() => ({
  mockApplyRateLimit: vi.fn(),
  mockSetRateLimitHeaders: vi.fn((response: Response, state: { remaining: number; limit: number }) => {
    response.headers.set("X-RateLimit-Remaining", String(state.remaining));
    response.headers.set("X-RateLimit-Limit", String(state.limit));
    return response;
  }),
}));

vi.mock("@/lib/job-store", () => ({
  getWebhookDeliveries: mockGetWebhookDeliveries,
}));

vi.mock("@/lib/api-rate-limit", () => ({
  applyRateLimit: mockApplyRateLimit,
  setRateLimitHeaders: mockSetRateLimitHeaders,
}));

function makeRequest(ip = "203.0.113.70", headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/webhooks/deliveries?limit=10", {
    headers: { "x-forwarded-for": ip, ...headers },
  });
}

beforeEach(() => {
  vi.resetModules();
  mockGetWebhookDeliveries.mockReset();
  mockGetWebhookDeliveries.mockResolvedValue([]);
  mockApplyRateLimit.mockReset();
  mockApplyRateLimit.mockResolvedValue({
    blocked: false,
    remaining: 29,
    retryAfterSec: 0,
    resetAt: Date.now() + 60_000,
    limit: 30,
  });
  mockSetRateLimitHeaders.mockImplementation(
    (response: Response, state: { remaining: number; limit: number }) => {
      response.headers.set("X-RateLimit-Remaining", String(state.remaining));
      response.headers.set("X-RateLimit-Limit", String(state.limit));
      return response;
    },
  );
  process.env.WEBHOOK_ADMIN_API_KEY = "webhook-admin-test-key";
  process.env.RATE_LIMIT_DB_PATH = path.join(
    process.cwd(),
    "data",
    `test-rate-limit-731-${Math.random().toString(36).slice(2)}.db`,
  );
});

describe("GET /api/webhooks/deliveries (#731)", () => {
  test("rejects an unauthenticated request", async () => {
    const { GET } = await import("@/app/api/webhooks/deliveries/route");

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockGetWebhookDeliveries).not.toHaveBeenCalled();
  });

  test("rejects an invalid admin key", async () => {
    const { GET } = await import("@/app/api/webhooks/deliveries/route");

    const response = await GET(makeRequest("203.0.113.71", { "x-api-key": "wrong-key" }));

    expect(response.status).toBe(403);
    expect(mockGetWebhookDeliveries).not.toHaveBeenCalled();
  });

  test("allows a valid admin key and returns rate-limit headers", async () => {
    mockGetWebhookDeliveries.mockResolvedValue([{ id: "delivery-1" }]);
    const { GET } = await import("@/app/api/webhooks/deliveries/route");

    const response = await GET(
      makeRequest("203.0.113.72", { authorization: "Bearer webhook-admin-test-key" }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).deliveries).toEqual([{ id: "delivery-1" }]);
    expect(response.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(response.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(mockApplyRateLimit).toHaveBeenCalledWith(expect.any(NextRequest), "webhook-deliveries");
    expect(mockGetWebhookDeliveries).toHaveBeenCalledWith({
      jobId: undefined,
      webhookId: undefined,
      limit: 10,
    });
  });

  test("returns 429 with headers after the admin budget is exhausted", async () => {
    const { GET } = await import("@/app/api/webhooks/deliveries/route");
    mockApplyRateLimit.mockResolvedValueOnce({ blocked: false, remaining: 0, limit: 30 });
    const blockedResponse = new Response(JSON.stringify({ error: "Too Many Requests" }), {
      status: 429,
    });
    blockedResponse.headers.set("Retry-After", "60");
    blockedResponse.headers.set("X-RateLimit-Limit", "30");
    blockedResponse.headers.set("X-RateLimit-Remaining", "0");
    mockApplyRateLimit.mockResolvedValueOnce({
      blocked: true,
      remaining: 0,
      retryAfterSec: 60,
      resetAt: Date.now() + 60_000,
      limit: 30,
      response: blockedResponse,
    });

    const first = await GET(
      makeRequest("203.0.113.73", { "x-api-key": "webhook-admin-test-key" }),
    );
    expect(first.status).not.toBe(429);

    const blocked = await GET(
      makeRequest("203.0.113.73", { "x-api-key": "webhook-admin-test-key" }),
    );

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(blocked.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(blocked.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(mockApplyRateLimit).toHaveBeenCalledTimes(2);
  });
});