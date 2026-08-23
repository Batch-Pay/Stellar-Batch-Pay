"use client";

import { useCallback, useEffect, useState } from "react";
import { signTransaction } from "@stellar/freighter-api";
import { useWalletConnection } from "@/contexts/WalletContext";
import {
  clearWalletSession,
  ensureWalletSession,
  getWalletSessionToken,
  type WalletChallengeSigner,
} from "@/lib/wallet-session-client";

export interface UseWalletSessionReturn {
  sessionToken: string | null;
  isAuthenticating: boolean;
  authError: string | null;
  ensureSession: () => Promise<string | null>;
}

/**
 * Keeps a short-lived wallet session in sync with the connected account.
 * Dashboard polling/history callers should await ensureSession() before
 * hitting protected /api/batch-* read routes.
 */
export function useWalletSession(): UseWalletSessionReturn {
  const { publicKey } = useWalletConnection();
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const signChallenge = useCallback<WalletChallengeSigner>(
    async (challengeXdr, networkPassphrase) => {
      const result = await signTransaction(challengeXdr, { networkPassphrase });
      if (result.error) {
        throw new Error(result.error);
      }
      return result.signedTxXdr;
    },
    [],
  );

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!publicKey) {
      setSessionToken(null);
      return null;
    }

    const cached = getWalletSessionToken(publicKey);
    if (cached) {
      setSessionToken(cached);
      return cached;
    }

    setIsAuthenticating(true);
    setAuthError(null);

    try {
      const token = await ensureWalletSession(publicKey, signChallenge);
      setSessionToken(token);
      return token;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Wallet authentication failed";
      setAuthError(message);
      setSessionToken(null);
      return null;
    } finally {
      setIsAuthenticating(false);
    }
  }, [publicKey, signChallenge]);

  useEffect(() => {
    if (!publicKey) {
      clearWalletSession();
      setSessionToken(null);
      setAuthError(null);
      return;
    }

    void ensureSession();
  }, [publicKey, ensureSession]);

  return {
    sessionToken,
    isAuthenticating,
    authError,
    ensureSession,
  };
}
