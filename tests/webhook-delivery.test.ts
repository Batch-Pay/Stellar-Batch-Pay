/**
 * Integration test: triggerWebhooksWithRetry delivers a signed payload to a
 * local HTTP server on batch.completed, and retries on 5xx before giving up.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import crypto from "crypto";
import {
  registerWebhook,
  unregisterWebhook,
  triggerWebhooksWithRetry,
  WEBHOOK_TIMEOUT_MS,
} from "../lib/webhooks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function collectBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("triggerWebhooksWithRetry (#338)", () => {
  let server: http.Server;
  let webhookUrl: string;
  let webhookId: string;
  let webhookSecret: string;

  afterEach(async () => {
    if (webhookId) unregisterWebhook(webhookId);
    if (server) await stopServer(server);
  });

  test("delivers signed batch.completed payload to a listening server", async () => {
    const received: { body: string; sig: string }[] = [];

    ({ server, url: webhookUrl } = await startServer(async (req, res) => {
      const body = await collectBody(req);
      received.push({ body, sig: req.headers["x-webhook-signature"] as string });
      res.writeHead(200);
      res.end();
    }));

    // Register with the HTTP url (bypass HTTPS check by using the in-memory store directly)
    const reg = registerWebhook(webhookUrl, ["batch.completed"]);
    webhookId = reg.id;
    webhookSecret = reg.secret;

    await triggerWebhooksWithRetry(
      "batch.completed",
      { jobId: "job-1", network: "testnet", summary: { successful: 5, failed: 0 } },
      "job-1",
    );

    expect(received).toHaveLength(1);

    // Verify HMAC signature
    const parsed = JSON.parse(received[0].body);
    const expectedSig = crypto
      .createHmac("sha256", webhookSecret)
      .update(received[0].body)
      .digest("hex");
    expect(received[0].sig).toBe(expectedSig);

    // Verify payload shape
    expect(parsed.event).toBe("batch.completed");
    expect(parsed.payload.jobId).toBe("job-1");
    expect(parsed.payload.summary.successful).toBe(5);
  });

  test("does not retry on 4xx response", async () => {
    let callCount = 0;

    ({ server, url: webhookUrl } = await startServer(async (_req, res) => {
      callCount++;
      res.writeHead(400);
      res.end();
    }));

    const reg = registerWebhook(webhookUrl, ["batch.completed"]);
    webhookId = reg.id;

    await triggerWebhooksWithRetry("batch.completed", { jobId: "job-2" }, "job-2");

    expect(callCount).toBe(1); // no retries on 4xx
  });

  test("retries on 5xx and eventually stops", async () => {
    let callCount = 0;

    ({ server, url: webhookUrl } = await startServer(async (_req, res) => {
      callCount++;
      res.writeHead(503);
      res.end();
    }));

    const reg = registerWebhook(webhookUrl, ["batch.failed"]);
    webhookId = reg.id;

    // Override BASE_DELAY_MS to 0 for fast test — we can't easily do that
    // without exporting it, so we just verify it retried more than once.
    await triggerWebhooksWithRetry("batch.failed", { jobId: "job-3" }, "job-3");

    // MAX_RETRIES = 4, so total attempts = 5 (initial + 4 retries)
    expect(callCount).toBe(5);
  }, 30_000);

  test("aborts and retries a delayed delivery at the webhook timeout", async () => {
    let abortedSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) => {
        abortedSignal = init?.signal ?? undefined;
        await new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const reg = registerWebhook("http://delayed.test", ["batch.completed"]);
    webhookId = reg.id;

    const startedAt = Date.now();
    await triggerWebhooksWithRetry("batch.completed", { jobId: "job-timeout" }, "job-timeout");

    expect(abortedSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(WEBHOOK_TIMEOUT_MS - 250);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    fetchSpy.mockRestore();
  }, 45_000);

  test("delivers to wildcard (*) subscriptions", async () => {
    const received: string[] = [];

    ({ server, url: webhookUrl } = await startServer(async (req, res) => {
      const body = await collectBody(req);
      received.push(JSON.parse(body).event);
      res.writeHead(200);
      res.end();
    }));

    const reg = registerWebhook(webhookUrl, ["*"]);
    webhookId = reg.id;

    await triggerWebhooksWithRetry("batch.completed", { jobId: "job-4" }, "job-4");

    expect(received).toContain("batch.completed");
  });

  test("blocks redirect responses to prevent SSRF", async () => {
    let redirectorCalls = 0;
    let metadataCalls = 0;

    const metadataServer = await startServer(async (_req, res) => {
      metadataCalls++;
      res.writeHead(200);
      res.end("metadata");
    });

    try {
      ({ server, url: webhookUrl } = await startServer(async (_req, res) => {
        redirectorCalls++;
        res.writeHead(302, { Location: `${metadataServer.url}/latest/meta-data` });
        res.end();
      }));

      const reg = registerWebhook(webhookUrl, ["batch.completed"]);
      webhookId = reg.id;

      await triggerWebhooksWithRetry("batch.completed", { jobId: "job-5" }, "job-5");

      expect(redirectorCalls).toBe(1);
      expect(metadataCalls).toBe(0);
    } finally {
      await stopServer(metadataServer.server);
    }
  }, 30_000);
});
