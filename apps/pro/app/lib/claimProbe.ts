import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";

/** True when this claim's nullifier is already spent on-chain — i.e. the
 *  claim has LANDED, even if the relayer request that landed it errored or
 *  timed out before responding.
 *
 *  Used as a post-failure backstop across every gasless-claim surface
 *  (/claim page, the order drawer's "Claim now", the /claims inbox): a
 *  gasless claim makes the relayer mine an on-chain tx before it replies,
 *  so a slow/failed response doesn't mean the claim failed. Probe the
 *  nullifier before surfacing an error — if it's spent, show success. */
export async function isClaimNullifierSpent(
  provider: ethers.Provider,
  settlementAddress: string,
  secret: bigint,
  leafIndex: number,
): Promise<boolean> {
  const nullifier = await computeClaimNullifier(secret, BigInt(leafIndex));
  const settlement = new ethers.Contract(
    settlementAddress,
    PRIVATE_SETTLEMENT_ABI,
    provider,
  );
  return (await settlement.claimNullifiers(toBytes32Hex(nullifier))) as boolean;
}
