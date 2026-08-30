import { Keypair } from "stellar-sdk";
import { describe, expect, test } from "vitest";
import {
  canContinueManualBatch,
  getValidManualPayments,
  validateManualAddress,
} from "../lib/dashboard/manual-batch-validation";

const validAddress = Keypair.random().publicKey();

describe("validateManualAddress", () => {
  test("accepts a valid Stellar public key", () => {
    expect(validateManualAddress(validAddress)).toBeUndefined();
  });

  test("rejects malformed checksum", () => {
    const flipAt = 12;
    const flip = validAddress[flipAt] === "A" ? "B" : "A";
    const bad = `${validAddress.slice(0, flipAt)}${flip}${validAddress.slice(flipAt + 1)}`;
    expect(validateManualAddress(bad)).toBe("Invalid Stellar address checksum");
  });

  test("ignores empty input", () => {
    expect(validateManualAddress("")).toBeUndefined();
    expect(validateManualAddress("   ")).toBeUndefined();
  });
});

describe("canContinueManualBatch", () => {
  test("allows a single valid row", () => {
    expect(
      canContinueManualBatch([
        { address: validAddress, amount: "10", asset: "XLM" },
      ]),
    ).toBe(true);
  });

  test("blocks malformed addresses", () => {
    expect(
      canContinueManualBatch([
        { address: "not-a-stellar-address", amount: "10", asset: "XLM" },
      ]),
    ).toBe(false);
    expect(getValidManualPayments([
      { address: "not-a-stellar-address", amount: "10", asset: "XLM" },
    ])).toHaveLength(0);
  });

  test("blocks partially filled rows", () => {
    expect(
      canContinueManualBatch([{ address: validAddress, amount: "", asset: "XLM" }]),
    ).toBe(false);
  });

  test("ignores trailing empty rows", () => {
    expect(
      canContinueManualBatch([
        { address: validAddress, amount: "10", asset: "XLM" },
        { address: "", amount: "", asset: "XLM" },
      ]),
    ).toBe(true);
  });
});
