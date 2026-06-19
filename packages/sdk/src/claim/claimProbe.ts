import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";
import { computeClaimNullifier, toBytes32Hex } from "../zk/commitment";

/** Canonical claim nullifier hex (0x + 32 bytes, lowercase) for a leaf — the
 *  key both the on-chain `claimNullifiers` mapping and the indexer's
 *  `/api/claim-nullifiers` endpoint are keyed on. Validates `leafIndex` up
 *  front: a negative/fractional index hashes to a nullifier that can never
 *  match a real leaf, which would read as a silent false negative downstream. */
export async function claimNullifierHex(
  secret: bigint,
  leafIndex: number,
  claimsRoot: bigint,
): Promise<string> {
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0) {
    throw new RangeError(`leafIndex must be a non-negative integer: ${leafIndex}`);
  }
  return toBytes32Hex(
    await computeClaimNullifier(secret, BigInt(leafIndex), claimsRoot),
  ).toLowerCase();
}

/** PrivateSettlement contract bound for read-only nullifier probes. Pull it
 *  out once and reuse across a batch of leaves rather than reconstructing per
 *  call. */
export function settlementReader(
  provider: ethers.Provider,
  settlementAddress: string,
): ethers.Contract {
  return new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, provider);
}

/** True when this claim's nullifier is already spent on the given settlement
 *  contract. The leaf-level primitive shared by the single probe and the batch
 *  RPC fallback, so both compute the nullifier and read `claimNullifiers` the
 *  same way. */
export async function isClaimNullifierSpentOn(
  settlement: ethers.Contract,
  secret: bigint,
  leafIndex: number,
  claimsRoot: bigint,
): Promise<boolean> {
  // Reuse `claimNullifierHex` so the RPC and indexer paths derive the key
  // identically (same leafIndex guard + canonical lowercasing).
  return (await settlement.claimNullifiers(
    await claimNullifierHex(secret, leafIndex, claimsRoot),
  )) as boolean;
}

/** True when this claim's nullifier is already spent on-chain — i.e. the claim
 *  has LANDED, even if the relayer request that landed it errored or timed out
 *  before responding.
 *
 *  Used as a post-failure backstop across every gasless-claim surface (the
 *  /claim page, the order drawer's "Claim now", the claims inbox): a gasless
 *  claim makes the relayer mine an on-chain tx before it replies, so a
 *  slow/failed response doesn't mean the claim failed. Probe the nullifier
 *  before surfacing an error — if it's spent, show success. */
export async function isClaimNullifierSpent(
  provider: ethers.Provider,
  settlementAddress: string,
  secret: bigint,
  leafIndex: number,
  claimsRoot: bigint,
): Promise<boolean> {
  return isClaimNullifierSpentOn(
    settlementReader(provider, settlementAddress),
    secret,
    leafIndex,
    claimsRoot,
  );
}
