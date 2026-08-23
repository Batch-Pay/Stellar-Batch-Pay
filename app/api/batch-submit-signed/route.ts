/**
 * API route for submitting a pre-signed Stellar transaction.
 *
 * POST /api/batch-submit-signed
 *
 * Accepts { signedXdr, network } where signedXdr is the base64-encoded
 * XDR of a transaction that has already been signed by the user's wallet.
 *
 * On low-fee errors, returns feeEstimate and currentNetworkFee to allow retry with higher fees.
 */

import { NextRequest, NextResponse } from "next/server";
import { TransactionBuilder, Horizon, Networks } from "stellar-sdk";
import { safeJsonResponse } from "@/lib/safe-json";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";
import { horizonUrl } from "@/lib/stellar/network-config";
import type { BatchJobNetwork } from "@/lib/stellar/types";
import {
    classifySubmitError,
    isBadSequenceError,
    isInsufficientFeeError,
} from "@/lib/stellar/submit-errors";
import { getXdrSourceAccount, operationCountOf } from "@/lib/stellar/xdr-source";
import { getRequestId, sanitizedErrorResponse } from "@/lib/api-error";
import { logger } from "@/lib/logger";

interface RequestBody {
    signedXdr: string;
    network: BatchJobNetwork;
    // #504: Optional authenticated wallet. When provided, the transaction's
    // source account (or fee-bump inner source) must match it.
    publicKey?: string;
}

interface FeeStats {
    last_ledger_base_fee?: string;
    ledger_capacity_usage?: string;
}

async function getFeeStats(server: Horizon.Server): Promise<FeeStats> {
    try {
        const response = await fetch(server.serverURL + "/fee_stats");
        return await response.json();
    } catch (error) {
        console.error("Failed to fetch fee stats:", error);
        return {};
    }
}

export async function POST(request: NextRequest) {
    const rate = await applyRateLimit(request, "batch-submit-signed");
    if (rate.blocked) return rate.response!;

    const requestId = getRequestId(request);

    try {
        const body = (await request.json()) as RequestBody;
        const { signedXdr, network, publicKey } = body;

        // ── Validate inputs ──────────────────────────────────────────

        if (!signedXdr || typeof signedXdr !== "string") {
            return NextResponse.json(
                { error: "signedXdr is required" },
                { status: 400 },
            );
        }

        if (!["testnet", "mainnet"].includes(network)) {
            return NextResponse.json(
                { error: "network must be 'testnet' or 'mainnet'" },
                { status: 400 },
            );
        }

        // #504: When the caller declares a wallet, the signed transaction must
        // originate from it. Reject mismatches before touching Horizon so a
        // client cannot submit another wallet's transaction under publicKey.
        if (publicKey) {
            const source = getXdrSourceAccount(signedXdr, network);
            if (source !== undefined && source !== publicKey) {
                return NextResponse.json(
                    {
                        success: false,
                        error:
                            "Signed transaction source account does not match publicKey. Pre-signed submissions must be signed by the authenticated wallet.",
                    },
                    { status: 403 },
                );
            }
        }

        // ── Rehydrate and submit ─────────────────────────────────────

        const networkPassphrase =
            network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;

        const transaction = TransactionBuilder.fromXDR(
            signedXdr,
            networkPassphrase,
        );

        // #272: Horizon URL is env-configurable; falls back to the
        // public SDF node when nothing is set.
        const serverUrl = horizonUrl(network);
        const server = new Horizon.Server(serverUrl);

        try {
            const result = await server.submitTransaction(transaction);

            return setRateLimitHeaders(safeJsonResponse({
                success: true,
                hash: result.hash,
                ledger: result.ledger,
            }), rate);
        } catch (submissionError: unknown) {
            // A stale/duplicate sequence number is NOT a fee problem: bumping
            // the fee or resubmitting the same signed XDR can't fix it. Surface
            // a structured "rebuild" action instead of fee guidance. (#330)
            if (isBadSequenceError(submissionError)) {
                const classified = classifySubmitError(submissionError);
                return setRateLimitHeaders(safeJsonResponse(
                    {
                        success: false,
                        error: classified.message,
                        code: classified.code,
                        action: classified.action,
                        resultCodes: classified.resultCodes,
                    },
                    { status: 400 },
                ), rate);
            }

            // Check if this is a low-fee error and provide fee guidance
            if (isInsufficientFeeError(submissionError)) {
                const feeStats = await getFeeStats(server);
                const currentBaseFee = Number(feeStats.last_ledger_base_fee || "100");
                const opCount = operationCountOf(transaction) ?? 1;
                const estimatedFee = (currentBaseFee * opCount).toString();

                return setRateLimitHeaders(safeJsonResponse(
                    {
                        success: false,
                        error: "Transaction fees are insufficient for current network conditions",
                        code: "insufficient_fee",
                        action: "increase_fee",
                        currentNetworkFee: currentBaseFee,
                        operationCount: opCount,
                        estimatedRequiredFee: estimatedFee,
                        guidance: `Network base fee is ${currentBaseFee} stroops × ${opCount} operation(s). Consider retrying with a fee of at least ${estimatedFee} stroops.`,
                    },
                    { status: 400 },
                ), rate);
            }

            throw submissionError;
        }
    } catch (error: unknown) {
        // Horizon result codes (e.g. tx_failed / op_underfunded) are stable,
        // documented codes, not internal details — safe to surface so the
        // client can react. Anything else (JSON parse failures, malformed
        // XDR, unexpected errors) is sanitized: only a generic message, a
        // stable code, and requestId go to the client; full detail is logged
        // server-side (#748).
        const classified = classifySubmitError(error);

        if (classified.code !== "UNKNOWN") {
            logger.error(
                { requestId },
                "Submit signed tx error (classified)",
                error,
            );
            return setRateLimitHeaders(safeJsonResponse(
                {
                    success: false,
                    error: classified.message,
                    code: classified.code,
                    action: classified.action,
                    resultCodes: classified.resultCodes,
                    requestId,
                },
                { status: 400 },
            ), rate);
        }

        return setRateLimitHeaders(
            sanitizedErrorResponse(error, {
                requestId,
                status: 400,
                logMessage: "Submit signed tx error",
                extraFields: { success: false },
            }),
            rate,
        );
    }
}
