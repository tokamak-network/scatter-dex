"use client";

import { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { poseidonHash, toBytes32Hex } from "./commitment";
import { getPrivateSettlementAddress } from "../config";
import { getReadProvider, getEarliestBlock } from "../provider";
import { PRIVATE_SETTLEMENT_ABI } from "../contracts";

export interface ClaimStatusInfo {
  claimed: boolean;
  txHash?: string;
}

/**
 * Check on-chain claim statuses for a list of claims.
 * Each claim must have `secret` and `leafIndex`.
 * Returns a record keyed by claim index.
 */
export function useClaimStatuses(
  claims: Array<{ secret?: string; leafIndex?: number }>,
  options?: { includeTxHash?: boolean }
): Record<number, ClaimStatusInfo> {
  const [statuses, setStatuses] = useState<Record<number, ClaimStatusInfo>>({});
  const keyRef = useRef("");

  useEffect(() => {
    if (claims.length === 0) return;
    // Stable key to avoid re-running for same claims
    const key = claims.map((c) => `${c.secret}:${c.leafIndex}`).join("|") + (options?.includeTxHash ? ":tx" : "");
    if (key === keyRef.current) return;
    keyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        const provider = getReadProvider();
        const settlement = new ethers.Contract(
          getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, provider
        );

        // Compute all nullifiers in parallel
        const nullifiers = await Promise.all(
          claims.map(async (c, i) => {
            if (c.secret == null || c.leafIndex == null) return { i, nullHex: null };
            // [M4] Domain-separated claim nullifier (tag = 2)
            const nullifier = await poseidonHash([2n, BigInt(c.secret), BigInt(c.leafIndex)]);
            return { i, nullHex: toBytes32Hex(nullifier) };
          })
        );

        // Check all nullifiers in parallel
        const checks = await Promise.all(
          nullifiers.filter((n) => n.nullHex).map(async ({ i, nullHex }) => {
            const claimed = await settlement.claimNullifiers(nullHex!);
            return { i, claimed, nullHex: nullHex! };
          })
        );

        // Optionally fetch tx hashes for claimed items in parallel
        let txMap: Record<number, string> = {};
        if (options?.includeTxHash) {
          const fromBlock = getEarliestBlock();
          const claimedItems = checks.filter((c) => c.claimed);
          const txResults = await Promise.all(
            claimedItems.map(async ({ i, nullHex }) => {
              try {
                const logs = await settlement.queryFilter(settlement.filters.PrivateClaim(null, nullHex), fromBlock);
                return { i, txHash: logs[0]?.transactionHash };
              } catch (e) { console.warn("Failed to fetch claim tx:", e); return { i, txHash: undefined }; }
            })
          );
          for (const { i, txHash } of txResults) {
            if (txHash) txMap[i] = txHash;
          }
        }

        if (cancelled) { keyRef.current = ""; return; }
        const result: Record<number, ClaimStatusInfo> = {};
        for (const { i, claimed } of checks) {
          result[i] = { claimed, txHash: txMap[i] };
        }
        setStatuses(result);
      } catch (e) {
        keyRef.current = ""; // allow retry on error
        console.warn("Failed to check claim statuses:", e);
      }
    })();
    return () => { cancelled = true; };
  // options.includeTxHash is checked via keyRef to avoid re-renders from unstable object refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  return statuses;
}
