"use client";

import { useState, useEffect, useCallback } from "react";
import {
    isConnected as freighterIsConnected,
    getNetwork,
    requestAccess,
    signTransaction,
} from "@stellar/freighter-api";

export interface UseFreighterReturn {
    /** The connected wallet's public key, or null */
    publicKey: string | null;
    /** Whether we are currently connecting */
    isConnecting: boolean;
    /** Whether Freighter extension is installed */
    isInstalled: boolean | null;
    /** Latest Freighter network passphrase, if available */
    networkPassphrase: string | null;
    /** Last error message */
    error: string | null;
    /** Connect to Freighter and request access */
    connect: () => Promise<void>;
    /** Clear local state (disconnect) */
    disconnect: () => void;
    /** Refresh the currently selected wallet network */
    refreshNetwork: () => Promise<void>;
    /** Sign a transaction XDR via Freighter */
    signTx: (
        xdr: string,
        network: "testnet" | "mainnet" | "futurenet",
    ) => Promise<string>;
}

export function useFreighter(): UseFreighterReturn {
    const [publicKey, setPublicKey] = useState<string | null>(null);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isInstalled, setIsInstalled] = useState<boolean | null>(null);
    const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Check if Freighter is installed on mount
    useEffect(() => {
        let cancelled = false;

        const check = async () => {
            try {
                const result = await freighterIsConnected();
                if (!cancelled) {
                    setIsInstalled(result.isConnected);
                }
            } catch {
                if (!cancelled) {
                    setIsInstalled(false);
                }
            }
        };

        check();
        return () => {
            cancelled = true;
        };
    }, []);

    const refreshNetwork = useCallback(async () => {
        try {
            const result = await getNetwork();
            if (result.error) {
                throw new Error(result.error);
            }

            setNetworkPassphrase(result.networkPassphrase || null);
        } catch {
            setNetworkPassphrase(null);
        }
    }, []);

    useEffect(() => {
        const handleFocus = () => {
            if (publicKey) {
                void refreshNetwork();
            }
        };

        window.addEventListener("focus", handleFocus);
        return () => window.removeEventListener("focus", handleFocus);
    }, [publicKey, refreshNetwork]);

    const connect = useCallback(async () => {
        setError(null);
        setIsConnecting(true);

        try {
            const accessResult = await requestAccess();
            if (accessResult.error) {
                throw new Error(accessResult.error);
            }
            setPublicKey(accessResult.address);
            await refreshNetwork();
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to connect to Freighter";
            setError(message);
            setPublicKey(null);
        } finally {
            setIsConnecting(false);
        }
    }, []);

    const disconnect = useCallback(() => {
        setPublicKey(null);
        setNetworkPassphrase(null);
        setError(null);
    }, []);

    const signTx = useCallback(
        async (xdr: string, network: "testnet" | "mainnet" | "futurenet"): Promise<string> => {
            if (!publicKey) {
                throw new Error("Wallet not connected");
            }

            const networkPassphrase =
                network === "testnet"
                    ? "Test SDF Network ; September 2015"
                    : network === "futurenet"
                      ? "Test SDF Future Network ; September 2015"
                      : "Public Global Stellar Network ; September 2015";

            const result = await signTransaction(xdr, {
                networkPassphrase,
            });

            if (result.error) {
                throw new Error(result.error);
            }

            return result.signedTxXdr;
        },
        [publicKey],
    );

    return {
        publicKey,
        isConnecting,
        isInstalled,
        networkPassphrase,
        error,
        connect,
        disconnect,
        refreshNetwork,
        signTx,
    };
}
