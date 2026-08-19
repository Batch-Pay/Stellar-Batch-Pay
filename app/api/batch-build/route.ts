/**
 * API route for building unsigned batch payment transactions.
 *
 * POST /api/batch-build
 *
 * Accepts { payments, network, publicKey } and returns an array of
 * unsigned transaction XDRs ready for client-side signing (e.g., Freighter).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  Asset as StellarAsset,
  Operation,
  Horizon,
  Memo,
  StrKey,
} from "stellar-sdk";
import { safeJsonResponse } from "@/lib/safe-json";
import { horizonUrl } from "@/lib/stellar/network-config";

import {
  BatchMemoConflictError,
  createBatches,
  estimateBatchTransactionSize,
  STELLAR_TRANSACTION_SIZE_LIMIT_BYTES,
} from "@/lib/stellar/batcher";
import { parseAsset } from "@/lib/stellar/utils";
import {
  validatePaymentInstruction,
  validatePaymentInstructions,
  validateMemo,
  buildBalancesMap,
  validateBalances,
} from "@/lib/stellar/validator";
import type {
  PaymentInstruction,
  HorizonBalance,
  BatchJobNetwork,
} from "@/lib/stellar/types";
import { getRecommendedFee } from "@/lib/stellar/fee-service";
import { MAX_UPLOAD_ROWS } from "@/lib/stellar/parser";
import { truncateMemoToBytes } from "@/lib/stellar/utils";
import { applyRateLimit, setRateLimitHeaders } from "@/lib/api-rate-limit";

interface RequestBody {
  payments: PaymentInstruction[];
  network: BatchJobNetwork;
  publicKey: string;
}

const MAX_OPS = 100;
const STROOPS_PER_XLM = 10_000_000;

async function fetchCurrentBaseReserveXlm(server: Horizon.Server): Promise<number | undefined> {
  try {
    const latestLedger = await server.ledgers().order("desc").limit(1).call();
    const record = latestLedger.records[0] as { base_reserve_in_stroops?: number | string } | undefined;
    if (!record?.base_reserve_in_stroops) return undefined;
    return Number(record.base_reserve_in_stroops) / STROOPS_PER_XLM;
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const rate = await applyRateLimit(request, "batch-build");
  if (rate.blocked) return rate.response!;

  try {
    const body = (await request.json()) as RequestBody;
    const { payments, network, publicKey } = body;

    // ── Validate inputs ──────────────────────────────────────────
    if (!publicKey || typeof publicKey !== "string") {
      return NextResponse.json(
        { error: "publicKey is required" },
        { status: 400 }
      );
    }

    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return NextResponse.json(
        { error: "Invalid Stellar public key checksum" },
        { status: 400 }
      );
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return NextResponse.json(
        { error: "payments must be a non-empty array" },
        { status: 400 }
      );
    }

    if (payments.length > MAX_UPLOAD_ROWS) {
      return NextResponse.json(
        { error: `Batch exceeds the maximum of ${MAX_UPLOAD_ROWS} payments per upload.` },
        { status: 400 }
      );
    }

    if (!["testnet", "mainnet"].includes(network)) {
      return NextResponse.json(
        { error: "network must be 'testnet' or 'mainnet'" },
        { status: 400 }
      );
    }

    const validation = validatePaymentInstructions(payments);
    if (!validation.valid) {
      const errors = Array.from(validation.errors.entries())
        .map(([idx, err]) => `Row ${idx + 1}: ${err}`)
        .slice(0, 5);
      return NextResponse.json(
        { error: `Invalid payment instructions: ${errors.join("; ")}` },
        { status: 400 }
      );
    }

    // ── Build unsigned XDRs ──────────────────────────────────────
    // #272: Horizon URL is env-configurable so deployments can point
    // at dedicated RPC providers; falls back to the public SDF node.
    const serverUrl = horizonUrl(network);
    const server = new Horizon.Server(serverUrl);

    const sourceAccount = await server.loadAccount(publicKey);

    // Validate source account has sufficient balance for all assets
    const balancesMap = buildBalancesMap(
      sourceAccount.balances as unknown as HorizonBalance[],
    );
    const reserveSource = sourceAccount as unknown as {
      subentry_count?: number | string;
      num_sponsoring?: number | string;
      num_sponsored?: number | string;
    };
    const balanceCheck = validateBalances(payments, balancesMap, undefined, MAX_OPS, {
      baseReserveXlm: await fetchCurrentBaseReserveXlm(server),
      subentryCount: Number(reserveSource.subentry_count ?? 0),
      numSponsoring: Number(reserveSource.num_sponsoring ?? 0),
      numSponsored: Number(reserveSource.num_sponsored ?? 0),
    });
    if (!balanceCheck.all_sufficient) {
      const insufficient = balanceCheck.checks
        .filter((c) => !c.sufficient)
        .map((c) => `${c.asset_key}: need ${c.required}, have ${c.available}`)
        .join("; ");
      return NextResponse.json(
        { error: `Insufficient balance: ${insufficient}` },
        { status: 400 },
      );
    }

    const dynamicFee = await getRecommendedFee(server);

    const batches = await createBatches(payments, MAX_OPS, {
      network,
      server,
    });

    const batchMeta = batches.map((batch) => {
      const estimatedBytes = estimateBatchTransactionSize(
        batch.payments,
        network,
        dynamicFee,
      );
      return {
        ops: batch.payments.length,
        estimatedBytes,
        byteSize: estimatedBytes,
      };
    });

    const networkPassphrase =
      network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;

    const xdrs: string[] = [];
    // #396: collect indices of rows skipped due to per-row validation failure.
    // #510: indices are the original 0-based positions in the request `payments`
    // array (mirrored from the parser's `rowIndex`), so duplicate rows resolve
    // to distinct positions instead of collapsing onto the first match.
    const omittedRows: number[] = [];
    // #510: map each omitted index to its validation reason for actionable 422s.
    const omittedReasons: Record<number, string> = {};

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // Use user-provided memo from the first payment that has one,
      // otherwise fall back to the system-generated tracking memo.
      // Stellar supports only one memo per transaction.
      const firstMemoPayment = batch.payments.find(p => p.memo);
      let memo: any;
      if (firstMemoPayment?.memo) {
        const memoType = firstMemoPayment.memoType ?? 'text';
        if (memoType === 'id') {
          const memoValidation = validateMemo(firstMemoPayment.memo, 'id');
          if (!memoValidation.valid) {
            return setRateLimitHeaders(
              NextResponse.json(
                { error: `Invalid memo ID at batch ${i}: ${memoValidation.error}` },
                { status: 400 },
              ),
              rate,
            );
          }
          memo = Memo.id(firstMemoPayment.memo);
        } else {
          memo = Memo.text(truncateMemoToBytes(firstMemoPayment.memo));
        }
      } else {
        const memoId = `bp-${Date.now()}-${i}`;
        memo = Memo.text(truncateMemoToBytes(memoId));
      }

      let builder = new TransactionBuilder(sourceAccount, {
        fee: String(dynamicFee),
        networkPassphrase,
      }).addMemo(memo);

      for (let pIdx = 0; pIdx < batch.payments.length; pIdx++) {
        const payment = batch.payments[pIdx];
        const pv = validatePaymentInstruction(payment);
        if (!pv.valid) {
          // #510: prefer the parser-assigned rowIndex so duplicate rows (same
          // address/amount/asset) map to the row that actually failed. indexOf
          // returns the first value-equal match, misreporting which CSV line was
          // skipped. Fall back to indexOf only for legacy payloads built without
          // a rowIndex.
          const originalIndex =
            typeof payment.rowIndex === "number"
              ? payment.rowIndex
              : payments.indexOf(payment);
          omittedRows.push(originalIndex);
          omittedReasons[originalIndex] = pv.error ?? "Failed per-row validation";
          continue;
        }

        const asset = parseAsset(payment.asset);
        const stellarAsset =
          asset.issuer === null
            ? StellarAsset.native()
            : new StellarAsset(asset.code, asset.issuer);

        builder = builder.addOperation(
          Operation.payment({
            destination: payment.address,
            asset: stellarAsset,
            amount: payment.amount,
          })
        );
      }

      const transaction = builder.setTimeout(300).build();
      xdrs.push(transaction.toXDR());

      // Increment sequence number for next transaction
      sourceAccount.incrementSequenceNumber();
    }

    // #396: if any rows were silently skipped, return 422 with the list of
    // omitted row indices so callers are never surprised by a short XDR.
    if (omittedRows.length > 0) {
      return setRateLimitHeaders(
        NextResponse.json(
          {
            error: "Some payment rows failed per-row validation and were omitted.",
            // #510: 0-based original row indices; duplicates resolve distinctly.
            omittedRows,
            // #510: per-index reason so callers can surface exactly what to fix.
            omittedReasons,
          },
          { status: 422 },
        ),
        rate,
      );
    }

    return setRateLimitHeaders(safeJsonResponse({
      xdrs,
      batchCount: batches.length,
      batchMeta,
      network,
      publicKey,
      estimatedFees: ((dynamicFee * payments.length) / 10_000_000).toFixed(7) + " XLM",
      maxTransactionBytes: STELLAR_TRANSACTION_SIZE_LIMIT_BYTES,
    }), rate);
  } catch (error) {
    console.error("Batch build error:", error);
    if (error instanceof BatchMemoConflictError) {
      return setRateLimitHeaders(safeJsonResponse(
        { error: error.message },
        { status: 400 },
      ), rate);
    }

    return setRateLimitHeaders(safeJsonResponse(
      {
        error:
          error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    ), rate);
  }
}
