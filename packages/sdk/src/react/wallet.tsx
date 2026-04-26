"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  /** Last error from a `connect()` attempt — covers both the
   *  "no wallet detected" case and user rejections. */
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

  // Tracks lifecycle so async refreshes can no-op after unmount and
  // avoid React's "setState on unmounted component" warnings.
  const mountedRef = useRef(true);

  /** Hydrate wallet state from the injected provider. Accepts a
   *  preFetched accounts list so callers that already received it
   *  (e.g. the `accountsChanged` event) don't pay an extra
   *  `eth_accounts` round-trip. An empty/missing accounts list is
   *  treated as "now disconnected" and clears stale state — important
   *  when a previously-connected wallet gets locked or revokes. */
  const refreshFromInjected = useCallback(
    async (preFetchedAccounts?: readonly string[]) => {
      const eth = injectedFromWindow();
      if (!eth) return;
      try {
        const bp = new ethers.BrowserProvider(eth);
        const accounts =
          preFetchedAccounts ??
          ((await eth.request({ method: "eth_accounts" })) as string[]);

        if (accounts.length === 0) {
          // Disconnect path — clear everything so a previously connected
          // session doesn't leave stale signer/account behind.
          if (!mountedRef.current) return;
          setProvider(null);
          setAccount(null);
          setSigner(null);
          setChainId(null);
          setWalletName(null);
          return;
        }

        if (!mountedRef.current) return;
        setProvider(bp);
        setAccount(accounts[0]!.toLowerCase());
        setWalletName(detectWalletName(eth));

        let nextSigner: ethers.Signer | null = null;
        try {
          nextSigner = await bp.getSigner();
        } catch {
          nextSigner = null;
        }
        if (!mountedRef.current) return;
        setSigner(nextSigner);

        const net = await bp.getNetwork();
        if (!mountedRef.current) return;
        setChainId(Number(net.chainId));
      } catch (e) {
        console.error("[wallet] refreshFromInjected failed:", e);
      }
    },
    [],
  );

  // Track mount lifecycle. Set false on unmount so any in-flight
  // promise from refreshFromInjected skips the setState calls.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate from any pre-authorized session and subscribe to wallet
  // events. Re-runs on `injectionTick` so a wallet that injects late
  // (e.g. extension still booting at first paint) still gets wired
  // up once it dispatches the `ethereum#initialized` window event.
  const [injectionTick, setInjectionTick] = useState(0);
  useEffect(() => {
    const eth = injectedFromWindow();
    if (!eth) return;

    refreshFromInjected();

    const handleAccountsChanged = (accounts: unknown) => {
      // Forward the array straight to the refresher so it doesn't
      // need to re-query eth_accounts; empty array drops state.
      refreshFromInjected((accounts as string[]) ?? []);
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
  }, [refreshFromInjected, injectionTick]);

  // Late-injection bootstrap. Some extensions inject `window.ethereum`
  // after React mounts and dispatch `ethereum#initialized` when they
  // do; bumping injectionTick re-runs the subscription effect above.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onInitialized = () => setInjectionTick((n) => n + 1);
    window.addEventListener("ethereum#initialized", onInitialized, { once: true });
    return () => window.removeEventListener("ethereum#initialized", onInitialized);
  }, []);

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
        await refreshFromInjected(accounts);
      }
    } catch (e) {
      // EIP-1193 user-rejection is code 4001 but other shapes exist;
      // surface a friendly message and keep the original on console
      // for debugging.
      console.warn("[wallet] connect rejected:", e);
      const msg =
        (e as { message?: string })?.message ?? "Wallet connection failed.";
      setConnectError(msg);
    }
  }, [refreshFromInjected]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setSigner(null);
    setChainId(null);
    setWalletName(null);
    setProvider(null);
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
