"use client";

import { useState, useEffect, useRef } from "react";
import { ethers } from "ethers";
import { toBytes32Hex } from "./commitment";
import { buildMerkleTree } from "./commitment";
import { getPrivateSettlementAddress } from "../config";
import { getReadProvider } from "../provider";
import { PRIVATE_SETTLEMENT_ABI } from "../contracts";

const CLAIMS_TREE_DEPTH = 4;

export interface ClaimsGroupStatus {
  /** Whether `claimsGroups[claimsRoot].totalLocked > 0` on-chain. */
  settled: boolean;
  /** The computed claimsRoot for these leaves (0x-prefixed bytes32). */
  claimsRootHex: string;
}

/**
 * Resolve on-chain settlement status for a list of claims.
 * A claim is only usable once the underlying order has been settled and
 * its `claimsGroups[claimsRoot]` slot has been registered — otherwise the
 * `claimWithProof` call reverts with `ClaimsGroupNotFound`.
 *
 * Groups claims by claimsRoot (computed from `allLeaves`) so we only issue
 * one RPC call per distinct settlement.
 */
export function useClaimsGroupStatus(
  claims: Array<{ allLeaves?: string[] }>,
): Record<number, ClaimsGroupStatus> {
  const [statuses, setStatuses] = useState<Record<number, ClaimsGroupStatus>>({});
  const keyRef = useRef("");
  const inflightKeyRef = useRef("");

  useEffect(() => {
    if (claims.length === 0) return;
    const key = claims.map((c) => (c.allLeaves ?? []).join(":")).join("|");
    if (key === keyRef.current) return;
    if (key === inflightKeyRef.current) return;
    inflightKeyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        await Promise.resolve();
        if (cancelled) return;

        // Compute claimsRoot for each claim. Dedup by root so co-claims
        // from the same settlement share one on-chain read.
        const roots = await Promise.all(
          claims.map(async (c, i) => {
            if (!c.allLeaves || c.allLeaves.length !== 16) return { i, rootHex: null };
            const leaves = c.allLeaves.map((l) => BigInt(l));
            const { root } = await buildMerkleTree(leaves, CLAIMS_TREE_DEPTH);
            return { i, rootHex: toBytes32Hex(root) };
          }),
        );
        if (cancelled) return;

        const distinctRoots = [...new Set(roots.map((r) => r.rootHex).filter(Boolean))] as string[];
        const provider = getReadProvider();
        const settlement = new ethers.Contract(
          getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, provider,
        );

        // `claimsGroups(root)` returns (totalLocked, totalClaimed, token).
        // Settled ↔ totalLocked > 0 (registerClaimsGroup writes this only
        // after settlePrivate / settleAuth / settleWithDex succeeds).
        const settlementByRoot = new Map<string, boolean>();
        await Promise.all(
          distinctRoots.map(async (rootHex) => {
            try {
              const [totalLocked] = await settlement.claimsGroups(rootHex);
              settlementByRoot.set(rootHex, BigInt(totalLocked) > 0n);
            } catch (e) {
              console.warn("Failed to read claimsGroup:", e);
              settlementByRoot.set(rootHex, false);
            }
          }),
        );
        if (cancelled) return;

        const result: Record<number, ClaimsGroupStatus> = {};
        for (const { i, rootHex } of roots) {
          if (rootHex == null) continue;
          result[i] = {
            settled: settlementByRoot.get(rootHex) ?? false,
            claimsRootHex: rootHex,
          };
        }
        setStatuses(result);
        keyRef.current = key;
      } catch (e) {
        console.warn("Failed to check claims-group statuses:", e);
      } finally {
        if (inflightKeyRef.current === key) inflightKeyRef.current = "";
      }
    })();
    return () => { cancelled = true; };
  }, [claims]);

  return statuses;
}
