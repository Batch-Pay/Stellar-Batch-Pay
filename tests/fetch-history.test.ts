import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  batchHistoryQueryKey,
  fetchHistory,
  BATCH_HISTORY_QUERY_KEY,
} from "../lib/dashboard/fetch-history";

describe("fetch-history", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("batchHistoryQueryKey builds shared prefix for invalidation", () => {
    expect(batchHistoryQueryKey("GABC", "testnet", { limit: 5 })).toEqual([
      BATCH_HISTORY_QUERY_KEY,
      "GABC",
      "testnet",
      { limit: 5 },
    ]);
  });

  test("fetchHistory calls /api/batch-history with expected params", async () => {
    const mockResponse = {
      items: [],
      pagination: { totalPages: 1, total: 0 },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await fetchHistory({
      publicKey: "GABC123",
      page: 1,
      limit: 5,
      networkFilter: "testnet",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/batch-history?page=1&limit=5&publicKey=GABC123&network=testnet&includeSummary=true",
    );
    expect(result).toEqual(mockResponse);
  });

  test("fetchHistory throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(
      fetchHistory({ publicKey: "GABC123" }),
    ).rejects.toThrow("HTTP 500");
  });
});
