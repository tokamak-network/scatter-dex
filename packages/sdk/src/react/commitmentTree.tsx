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
import { useWallet } from "./wallet";
import { ZERO_ADDRESS } from "../core/addresses";
import {
  loadCommitmentInsertedHistory,
  subscribeCommitmentInserted,
} from "../core/pool";
import {
  COMMIT_TREE_DEPTH,
  IncrementalMerkleTree,
  type MerkleProof,
} from "../zk";

type Mode = "demo" | "live";

export interface CommitmentTreeState {
  /** "live" once the tree is being maintained from on-chain events;
   *  "demo" when the supplied `poolAddress` is the zero address. */
  mode: Mode;
  /** True after the initial event-history fetch completes (or
   *  immediately in demo mode). Spend flows that need an authoritative
   *  proof should wait on this. */
  ready: boolean;
  /** Current leaf count. Demo mode: 0. */
  leafCount: number;
  /** Find the leaf index for a previously-deposited commitment.
   *  Returns -1 when not present. */
  findIndex(commitment: bigint): number;
  /** Inclusion proof for the given commitment, sourced from the
   *  on-chain tree. Returns null when the commitment isn't yet in
   *  the tree. Use `getMerkleProofWithFallback` for the common
   *  demo-mode-aware case. */
  tryProofFor(commitment: bigint): Promise<MerkleProof | null>;
}

/** Thrown when the supplied pool has a real CommitmentPool but the
 *  commitment isn't (yet) in the tree — usually means the deposit's
 *  log hasn't been processed, the tree is mid-sync, or the user
 *  spent before reconciliation. Safer than silently generating an
 *  empty-tree proof whose root would mismatch the pool's
 *  `getLastRoot()` at settle time. */
export class CommitmentProofUnavailableError extends Error {
  readonly code = "COMMITMENT_PROOF_UNAVAILABLE";
  constructor(readonly commitment: bigint, message?: string) {
    super(
      message ??
        `Commitment ${commitment.toString().slice(0, 16)}… is not yet in the on-chain tree. Wait for the deposit to confirm and the tree to sync.`,
    );
    this.name = "CommitmentProofUnavailableError";
  }
}

/** Resolve a Merkle proof for a note's commitment: prefer the
 *  on-chain tree, fall back to the empty-tree shortcut **only in
 *  demo mode**. In live mode a missing commitment throws so the UI
 *  surfaces "wait for confirmation" instead of producing an
 *  invalid-root proof that would fail at settle time. */
export async function getMerkleProofWithFallback(
  tree: CommitmentTreeState,
  commitment: bigint,
  fallback: () => Promise<{ merkleProof: MerkleProof; leafIndex: number }>,
): Promise<{ merkleProof: MerkleProof; leafIndex: number }> {
  const live = await tree.tryProofFor(commitment);
  if (live) return { merkleProof: live, leafIndex: tree.findIndex(commitment) };
  if (tree.mode === "live") throw new CommitmentProofUnavailableError(commitment);
  const empty = await fallback();
  return { merkleProof: empty.merkleProof, leafIndex: empty.leafIndex };
}

const Ctx = createContext<CommitmentTreeState | null>(null);

export function useCommitmentTree(): CommitmentTreeState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommitmentTree must be used inside <CommitmentTreeProvider>");
  return ctx;
}

export interface CommitmentTreeProviderProps {
  /** On-chain CommitmentPool the tree mirrors. Pass `ZERO_ADDRESS` to
   *  stay in demo mode (no fetch, no subscription). The provider
   *  rebuilds the tree whenever this changes — apps that switch
   *  networks supply the active address through their network hook. */
  poolAddress: string;
  children: React.ReactNode;
}

export function CommitmentTreeProvider({
  poolAddress,
  children,
}: CommitmentTreeProviderProps) {
  const { readProvider } = useWallet();
  const isLive = poolAddress !== ZERO_ADDRESS;

  // Tree is keyed on `poolAddress` — switching invalidates state.
  // The ref is canonical; React state mirrors only the user-visible
  // fields (count, ready) so we don't re-render every consumer on
  // every event.
  const treeRef = useRef<IncrementalMerkleTree>(new IncrementalMerkleTree(COMMIT_TREE_DEPTH));
  const indexRef = useRef<Map<string, number>>(new Map());
  const [leafCount, setLeafCount] = useState(0);
  const [ready, setReady] = useState(!isLive);

  useEffect(() => {
    treeRef.current = new IncrementalMerkleTree(COMMIT_TREE_DEPTH);
    indexRef.current = new Map();
    setLeafCount(0);

    if (!isLive) {
      setReady(true);
      return;
    }
    setReady(false);

    let cancelled = false;

    // Serialise all tree mutations so concurrent insert() calls —
    // historical hydration vs. an early live event, or two events
    // in the same tick — can't corrupt `filledSubtrees`.
    let chain: Promise<void> = Promise.resolve();

    chain = chain.then(async () => {
      try {
        const past = await loadCommitmentInsertedHistory(readProvider, poolAddress);
        if (cancelled) return;
        for (const row of past) {
          if (cancelled) return;
          const idx = await treeRef.current.insert(row.commitment);
          // A divergence means the RPC dropped a log or returned
          // out of order — building proofs against a corrupted tree
          // would silently fail at settle time, so refuse to mark
          // `ready` and surface the discrepancy.
          if (idx !== row.leafIndex) {
            throw new Error(
              `[commitmentTree] hydrate mismatch at idx ${row.leafIndex}: insert returned ${idx}. RPC may have returned an incomplete log set; refresh to retry.`,
            );
          }
          indexRef.current.set(row.commitment.toString(), idx);
        }
        if (cancelled) return;
        setLeafCount(treeRef.current.nextIndex);
        setReady(true);
      } catch (err) {
        // Keep `ready=false` so spend flows don't use an empty
        // tree as truth. Apps can refresh; retry-on-failure is a
        // future iteration.
        console.error("[commitmentTree] history fetch failed:", err);
      }
    });

    const unsubscribe = subscribeCommitmentInserted(readProvider, poolAddress, (row) => {
      if (cancelled) return;
      chain = chain.then(async () => {
        if (cancelled) return;
        if (row.leafIndex !== treeRef.current.nextIndex) {
          console.warn(
            `[commitmentTree] skipping out-of-order event: expected idx ${treeRef.current.nextIndex}, got ${row.leafIndex}`,
          );
          return;
        }
        const idx = await treeRef.current.insert(row.commitment);
        indexRef.current.set(row.commitment.toString(), idx);
        setLeafCount(treeRef.current.nextIndex);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [poolAddress, isLive, readProvider]);

  const findIndex = useCallback((commitment: bigint): number => {
    return indexRef.current.get(commitment.toString()) ?? -1;
  }, []);

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
