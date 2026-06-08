"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { getReadProvider } from "./provider";
import { EXPECTED_CHAIN_ID, RPC_URL, getChainName } from "./config";

const READ_PROVIDER = getReadProvider();

declare global {
   
  interface Window {
    ethereum?: ethers.Eip1193Provider & {
      on?(event: string, handler: (...args: unknown[]) => void): void;
      removeListener?(event: string, handler: (...args: unknown[]) => void): void;
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
  /**
   * True when a wallet is connected but its active chain differs from the
   * deployment's EXPECTED_CHAIN_ID. Reads always come from the fixed RPC
   * (EXPECTED_CHAIN_ID); writes go through the wallet's current chain. When
   * these diverge the app would silently read one chain and write another,
   * so write paths must guard on this flag (see `useChainGuard`).
   */
  isWrongNetwork: boolean;
  provider: ethers.BrowserProvider | null;
  readProvider: ethers.JsonRpcProvider | null;
  signer: ethers.Signer | null;
  walletName: string | null;
  availableWallets: WalletInfo[];
  connectError: string | null;
  connect: (walletProvider?: ethers.Eip1193Provider) => Promise<void>;
  disconnect: () => void;
  /** Prompt the wallet to switch to EXPECTED_CHAIN_ID (adds it if unknown). */
  switchNetwork: () => Promise<void>;
}

const WalletCtx = createContext<WalletState>({
  account: null,
  chainId: null,
  isWrongNetwork: false,
  provider: null,
  readProvider: null,
  signer: null,
  walletName: null,
  availableWallets: [],
  connectError: null,
  connect: async () => {},
  disconnect: () => {},
  switchNetwork: async () => {},
});

export function useWallet() {
  return useContext(WalletCtx);
}

/** User-facing message for a wallet on the wrong chain. */
const WRONG_NETWORK_MESSAGE =
  `Wrong network — switch your wallet to ${getChainName(EXPECTED_CHAIN_ID)} (${EXPECTED_CHAIN_ID}) before continuing.`;

/**
 * Guard hook for write paths. Returns an async function that resolves to true
 * when the wallet is on EXPECTED_CHAIN_ID; otherwise it reports the mismatch
 * via `onError`, kicks off a network switch, and resolves false so the caller
 * aborts the transaction. This prevents the read-chain / write-chain
 * divergence described on `WalletState.isWrongNetwork` — reads come from the
 * fixed RPC, so a write on a different wallet chain would land elsewhere.
 *
 * Usage at the top of any write handler:
 *   const guardChain = useChainGuard();
 *   ...
 *   if (!(await guardChain(setError))) return;
 */
export function useChainGuard(): (onError: (msg: string) => void) => Promise<boolean> {
  const { chainId, switchNetwork } = useWallet();
  return useCallback(async (onError: (msg: string) => void) => {
    if (chainId === EXPECTED_CHAIN_ID) return true;
    onError(WRONG_NETWORK_MESSAGE);
    await switchNetwork();
    return false;
  }, [chainId, switchNetwork]);
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
type InjectedProvider = NonNullable<Window["ethereum"]>;

function detectWalletName(provider: ethers.Eip1193Provider): string {
  // The wallet vendor flags (isRabby / isMetaMask / isCoinbaseWallet) are
  // declared on Window["ethereum"] above; narrow to that augmented shape.
  const flags = provider as InjectedProvider;
  if (flags.isRabby) return "Rabby";
  if (flags.isCoinbaseWallet) return "Coinbase Wallet";
  if (flags.isMetaMask) return "MetaMask";
  return "Browser Wallet";
}

function detectWallets(): WalletInfo[] {
  if (typeof window === "undefined" || !window.ethereum) return [];
  return [{ name: detectWalletName(window.ethereum), provider: window.ethereum }];
}

/**
 * Dig the numeric EIP-1193 error code out of a thrown value. ethers v6 wraps
 * provider errors ("could not coalesce error"), so the original `.code` can be
 * nested under `error`, `data.originalError`, or `info.error`. Returns
 * undefined when no numeric code is present.
 */
function extractRpcErrorCode(e: unknown): number | undefined {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const obj = cur as Record<string, unknown>;
    if (typeof obj.code === "number") return obj.code;
    cur = obj.error ?? (obj.data as Record<string, unknown> | undefined)?.originalError ?? (obj.info as Record<string, unknown> | undefined)?.error;
  }
  return undefined;
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

    const ethEmitter = eth as InjectedProvider;
    ethEmitter.on?.("accountsChanged", handleAccountsChanged as (...args: unknown[]) => void);
    ethEmitter.on?.("chainChanged", handleChainChanged);

    return () => {
      ethEmitter.removeListener?.("accountsChanged", handleAccountsChanged as (...args: unknown[]) => void);
      ethEmitter.removeListener?.("chainChanged", handleChainChanged);
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

  // Ask the wallet to switch to EXPECTED_CHAIN_ID. If the chain is unknown to
  // the wallet (EIP-1193 error 4902) we add it first, then switch. The
  // `chainChanged` listener above re-syncs provider/signer/chainId afterwards.
  const switchNetwork = useCallback(async () => {
    const target = activeEip1193 || window.ethereum;
    if (!target) return;
    const hexChainId = "0x" + EXPECTED_CHAIN_ID.toString(16);
    try {
      await target.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: hexChainId }],
      });
    } catch (e) {
      // 4902 = chain not added to the wallet yet. ethers v6 often wraps the
      // provider error, so the code can be nested several levels deep.
      if (extractRpcErrorCode(e) === 4902) {
        try {
          await target.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hexChainId,
              chainName: getChainName(EXPECTED_CHAIN_ID),
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            }],
          });
          // Most wallets switch as part of adding, but some only add — retry
          // the switch so the active chain ends up on EXPECTED_CHAIN_ID.
          await target.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: hexChainId }],
          });
        } catch (addErr) {
          console.error("Failed to add network:", addErr);
        }
      } else {
        console.error("Failed to switch network:", e);
      }
    }
  }, [activeEip1193]);

  const isWrongNetwork = account != null && chainId != null && chainId !== EXPECTED_CHAIN_ID;

  return (
    <WalletCtx.Provider value={{
      account, chainId, isWrongNetwork, provider, readProvider, signer,
      walletName, availableWallets, connectError, connect, disconnect, switchNetwork,
    }}>
      {children}
    </WalletCtx.Provider>
  );
}
