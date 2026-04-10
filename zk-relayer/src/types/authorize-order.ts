/**
 * AuthorizeOrderFile — the new order format for the Half-proof (trustless)
 * settlement path.
 *
 * Unlike the legacy `PrivateOrder` (which carries ownerSecret, balance,
 * salt, and the full EdDSA private key material), the AuthorizeOrderFile
 * contains ONLY the Groth16 proof + public signals + matching metadata.
 * The relayer NEVER sees the user's witness data.
 *
 * Flow:
 *   1. User generates an `authorize.circom` proof in the browser
 *      (via `frontend/app/lib/zk/authorize-prover.ts`)
 *   2. User sends the AuthorizeOrderFile to the relayer
 *   3. Relayer validates public signals (expiry, token whitelist, etc.)
 *      and adds the order to the in-memory orderbook
 *   4. When a matching counterparty is found, the relayer calls
 *      `PrivateSettlement.settleAuth(makerProof, takerProof)` on-chain
 *   5. Neither the relayer nor the counterparty ever held any secrets
 *
 * See: circuits/authorize.circom, contracts/src/zk/PrivateSettlement.sol
 *      (settleAuth), frontend/app/lib/zk/authorize-prover.ts
 */

import { pairKey } from "./order.js";

// ─── Groth16 proof (Solidity-formatted) ─────────────────────────

export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

// ─── AuthorizeOrderFile ─────────────────────────────────────────

/**
 * The 14 public signals from authorize.circom, in the same order as
 * the circuit's `component main { public [...] }` block and the
 * on-chain `IAuthorizeVerifier.verifyProof` signature.
 */
export interface AuthorizePublicSignals {
  commitmentRoot: string;   // [0] uint256
  nullifier: string;        // [1] bytes32
  nonceNullifier: string;   // [2] bytes32
  newCommitment: string;    // [3] bytes32
  sellToken: string;        // [4] uint160 as uint256
  buyToken: string;         // [5] uint160 as uint256
  sellAmount: string;       // [6] uint128 (≤ 2^126 in-circuit)
  buyAmount: string;        // [7] uint128 (≤ 2^126 in-circuit)
  maxFee: string;           // [8] uint16 (bps)
  expiry: string;           // [9] uint64 (unix seconds)
  claimsRoot: string;       // [10] bytes32
  totalLocked: string;      // [11] uint96
  relayer: string;          // [12] uint160 as uint256
  orderHash: string;        // [13] bytes32
}

/**
 * An order file for the Half-proof (trustless) settlement path.
 *
 * This is what the user's browser sends to the relayer after generating
 * an authorize.circom proof. The relayer validates and stores it, then
 * matches it against a counterparty's AuthorizeOrderFile and calls
 * settleAuth on-chain.
 */
export interface AuthorizeOrderFile {
  /** Groth16 proof (Solidity-formatted, pi_b reversed). */
  proof: SolidityProof;

  /**
   * The 14 public signals as decimal strings, in circuit order.
   * The relayer can extract matching fields (sellToken, buyToken,
   * sellAmount, buyAmount, maxFee, expiry) from these for the
   * in-memory orderbook without touching any private data.
   */
  publicSignals: AuthorizePublicSignals;

  /**
   * Raw public signals array as produced by snarkjs (decimal strings,
   * length 14). Passed directly to the on-chain verifier. Redundant
   * with the named `publicSignals` above but kept for compatibility
   * with the Groth16 verifier's `uint[14]` calldata layout.
   */
  publicSignalsArray: string[];
}

// ─── Stored order (in-memory + SQLite) ──────────────────────────

export type AuthorizeOrderStatus = "pending" | "matched" | "settled" | "cancelled" | "expired";

export interface StoredAuthorizeOrder {
  order: AuthorizeOrderFile;
  status: AuthorizeOrderStatus;
  submittedAt: number;
  settleTxHash?: string;
  crossRelayer?: boolean;
}

export interface AuthorizeMatch {
  maker: StoredAuthorizeOrder;
  taker: StoredAuthorizeOrder;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Extract the pair key from an authorize order's public signals. */
export function authorizePairKey(ps: AuthorizePublicSignals): string {
  return pairKey(BigInt(ps.sellToken), BigInt(ps.buyToken));
}

/**
 * Check whether two authorize orders are price-compatible.
 * Same formula as settleAuth step 4:
 *   maker.sellAmount * taker.sellAmount >= maker.buyAmount * taker.buyAmount
 * Both sell/buyAmount are ≤ 2^126 so the products fit in JS number-safe
 * bigint arithmetic.
 */
export function isPriceCompatible(
  maker: AuthorizePublicSignals,
  taker: AuthorizePublicSignals,
): boolean {
  const makerProduct = BigInt(maker.sellAmount) * BigInt(taker.sellAmount);
  const takerProduct = BigInt(maker.buyAmount) * BigInt(taker.buyAmount);
  return takerProduct <= makerProduct;
}

/**
 * Check whether two authorize orders have compatible token sides.
 * Same as settleAuth step 3: maker.sellToken == taker.buyToken AND vice versa.
 */
export function isTokenCompatible(
  maker: AuthorizePublicSignals,
  taker: AuthorizePublicSignals,
): boolean {
  return (
    maker.sellToken === taker.buyToken &&
    taker.sellToken === maker.buyToken
  );
}

// ─── Validation ─────────────────────────────────────────────────

const BN254_FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Validate an incoming AuthorizeOrderFile from a user.
 * Returns null on success, or an error message string on failure.
 * Does NOT verify the Groth16 proof (that's done on-chain); this
 * only checks structural validity and basic sanity of public signals.
 */
export function validateAuthorizeOrder(
  order: AuthorizeOrderFile,
  relayerAddress: string,
  nowSeconds: number,
): string | null {
  const ps = order.publicSignals;

  // Proof structure
  if (!order.proof?.a || !order.proof?.b || !order.proof?.c) {
    return "Missing proof components";
  }
  if (!order.publicSignalsArray || order.publicSignalsArray.length !== 14) {
    return "publicSignalsArray must have exactly 14 elements";
  }

  // Field element range (all public signals must be < BN254 modulus)
  for (const [key, val] of Object.entries(ps)) {
    try {
      const v = BigInt(val);
      if (v < 0n || v >= BN254_FIELD_MODULUS) {
        return `${key} out of BN254 field range`;
      }
    } catch {
      return `${key} is not a valid bigint string`;
    }
  }

  // Expiry: must be in the future
  const expiry = Number(BigInt(ps.expiry));
  if (expiry <= nowSeconds) {
    return `Order expired (expiry=${expiry}, now=${nowSeconds})`;
  }

  // Relayer binding: the proof must be bound to this relayer
  const proofRelayer = "0x" + BigInt(ps.relayer).toString(16).padStart(40, "0");
  if (proofRelayer.toLowerCase() !== relayerAddress.toLowerCase()) {
    return `Proof bound to relayer ${proofRelayer}, expected ${relayerAddress}`;
  }

  // Amounts must be positive
  if (BigInt(ps.sellAmount) === 0n) return "sellAmount must be > 0";
  if (BigInt(ps.buyAmount) === 0n) return "buyAmount must be > 0";
  if (BigInt(ps.totalLocked) === 0n) return "totalLocked must be > 0";

  // Nullifiers must be nonzero
  if (BigInt(ps.nullifier) === 0n) return "nullifier must be nonzero";
  if (BigInt(ps.nonceNullifier) === 0n) return "nonceNullifier must be nonzero";

  return null;
}

export { pairKey };
