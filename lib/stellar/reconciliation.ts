import { Horizon } from "stellar-sdk";
import { createHash } from "crypto";

export interface ReconciliationResult {
  status: "success" | "failed" | "unknown";
  attempts: number;
}

const DEFAULT_RECONCILIATION_ATTEMPTS = 4;
const DEFAULT_INITIAL_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { response?: { status?: unknown } }).response?.status;
  return typeof status === "number" ? status : undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function isTransportError(error: unknown): boolean {
  const status = getStatusCode(error);
  const code = getErrorCode(error);
  const message = error instanceof Error ? error.message : "";

  return (
    code === "FETCH_ERROR" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    message.includes("TimeoutError") ||
    message.includes("network timeout") ||
    message.includes("connection reset") ||
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export async function reconcileTransaction(
  server: Horizon.Server,
  txHash: string,
  attempts = DEFAULT_RECONCILIATION_ATTEMPTS,
): Promise<ReconciliationResult> {
  let backoff = DEFAULT_INITIAL_BACKOFF_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await server.transactions().transaction(txHash).call();
      return { status: "success", attempts: attempt };
    } catch (error: unknown) {
      const status = getStatusCode(error);
      if (status === 404) {
        return { status: "failed", attempts: attempt };
      }

      if (attempt === attempts) {
        return { status: "unknown", attempts: attempt };
      }

      await sleep(backoff);
      backoff = Math.min(backoff * 2, DEFAULT_MAX_BACKOFF_MS);
    }
  }

  return { status: "unknown", attempts };
}

export function computeTransactionHash(transaction: {
  hash?: () => Uint8Array | Buffer;
  toEnvelope?: () => { toXDR?: () => string | Buffer };
}): string {
  if (typeof transaction.hash === "function") {
    const hash = transaction.hash();
    if (hash instanceof Uint8Array || Buffer.isBuffer(hash)) {
      return Buffer.from(hash).toString("hex");
    }
  }

  const xdr = transaction.toEnvelope?.().toXDR?.();
  if (typeof xdr === "string" || Buffer.isBuffer(xdr)) {
    return createHash("sha256").update(xdr).digest("hex");
  }

  throw new Error("Unable to compute transaction hash");
}
