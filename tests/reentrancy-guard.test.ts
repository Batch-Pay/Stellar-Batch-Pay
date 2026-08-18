/**
 * Unit tests for client-side durable reentrancy guard (#250, #744).
 */

import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import {
  acquireGuard,
  releaseGuard,
  isLocked,
  clearAllGuards,
  ReentrancyError,
  makeGuardKey,
  getActiveLock,
  getHolderId,
} from "../lib/stellar/reentrancy-guard";

const TEST_ACCOUNT_A = "GBBD47UZM2HN7D7XZIZVG4KVAUC36THN5BES6RMNNOK5TUNXAUCVMAKER";
const TEST_ACCOUNT_B = "GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3AEYZ7R37ZJNHYQM7MDEBC67";

describe("Client Reentrancy Guard (reentrancy-guard.ts)", () => {
  beforeEach(() => {
    clearAllGuards();
  });

  afterEach(() => {
    clearAllGuards();
    vi.unstubAllGlobals();
  });

  test("serializes simultaneous cross-tab acquisition with Web Locks", async () => {
    let held = false;
    const locks = {
      request: vi.fn(async (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name: _name });
        } finally {
          held = false;
        }
      }),
    };
    vi.stubGlobal("navigator", { locks });

    const first = acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId: "tab_1" });
    const second = acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId: "tab_2" });

    const releaseFirst = await first;
    await expect(second).rejects.toThrow(ReentrancyError);
    expect(locks.request).toHaveBeenCalledTimes(2);

    releaseFirst();
    await vi.waitFor(() => expect(held).toBe(false));
    const releaseSecond = await acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId: "tab_2" });
    releaseSecond();
  });

  test("acquires lock and releases properly", async () => {
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(false);

    const release = await acquireGuard(TEST_ACCOUNT_A, "deposit");
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);

    release();
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(false);
  });

  test("rejects concurrent acquisition from a different holder/tab with ReentrancyError", async () => {
    await acquireGuard(TEST_ACCOUNT_A, "claim", { holderId: "tab_1" });
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(true);

    await expect(acquireGuard(TEST_ACCOUNT_A, "claim", { holderId: "tab_2" })).rejects.toThrow(ReentrancyError);

    try {
      await acquireGuard(TEST_ACCOUNT_A, "claim", { holderId: "tab_2" });
    } catch (err) {
      expect(err).toBeInstanceOf(ReentrancyError);
      expect((err as ReentrancyError).operation).toBe("claim");
      expect((err as Error).message).toContain("already in progress");
    }
  });

  test("supports same-holder nested reentrancy with reference counting", async () => {
    const holderId = "tab_main";

    // Outer lock (e.g. UI lifecycle)
    const releaseOuter = await acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId });
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);

    // Inner lock (e.g. builder inside the same tab)
    const releaseInner = await acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId });
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);

    // Inner release should not fully free the lock because outer is still held
    releaseInner();
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);

    // Another holder is still blocked
    await expect(acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId: "tab_other" })).rejects.toThrow(ReentrancyError);

    // Final outer release frees the lock
    releaseOuter();
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(false);

    // Now another holder can acquire
    const releaseOther = await acquireGuard(TEST_ACCOUNT_A, "deposit", { holderId: "tab_other" });
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);
    releaseOther();
  });

  test("isolates locks between different accounts and operations", async () => {
    const releaseDepositA = await acquireGuard(TEST_ACCOUNT_A, "deposit");
    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(true);

    // Different operation for same account should succeed
    const releaseClaimA = await acquireGuard(TEST_ACCOUNT_A, "claim");
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(true);

    // Different account for same operation should succeed
    const releaseDepositB = await acquireGuard(TEST_ACCOUNT_B, "deposit");
    expect(isLocked(TEST_ACCOUNT_B, "deposit")).toBe(true);

    releaseDepositA();
    releaseClaimA();
    releaseDepositB();

    expect(isLocked(TEST_ACCOUNT_A, "deposit")).toBe(false);
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(false);
    expect(isLocked(TEST_ACCOUNT_B, "deposit")).toBe(false);
  });

  test("auto-expires stale lock after TTL", async () => {
    const shortTtlMs = 50;
    await acquireGuard(TEST_ACCOUNT_A, "revoke", { ttlMs: shortTtlMs, holderId: "tab_crashed" });
    expect(isLocked(TEST_ACCOUNT_A, "revoke")).toBe(true);

    // Advance time past TTL
    vi.setSystemTime(Date.now() + 100);

    try {
      expect(isLocked(TEST_ACCOUNT_A, "revoke")).toBe(false);

      // New holder can acquire immediately after TTL expiration
      const releaseNew = await acquireGuard(TEST_ACCOUNT_A, "revoke", { holderId: "tab_healthy" });
      expect(isLocked(TEST_ACCOUNT_A, "revoke")).toBe(true);
      releaseNew();
    } finally {
      vi.useRealTimers();
    }
  });

  test("idempotent release function invocation does not corrupt state", async () => {
    const release = await acquireGuard(TEST_ACCOUNT_A, "claim");
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(true);

    release();
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(false);

    // Calling release multiple times should be safe no-op
    expect(() => release()).not.toThrow();
    expect(isLocked(TEST_ACCOUNT_A, "claim")).toBe(false);
  });
});
