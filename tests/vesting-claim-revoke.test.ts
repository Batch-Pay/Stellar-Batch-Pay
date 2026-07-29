/**
 * Regression: vesting claim/revoke must use client-side Soroban builders with
 * the full contract ABI (recipient + index + amount / caller + indices), not
 * POST to missing `/api/vesting-claim` or `/api/vesting-revoke` routes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { Contract, Keypair, xdr, scValToNative } from "stellar-sdk";

const VALID_CONTRACT_ID =
  "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ";

const VESTING_PAGE = path.join(
  process.cwd(),
  "app",
  "dashboard",
  "vesting",
  "page.tsx",
);
const PAGE_SOURCE = readFileSync(VESTING_PAGE, "utf8");

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vesting page claim/revoke wiring", () => {
  test("does not POST to missing /api/vesting-claim or /api/vesting-revoke", () => {
    expect(PAGE_SOURCE).not.toMatch(/\/api\/vesting-claim/);
    expect(PAGE_SOURCE).not.toMatch(/\/api\/vesting-revoke/);
  });

  test("imports client-side claim and revoke builders", () => {
    expect(PAGE_SOURCE).toMatch(/buildClaimTransaction/);
    expect(PAGE_SOURCE).toMatch(/buildRevokeTransaction/);
    expect(PAGE_SOURCE).toMatch(/buildBatchRevokeTransaction/);
  });

  test("passes schedule index into claim and revoke builders", () => {
    expect(PAGE_SOURCE).toMatch(
      /buildClaimTransaction\(\s*contractId,\s*schedule\.recipient,\s*schedule\.index,\s*schedule\.claimableAmount/s,
    );
    expect(PAGE_SOURCE).toMatch(
      /buildRevokeTransaction\(\s*contractId,\s*schedules\[0\]\.recipient,\s*schedules\[0\]\.index/s,
    );
    expect(PAGE_SOURCE).toMatch(/index:\s*s\.index/);
  });

  test("tracks per-recipient on-chain schedule index on VestingSchedule", () => {
    expect(PAGE_SOURCE).toMatch(/index:\s*number/);
    expect(PAGE_SOURCE).toMatch(/recipientNextIndex/);
  });
});

describe("buildClaimTransaction ABI (recipient, index, amount)", () => {
  test("claim passes recipient, index, and amount in order", async () => {
    const callSpy = vi.spyOn(Contract.prototype, "call");
    const { buildClaimTransaction } = await import("../lib/stellar/vesting");

    const recipient = Keypair.random().publicKey();
    const signer = Keypair.random().publicKey();

    await buildClaimTransaction(
      VALID_CONTRACT_ID,
      recipient,
      2,
      "1.5",
      "testnet",
      signer,
    ).catch(() => undefined);

    expect(callSpy).toHaveBeenCalled();
    const claimCall = callSpy.mock.calls.find(([fn]) => fn === "claim");
    expect(claimCall).toBeDefined();
    const [, ...args] = claimCall!;
    expect(args).toHaveLength(3);
    expect(scValToNative(args[0] as xdr.ScVal)).toBe(recipient);
    expect(Number(scValToNative(args[1] as xdr.ScVal))).toBe(2);
    expect(scValToNative(args[2] as xdr.ScVal)).toBe(15_000_000n);
    callSpy.mockRestore();
  });
});

describe("buildRevokeTransaction / buildBatchRevokeTransaction ABI", () => {
  test("single revoke passes caller, recipient, and index", async () => {
    const callSpy = vi.spyOn(Contract.prototype, "call");
    const { buildRevokeTransaction } = await import("../lib/stellar/vesting");

    const recipient = Keypair.random().publicKey();
    const caller = Keypair.random().publicKey();

    await buildRevokeTransaction(
      VALID_CONTRACT_ID,
      recipient,
      4,
      "testnet",
      caller,
    ).catch(() => undefined);

    const revokeCall = callSpy.mock.calls.find(([fn]) => fn === "revoke");
    expect(revokeCall).toBeDefined();
    const [, ...args] = revokeCall!;
    expect(args).toHaveLength(3);
    expect(scValToNative(args[0] as xdr.ScVal)).toBe(caller);
    expect(scValToNative(args[1] as xdr.ScVal)).toBe(recipient);
    expect(Number(scValToNative(args[2] as xdr.ScVal))).toBe(4);
    callSpy.mockRestore();
  });

  test("batch_revoke passes caller and exact schedule indices (descending)", async () => {
    const callSpy = vi.spyOn(Contract.prototype, "call");
    const {
      buildBatchRevokeTransaction,
      sortRevokeRequestsDescending,
    } = await import("../lib/stellar/vesting");

    const recipientA = Keypair.random().publicKey();
    const recipientB = Keypair.random().publicKey();
    const caller = Keypair.random().publicKey();

    const requests = [
      { recipient: recipientA, index: 0 },
      { recipient: recipientA, index: 2 },
      { recipient: recipientA, index: 1 },
      { recipient: recipientB, index: 0 },
    ];

    const sorted = sortRevokeRequestsDescending(requests);
    // Same-recipient indices must be strictly descending.
    const aIndices = sorted
      .filter((r) => r.recipient === recipientA)
      .map((r) => r.index);
    expect(aIndices).toEqual([2, 1, 0]);

    await buildBatchRevokeTransaction(
      VALID_CONTRACT_ID,
      requests,
      "testnet",
      caller,
    ).catch(() => undefined);

    const batchCall = callSpy.mock.calls.find(([fn]) => fn === "batch_revoke");
    expect(batchCall).toBeDefined();
    const [, callerArg, requestsArg] = batchCall!;
    expect(scValToNative(callerArg as xdr.ScVal)).toBe(caller);

    const decoded = scValToNative(requestsArg as xdr.ScVal) as Array<{
      recipient: string;
      index: number | bigint;
    }>;
    expect(decoded).toHaveLength(4);

    const decodedA = decoded.filter((r) => r.recipient === recipientA);
    expect(decodedA.map((r) => Number(r.index))).toEqual([2, 1, 0]);

    const decodedB = decoded.filter((r) => r.recipient === recipientB);
    expect(decodedB.map((r) => Number(r.index))).toEqual([0]);

    callSpy.mockRestore();
  });

  test("batch_revoke rejects an empty request list before RPC", async () => {
    const { buildBatchRevokeTransaction } = await import(
      "../lib/stellar/vesting"
    );
    const caller = Keypair.random().publicKey();

    await expect(
      buildBatchRevokeTransaction(VALID_CONTRACT_ID, [], "testnet", caller),
    ).rejects.toThrow(/at least one/);
  });
});
