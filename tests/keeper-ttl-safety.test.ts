import { describe, expect, it, vi } from "vitest";
import {
  buildGetEventsRequest,
  extractEventsCursor,
  startLedgerForLookback,
  type GetEventsPageRequest,
} from "../lib/keeper/events-pagination";
import { fetchActiveRecipients } from "../lib/keeper/discovery";
import { applyWindowOutcome, parseKeeperState } from "../lib/keeper/state";
import { selectUrgentRecipients } from "../lib/keeper/schedule";
import { DAY_IN_LEDGERS } from "../lib/keeper/threshold";
import {
  confirmSubmittedTransaction,
  isSubmitAccepted,
  waitForTransactionInclusion,
} from "../lib/keeper/tx-confirm";

describe("extractEventsCursor", () => {
  it("uses the RPC paging cursor and ignores latestLedger", () => {
    expect(
      extractEventsCursor({
        cursor: "0016010972359577600-0000000008",
        latestLedger: 3730843,
        events: [{ id: "older-id" }],
      }),
    ).toBe("0016010972359577600-0000000008");
  });

  it("falls back to the last event id, not latestLedger", () => {
    expect(
      extractEventsCursor({
        latestLedger: 99,
        events: [{ id: "evt-1" }, { id: "evt-2" }],
      }),
    ).toBe("evt-2");
  });

  it("never treats latestLedger as a cursor", () => {
    expect(
      extractEventsCursor({
        latestLedger: 18811945,
        events: [],
      }),
    ).toBeUndefined();
  });
});

describe("buildGetEventsRequest", () => {
  it("uses startLedger on the first page and cursor-only afterwards", () => {
    const first = buildGetEventsRequest({
      contractId: "CCONTRACT",
      startLedger: 1000,
      limit: 100,
    });
    expect(first).toEqual({
      filters: [{ type: "contract", contractIds: ["CCONTRACT"] }],
      startLedger: 1000,
      limit: 100,
    });
    expect(first).not.toHaveProperty("cursor");

    const next = buildGetEventsRequest({
      contractId: "CCONTRACT",
      startLedger: 1000,
      cursor: "page-token",
      limit: 100,
    });
    expect(next).toEqual({
      filters: [{ type: "contract", contractIds: ["CCONTRACT"] }],
      cursor: "page-token",
      limit: 100,
    });
    expect(next).not.toHaveProperty("startLedger");
    expect(next).not.toHaveProperty("latestLedger");
  });
});

describe("startLedgerForLookback", () => {
  it("clamps to ledger 1", () => {
    expect(startLedgerForLookback(50, 120_960)).toBe(1);
  });

  it("subtracts the lookback window from the chain tip", () => {
    expect(startLedgerForLookback(200_000, 120_960)).toBe(79_040);
  });
});

describe("fetchActiveRecipients pagination", () => {
  const recipientA = "GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234";
  const recipientB = "GDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234";

  function vestingEvent(recipient: string) {
    return {
      type: "contract",
      topic: [{ sym: "VestingClaimed" }, recipient],
    };
  }

  it("walks every page with the RPC cursor and never passes latestLedger as cursor", async () => {
    const requests: unknown[] = [];
    const rpc = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 200_000 }),
      getEvents: vi.fn(async (request: unknown) => {
        requests.push(request);
        if (!(request as { cursor?: string }).cursor) {
          return {
            events: [vestingEvent(recipientA), vestingEvent(recipientA)],
            cursor: "cursor-page-2",
            latestLedger: 200_000,
          };
        }
        return {
          events: [vestingEvent(recipientB)],
          cursor: "cursor-done",
          latestLedger: 200_001,
        };
      }),
    };

    const onAlert = vi.fn();
    const recipients = await fetchActiveRecipients({
      rpc,
      contractId: "CCONTRACT",
      lookbackLedgers: 1000,
      maxPages: 10,
      pageLimit: 2,
      onAlert,
    });

    expect(recipients).toEqual(expect.arrayContaining([recipientA, recipientB]));
    expect(recipients).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ startLedger: 199_000 });
    expect(requests[1]).toMatchObject({ cursor: "cursor-page-2" });
    expect(JSON.stringify(requests[1])).not.toContain("200000");
    expect(onAlert).not.toHaveBeenCalled();
  });

  it("alerts when max pages is hit before events are exhausted", async () => {
    const rpc = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 50_000 }),
      getEvents: vi.fn(async (request: GetEventsPageRequest) => ({
        events: [vestingEvent(recipientA), vestingEvent(recipientB)],
        cursor: `next-after-${"cursor" in request ? request.cursor : "start"}`,
        latestLedger: 50_000,
      })),
    };
    const onAlert = vi.fn();

    await fetchActiveRecipients({
      rpc,
      contractId: "CCONTRACT",
      lookbackLedgers: 1000,
      maxPages: 2,
      pageLimit: 2,
      onAlert,
    });

    expect(rpc.getEvents).toHaveBeenCalledTimes(2);
    expect(onAlert).toHaveBeenCalledWith(
      expect.stringMatching(/hit max pages/),
    );
  });

  it("alerts and throws when RPC discovery fails", async () => {
    const rpc = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("rpc down")),
      getEvents: vi.fn(),
    };
    const onAlert = vi.fn();

    await expect(
      fetchActiveRecipients({
        rpc,
        contractId: "CCONTRACT",
        lookbackLedgers: 1000,
        maxPages: 10,
        pageLimit: 100,
        onAlert,
      }),
    ).rejects.toThrow("rpc down");

    expect(onAlert).toHaveBeenCalledOnce();
    expect(onAlert.mock.calls[0]![0]).toMatch(/Failed to fetch active recipients/);
  });

  it("alerts when discovery succeeds with zero recipients", async () => {
    const rpc = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 10_000 }),
      getEvents: vi.fn().mockResolvedValue({ events: [], cursor: "" }),
    };
    const onAlert = vi.fn();

    const recipients = await fetchActiveRecipients({
      rpc,
      contractId: "CCONTRACT",
      lookbackLedgers: 1000,
      maxPages: 10,
      pageLimit: 100,
      onAlert,
    });

    expect(recipients).toEqual([]);
    expect(onAlert).toHaveBeenCalledOnce();
    expect(onAlert.mock.calls[0]![0]).toMatch(/no vesting recipients/);
  });
});

describe("applyWindowOutcome", () => {
  it("advances nextMaintenanceIndex only after confirmed success", () => {
    const state = parseKeeperState({
      nextMaintenanceIndex: { G1: 10 },
    });
    applyWindowOutcome(state, "G1", 10, 10, "success");
    expect(state.nextMaintenanceIndex.G1).toBe(20);
  });

  it("does not advance the index for unconfirmed transactions", () => {
    const state = parseKeeperState({
      nextMaintenanceIndex: { G1: 10 },
    });
    applyWindowOutcome(state, "G1", 10, 10, "not_confirmed");
    expect(state.nextMaintenanceIndex.G1).toBe(10);
  });

  it("resets the index when the window has no work", () => {
    const state = parseKeeperState({
      nextMaintenanceIndex: { G1: 30 },
    });
    applyWindowOutcome(state, "G1", 30, 10, "no_work");
    expect(state.nextMaintenanceIndex.G1).toBe(0);
  });
});

describe("transaction inclusion", () => {
  it("does not treat sendTransaction PENDING as confirmation", () => {
    expect(isSubmitAccepted("PENDING")).toBe(true);
    expect(isSubmitAccepted("ERROR")).toBe(false);
  });

  it("returns false when submit is rejected before polling", async () => {
    const pollTransaction = vi.fn();
    const confirmed = await confirmSubmittedTransaction(
      { pollTransaction },
      "abc",
      "ERROR",
    );
    expect(confirmed).toBe(false);
    expect(pollTransaction).not.toHaveBeenCalled();
  });

  it("polls until SUCCESS or FAILED", async () => {
    const pollTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: "SUCCESS" });
    expect(await waitForTransactionInclusion({ pollTransaction }, "h")).toBe(
      "SUCCESS",
    );

    pollTransaction.mockResolvedValueOnce({ status: "FAILED" });
    expect(await waitForTransactionInclusion({ pollTransaction }, "h")).toBe(
      "FAILED",
    );

    const confirmed = await confirmSubmittedTransaction(
      { pollTransaction: async () => ({ status: "NOT_FOUND" }) },
      "h",
      "PENDING",
    );
    expect(confirmed).toBe(false);
  });
});

describe("selectUrgentRecipients", () => {
  it("prioritizes near-expiry recipients via threshold helpers", () => {
    const currentLedger = 1_000_000;
    const thresholdLedgers = 7 * DAY_IN_LEDGERS;
    const ordered = selectUrgentRecipients(
      [
        {
          recipient: "G_HEALTHY",
          liveUntilLedger: currentLedger + 30 * DAY_IN_LEDGERS,
        },
        {
          recipient: "G_DUE_IN_5D",
          liveUntilLedger: currentLedger + 5 * DAY_IN_LEDGERS,
        },
        {
          recipient: "G_DUE_IN_1D",
          liveUntilLedger: currentLedger + 1 * DAY_IN_LEDGERS,
        },
        { recipient: "G_UNKNOWN", liveUntilLedger: null },
      ],
      currentLedger,
      thresholdLedgers,
    );

    expect(ordered).toEqual(["G_UNKNOWN", "G_DUE_IN_1D", "G_DUE_IN_5D"]);
    expect(ordered).not.toContain("G_HEALTHY");
  });
});
