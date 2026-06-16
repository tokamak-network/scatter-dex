/**
 * Spent claim nullifier as stored/served by the orderbook. One `PrivateClaim`
 * event, normalised: `nullifier` is the lowercase 0x-hex of the indexed
 * `bytes32` nullifier topic — the same value a client gets from
 * `toBytes32Hex(computeClaimNullifier(secret, leafIndex))`. Presence of a row
 * means the claim has landed on-chain (nullifiers are monotonic — once spent,
 * always spent), so clients can resolve "is this claim spent?" with a batch
 * lookup instead of an `eth_call` to `claimNullifiers` per leaf.
 */
export interface ClaimNullifierRow {
  nullifier: string;
  blockNumber: number;
}
