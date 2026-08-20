/**
 * Confirm that a submitted Soroban transaction reached a terminal status
 * before treating it as success. sendTransaction only enqueues; inclusion
 * is reported by getTransaction / pollTransaction.
 *
 * @see https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction
 * @see https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
 */

export const TERMINAL_TX_STATUS = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  NOT_FOUND: "NOT_FOUND",
} as const;

export type TerminalTxStatus =
  (typeof TERMINAL_TX_STATUS)[keyof typeof TERMINAL_TX_STATUS];

export type SubmittedTxStatus = "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR";

export type TransactionPoller = {
  pollTransaction: (
    hash: string,
    opts?: { attempts?: number },
  ) => Promise<{ status: string }>;
};

/** RPC accepted the envelope; it is not yet a confirmed ledger inclusion. */
export function isSubmitAccepted(status: string): boolean {
  return status === "PENDING" || status === "DUPLICATE";
}

export async function waitForTransactionInclusion(
  server: TransactionPoller,
  hash: string,
  attempts = 30,
): Promise<TerminalTxStatus> {
  const result = await server.pollTransaction(hash, { attempts });
  if (result.status === TERMINAL_TX_STATUS.SUCCESS) {
    return TERMINAL_TX_STATUS.SUCCESS;
  }
  if (result.status === TERMINAL_TX_STATUS.FAILED) {
    return TERMINAL_TX_STATUS.FAILED;
  }
  return TERMINAL_TX_STATUS.NOT_FOUND;
}

export async function confirmSubmittedTransaction(
  server: TransactionPoller,
  hash: string,
  submitStatus: string,
  attempts = 30,
): Promise<boolean> {
  if (!isSubmitAccepted(submitStatus)) {
    return false;
  }
  const inclusion = await waitForTransactionInclusion(server, hash, attempts);
  return inclusion === TERMINAL_TX_STATUS.SUCCESS;
}
