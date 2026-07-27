/**
 * Validation utilities for payment instructions and configuration
 */

import { StrKey } from "stellar-sdk";

import {
  PaymentInstruction,
  MemoType,
  BatchConfig,
  BatchJobNetwork,
  HorizonBalance,
  BalancesMap,
  BalanceValidationResult,
} from "./types";
import { parseStellarAmount, formatAmount } from "./utils";

function isValidPublicKey(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

function isValidSecretSeed(value: string): boolean {
  return StrKey.isValidEd25519SecretSeed(value);
}

/**
 * Validate a memo value based on its type.
 * - MEMO_TEXT: must be <= 28 bytes (UTF-8)
 * - MEMO_ID: must be a valid unsigned 64-bit integer
 */
export function validateMemo(
  memo: string,
  memoType: MemoType,
): { valid: boolean; error?: string } {
  if (memoType === "none" || !memo) {
    return { valid: true };
  }

  if (memoType === "text") {
    const byteLength = new TextEncoder().encode(memo).length;
    if (byteLength > 28) {
      return {
        valid: false,
        error: `Memo text exceeds 28 bytes (got ${byteLength} bytes)`,
      };
    }
    return { valid: true };
  }

  if (memoType === "id") {
    if (!/^\d+$/.test(memo)) {
      return {
        valid: false,
        error: `Memo ID must be a valid integer (got "${memo}")`,
      };
    }
    const value = BigInt(memo);
    if (value < 0n || value > 18446744073709551615n) {
      return {
        valid: false,
        error: `Memo ID must be a valid unsigned 64-bit integer`,
      };
    }
    return { valid: true };
  }

  return { valid: false, error: `Invalid memo type: ${memoType}` };
}

export function validatePaymentInstruction(instruction: PaymentInstruction): {
  valid: boolean;
  error?: string;
} {
  if (!instruction.address || typeof instruction.address !== "string") {
    return {
      valid: false,
      error: "Invalid address: must be a non-empty string",
    };
  }

  if (!isValidPublicKey(instruction.address)) {
    return {
      valid: false,
      error: `Invalid Stellar address checksum: ${instruction.address}`,
    };
  }

  if (!instruction.amount || typeof instruction.amount !== "string") {
    return {
      valid: false,
      error: "Invalid amount: must be a non-empty string",
    };
  }

  // Check if amount is a valid number
  let parsedAmount;
  try {
    parsedAmount = parseStellarAmount(instruction.amount);
  } catch {
    return {
      valid: false,
      error: `Invalid amount: must be a positive number (got ${instruction.amount})`,
    };
  }
  if (parsedAmount.lte(0)) {
    return {
      valid: false,
      error: `Invalid amount: must be a positive number (got ${instruction.amount})`,
    };
  }

  if (!instruction.asset || typeof instruction.asset !== "string") {
    return { valid: false, error: "Invalid asset: must be a non-empty string" };
  }

  // Validate memo if provided (before asset-specific checks)
  if (instruction.memo) {
    const memoType = instruction.memoType ?? "text";
    const memoResult = validateMemo(instruction.memo, memoType);
    if (!memoResult.valid) {
      return memoResult;
    }
  }

  // Validate asset format: either 'XLM' or 'CODE:ISSUER'
  if (instruction.asset === "XLM") {
    return { valid: true };
  }

  const assetParts = instruction.asset.split(":");
  if (
    assetParts.length !== 2 ||
    assetParts[0].length === 0 ||
    assetParts[1].length === 0
  ) {
    return {
      valid: false,
      error: `Invalid asset format: must be 'XLM' or 'CODE:ISSUER' (got ${instruction.asset})`,
    };
  }

  const [code, issuer] = assetParts;
  if (!isValidPublicKey(issuer)) {
    return {
      valid: false,
      error: `Invalid issuer address checksum in asset: ${issuer}`,
    };
  }

  if (code.length > 12) {
    return { valid: false, error: `Invalid asset code length: ${code}` };
  }

  if (!/^[A-Za-z0-9]+$/.test(code)) {
    return {
      valid: false,
      error: `Invalid asset code "${code}": must contain only alphanumeric characters (A-Z, a-z, 0-9)`,
    };
  }

  return { valid: true };
}

export function validateBatchConfig(config: BatchConfig): {
  valid: boolean;
  error?: string;
} {
  if (
    config.maxOperationsPerTransaction < 1 ||
    config.maxOperationsPerTransaction > 100
  ) {
    return {
      valid: false,
      error: "maxOperationsPerTransaction must be between 1 and 100",
    };
  }

  if (config.network !== "testnet" && config.network !== "mainnet") {
    return {
      valid: false,
      error: "network must be 'testnet' or 'mainnet'",
    };
  }

  if (!config.secretKey || typeof config.secretKey !== "string") {
    return { valid: false, error: "secretKey must be a non-empty string" };
  }

  if (!isValidSecretSeed(config.secretKey)) {
    return { valid: false, error: "Invalid Stellar secret key format" };
  }

  return { valid: true };
}

export function findDuplicates(
  instructions: PaymentInstruction[],
): Map<string, number[]> {
  const addressMap = new Map<string, number[]>();
  instructions.forEach((inst, index) => {
    if (inst.address) {
      const indices = addressMap.get(inst.address) || [];
      indices.push(index);
      addressMap.set(inst.address, indices);
    }
  });

  const duplicates = new Map<string, number[]>();
  for (const [address, indices] of addressMap.entries()) {
    if (indices.length > 1) {
      duplicates.set(address, indices);
    }
  }
  return duplicates;
}

export function validatePaymentInstructions(
  instructions: PaymentInstruction[],
): {
  valid: boolean;
  errors: Map<number, string>;
  duplicateIndices: Set<number>;
} {
  const errors = new Map<number, string>();
  const duplicateIndices = new Set<number>();

  // 1. Individual validation
  for (let i = 0; i < instructions.length; i++) {
    const result = validatePaymentInstruction(instructions[i]);
    if (!result.valid) {
      errors.set(i, result.error || "Unknown validation error");
    }
  }

  // 2. Duplicate detection
  const duplicates = findDuplicates(instructions);
  for (const indices of duplicates.values()) {
    indices.forEach((idx) => duplicateIndices.add(idx));
  }

  return {
    valid: errors.size === 0 && duplicateIndices.size === 0,
    errors,
    duplicateIndices,
  };
}

/**
 * Build a lookup map from a Horizon account's balances array.
 * Native XLM is keyed as "XLM"; non-native assets as "CODE:ISSUER".
 */
export function buildBalancesMap(balances: HorizonBalance[]): BalancesMap {
  const map: BalancesMap = {};
  for (const entry of balances) {
    const key =
      entry.asset_type === "native"
        ? "XLM"
        : `${entry.asset_code}:${entry.asset_issuer}`;
    map[key] = Number(entry.balance);
  }
  return map;
}

/**
 * Resolve the asset key used in the balances map for a payment instruction.
 */
export function resolveAssetKey(asset: string): string {
  return asset === "XLM" ? "XLM" : asset; // already in "CODE:ISSUER" format
}

/**
 * Validate that the source account has sufficient balance for every asset
 * across all payment instructions. Multiple payments of the same asset are
 * aggregated so cumulative spend is checked.
 *
 * For XLM, reserves the following:
 * - Base reserve: 2 XLM (minimum account balance)
 * - Transaction fees: ~0.00001 XLM per operation
 * - Subentry reserves: 0.5 XLM per trustline (if creating trustlines)
 *
 * @param instructions Payment instructions to validate
 * @param balancesMap Current account balances from Horizon
 * @param estimatedOperations Optional: total operations across all batches (for fee calculation)
 * @returns Validation result with per-asset checks
 */
export function validateBalances(
  instructions: PaymentInstruction[],
  balancesMap: BalancesMap,
  estimatedOperations?: number,
  maxOperationsPerTransaction: number = 100,
): BalanceValidationResult {
  // Aggregate required amounts per asset
  const requiredByAsset: Record<string, number> = {};
  for (const instruction of instructions) {
    const key = resolveAssetKey(instruction.asset);
    requiredByAsset[key] =
      (requiredByAsset[key] ?? 0) + Number(instruction.amount);
  }

  const checks = [];
  let allSufficient = true;

  // Stellar constants
  const BASE_RESERVE_XLM = 2; // minimum account balance
  const FEE_PER_OPERATION_XLM = 0.00001; // stroops: 100 / 10^7
  const SUBENTRY_RESERVE_XLM = 0.5; // per trustline

  // Calculate XLM reserves
  const finalOps = estimatedOperations !== undefined
    ? estimatedOperations
    : Math.max(instructions.length, 1);

  const transactionFees = finalOps * FEE_PER_OPERATION_XLM;
  const xlmReserved = BASE_RESERVE_XLM + transactionFees;

  for (const [assetKey, required] of Object.entries(requiredByAsset)) {
    const available = balancesMap[assetKey] ?? 0; // missing trustline → zero

    let sufficient = available >= required;
    let availableAfterReserve = available;

    // For XLM, subtract reserves before checking sufficiency
    if (assetKey === "XLM") {
      availableAfterReserve = available - xlmReserved;
      sufficient = availableAfterReserve >= required;
    }

    if (!sufficient) allSufficient = false;
    checks.push({
      asset_key: assetKey,
      required,
      available,
      sufficient,
      // Include reserve info for XLM in the check
      ...(assetKey === "XLM" && {
        xlm_reserved: xlmReserved,
        xlm_available_after_reserve: Math.max(0, availableAfterReserve),
      }),
    });
  }

  return { all_sufficient: allSufficient, checks };
}

export interface BatchSubmitValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateBatchForSubmit(
  payments: PaymentInstruction[],
  balancesMap: BalancesMap,
  missingTrustlines: string[],
  network: BatchJobNetwork,
  estimatedOperations?: number,
  maxOperationsPerTransaction: number = 100,
): BatchSubmitValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (payments.length === 0) {
    errors.push("No payments to submit.");
    return { valid: false, errors, warnings };
  }

  // 1. Validate payment instructions (formats, addresses, memos)
  const instrValidation = validatePaymentInstructions(payments);
  if (!instrValidation.valid) {
    for (const [idx, err] of instrValidation.errors.entries()) {
      errors.push(`Row ${idx + 1}: ${err}`);
    }
  }

  // 2. Validate balances (sums and reserves)
  const balanceCheck = validateBalances(payments, balancesMap, estimatedOperations, maxOperationsPerTransaction);
  if (!balanceCheck.all_sufficient) {
    for (const check of balanceCheck.checks) {
      if (!check.sufficient) {
        if (check.asset_key === "XLM" && check.xlm_reserved) {
          errors.push(
            `Insufficient balance for XLM. Required: ${formatAmount(check.required)} (plus ${check.xlm_reserved.toFixed(7)} reserve), Available: ${formatAmount(check.available)}`
          );
        } else {
          errors.push(
            `Insufficient balance for ${check.asset_key}. Required: ${formatAmount(check.required)}, Available: ${formatAmount(check.available)}`
          );
        }
      }
    }
  }

  // 3. Trustline warnings
  if (missingTrustlines.length > 0) {
    warnings.push(`${missingTrustlines.length} recipient(s) missing trustline. You can skip or convert to claimable balance.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
