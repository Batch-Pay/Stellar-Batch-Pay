/**
 * Main export file for the Stellar bulk payment library
 * NOTE: StellarService is NOT exported here - use lib/stellar/server.ts server-side only
 */

export { parseInput, parseJSON, parseCSV, parseFileStream, analyzeParsedPayments, parsePaymentFile, MAX_UPLOAD_ROWS } from './parser';
export { createBatches, getBatchSummary } from './batcher';
export { parseAsset } from './utils';
export { validatePaymentInstruction, validateBatchConfig, validatePaymentInstructions, validateBalances, buildBalancesMap, validateBatchForSubmit } from './validator';
export { fetchFeeStats, getRecommendedFee, getFeeForOperations, clearFeeCache } from './fee-service';
export type { FeeStats, FeeOptions } from './fee-service';
export type { 
  PaymentInstruction, 
  BatchJobNetwork,
  HorizonNetwork,
  Network,
  Asset, 
  StellarTransaction, 
  PaymentResult, 
  BatchResult, 
  BatchConfig, 
  PaymentValidationRow, 
  ParsedPaymentFile,
  HorizonBalance,
  BalancesMap,
  BalanceValidationResult
} from './types';
export { formatAmount } from './utils';
export {
  buildDepositTransaction,
  buildClaimTransaction,
  buildRevokeTransaction,
  buildBatchRevokeTransaction,
  sortRevokeRequestsDescending,
  buildTransferVestingRightsTransaction,
  buildBumpInstanceTtlTransaction,
  buildBumpVestingTtlTransaction,
} from './vesting';
export type { VestingRevokeRequest } from './vesting';
export {
  parseVestingClaimedPayload,
  parseVestingDeposited,
  parseVestingRevoked,
  parseVestingPartiallyRevoked,
  parseVestingTransferred,
  parseFeeCollected,
  parseVestingEventRecipient,
} from './vesting-events';
export type {
  VestingClaimedEventPayload,
  VestingDepositedEventPayload,
  VestingRevokedEventPayload,
  VestingPartiallyRevokedEventPayload,
  VestingTransferredEventPayload,
  FeeCollectedEventPayload,
} from './vesting-events';
