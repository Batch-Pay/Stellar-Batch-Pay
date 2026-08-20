/**
 * Wallet authentication for batch read/recover APIs.
 *
 * Uses a SEP-10-style challenge transaction that the connected wallet signs.
 * A successful verification issues a short-lived HMAC session token bound to
 * the wallet's G-address. Protected routes require that token (Bearer header
 * or HttpOnly cookie) and reject requests where publicKey alone is supplied.
 */

import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import {
  Keypair,
  Networks,
  StrKey,
  Transaction,
  WebAuth,
  xdr,
} from "stellar-sdk";
import type { NextRequest } from "next/server";
import { logger } from "@/lib/logger";

const DEFAULT_CHALLENGE_TIMEOUT_SEC = 300;
const DEFAULT_SESSION_TTL_SEC = 3600;
const SESSION_COOKIE_NAME = "wallet_session";
const DEV_FALLBACK_SECRET = "dev-wallet-auth-secret-do-not-use-in-production";

/** In-memory replay guard for consumed challenge envelopes (single-node). */
const consumedChallenges = new Map<string, number>();

export interface WalletAuthConfig {
  sessionSecret: string;
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  challengeTimeoutSec: number;
  sessionTtlSec: number;
}

export interface WalletAuthResult {
  valid: boolean;
  status?: 400 | 401 | 403;
  error?: string;
  publicKey?: string;
}

export interface WalletSessionPayload {
  sub: string;
  exp: number;
  iat: number;
  jti: string;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function pruneConsumedChallenges(now: number): void {
  for (const [hash, expiresAt] of consumedChallenges) {
    if (expiresAt <= now) {
      consumedChallenges.delete(hash);
    }
  }
}

function challengeFingerprint(signedChallengeXdr: string): string {
  return createHash("sha256").update(signedChallengeXdr).digest("hex");
}

function markChallengeConsumed(signedChallengeXdr: string, ttlSec: number): void {
  const now = Date.now();
  pruneConsumedChallenges(now);
  consumedChallenges.set(
    challengeFingerprint(signedChallengeXdr),
    now + ttlSec * 1000,
  );
}

function isChallengeConsumed(signedChallengeXdr: string): boolean {
  const now = Date.now();
  pruneConsumedChallenges(now);
  const expiresAt = consumedChallenges.get(challengeFingerprint(signedChallengeXdr));
  return expiresAt !== undefined && expiresAt > now;
}

function resolveSessionSecret(): string {
  const secret = process.env.WALLET_AUTH_SECRET?.trim();
  if (secret) return secret;

  if (process.env.NODE_ENV === "production") {
    logger.warn(
      {},
      "WALLET_AUTH_SECRET is not set. Using an insecure development fallback. " +
        "Configure WALLET_AUTH_SECRET in production (see DEPLOYMENT.md).",
    );
  }
  return DEV_FALLBACK_SECRET;
}

function resolveServerKeypair(sessionSecret: string): Keypair {
  const configured = process.env.WALLET_AUTH_SERVER_SECRET?.trim();
  if (configured) {
    return Keypair.fromSecret(configured);
  }

  const seed = createHash("sha256")
    .update(`${sessionSecret}:wallet-auth-server`)
    .digest();
  return Keypair.fromRawEd25519Seed(seed);
}

function resolveHomeDomain(): string {
  const configured = process.env.WALLET_AUTH_HOME_DOMAIN?.trim();
  if (configured) return configured;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (siteUrl) {
    try {
      return new URL(siteUrl).hostname;
    } catch {
      // fall through
    }
  }

  return "localhost";
}

function resolveNetworkPassphrase(): string {
  const configured = process.env.WALLET_AUTH_NETWORK_PASSPHRASE?.trim();
  if (configured) return configured;

  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv === "production" ? Networks.PUBLIC : Networks.TESTNET;
}

export function getWalletAuthConfig(): WalletAuthConfig {
  const sessionSecret = resolveSessionSecret();
  const challengeTimeoutSec = Math.max(
    60,
    parseInt(process.env.WALLET_AUTH_CHALLENGE_TIMEOUT_SEC ?? "", 10) ||
      DEFAULT_CHALLENGE_TIMEOUT_SEC,
  );
  const sessionTtlSec = Math.max(
    300,
    parseInt(process.env.WALLET_AUTH_SESSION_TTL_SEC ?? "", 10) ||
      DEFAULT_SESSION_TTL_SEC,
  );

  return {
    sessionSecret,
    serverKeypair: resolveServerKeypair(sessionSecret),
    homeDomain: resolveHomeDomain(),
    webAuthDomain:
      process.env.WALLET_AUTH_WEB_AUTH_DOMAIN?.trim() || "stellar-batch-pay",
    networkPassphrase: resolveNetworkPassphrase(),
    challengeTimeoutSec,
    sessionTtlSec,
  };
}

export function createWalletChallenge(publicKey: string): {
  challengeXdr: string;
  expiresAt: string;
  serverPublicKey: string;
  networkPassphrase: string;
} {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error("Invalid Stellar public key");
  }

  const config = getWalletAuthConfig();
  const challengeXdr = WebAuth.buildChallengeTx(
    config.serverKeypair,
    publicKey,
    config.homeDomain,
    config.challengeTimeoutSec,
    config.networkPassphrase,
    config.webAuthDomain,
  );

  const expiresAt = new Date(
    Date.now() + config.challengeTimeoutSec * 1000,
  ).toISOString();

  return {
    challengeXdr,
    expiresAt,
    serverPublicKey: config.serverKeypair.publicKey(),
    networkPassphrase: config.networkPassphrase,
  };
}

function signSessionToken(
  payload: WalletSessionPayload,
  secret: string,
): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(body).digest();
  return `${body}.${base64UrlEncode(sig)}`;
}

function parseSessionToken(token: string, secret: string): WalletSessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, sigPart] = parts;
  const expectedSig = createHmac("sha256", secret).update(body).digest();
  const providedSig = base64UrlDecode(sigPart);

  if (
    expectedSig.length !== providedSig.length ||
    !timingSafeEqual(expectedSig, providedSig)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(body).toString("utf8")) as WalletSessionPayload;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      typeof payload.jti !== "string"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function issueWalletSession(publicKey: string): {
  sessionToken: string;
  expiresAt: string;
} {
  const config = getWalletAuthConfig();
  const now = Math.floor(Date.now() / 1000);
  const payload: WalletSessionPayload = {
    sub: publicKey,
    iat: now,
    exp: now + config.sessionTtlSec,
    jti: randomBytes(16).toString("hex"),
  };

  return {
    sessionToken: signSessionToken(payload, config.sessionSecret),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export function verifySignedChallenge(
  signedChallengeXdr: string,
  expectedPublicKey: string,
): { valid: true; publicKey: string } | { valid: false; error: string } {
  if (!StrKey.isValidEd25519PublicKey(expectedPublicKey)) {
    return { valid: false, error: "Invalid Stellar public key" };
  }

  if (isChallengeConsumed(signedChallengeXdr)) {
    return { valid: false, error: "Challenge has already been used" };
  }

  const config = getWalletAuthConfig();

  try {
    const signers = WebAuth.verifyChallengeTxSigners(
      signedChallengeXdr,
      config.serverKeypair.publicKey(),
      config.networkPassphrase,
      [expectedPublicKey],
      config.homeDomain,
      config.webAuthDomain,
    );

    if (!signers.includes(expectedPublicKey)) {
      return {
        valid: false,
        error: "Signed challenge does not match the requested publicKey",
      };
    }

    markChallengeConsumed(signedChallengeXdr, config.challengeTimeoutSec);
    return { valid: true, publicKey: expectedPublicKey };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid signed challenge";
    return { valid: false, error: message };
  }
}

export function validateWalletSessionToken(
  token: string | null | undefined,
  expectedPublicKey?: string | null,
): WalletAuthResult {
  if (!token) {
    return {
      valid: false,
      status: 401,
      error:
        "Wallet authentication required. Sign the SEP-10 challenge via POST /api/auth/verify " +
        "and include the session token in Authorization: Bearer <token> or the wallet_session cookie.",
    };
  }

  const config = getWalletAuthConfig();
  const payload = parseSessionToken(token, config.sessionSecret);
  if (!payload) {
    return {
      valid: false,
      status: 401,
      error: "Invalid or malformed wallet session token",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return {
      valid: false,
      status: 401,
      error: "Wallet session token has expired. Re-authenticate via /api/auth/challenge.",
    };
  }

  if (expectedPublicKey && payload.sub !== expectedPublicKey) {
    return {
      valid: false,
      status: 403,
      error: "Session token publicKey does not match the requested publicKey",
    };
  }

  return { valid: true, publicKey: payload.sub };
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export function extractWalletSessionToken(request: NextRequest): string | null {
  const bearer = extractBearerToken(request.headers.get("authorization"));
  if (bearer) return bearer;

  return request.cookies.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Require a valid wallet session for batch read/recover routes.
 * publicKey remains a filter, but only after session verification.
 */
export function requireWalletAuth(
  request: NextRequest,
  publicKey: string | null,
): WalletAuthResult {
  if (!publicKey || !StrKey.isValidEd25519PublicKey(publicKey)) {
    return {
      valid: false,
      status: 400,
      error: "A valid publicKey query parameter is required",
    };
  }

  const token = extractWalletSessionToken(request);
  return validateWalletSessionToken(token, publicKey);
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function buildSessionCookie(
  sessionToken: string,
  expiresAt: string,
): string {
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";
  return (
    `${SESSION_COOKIE_NAME}=${sessionToken}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

/** Test helper: sign a server-issued challenge with a known keypair secret. */
export function signChallengeForTests(
  challengeXdr: string,
  clientSecret: string,
  networkPassphrase: string,
): string {
  const env = xdr.TransactionEnvelope.fromXDR(challengeXdr, "base64");
  const tx = new Transaction(env, networkPassphrase);
  tx.sign(Keypair.fromSecret(clientSecret));
  return tx.toEnvelope().toXDR("base64");
}

/** Test helper: create a valid session without going through the challenge flow. */
export function createTestWalletSession(publicKey: string): string {
  return issueWalletSession(publicKey).sessionToken;
}
