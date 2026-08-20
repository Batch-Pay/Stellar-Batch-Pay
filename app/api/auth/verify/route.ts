/**
 * POST /api/auth/verify
 *
 * Verifies a wallet-signed SEP-10 challenge and issues a short-lived session
 * token. The token is returned in the JSON body and set as an HttpOnly cookie
 * scoped to /api so SSE (EventSource) requests inherit it automatically.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "stellar-sdk";
import {
  buildSessionCookie,
  issueWalletSession,
  verifySignedChallenge,
} from "@/lib/wallet-auth";

export async function POST(request: NextRequest) {
  let body: { publicKey?: string; signedChallengeXdr?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { publicKey, signedChallengeXdr } = body;

  if (!publicKey || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json(
      { error: "A valid publicKey is required" },
      { status: 400 },
    );
  }

  if (!signedChallengeXdr || typeof signedChallengeXdr !== "string") {
    return NextResponse.json(
      { error: "signedChallengeXdr is required" },
      { status: 400 },
    );
  }

  const verification = verifySignedChallenge(signedChallengeXdr, publicKey);
  if (!verification.valid) {
    return NextResponse.json({ error: verification.error }, { status: 401 });
  }

  const session = issueWalletSession(publicKey);
  const response = NextResponse.json({
    sessionToken: session.sessionToken,
    expiresAt: session.expiresAt,
    publicKey,
  });

  response.headers.set(
    "Set-Cookie",
    buildSessionCookie(session.sessionToken, session.expiresAt),
  );

  return response;
}
