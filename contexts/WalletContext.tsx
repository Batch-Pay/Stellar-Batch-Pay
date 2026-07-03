"use client";

import React, { createContext, useContext, useCallback, useEffect, useState } from "react";
import { useStellarWallet, SigningMethod } from "@/hooks/use-stellar-wallet";
import { useFreighter } from "@/hooks/use-freighter";
import { Sep7Modal } from "@/components/dashboard/Sep7Modal";
import { Networks } from "stellar-sdk";
import { isMobileDevice } from "@/lib/stellar/sep7";

export type SorobanNetwork = "mainnet" | "testnet" | "futurenet";

export interface WalletConnectionContextType {
  publicKey: string | null;
  isConnecting: boolean;
  isInstalled: boolean | null;
  error: string | null;
  network: SorobanNetwork | null;
  networkMismatch: boolean;
  expectedNetwork: SorobanNetwork;
  method: SigningMethod | null;
  sep7Uri: string | null;
  isSep7ModalOpen: boolean;
  ledger: ReturnType<typeof import("@/hooks/use-ledger").useLedger>;
}

export interface WalletActionsContextType {
  connect: () => Promise<void>;
  disconnect: () => void;
  signTx: (xdr: string, network: SorobanNetwork) => Promise<string>;
  selectNetwork: (network: SorobanNetwork) => void;
  setSep7ModalOpen: (open: boolean) => void;
  connectLedger: () => Promise<void>;
}

const WalletConnectionContext = createContext<WalletConnectionContextType | undefined>(undefined);
const WalletActionsContext = createContext<WalletActionsContextType | undefined>(undefined);

export interface WalletProviderProps {
  children: React.ReactNode;
  expectedNetwork?: SorobanNetwork;
}

export function WalletProvider({ children, expectedNetwork = "testnet" }: WalletProviderProps) {
  const wallet = useStellarWallet();
  const freighter = useFreighter();
  const [selectedNetwork, setSelectedNetwork] = useState<SorobanNetwork>(expectedNetwork);
  const [detectedNetwork, setDetectedNetwork] = useState<SorobanNetwork | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  const normalizeDetectedNetwork = useCallback((networkPassphrase: string | null): SorobanNetwork | null => {
    if (!networkPassphrase) {
      return wallet.method === "ledger" ? selectedNetwork : null;
    }

    if (networkPassphrase === Networks.TESTNET) return "testnet";
    if (networkPassphrase === Networks.PUBLIC) return "mainnet";
    if (networkPassphrase.toLowerCase().includes("future")) return "futurenet";

    return null;
  }, [selectedNetwork, wallet.method]);

  // Restore network from localStorage on mount
  useEffect(() => {
    const storedNetwork = (localStorage.getItem("wallet_network") as SorobanNetwork) || expectedNetwork;
    setSelectedNetwork(storedNetwork);
  }, [expectedNetwork]);

  // Detect network 
  useEffect(() => {
    if (wallet.publicKey) {
      const liveNetwork = normalizeDetectedNetwork(wallet.networkPassphrase);
      setDetectedNetwork(liveNetwork);
      setNetworkMismatch(liveNetwork !== selectedNetwork);
      localStorage.setItem("wallet_public_key", wallet.publicKey);
    } else {
      setDetectedNetwork(null);
      setNetworkMismatch(false);
      localStorage.removeItem("wallet_public_key");
    }
  }, [wallet.publicKey, wallet.networkPassphrase, selectedNetwork, expectedNetwork, normalizeDetectedNetwork]);

  const handleConnect = useCallback(async () => {
    try {
      await wallet.connect();
      localStorage.setItem("wallet_network", selectedNetwork);
    } catch (err) {
      console.error("Failed to connect wallet:", err);
    }
  }, [wallet, selectedNetwork]);

  const handleConnectLedger = useCallback(async () => {
    try {
      setLedgerError(null);
      await wallet.connectLedger();
      localStorage.setItem("wallet_network", selectedNetwork);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to connect Ledger";
      setLedgerError(errorMsg);
      console.error("Failed to connect Ledger:", err);
    }
  }, [wallet, selectedNetwork]);

  const handleDisconnect = useCallback(() => {
    wallet.disconnect();
    localStorage.removeItem("wallet_public_key");
    localStorage.removeItem("wallet_network");
    sessionStorage.removeItem("new_batch_state");
    setLedgerError(null);
  }, [wallet]);

  const handleSelectNetwork = useCallback((network: SorobanNetwork) => {
    setSelectedNetwork(network);
    localStorage.setItem("wallet_network", network);
  }, []);

  const handleSignTx = useCallback(
    async (xdr: string, network: SorobanNetwork): Promise<string> => {
      return wallet.signTx(xdr, network);
    },
    [wallet]
  );

  // On mobile, SEP-7 deep-linking is always viable so treat as installed.
  // On desktop, reflect real Freighter extension detection from useFreighter.
  const isInstalled = isMobileDevice() ? true : freighter.isInstalled;

  const connectionValue = React.useMemo<WalletConnectionContextType>(() => ({
    publicKey: wallet.publicKey,
    isConnecting: wallet.isConnecting,
    isInstalled,
    error: ledgerError,
    network: detectedNetwork,
    networkMismatch,
    expectedNetwork: selectedNetwork,
    method: wallet.method,
    sep7Uri: wallet.sep7Uri,
    isSep7ModalOpen: wallet.isSep7ModalOpen,
    ledger: wallet.ledger,
  }), [
    wallet.publicKey,
    wallet.isConnecting,
    isInstalled,
    ledgerError,
    detectedNetwork,
    networkMismatch,
    selectedNetwork,
    wallet.method,
    wallet.sep7Uri,
    wallet.isSep7ModalOpen,
    wallet.ledger,
  ]);

  const actionsValue = React.useMemo<WalletActionsContextType>(() => ({
    connect: handleConnect,
    disconnect: handleDisconnect,
    signTx: handleSignTx,
    selectNetwork: handleSelectNetwork,
    setSep7ModalOpen: wallet.setSep7ModalOpen,
    connectLedger: handleConnectLedger,
  }), [
    handleConnect,
    handleDisconnect,
    handleSignTx,
    handleSelectNetwork,
    wallet.setSep7ModalOpen,
    handleConnectLedger,
  ]);

  return (
    <WalletConnectionContext.Provider value={connectionValue}>
      <WalletActionsContext.Provider value={actionsValue}>
        {children}
        <Sep7Modal
          isOpen={wallet.isSep7ModalOpen}
          onOpenChange={wallet.setSep7ModalOpen}
          uri={wallet.sep7Uri}
        />
      </WalletActionsContext.Provider>
    </WalletConnectionContext.Provider>
  );
}

export type WalletContextType = WalletConnectionContextType & WalletActionsContextType;

export function useWalletConnection(): WalletConnectionContextType {
  const context = useContext(WalletConnectionContext);
  if (context === undefined) {
    throw new Error("useWalletConnection must be used within a WalletProvider");
  }
  return context;
}

export function useWalletActions(): WalletActionsContextType {
  const context = useContext(WalletActionsContext);
  if (context === undefined) {
    throw new Error("useWalletActions must be used within a WalletProvider");
  }
  return context;
}

export function useWallet(): WalletContextType {
  const connection = useContext(WalletConnectionContext);
  const actions = useContext(WalletActionsContext);
  if (connection === undefined || actions === undefined) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return React.useMemo(() => ({ ...connection, ...actions }), [connection, actions]);
}
