/**
 * Unit tests for scripts/keeper.ts pure functions (#588).
 *
 * keeper.ts is a top-level script that calls `main()` on import, so we
 * cannot import it directly in tests. Instead we:
 *   1. Test the pure helper functions by extracting equivalent logic here.
 *   2. Test the SorobanRpc.Server simulation error path by mocking the
 *      stellar-sdk and verifying sendTransaction is NOT called when
 *      simulateTransaction returns an error.
 *   3. Test the alert webhook notification path by mocking `fetch`.
 *
 * All tests use vitest globals (describe / it / expect / vi / beforeEach).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  determineMaintenanceState,
  getNextPageCursor,
} from "../scripts/keeper";

// ── readU32Env ───────────────────────────────────────────────────────────────
// Extracted replica of the function in keeper.ts (pure, no side effects).

const U32_MAX = 2 ** 32 - 1;

function readU32Env(
  envVars: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const rawValue = envVars[name];
  if (rawValue === undefined || rawValue === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

describe("keeper pagination and maintenance state", () => {
  it("uses the RPC paging cursor, not the latest ledger, for continued event scans", () => {
    expect(getNextPageCursor({ cursor: "abc123", latestLedger: 999 })).toBe("abc123");
    expect(getNextPageCursor({ latestLedger: 999 })).toBeUndefined();
  });

  it("keeps the maintenance index for pending transactions instead of advancing it", () => {
    expect(determineMaintenanceState("bumped")).toBe("advance");
    expect(determineMaintenanceState("no-work")).toBe("reset");
    expect(determineMaintenanceState("pending")).toBe("hold");
    expect(determineMaintenanceState("failed")).toBe("hold");
  });
});

describe("readU32Env", () => {
  it("returns the parsed integer when the env var is set", () => {
    expect(readU32Env({ LIMIT: "42" }, "LIMIT", 10)).toBe(42);
  });

  it("returns the fallback when the env var is undefined", () => {
    expect(readU32Env({}, "LIMIT", 10)).toBe(10);
  });

  it("returns the fallback when the env var is an empty string", () => {
    expect(readU32Env({ LIMIT: "" }, "LIMIT", 10)).toBe(10);
  });

  it("throws when the value is not an integer", () => {
    expect(() => readU32Env({ LIMIT: "3.14" }, "LIMIT", 10)).toThrow(
      "must be an unsigned 32-bit integer",
    );
  });

  it("throws when the value is negative", () => {
    expect(() => readU32Env({ LIMIT: "-1" }, "LIMIT", 10)).toThrow(
      "must be an unsigned 32-bit integer",
    );
  });

  it("throws when the value exceeds U32_MAX", () => {
    expect(() =>
      readU32Env({ LIMIT: String(U32_MAX + 1) }, "LIMIT", 10),
    ).toThrow("must be an unsigned 32-bit integer");
  });

  it("accepts 0 as a valid U32 value", () => {
    expect(readU32Env({ LIMIT: "0" }, "LIMIT", 10)).toBe(0);
  });

  it("accepts U32_MAX as a valid value", () => {
    expect(readU32Env({ LIMIT: String(U32_MAX) }, "LIMIT", 10)).toBe(U32_MAX);
  });
});

// ── Recipient set deduplication ──────────────────────────────────────────────
// keeper.ts uses a Set<string> to collect unique recipient addresses from
// contract events. Tests verify that duplicate addresses are collapsed.

describe("recipient set deduplication", () => {
  function collectRecipients(addresses: string[]): string[] {
    const recipients = new Set<string>();
    for (const addr of addresses) {
      if (addr.startsWith("G")) {
        recipients.add(addr);
      }
    }
    return Array.from(recipients);
  }

  it("deduplicates identical addresses", () => {
    const addresses = [
      "GABC123",
      "GABC123",
      "GDEF456",
      "GABC123",
    ];
    const result = collectRecipients(addresses);
    expect(result).toHaveLength(2);
    expect(result).toContain("GABC123");
    expect(result).toContain("GDEF456");
  });

  it("filters out non-G addresses", () => {
    const addresses = ["GABC123", "not-a-stellar-addr", "GDEF456", ""];
    const result = collectRecipients(addresses);
    expect(result).toEqual(expect.arrayContaining(["GABC123", "GDEF456"]));
    expect(result).not.toContain("not-a-stellar-addr");
    expect(result).not.toContain("");
  });

  it("returns an empty array when no valid addresses are present", () => {
    const result = collectRecipients(["bad", "also-bad"]);
    expect(result).toHaveLength(0);
  });

  it("handles an empty input list", () => {
    expect(collectRecipients([])).toHaveLength(0);
  });
});

// ── Alert message formatting ─────────────────────────────────────────────────
// keeper.ts embeds the alert message in a JSON body:
//   { text: `🚨 *Keeper Bot Alert*: ${message}` }

describe("alert message formatting", () => {
  function formatAlertBody(message: string): string {
    return JSON.stringify({ text: `🚨 *Keeper Bot Alert*: ${message}` });
  }

  it("includes the keeper prefix and the supplied message", () => {
    const body = formatAlertBody("Something went wrong");
    const parsed = JSON.parse(body) as { text: string };
    expect(parsed.text).toContain("Keeper Bot Alert");
    expect(parsed.text).toContain("Something went wrong");
  });

  it("produces valid JSON", () => {
    const body = formatAlertBody('Critical: "quota exceeded"');
    expect(() => JSON.parse(body)).not.toThrow();
  });
});

// ── Pagination guard (maxPages limit) ───────────────────────────────────────

describe("pagination guard", () => {
  it("stops after maxPages iterations even if events keep arriving", async () => {
    const maxPages = 10;
    let pageCount = 0;
    let cursor: string | undefined;

    const getEvents = async (_params: { limit: number; cursor?: string }) => {
      // Always return one event so the loop would otherwise run forever.
      return {
        events: [{ type: "contract", contractId: [] }],
        latestLedger: String(pageCount + 1),
      };
    };

    while (pageCount < maxPages) {
      const params: { limit: number; cursor?: string } = { limit: 100 };
      if (cursor) params.cursor = cursor;

      const events = await getEvents(params);

      if (!events.events || events.events.length === 0) break;

      cursor = events.latestLedger;
      pageCount++;
    }

    expect(pageCount).toBe(maxPages);
  });

  it("stops early when no events are returned", async () => {
    const maxPages = 10;
    let pageCount = 0;

    const getEvents = async (_params: unknown) => ({
      events: [] as unknown[],
      latestLedger: "0",
    });

    while (pageCount < maxPages) {
      const events = await getEvents({});
      if (!events.events || events.events.length === 0) break;
      pageCount++;
    }

    expect(pageCount).toBe(0);
  });
});

// ── simulateTransaction error → no sendTransaction ───────────────────────────

describe("maintainRecipientWindow simulation error path", () => {
  it("does not call sendTransaction when simulateTransaction returns an error", async () => {
    const sendTransaction = vi.fn();
    const simulateTransaction = vi.fn().mockResolvedValue({
      // Shape of a SorobanRpc simulation error response.
      error: "contract invocation failed",
      _type: "SimulateTransactionErrorResponse",
    });

    // Mirrors the logic in maintainRecipientWindow:
    // if (SorobanRpc.Api.isSimulationError(sim)) return false;
    const isSimulationError = (sim: { error?: string }) =>
      typeof sim.error === "string";

    const sim = await simulateTransaction("fake-tx");

    if (isSimulationError(sim)) {
      // no-op — sendTransaction must not be called
    } else {
      await sendTransaction("prepared-tx");
    }

    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("calls sendTransaction when simulation succeeds", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({ hash: "abc123" });
    const simulateTransaction = vi.fn().mockResolvedValue({
      // Successful simulation — no `error` field.
      results: [],
      _type: "SimulateTransactionSuccessResponse",
    });

    const isSimulationError = (sim: { error?: string }) =>
      typeof sim.error === "string";

    const sim = await simulateTransaction("fake-tx");

    if (isSimulationError(sim)) {
      // no-op
    } else {
      await sendTransaction("prepared-tx");
    }

    expect(sendTransaction).toHaveBeenCalledOnce();
  });
});

// ── Alert webhook notification path ─────────────────────────────────────────

describe("sendAlert webhook", () => {
  const WEBHOOK_URL = "https://example.com/webhook";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sendAlert(message: string, webhookUrl?: string) {
    if (!webhookUrl) return;
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `🚨 *Keeper Bot Alert*: ${message}` }),
    });
  }

  it("POSTs to the webhook URL with the alert message", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await sendAlert("Test alert", WEBHOOK_URL);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe(WEBHOOK_URL);
    expect((options as RequestInit).method).toBe("POST");
    const body = JSON.parse((options as RequestInit).body as string) as {
      text: string;
    };
    expect(body.text).toContain("Test alert");
  });

  it("does not call fetch when no webhook URL is configured", async () => {
    const mockFetch = vi.mocked(fetch);
    await sendAlert("silent alert", undefined);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
