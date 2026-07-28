import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveVestingContractId } from "../lib/stellar/vesting-config";

const VALID_CONTRACT_ID = "CAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQMCJ";
const PLACEHOLDER_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ENV_KEYS = [
  "NEXT_PUBLIC_CONTRACT_ID_TESTNET",
  "NEXT_PUBLIC_CONTRACT_ID_MAINNET",
  "NEXT_PUBLIC_CONTRACT_ID_FUTURENET",
  "NEXT_PUBLIC_CONTRACT_ID",
  "CONTRACT_ID_TESTNET",
  "CONTRACT_ID_MAINNET",
  "CONTRACT_ID_FUTURENET",
  "CONTRACT_ID",
];

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveVestingContractId", () => {
  test("prefers network-specific contract IDs over the generic fallback", () => {
    process.env.NEXT_PUBLIC_CONTRACT_ID = "C123";
    process.env.NEXT_PUBLIC_CONTRACT_ID_TESTNET = VALID_CONTRACT_ID;

    expect(resolveVestingContractId("testnet")).toBe(VALID_CONTRACT_ID);
  });

  test("falls back to the generic public contract ID when no network-specific value is set", () => {
    process.env.NEXT_PUBLIC_CONTRACT_ID = VALID_CONTRACT_ID;

    expect(resolveVestingContractId("mainnet")).toBe(VALID_CONTRACT_ID);
  });

  test("throws an actionable error when the contract is missing or invalid", () => {
    expect(() => resolveVestingContractId("testnet")).toThrow(
      "Vesting contract is not configured for testnet. Set NEXT_PUBLIC_CONTRACT_ID_TESTNET, CONTRACT_ID_TESTNET, NEXT_PUBLIC_CONTRACT_ID, or CONTRACT_ID.",
    );

    process.env.NEXT_PUBLIC_CONTRACT_ID_TESTNET = "not-a-contract";

    expect(() => resolveVestingContractId("testnet")).toThrow(
      "Invalid vesting contract ID for testnet",
    );
  });

  test("throws an actionable error when the configured contract ID is the placeholder value", () => {
    process.env.NEXT_PUBLIC_CONTRACT_ID_TESTNET = PLACEHOLDER_CONTRACT_ID;

    expect(() => resolveVestingContractId("testnet")).toThrow(
      "Configured vesting contract ID for testnet is a placeholder value.",
    );
  });
});
