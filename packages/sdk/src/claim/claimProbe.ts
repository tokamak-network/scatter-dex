import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";
import { computeClaimNullifier, toBytes32Hex } from "../zk/commitment";

/** Canonical claim nullifier hex (0x + 32 bytes, lowercase) for a leaf — the
 *  key both the on-chain `claimNullifiers` mapping and the indexer's
 *  `/api/claim-nullifiers` endpoint are keyed on. */
export async function claimNullifierHex(secret: bigint, leafIndex: number): Promise<string> {
  return toBytes32Hex(await computeClaimNullifier(secret, BigInt(leafIndex))).toLowerCase();
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
): Promise<boolean> {
  const nullifier = await computeClaimNullifier(secret, BigInt(leafIndex));
  return (await settlement.claimNullifiers(toBytes32Hex(nullifier))) as boolean;
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
): Promise<boolean> {
  return isClaimNullifierSpentOn(
    settlementReader(provider, settlementAddress),
    secret,
    leafIndex,
  );
}
