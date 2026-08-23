"use client";

import { createContext, useContext, type ReactNode } from "react";
import {
  useWalletSession,
  type UseWalletSessionReturn,
} from "@/hooks/use-wallet-session";

const WalletSessionContext = createContext<UseWalletSessionReturn | null>(
  null,
);

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const value = useWalletSession();
  return (
    <WalletSessionContext.Provider value={value}>
      {children}
    </WalletSessionContext.Provider>
  );
}

export function useWalletSessionContext(): UseWalletSessionReturn {
  const context = useContext(WalletSessionContext);
  if (!context) {
    throw new Error(
      "useWalletSessionContext must be used within WalletSessionProvider",
    );
  }
  return context;
}

/** Returns null when rendered outside WalletSessionProvider (e.g. demo page). */
export function useOptionalWalletSession(): UseWalletSessionReturn | null {
  return useContext(WalletSessionContext);
}
