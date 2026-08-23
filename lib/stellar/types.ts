/**
 * Type definitions for the Stellar bulk payment system
 */

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type HorizonNetwork = "testnet" | "mainnet" | "futurenet";
// Backward-compatible alias for modules that still import `Network`.
export type Network = HorizonNetwork;
// Batch jobs are only supported on production-facing payment networks.
export type BatchJobNetwork = "testnet" | "mainnet";

export interface JobState {
  jobId: string;
  publicKey: string | null;
  status: JobStatus;
  totalBatches: number;
  completedBatches: number;
  payments: PaymentInstruction[];
  network: BatchJobNetwork;
  // #300: Support for pre-signed transactions (client-side signing)
  signedTransactions?: string[];
  result?: BatchResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type MemoType = "text" | "id" | "none";

export interface PaymentInstruction {
  address: string;
  amount: string;
  asset: string; // 'XLM' for native or 'CODE:ISSUER' for issued assets
  memo?: string;
  memoType?: MemoType; // defaults to 'text' when memo is provided
  rowIndex?: number; // #397: original row index from upload, used for retry matching
}

/**
 * PaymentInstruction with a guaranteed rowIndex, used for files and lists
 * parsed from uploads to enable stable retry mapping.
 */
export interface UploadedPaymentInstruction extends PaymentInstruction {
  rowIndex: number;
}

export interface PaymentValidationRow {
  rowNumber: number;
  instruction: UploadedPaymentInstruction;
  valid: boolean;
  isDuplicate?: boolean;
  error?: string;
}

export interface ParsedPaymentFile {
  rows: PaymentValidationRow[];
  validPayments: UploadedPaymentInstruction[];
  invalidCount: number;
}

export interface Asset {
  code: string;
  issuer: string | null; // null for native XLM
}

export interface StellarTransaction {
  hash: string;
  operations: number;
}

export interface PaymentResult {
  recipient: string;
  amount: string;
  asset: string;
  status: "success" | "failed" | "unknown";
  transactionHash?: string;
  error?: string;
  rowIndex?: number; // #397: original row index, persisted for retry matching
}

export interface BatchResult {
  batchId: string;
  totalRecipients: number;
  totalAmount: string;
  totalTransactions: number;
  network: BatchJobNetwork;
  timestamp: string;
  submittedAt?: string;
  results: PaymentResult[];
  summary: {
    successful: number;
    failed: number;
  };
}

export interface BatchConfig {
  maxOperationsPerTransaction: number;
  network: BatchJobNetwork;
  secretKey: string;
}

/** Config for building unsigned transactions (wallet-signing flow) */
export interface BuildBatchConfig {
  maxOperationsPerTransaction: number;
  network: BatchJobNetwork;
  publicKey: string;
}

export interface BatchMetaEntry {
  ops: number;
  estimatedBytes: number;
  /** Explicit byte size alias for clarity in API responses (#612). Same as estimatedBytes. */
  byteSize: number;
}

/** Result from the batch-build endpoint (unsigned XDRs) */
export interface BuildBatchResult {
  xdrs: string[];
  batchCount: number;
  batchMeta?: BatchMetaEntry[];
  network: BatchJobNetwork;
  publicKey: string;
  /** The Stellar network max transaction size constant (100KB) for client-side progress bars (#612). */
  maxTransactionBytes?: number;
}

/** Vesting data structure matching the smart contract */
export interface VestingData {
  totalAmount: string;
  releasedAmount: string;
  startTime: number;
  endTime: number;
  sender: string;
  token: string;
  recipient: string;
  index: number;
  memo: string;
  vestingStep: number;
  ttlStatus?: "healthy" | "warning" | "expired";
  remainingDays?: number;
}

export type TTLStatus = "healthy" | "warning" | "expired";

// #335: Balance validation types referenced by validator.ts
export interface HorizonBalance {
  balance: string;
  asset_type: "native" | "credit_alphanum4" | "credit_alphanum12";
  asset_code?: string;
  asset_issuer?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
}

export interface BalancesMap {
  [assetKey: string]: number;
}

export interface BalanceValidationResult {
  all_sufficient: boolean;
  checks: Array<{
    asset_key: string;
    required: number;
    available: number;
    sufficient: boolean;
    xlm_reserved?: number;
    xlm_available_after_reserve?: number;
  }>;
}
