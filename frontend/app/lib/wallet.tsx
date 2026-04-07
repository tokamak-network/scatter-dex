"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { getReadProvider } from "./provider";

const READ_PROVIDER = getReadProvider();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    ethereum?: ethers.Eip1193Provider & {
      on(event: string, handler: (...args: any[]) => void): void;
      removeListener(event: string, handler: (...args: any[]) => void): void;
    };
  }
}

interface WalletState {
  account: string | null;
  chainId: number | null;
  provider: ethers.BrowserProvider | null;
  readProvider: ethers.JsonRpcProvider | null;
  signer: ethers.Signer | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletCtx = createContext<WalletState>({
  account: null,
  chainId: null,
  provider: null,
  readProvider: null,
  signer: null,
  connect: async () => {},
  disconnect: () => {},
});

export function useWallet() {
  return useContext(WalletCtx);
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);

  const readProvider = READ_PROVIDER;

  const setupProvider = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) return;

    try {
      const bp = new ethers.BrowserProvider(window.ethereum);
      setProvider(bp);

      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts.length > 0) {
        setAccount(accounts[0]);
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
  }, []);

  useEffect(() => {
    setupProvider();

    if (typeof window !== "undefined" && window.ethereum) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length === 0) {
          setAccount(null);
          setSigner(null);
          setChainId(null);
        } else {
          setAccount(accounts[0]);
          setupProvider();
        }
      };
      const handleChainChanged = () => {
        setupProvider();
      };

      window.ethereum.on("accountsChanged", handleAccountsChanged);
      window.ethereum.on("chainChanged", handleChainChanged);

      return () => {
        window.ethereum?.removeListener("accountsChanged", handleAccountsChanged);
        window.ethereum?.removeListener("chainChanged", handleChainChanged);
      };
    }
  }, [setupProvider]);

  const connect = async () => {
    if (!window.ethereum) {
      console.error("MetaMask not found");
      return;
    }
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (accounts.length > 0) {
      await setupProvider();
    }
  };

  const disconnect = () => {
    setAccount(null);
    setSigner(null);
    setChainId(null);
  };

  return (
    <WalletCtx.Provider value={{ account, chainId, provider, readProvider, signer, connect, disconnect }}>
      {children}
    </WalletCtx.Provider>
  );
}
