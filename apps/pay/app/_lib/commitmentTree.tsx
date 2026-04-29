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
import { getNetworkConfig } from "./network";

type Mode = "demo" | "live";

export interface CommitmentTreeState {
  mode: Mode;
  ready: boolean;
  leafCount: number;
  findIndex(commitment: bigint): number;
  tryProofFor(commitment: bigint): Promise<MerkleProof | null>;
}

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

const Ctx = createContext<CommitmentTreeState | null>(null);

export function useCommitmentTree(): CommitmentTreeState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCommitmentTree must be used inside <CommitmentTreeProvider>");
  return ctx;
}

export function CommitmentTreeProvider({ children }: { children: React.ReactNode }) {
  // Pay is single-network — addresses are inlined at build time, so a
  // module-scope read here is stable for the bundle's lifetime.
  const poolAddress = useMemo(() => getNetworkConfig().contracts.commitmentPool, []);
  const { readProvider } = useWallet();
  const isLive = poolAddress !== ZERO_ADDRESS;

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
    // Serialise all tree mutations so concurrent insert()s
    // (hydration race vs. an early live event) can't corrupt
    // `filledSubtrees`. See Pro's commitmentTree for the same pattern.
    let chain: Promise<void> = Promise.resolve();

    chain = chain.then(async () => {
      try {
        const past = await loadCommitmentInsertedHistory(readProvider, poolAddress);
        if (cancelled) return;
        for (const row of past) {
          if (cancelled) return;
          const idx = await treeRef.current.insert(row.commitment);
          if (idx !== row.leafIndex) {
            throw new Error(
              `[commitmentTree] hydrate mismatch at idx ${row.leafIndex}: insert returned ${idx}.`,
            );
          }
          indexRef.current.set(row.commitment.toString(), idx);
        }
        if (cancelled) return;
        setLeafCount(treeRef.current.nextIndex);
        setReady(true);
      } catch (err) {
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
