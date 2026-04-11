"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { getReadProvider } from "./provider";

const READ_PROVIDER = getReadProvider();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    ethereum?: ethers.Eip1193Provider & {
      on?(event: string, handler: (...args: any[]) => void): void;
      removeListener?(event: string, handler: (...args: any[]) => void): void;
      isMetaMask?: boolean;
      isCoinbaseWallet?: boolean;
      isRabby?: boolean;
    };
  }
}

/** Detected wallet provider info */
export interface WalletInfo {
  name: string;
  icon?: string;
  provider: ethers.Eip1193Provider;
}

interface WalletState {
  account: string | null;
  chainId: number | null;
  provider: ethers.BrowserProvider | null;
  readProvider: ethers.JsonRpcProvider | null;
  signer: ethers.Signer | null;
  walletName: string | null;
  availableWallets: WalletInfo[];
  connectError: string | null;
  connect: (walletProvider?: ethers.Eip1193Provider) => Promise<void>;
  disconnect: () => void;
}

const WalletCtx = createContext<WalletState>({
  account: null,
  chainId: null,
  provider: null,
  readProvider: null,
  signer: null,
  walletName: null,
  availableWallets: [],
  connectError: null,
  connect: async () => {},
  disconnect: () => {},
});

export function useWallet() {
  return useContext(WalletCtx);
}

/**
 * Detect available wallet providers in the browser.
 * Supports: MetaMask, Coinbase Wallet, Rabby, and any EIP-1193 provider.
 */
/**
 * Detect the wallet name from a provider's flags.
 * Check specific flags BEFORE isMetaMask — many wallets set isMetaMask=true
 * for compatibility (Rabby, Coinbase, etc.).
 */
function detectWalletName(provider: any): string {
  if (provider.isRabby) return "Rabby";
  if (provider.isCoinbaseWallet) return "Coinbase Wallet";
  if (provider.isMetaMask) return "MetaMask";
  return "Browser Wallet";
}

function detectWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.ethereum) return [];
  return [{ name: detectWalletName(window.ethereum), provider: window.ethereum }];
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<WalletInfo[]>([]);
  const [activeEip1193, setActiveEip1193] = useState<ethers.Eip1193Provider | null>(null);

  const readProvider = READ_PROVIDER;

  const setupProvider = useCallback(async (eip1193?: ethers.Eip1193Provider) => {
    const target = eip1193 || activeEip1193 || window.ethereum;
    if (!target) return;

    try {
      const bp = new ethers.BrowserProvider(target);
      setProvider(bp);

      const accounts = await target.request({ method: "eth_accounts" });
      if (accounts.length > 0) {
        setAccount(accounts[0]);
        setWalletName(detectWalletName(target));
        try {
          setSigner(await bp.getSigner());
        } catch (e) {
          console.error("Failed to get signer:", e);
          setSigner(null);
        }
        const network = await bp.getNetwork();
        setChainId(Number(network.chainId));
      }
    } catch (e) {
      console.error("Failed to setup provider:", e);
    }
  }, [activeEip1193]);

  // Detect available wallets on mount
  useEffect(() => {
    setAvailableWallets(detectWallets());
  }, []);

  // Listen for account/chain changes
  useEffect(() => {
    const eth = activeEip1193 || window.ethereum;
    if (typeof window === "undefined" || !eth) return;

    setupProvider();

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        setAccount(null);
        setSigner(null);
        setChainId(null);
        setWalletName(null);
      } else {
        setAccount(accounts[0]);
        setupProvider();
      }
    };
    const handleChainChanged = () => {
      setupProvider();
    };

    const anyEth = eth as any;
    anyEth.on?.("accountsChanged", handleAccountsChanged);
    anyEth.on?.("chainChanged", handleChainChanged);

    return () => {
      anyEth.removeListener?.("accountsChanged", handleAccountsChanged);
      anyEth.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [setupProvider, activeEip1193]);

  /** Error message when no wallet is detected (rendered by UI layer) */
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async (walletProvider?: ethers.Eip1193Provider) => {
    const target = walletProvider || window.ethereum;
    if (!target) {
      setConnectError("No wallet detected. Install MetaMask, Coinbase Wallet, or Rabby.");
      return;
    }
    setConnectError(null);

    try {
      const accounts = await target.request({ method: "eth_requestAccounts" });
      if (accounts.length > 0) {
        setActiveEip1193(target);
        await setupProvider(target);
      }
    } catch (e) {
      console.warn("Wallet connection rejected:", e);
      // Don't set activeEip1193/walletName on failure
    }
  };

  const disconnect = () => {
    setAccount(null);
    setSigner(null);
    setChainId(null);
    setWalletName(null);
    setActiveEip1193(null);
  };

  return (
    <WalletCtx.Provider value={{
      account, chainId, provider, readProvider, signer,
      walletName, availableWallets, connectError, connect, disconnect,
    }}>
      {children}
    </WalletCtx.Provider>
  );
}
