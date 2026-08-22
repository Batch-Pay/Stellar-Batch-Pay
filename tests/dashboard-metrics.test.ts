import { describe, test, expect, vi, beforeEach } from "vitest";
import { useDashboardMetrics } from "../hooks/use-dashboard-metrics";
import { useQuery } from "@tanstack/react-query";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

describe("Issue #461: useDashboardMetrics behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns zero defaults when wallet is disconnected (publicKey is null)", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    const result = useDashboardMetrics(null, "testnet");

    expect(result.metrics).toEqual({
      totalPayments: 0,
      totalAmountSent: "0 XLM",
      successRate: "0.0%",
      activeBatches: 0,
      paymentsLast24h: 0,
    });
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });

  test("keeps metrics null on error when wallet is connected", () => {
    const mockError = new Error("Horizon server error");
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: mockError,
      refetch: vi.fn(),
    } as any);

    const result = useDashboardMetrics("GDQERHRWJY...", "testnet");

    expect(result.metrics).toBeNull();
    expect(result.loading).toBe(false);
    expect(result.error).toBe("Horizon server error");
  });

  test("keeps metrics null when loading and no cached data", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as any);

    const result = useDashboardMetrics("GDQERHRWJY...", "testnet");

    expect(result.metrics).toBeNull();
    expect(result.loading).toBe(true);
    expect(result.error).toBeNull();
  });

  test("returns fetched data when successful", () => {
    const mockData = {
      totalPayments: 42,
      totalAmountSent: "1500 XLM",
      successRate: "98.5%",
      activeBatches: 2,
      paymentsLast24h: 5,
    };

    vi.mocked(useQuery).mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    const result = useDashboardMetrics("GDQERHRWJY...", "testnet");

    expect(result.metrics).toEqual(mockData);
    expect(result.loading).toBe(false);
    expect(result.error).toBeNull();
  });
});
