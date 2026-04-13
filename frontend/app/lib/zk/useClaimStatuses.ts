"use client";

import { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { computeClaimNullifier, toBytes32Hex } from "./commitment";
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
  // `keyRef` caches the key whose result is currently in `statuses`.
  // `inflightKeyRef` tracks a query that's started but not yet committed
  // — gates against thundering-herd concurrent fetches when a parent
  // re-render passes a new `claims` reference for the same logical
  // data while a fetch is in flight.
  const keyRef = useRef("");
  const inflightKeyRef = useRef("");

  const includeTxHash = options?.includeTxHash;
  useEffect(() => {
    if (claims.length === 0) return;
    const key = claims.map((c) => `${c.secret}:${c.leafIndex}`).join("|") + (includeTxHash ? ":tx" : "");
    // Skip if (a) we already have this result cached, or (b) an
    // identical query is already in flight. The cached check is
    // committed after `setStatuses` lands; the in-flight check
    // prevents duplicate concurrent fan-outs.
    if (key === keyRef.current) return;
    if (key === inflightKeyRef.current) return;
    inflightKeyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        // Yield once before any work so a synchronous cleanup (React 18
        // strict-mode double invoke, rapid prop change) short-circuits
        // before we burn Poseidon hashing + RPC reads on a doomed run.
        await Promise.resolve();
        if (cancelled) return;

        const provider = getReadProvider();
        const settlement = new ethers.Contract(
          getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, provider
        );

        // Compute all nullifiers in parallel
        const nullifiers = await Promise.all(
          claims.map(async (c, i) => {
            if (c.secret == null || c.leafIndex == null) return { i, nullHex: null };
            // [M4] Use the centralised computeClaimNullifier helper so the
            //      tag definition cannot drift from circuits/zk-prover.
            const nullifier = await computeClaimNullifier(BigInt(c.secret), BigInt(c.leafIndex));
            return { i, nullHex: toBytes32Hex(nullifier) };
          })
        );
        if (cancelled) return;

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

        if (cancelled) return;
        const result: Record<number, ClaimStatusInfo> = {};
        for (const { i, claimed } of checks) {
          result[i] = { claimed, txHash: txMap[i] };
        }
        setStatuses(result);
        keyRef.current = key;
      } catch (e) {
        console.warn("Failed to check claim statuses:", e);
      } finally {
        // Clear in-flight only if this run is still the latest — a
        // newer effect may have already taken over the slot.
        if (inflightKeyRef.current === key) inflightKeyRef.current = "";
      }
    })();
    return () => { cancelled = true; };
  }, [claims, includeTxHash]);

  return statuses;
}
