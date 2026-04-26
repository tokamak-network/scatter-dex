"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ethers } from "ethers";
import type { NetworkConfig } from "../core/network";
import { getReadProvider } from "../core/provider";

/** Subset of EIP-1193 provider that wallets expose, plus the vendor
 *  flags that let us label the connected wallet. Apps that augment
 *  `window.ethereum` types themselves can rely on those; the SDK
 *  works with this minimal shape. */
type InjectedProvider = ethers.Eip1193Provider & {
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  isRabby?: boolean;
};

function injectedFromWindow(): InjectedProvider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: InjectedProvider }).ethereum;
}

/** Vendor-flag-based label for a connected wallet. Checks specific
 *  flags before `isMetaMask` because many wallets (Rabby, Coinbase…)
 *  set `isMetaMask=true` for compatibility. */
function detectWalletName(provider: ethers.Eip1193Provider): string {
  const flags = provider as InjectedProvider;
  if (flags.isRabby) return "Rabby";
  if (flags.isCoinbaseWallet) return "Coinbase Wallet";
  if (flags.isMetaMask) return "MetaMask";
  return "Browser Wallet";
}

export interface WalletState {
  /** Connected EOA, lowercased. Null when disconnected. */
  account: string | null;
  /** Chain id reported by the wallet. May differ from
   *  `network.chainId` while the user is on the wrong chain. */
  chainId: number | null;
  /** Wallet-backed signer for transactions. Null when disconnected. */
  signer: ethers.Signer | null;
  /** Browser provider wrapping the wallet's EIP-1193. */
  provider: ethers.BrowserProvider | null;
  /** Read-only RPC provider built from `network.rpcUrl`.
   *  Always available regardless of wallet state. */
  readProvider: ethers.JsonRpcProvider;
  /** Best-effort wallet vendor name; null when disconnected. */
  walletName: string | null;
  /** Last error from a `connect()` attempt (e.g. "no wallet"). */
  connectError: string | null;
  /** Trigger the wallet's account-request flow. */
  connect: () => Promise<void>;
  /** Drop the connected account from app state. (Most wallets don't
   *  expose a programmatic disconnect; this clears local state only.) */
  disconnect: () => void;
}

const WalletCtx = createContext<WalletState | null>(null);

/** Read the wallet state. Throws when called outside a
 *  `<WalletProvider>` so missing-provider mistakes surface
 *  immediately instead of silently degrading. */
export function useWallet(): WalletState {
  const ctx = useContext(WalletCtx);
  if (!ctx) {
    throw new Error("useWallet must be used inside <WalletProvider>");
  }
  return ctx;
}

interface WalletProviderProps {
  /** The network this app talks to. Used to build the read provider
   *  and (later) to gate features when the wallet is on the wrong
   *  chain. The SDK never reads env directly; pass it from the host. */
  network: NetworkConfig;
  children: React.ReactNode;
}

export function WalletProvider({ network, children }: WalletProviderProps) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [provider, setProvider] = useState<ethers.BrowserProvider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Cache one read provider per rpcUrl so component re-renders don't
  // churn JsonRpcProvider instances (each opens its own keep-alive).
  const readProvider = useMemo(() => getReadProvider(network.rpcUrl), [network.rpcUrl]);

  const refreshFromInjected = useCallback(async () => {
    const eth = injectedFromWindow();
    if (!eth) return;
    try {
      const bp = new ethers.BrowserProvider(eth);
      setProvider(bp);
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      if (accounts.length === 0) return;
      setAccount(accounts[0]!.toLowerCase());
      setWalletName(detectWalletName(eth));
      try {
        setSigner(await bp.getSigner());
      } catch {
        setSigner(null);
      }
      const net = await bp.getNetwork();
      setChainId(Number(net.chainId));
    } catch (e) {
      console.error("[wallet] refreshFromInjected failed:", e);
    }
  }, []);

  // Eagerly hydrate from any pre-authorized session and subscribe to
  // wallet events. Cleanup removes listeners so re-renders don't pile
  // up handlers on the injected provider.
  useEffect(() => {
    const eth = injectedFromWindow();
    if (!eth) return;

    refreshFromInjected();

    const handleAccountsChanged = (accounts: unknown) => {
      const list = accounts as string[];
      if (list.length === 0) {
        setAccount(null);
        setSigner(null);
        setChainId(null);
        setWalletName(null);
        return;
      }
      setAccount(list[0]!.toLowerCase());
      refreshFromInjected();
    };
    const handleChainChanged = () => {
      refreshFromInjected();
    };

    eth.on?.("accountsChanged", handleAccountsChanged);
    eth.on?.("chainChanged", handleChainChanged);

    return () => {
      eth.removeListener?.("accountsChanged", handleAccountsChanged);
      eth.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [refreshFromInjected]);

  const connect = useCallback(async () => {
    const eth = injectedFromWindow();
    if (!eth) {
      setConnectError(
        "No wallet detected. Install MetaMask, Coinbase Wallet, or Rabby.",
      );
      return;
    }
    setConnectError(null);
    try {
      const accounts = (await eth.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (accounts.length > 0) {
        await refreshFromInjected();
      }
    } catch (e) {
      // User-rejected requests are the common case — log quietly.
      console.warn("[wallet] connect rejected:", e);
    }
  }, [refreshFromInjected]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setSigner(null);
    setChainId(null);
    setWalletName(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      account,
      chainId,
      provider,
      signer,
      readProvider,
      walletName,
      connectError,
      connect,
      disconnect,
    }),
    [
      account,
      chainId,
      provider,
      signer,
      readProvider,
      walletName,
      connectError,
      connect,
      disconnect,
    ],
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

/** Truncated address helper for display (`0xabcd…1234`). Returns
 *  empty string for empty input so callers can chain without guards. */
export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "";
  const a = addr.trim();
  if (a.length < 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
