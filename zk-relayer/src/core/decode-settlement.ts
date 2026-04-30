/**
 * Decoder for the calldata of `settleAuth` and `scatterDirectAuth` —
 * powers the operator-console proof-inspection view (Phase 3 #16).
 *
 * Inlined ABI fragment instead of importing from `@zkscatter/sdk`:
 * the relayer's vitest setup doesn't have the SDK workspace alias
 * wired up, so a bare-package import fails in tests. The tuple
 * shape is small and stable; if it changes in the SDK, this file
 * needs the same edit. See `docs/operations/operator-gap-analysis.md`
 * for the broader reasoning.
 */

import { ethers } from "ethers";

const AUTHORIZE_PROOF_TUPLE =
  "(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, " +
  "bytes32 pubKeyBind, uint256 commitmentRoot, " +
  "bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment, " +
  "address sellToken, address buyToken, " +
  "uint128 sellAmount, uint128 buyAmount, " +
  "uint16 maxFee, uint64 expiry, " +
  "bytes32 claimsRoot, uint128 totalLocked, " +
  "address relayer, bytes32 orderHash, " +
  "uint8 tier)";

const SETTLEMENT_FN_ABI = [
  `function settleAuth((${AUTHORIZE_PROOF_TUPLE} maker, ${AUTHORIZE_PROOF_TUPLE} taker, uint96 feeTokenMaker, uint96 feeTokenTaker) p) external`,
  `function scatterDirectAuth((${AUTHORIZE_PROOF_TUPLE} proof, uint96 fee) p) external`,
];

const settlementInterface = new ethers.Interface(SETTLEMENT_FN_ABI);

/** Public-signal fields of an authorize proof, normalized to JSON-safe
 *  primitives (BigInt → string for uints over 2^53). */
export interface AuthorizeProofSignals {
  pubKeyBind: string;
  commitmentRoot: string;
  nullifier: string;
  nonceNullifier: string;
  newCommitment: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: number;
  expiry: string;
  claimsRoot: string;
  totalLocked: string;
  relayer: string;
  orderHash: string;
  tier: number;
}

export type DecodedSettlement =
  | {
      function: "settleAuth";
      maker: AuthorizeProofSignals;
      taker: AuthorizeProofSignals;
      feeTokenMaker: string;
      feeTokenTaker: string;
    }
  | {
      function: "scatterDirectAuth";
      proof: AuthorizeProofSignals;
      fee: string;
    };

function toSignals(p: ethers.Result): AuthorizeProofSignals {
  return {
    pubKeyBind: String(p.pubKeyBind),
    commitmentRoot: BigInt(p.commitmentRoot).toString(),
    nullifier: String(p.nullifier),
    nonceNullifier: String(p.nonceNullifier),
    newCommitment: String(p.newCommitment),
    sellToken: String(p.sellToken),
    buyToken: String(p.buyToken),
    sellAmount: BigInt(p.sellAmount).toString(),
    buyAmount: BigInt(p.buyAmount).toString(),
    maxFee: Number(p.maxFee),
    expiry: BigInt(p.expiry).toString(),
    claimsRoot: String(p.claimsRoot),
    totalLocked: BigInt(p.totalLocked).toString(),
    relayer: String(p.relayer),
    orderHash: String(p.orderHash),
    tier: Number(p.tier),
  };
}

/** Decode the `data` field of a settlement transaction. Returns null
 *  when the calldata's selector matches neither known function — keeps
 *  the route usable for unrelated txs without throwing. */
export function decodeSettlementCalldata(data: string): DecodedSettlement | null {
  let parsed: ethers.TransactionDescription | null = null;
  try {
    parsed = settlementInterface.parseTransaction({ data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const p = parsed.args.p;
  if (parsed.name === "settleAuth") {
    return {
      function: "settleAuth",
      maker: toSignals(p.maker),
      taker: toSignals(p.taker),
      feeTokenMaker: BigInt(p.feeTokenMaker).toString(),
      feeTokenTaker: BigInt(p.feeTokenTaker).toString(),
    };
  }
  if (parsed.name === "scatterDirectAuth") {
    return {
      function: "scatterDirectAuth",
      proof: toSignals(p.proof),
      fee: BigInt(p.fee).toString(),
    };
  }
  return null;
}
