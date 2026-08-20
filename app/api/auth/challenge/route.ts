/**
 * POST /api/auth/challenge
 *
 * Issues a SEP-10-style challenge transaction for the requested wallet.
 * The client signs the returned XDR with Freighter (or another wallet) and
 * submits it to POST /api/auth/verify to obtain a short-lived session token.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "stellar-sdk";
import { createWalletChallenge } from "@/lib/wallet-auth";

export async function POST(request: NextRequest) {
  let body: { publicKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const publicKey = body.publicKey;
  if (!publicKey || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json(
      { error: "A valid publicKey is required" },
      { status: 400 },
    );
  }

  try {
    const challenge = createWalletChallenge(publicKey);
    return NextResponse.json(challenge);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create challenge";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
