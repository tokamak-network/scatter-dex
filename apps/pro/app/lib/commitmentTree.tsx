"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadCommitmentInsertedHistory,
  subscribeCommitmentInserted,
  ZERO_ADDRESS,
} from "@zkscatter/sdk";
import {
  COMMIT_TREE_DEPTH,
  IncrementalMerkleTree,
  type MerkleProof,
} from "@zkscatter/sdk/zk";
import { useActiveNetwork } from "./activeNetwork";

type Mode = "demo" | "live";

interface CommitmentTreeState {
  /** "live" once the tree is being maintained from on-chain events;
   *  "demo" when the active network's `commitmentPool` is unset. */
  mode: Mode;
  /** True after the initial event-history fetch completes (or
   *  immediately in demo mode). Spend flows that need an authoritative
   *  proof should wait on this. */
  ready: boolean;
  /** Current leaf count. Demo mode: 0. */
  leafCount: number;
  /** Find the leaf index for a previously-deposited commitment.
   *  Returns -1 when not present (e.g. event hasn't been mined /
   *  reconciled yet, or demo mode). */
  findIndex(commitment: bigint): number;
  /** Inclusion proof for the given commitment, sourced from the
   *  on-chain tree. Returns null when the commitment isn't yet in
   *  the tree — callers should fall back to the empty-tree proof
   *  for demo flows or surface "wait for confirmation" for real
   *  flows. Use `getMerkleProofWithFallback` for the common case. */
  tryProofFor(commitment: bigint): Promise<MerkleProof | null>;
}

/** Resolve a Merkle proof for a note's commitment: prefer the
 *  on-chain tree (live mode), fall back to the empty-tree shortcut
 *  for the demo path. Both produce the `MerkleProof` shape every
 *  spend circuit consumes — only the root differs. Centralised
 *  here so OrderModal / CancelOrderModal don't drift. */
export async function getMerkleProofWithFallback(
  tree: CommitmentTreeState,
  commitment: bigint,
  fallback: () => Promise<{ merkleProof: MerkleProof; leafIndex: number }>,
): Promise<{ merkleProof: MerkleProof; leafIndex: number }> {
  const live = await tree.tryProofFor(commitment);
  if (live) return { merkleProof: live, leafIndex: tree.findIndex(commitment) };
  const empty = await fallback();
  return { merkleProof: empty.merkleProof, leafIndex: empty.leafIndex };
}

const Ctx = createContext<CommitmentTreeState | null>(null);

export function useCommitmentTree(): CommitmentTreeState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommitmentTree must be used inside <CommitmentTreeProvider>");
  return ctx;
}

export function CommitmentTreeProvider({ children }: { children: React.ReactNode }) {
  const { network } = useActiveNetwork();
  const { readProvider } = useWallet();
  const poolAddress = network.contracts.commitmentPool;
  const isLive = poolAddress !== ZERO_ADDRESS;

  // Tree is keyed on the (chainId, poolAddress) pair — switching
  // either invalidates the cached state. The ref is the canonical
  // copy; React state mirrors only the user-visible fields (count,
  // ready) so we don't re-render every consumer on every event.
  const treeRef = useRef<IncrementalMerkleTree>(new IncrementalMerkleTree(COMMIT_TREE_DEPTH));
  const indexRef = useRef<Map<string, number>>(new Map());
  const [leafCount, setLeafCount] = useState(0);
  const [ready, setReady] = useState(!isLive);

  useEffect(() => {
    // Fresh tree per (chainId, pool) so a network switch doesn't
    // mix leaves from one pool into another.
    treeRef.current = new IncrementalMerkleTree(COMMIT_TREE_DEPTH);
    indexRef.current = new Map();
    setLeafCount(0);

    if (!isLive) {
      // Demo mode: there's no pool to read. Stay ready immediately
      // so spend flows fall through to `buildEmptyTreeProof`.
      setReady(true);
      return;
    }
    setReady(false);

    let cancelled = false;

    void (async () => {
      try {
        // Pull historical events first; helper returns rows already
        // sorted by leafIndex (the order tree.insert relies on).
        const past = await loadCommitmentInsertedHistory(readProvider, poolAddress);
        if (cancelled) return;

        for (const row of past) {
          if (cancelled) return;
          const idx = await treeRef.current.insert(row.commitment);
          indexRef.current.set(row.commitment.toString(), idx);
        }
        if (cancelled) return;
        setLeafCount(treeRef.current.nextIndex);
        setReady(true);
          } catch (err) {
        // Surface the failure but keep `ready=false` so spend flows
        // don't accidentally use an empty tree as if it were truth.
        // Operators can refresh; future iterations may retry.
        console.error("[commitmentTree] history fetch failed:", err);
      }
    })();

    const unsubscribe = subscribeCommitmentInserted(readProvider, poolAddress, (row) => {
      if (cancelled) return;
      void (async () => {
        // If the event arrives out-of-order with respect to our
        // local nextIndex (rare under normal RPC ordering), drop it
        // — the historical refetch on the next mount will reconcile.
        if (row.leafIndex !== treeRef.current.nextIndex) {
          console.warn(
            `[commitmentTree] skipping out-of-order event: expected idx ${treeRef.current.nextIndex}, got ${row.leafIndex}`,
          );
          return;
        }
        const idx = await treeRef.current.insert(row.commitment);
        indexRef.current.set(row.commitment.toString(), idx);
        setLeafCount(treeRef.current.nextIndex);
          })();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [poolAddress, isLive, readProvider]);

  const findIndex = useCallback((commitment: bigint): number => {
    return indexRef.current.get(commitment.toString()) ?? -1;
  }, []);

  // Closure reads from `indexRef` / `treeRef` at call time, so it
  // always sees the latest tree state without needing a version
  // dependency to break consumers' memoisation.
  const tryProofFor = useCallback(
    async (commitment: bigint): Promise<MerkleProof | null> => {
      const idx = indexRef.current.get(commitment.toString());
      if (idx === undefined) return null;
      return treeRef.current.proof(idx);
    },
    [],
  );

  const value = useMemo<CommitmentTreeState>(
    () => ({
      mode: isLive ? "live" : "demo",
      ready,
      leafCount,
      findIndex,
      tryProofFor,
    }),
    [isLive, ready, leafCount, findIndex, tryProofFor],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
