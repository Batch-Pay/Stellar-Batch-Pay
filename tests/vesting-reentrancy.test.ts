/**
 * Integration tests for reentrancy guard coverage across Soroban vesting builders and UI lifecycle (#744).
 */

import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "stellar-sdk";
import {
  buildDepositTransaction,
  buildClaimTransaction,
  buildRevokeTransaction,
  buildBatchRevokeTransaction,
  buildTransferVestingRightsTransaction,
  buildBumpVestingTtlTransaction,
} from "../lib/stellar/vesting";
import {
  acquireGuard,
  clearAllGuards,
  isLocked,
  ReentrancyError,
} from "../lib/stellar/reentrancy-guard";

const VALID_CONTRACT_ID = "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ";
const TEST_SIGNER = Keypair.random().publicKey();
const TEST_RECIPIENT = Keypair.random().publicKey();

vi.mock("stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stellar-sdk")>();

  class FakeServer {
    constructor(_url: string, _opts?: { allowHttp?: boolean }) {}

    async getAccount(id: string) {
      return new actual.Account(id, "12345");
    }

    async simulateTransaction() {
      return {
        transactionData: { resourceFee: () => 100n },
        minResourceFee: "100",
        latestLedger: 1,
      };
    }
  }

  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: FakeServer,
      assembleTransaction: vi.fn((tx: unknown) => ({
        build: () => tx,
      })),
      Api: {
        ...(actual.rpc?.Api ?? {}),
        isSimulationError: vi.fn(() => false),
      },
    },
  };
});

describe("Vesting Builders Reentrancy Guard Coverage (#744)", () => {
  beforeEach(() => {
    clearAllGuards();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearAllGuards();
  });

  test("buildClaimTransaction enforces reentrancy guard", async () => {
    // Acquire guard from a foreign holder (e.g. another tab)
    const releaseForeign = await acquireGuard(TEST_SIGNER, "claim", { holderId: "other_tab" });

    // Attempting buildClaimTransaction should be rejected
    await expect(
      buildClaimTransaction(
        VALID_CONTRACT_ID,
        TEST_RECIPIENT,
        0,
        "100.0",
        "testnet",
        TEST_SIGNER,
      ),
    ).rejects.toThrow(ReentrancyError);

    releaseForeign();

    // After release, buildClaimTransaction succeeds
    const xdr = await buildClaimTransaction(
      VALID_CONTRACT_ID,
      TEST_RECIPIENT,
      0,
      "100.0",
      "testnet",
      TEST_SIGNER,
    );
    expect(typeof xdr).toBe("string");
  });

  test("buildRevokeTransaction enforces reentrancy guard", async () => {
    const releaseForeign = await acquireGuard(TEST_SIGNER, "revoke", { holderId: "other_tab" });

    await expect(
      buildRevokeTransaction(
        VALID_CONTRACT_ID,
        TEST_RECIPIENT,
        0,
        "testnet",
        TEST_SIGNER,
      ),
    ).rejects.toThrow(ReentrancyError);

    releaseForeign();

    const xdr = await buildRevokeTransaction(
      VALID_CONTRACT_ID,
      TEST_RECIPIENT,
      0,
      "testnet",
      TEST_SIGNER,
    );
    expect(typeof xdr).toBe("string");
  });

  test("buildBatchRevokeTransaction enforces reentrancy guard", async () => {
    const releaseForeign = await acquireGuard(TEST_SIGNER, "revoke", { holderId: "other_tab" });

    await expect(
      buildBatchRevokeTransaction(
        VALID_CONTRACT_ID,
        [{ recipient: TEST_RECIPIENT, index: 0 }],
        "testnet",
        TEST_SIGNER,
      ),
    ).rejects.toThrow(ReentrancyError);

    releaseForeign();

    const xdr = await buildBatchRevokeTransaction(
      VALID_CONTRACT_ID,
      [{ recipient: TEST_RECIPIENT, index: 0 }],
      "testnet",
      TEST_SIGNER,
    );
    expect(typeof xdr).toBe("string");
  });

  test("buildDepositTransaction enforces reentrancy guard", async () => {
    const releaseForeign = await acquireGuard(TEST_SIGNER, "deposit", { holderId: "other_tab" });

    await expect(
      buildDepositTransaction(
        VALID_CONTRACT_ID,
        [{ address: TEST_RECIPIENT, amount: "50", asset: "XLM" }],
        1000,
        2000,
        1000,
        86400,
        "testnet",
        TEST_SIGNER,
      ),
    ).rejects.toThrow(ReentrancyError);

    releaseForeign();

    const xdr = await buildDepositTransaction(
      VALID_CONTRACT_ID,
      [{ address: TEST_RECIPIENT, amount: "50", asset: "XLM" }],
      1000,
      2000,
      1000,
      86400,
      "testnet",
      TEST_SIGNER,
    );
    expect(typeof xdr).toBe("string");
  });

  test("end-to-end lifecycle lock survives through signing and submission", async () => {
    // 1. User initiates deposit workflow (UI acquires outer lock)
    const releaseOuter = await acquireGuard(TEST_SIGNER, "deposit");
    expect(isLocked(TEST_SIGNER, "deposit")).toBe(true);

    // 2. Build transaction runs reentrantly without conflict in the same tab
    const xdr = await buildDepositTransaction(
      VALID_CONTRACT_ID,
      [{ address: TEST_RECIPIENT, amount: "50", asset: "XLM" }],
      1000,
      2000,
      1000,
      86400,
      "testnet",
      TEST_SIGNER,
    );
    expect(typeof xdr).toBe("string");

    // 3. Crucial correctness check: Lock is STILL held during simulated wallet prompt / submit!
    expect(isLocked(TEST_SIGNER, "deposit")).toBe(true);

    // Concurrent submission attempt from Tab 2 is blocked
    await expect(acquireGuard(TEST_SIGNER, "deposit", { holderId: "tab_2" })).rejects.toThrow(ReentrancyError);

    // 4. Simulated wallet sign + confirmation completed
    releaseOuter();

    // 5. Lock is now released
    expect(isLocked(TEST_SIGNER, "deposit")).toBe(false);
  });
});
