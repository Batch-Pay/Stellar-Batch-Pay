/**
 * Unit tests for the shared API error-sanitization helper (#748).
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { getRequestId, sanitizedErrorResponse } from "@/lib/api-error";

describe("getRequestId", () => {
  test("returns the caller-supplied x-request-id header when present", () => {
    const req = new Request("http://localhost/api/whatever", {
      headers: { "x-request-id": "client-supplied-id" },
    });
    expect(getRequestId(req)).toBe("client-supplied-id");
  });

  test("trims whitespace from a supplied header", () => {
    const req = new Request("http://localhost/api/whatever", {
      headers: { "x-request-id": "  padded-id  " },
    });
    expect(getRequestId(req)).toBe("padded-id");
  });

  test("mints a fresh UUID when no header is supplied", () => {
    const req = new Request("http://localhost/api/whatever");
    const id = getRequestId(req);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("mints a fresh UUID when the header is blank", () => {
    const req = new Request("http://localhost/api/whatever", {
      headers: { "x-request-id": "   " },
    });
    const id = getRequestId(req);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test("two calls without a header produce different ids", () => {
    const a = getRequestId(new Request("http://localhost/api/a"));
    const b = getRequestId(new Request("http://localhost/api/b"));
    expect(a).not.toBe(b);
  });
});

describe("sanitizedErrorResponse", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("never includes the caught error's message in the response body", async () => {
    const sensitiveError = new Error(
      "ENOENT: no such file or directory, open '/var/secrets/stellar-secret-key.pem'",
    );
    const res = sanitizedErrorResponse(sensitiveError, {
      requestId: "req-1",
      status: 500,
      logMessage: "Something broke",
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("ENOENT");
    expect(JSON.stringify(body)).not.toContain("/var/secrets");
    expect(JSON.stringify(body)).not.toContain(
      "stellar-secret-key.pem",
    );
  });

  test("never includes a stack trace in the response body", async () => {
    const error = new Error("boom");
    const res = sanitizedErrorResponse(error, {
      requestId: "req-2",
      status: 500,
      logMessage: "Something broke",
    });
    const body = await res.json();

    expect(body).not.toHaveProperty("stack");
    expect(JSON.stringify(body)).not.toContain("at ");
    expect(JSON.stringify(body)).not.toContain(".ts:");
  });

  test("response body is exactly {error, code, requestId} by default", async () => {
    const res = sanitizedErrorResponse(new Error("internal detail"), {
      requestId: "req-3",
      status: 500,
      logMessage: "Something broke",
    });
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(["code", "error", "requestId"]);
    expect(body.requestId).toBe("req-3");
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  test("maps status codes to stable public codes", async () => {
    const cases: Array<[number, string]> = [
      [400, "BAD_REQUEST"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "CONFLICT"],
      [429, "RATE_LIMITED"],
      [500, "INTERNAL_ERROR"],
    ];

    for (const [status, code] of cases) {
      const res = sanitizedErrorResponse(new Error("x"), {
        requestId: "req",
        status,
        logMessage: "x",
      });
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(res.status).toBe(status);
    }
  });

  test("extraFields are merged into the body without overriding requestId/code", async () => {
    const res = sanitizedErrorResponse(new Error("internal detail"), {
      requestId: "req-4",
      status: 400,
      logMessage: "x",
      extraFields: { success: false },
    });
    const body = await res.json();

    expect(body.success).toBe(false);
    expect(body.requestId).toBe("req-4");
    expect(body.code).toBe("BAD_REQUEST");
  });

  test("logs the full error server-side, tagged with requestId, for support correlation", async () => {
    const error = new Error("the real, detailed failure reason");
    sanitizedErrorResponse(error, {
      requestId: "req-5",
      status: 500,
      logMessage: "Route X failed",
      context: { jobId: "job-123" },
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0][0] as string;
    expect(logged).toContain("req-5");
    expect(logged).toContain("job-123");
    expect(logged).toContain("the real, detailed failure reason");
  });

  test("defaults to status 500 / INTERNAL_ERROR when status is omitted", async () => {
    const res = sanitizedErrorResponse(new Error("x"), {
      requestId: "req-6",
      logMessage: "x",
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  test("handles non-Error thrown values without leaking their content unexpectedly", async () => {
    const res = sanitizedErrorResponse("a raw string throw with /etc/passwd", {
      requestId: "req-7",
      status: 500,
      logMessage: "x",
    });
    const body = await res.json();

    expect(JSON.stringify(body)).not.toContain("/etc/passwd");
  });
});
