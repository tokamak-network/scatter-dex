"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { Vault, Loader2, ArrowDownToLine } from "lucide-react";
import { useWallet } from "../lib/wallet";
import type { TokenInfo } from "../lib/tokens";
import { getFeeVaultAddress } from "../lib/config";
import { FEE_VAULT_ABI } from "../lib/contracts";
import { getReadProvider } from "../lib/provider";
import { extractMessage } from "../lib/error-messages";

interface VaultBalance {
  token: string;
  symbol: string;
  balance: bigint;
}

interface FeeVaultPanelProps {
  tokens: TokenInfo[];
}

/**
 * Operator-only panel: shows the connected wallet's accumulated FeeVault
 * balance per token and lets the operator claim. Renders nothing if either
 * the FeeVault address is unconfigured or the wallet has no balance.
 */
export default function FeeVaultPanel({ tokens }: FeeVaultPanelProps) {
  const { account, signer } = useWallet();
  const feeVaultAddr = getFeeVaultAddress();

  const [balances, setBalances] = useState<VaultBalance[]>([]);
  const [platformFee, setPlatformFee] = useState<number>(0);
  const [claimingToken, setClaimingToken] = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  const findToken = (addr: string) => tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase());

  // Bumped on every loadBalances call; in-flight responses that come back
  // with a stale id are ignored, preventing late RPCs from overwriting the
  // newer state after `account` changes or the component unmounts.
  const loadIdRef = useRef(0);

  const loadBalances = useCallback(async () => {
    if (!account || !feeVaultAddr) { setBalances([]); return; }
    const myLoadId = ++loadIdRef.current;
    try {
      const provider = getReadProvider();
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
      const feeBps = await vault.platformFeeBps();
      if (loadIdRef.current !== myLoadId) return;
      setPlatformFee(Number(feeBps));

      const erc20Tokens = tokens.filter((t) => !t.isNative);
      // Promise.allSettled: a single failed RPC shouldn't drop the whole
      // balance list. Successful entries still display.
      const settled = await Promise.allSettled(
        erc20Tokens.map((t) => vault.balances(account, t.address)),
      );
      if (loadIdRef.current !== myLoadId) return;
      const bals: VaultBalance[] = [];
      settled.forEach((res, i) => {
        if (res.status === "fulfilled" && res.value > 0n) {
          bals.push({
            token: erc20Tokens[i].address,
            symbol: erc20Tokens[i].symbol,
            balance: res.value,
          });
        } else if (res.status === "rejected") {
          console.warn(`Vault balance fetch failed for ${erc20Tokens[i].symbol}:`, res.reason);
        }
      });
      setBalances(bals);
    } catch (e) {
      console.warn("Failed to load vault balances:", e);
    }
  }, [account, feeVaultAddr, tokens]);

  useEffect(() => {
    loadBalances();
    return () => { loadIdRef.current++; };
  }, [loadBalances]);

  const handleClaim = useCallback(async (token: string) => {
    if (!signer || !feeVaultAddr) return;
    setClaimingToken(token);
    setClaimTxHash(null);
    setClaimError(null);
    try {
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, signer);
      const tx = await vault.claim(token);
      const receipt = await tx.wait();
      setClaimTxHash(receipt.hash ?? receipt.transactionHash);
      await loadBalances();
    } catch (e: unknown) {
      console.error("Vault claim failed:", e);
      setClaimError(extractMessage(e));
    } finally {
      setClaimingToken(null);
    }
  }, [signer, feeVaultAddr, loadBalances]);

  if (!feeVaultAddr || !account || balances.length === 0) return null;

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/10 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Vault className="w-4 h-4 text-tertiary" />
          <span className="text-sm font-semibold text-on-surface">Fee Vault</span>
          <span className="text-[10px] text-on-surface-variant/50">Platform fee: {(platformFee / 100).toFixed(1)}%</span>
        </div>
        <button
          onClick={loadBalances}
          className="text-[10px] text-primary hover:text-primary-container font-bold"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-2">
        {balances.map((b) => {
          const dec = findToken(b.token)?.decimals ?? 18;
          const grossStr = ethers.formatUnits(b.balance, dec);
          const netStr = ethers.formatUnits(b.balance * BigInt(10000 - platformFee) / 10000n, dec);
          const maxDp = Math.min(dec, 6);
          const truncate = (s: string) => {
            const [i, d] = s.split(".");
            return d && maxDp > 0 ? `${i}.${d.slice(0, maxDp)}` : i;
          };
          return (
            <div key={b.token} className="flex items-center justify-between bg-surface rounded-lg px-4 py-3">
              <div>
                <span className="font-mono font-bold text-on-surface">
                  {truncate(grossStr)} {b.symbol}
                </span>
                <span className="text-[10px] text-on-surface-variant/40 ml-2">
                  (net: {truncate(netStr)})
                </span>
              </div>
              <button
                onClick={() => handleClaim(b.token)}
                disabled={claimingToken === b.token}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-tertiary/15 text-tertiary text-xs font-bold hover:bg-tertiary/25 transition-colors disabled:opacity-50"
              >
                {claimingToken === b.token ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <ArrowDownToLine className="w-3 h-3" />
                )}
                Claim
              </button>
            </div>
          );
        })}
      </div>

      {claimTxHash && (
        <div className="mt-2 text-[10px] font-mono text-primary bg-primary/5 rounded p-2 break-all">
          Tx: {claimTxHash}
        </div>
      )}
      {claimError && (
        <div className="mt-2 text-[10px] text-error bg-error/5 rounded p-2">
          {claimError}
        </div>
      )}
    </div>
  );
}
