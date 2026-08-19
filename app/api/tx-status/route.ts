/**
 * API route for checking a transaction's status on the Stellar network.
 *
 * GET /api/tx-status?hash=<txHash>&network=<testnet|mainnet>
 *
 * Queries Horizon for the transaction and returns its current state.
 * Useful when a submission times out and the user needs to verify
 * whether the transaction actually landed on-ledger.
 */

import { NextRequest, NextResponse } from "next/server";
import { Horizon } from "stellar-sdk";
import { horizonUrl } from "@/lib/stellar/network-config";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

export async function GET(request: NextRequest) {
  const rate = await applyRateLimit(request, "tx-status");
  if (rate.blocked) return rate.response!;

  const { searchParams } = request.nextUrl;
  const hash = searchParams.get("hash");
  const network = searchParams.get("network");

  if (!hash || typeof hash !== "string") {
    return NextResponse.json(
      { error: "Missing required query parameter: hash" },
      { status: 400 },
    );
  }

  if (network !== "testnet" && network !== "mainnet") {
    return NextResponse.json(
      { error: "network must be 'testnet' or 'mainnet'" },
      { status: 400 },
    );
  }

  const server = new Horizon.Server(horizonUrl(network));

  try {
    const tx = await server.transactions().transaction(hash).call();

    return setRateLimitHeaders(
      NextResponse.json({
        found: true,
        hash: tx.hash,
        successful: tx.successful,
        ledger: tx.ledger_attr,
        createdAt: tx.created_at,
        operationCount: tx.operation_count,
        sourceAccount: tx.source_account,
      }),
      rate,
    );
  } catch (error: unknown) {
    // Horizon returns 404 when the transaction doesn't exist
    const isNotFound =
      error &&
      typeof error === "object" &&
      "response" in error &&
      (error as { response?: { status?: number } }).response?.status === 404;

    if (isNotFound) {
      return setRateLimitHeaders(
        NextResponse.json({
          found: false,
          hash,
          message:
            "Transaction not found on the network. It may have expired or was never submitted successfully.",
        }),
        rate,
      );
    }

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to query transaction status",
      },
      { status: 500 },
    );
  }
}
