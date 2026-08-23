"use client";

/**
 * Client-side wallet session management for authenticated batch read APIs.
 *
 * After the connected wallet signs a SEP-10 challenge, the server issues a
 * short-lived session token (also set as an HttpOnly cookie for SSE). This
 * module stores the bearer token for fetch calls and exposes helpers used by
 * dashboard polling/history adapters.
 */

const SESSION_STORAGE_KEY = "wallet_auth_session";

interface StoredWalletSession {
  publicKey: string;
  sessionToken: string;
  expiresAt: string;
}

export type WalletChallengeSigner = (
  challengeXdr: string,
  networkPassphrase: string,
) => Promise<string>;

function readStoredSession(): StoredWalletSession | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredWalletSession;
    if (
      !parsed.publicKey ||
      !parsed.sessionToken ||
      !parsed.expiresAt ||
      new Date(parsed.expiresAt).getTime() <= Date.now()
    ) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeStoredSession(session: StoredWalletSession): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearWalletSession(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

export function getWalletSessionToken(publicKey: string | null): string | null {
  if (!publicKey) return null;
  const stored = readStoredSession();
  if (!stored || stored.publicKey !== publicKey) return null;
  return stored.sessionToken;
}

export async function ensureWalletSession(
  publicKey: string,
  signChallenge: WalletChallengeSigner,
): Promise<string> {
  const existing = getWalletSessionToken(publicKey);
  if (existing) return existing;

  const challengeRes = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });

  if (!challengeRes.ok) {
    const body = await challengeRes.json().catch(() => ({}));
    throw new Error(body.error ?? "Failed to request wallet auth challenge");
  }

  const challenge = (await challengeRes.json()) as {
    challengeXdr: string;
    networkPassphrase: string;
  };

  const signedChallengeXdr = await signChallenge(
    challenge.challengeXdr,
    challenge.networkPassphrase,
  );

  const verifyRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ publicKey, signedChallengeXdr }),
  });

  if (!verifyRes.ok) {
    const body = await verifyRes.json().catch(() => ({}));
    throw new Error(body.error ?? "Wallet authentication failed");
  }

  const verified = (await verifyRes.json()) as {
    sessionToken: string;
    expiresAt: string;
    publicKey: string;
  };

  writeStoredSession({
    publicKey: verified.publicKey,
    sessionToken: verified.sessionToken,
    expiresAt: verified.expiresAt,
  });

  return verified.sessionToken;
}

export function withWalletAuthHeaders(
  publicKey: string | null,
  init: RequestInit = {},
): RequestInit {
  const token = getWalletSessionToken(publicKey);
  const headers = new Headers(init.headers ?? undefined);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return {
    ...init,
    headers,
    credentials: init.credentials ?? "include",
  };
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  publicKey: string | null,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(input, withWalletAuthHeaders(publicKey, init));
}
