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

import { eqAddr } from "../lib/address.js";

/**
 * Sorted "lo-hi" hex address pair — stable key for the unordered
 * (sellToken, buyToken) pair. Lives here (not in `./order.js`) because
 * the only consumer is the authorize flow.
 */
export function pairKey(tokenA: bigint, tokenB: bigint): string {
  const a = "0x" + tokenA.toString(16).padStart(40, "0");
  const b = "0x" + tokenB.toString(16).padStart(40, "0");
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}-${hi}`;
}

// ─── Groth16 proof (Solidity-formatted) ─────────────────────────

export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

// ─── AuthorizeOrderFile ─────────────────────────────────────────

/**
 * The 15 public signals from authorize.circom.
 * Signal ordering: [0] = pubKeyBind (output), [1..14] = public inputs.
 */
export interface AuthorizePublicSignals {
  pubKeyBind: string;       // [0] Poseidon(pubKeyAx, pubKeyAy, nullifier) — circuit output
  commitmentRoot: string;   // [1] uint256
  nullifier: string;        // [2] bytes32
  nonceNullifier: string;   // [3] bytes32
  newCommitment: string;    // [4] bytes32
  sellToken: string;        // [5] uint160 as uint256
  buyToken: string;         // [6] uint160 as uint256
  sellAmount: string;       // [7] uint128 (≤ 2^126 in-circuit)
  buyAmount: string;        // [8] uint128 (≤ 2^126 in-circuit)
  maxFee: string;           // [9] uint16 (bps)
  expiry: string;           // [10] uint64 (unix seconds)
  claimsRoot: string;       // [11] bytes32
  totalLocked: string;      // [12] uint128 (circuit Num2Bits(128))
  relayer: string;          // [13] uint160 as uint256
  orderHash: string;        // [14] bytes32
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
   * length 15 — `pubKeyBind` is the circuit's only output and lands at
   * index 0, followed by the 14 public inputs). Passed directly to the
   * on-chain verifier; redundant with the named `publicSignals` above
   * but kept because the Groth16 verifier's `uint[15]` calldata layout
   * is positional. {@link validateAuthorizeOrder} hard-rejects any
   * other length.
   */
  publicSignalsArray: string[];

  /**
   * Circuit tier this proof was generated against (16 | 64 | 128).
   * NOT a Groth16 public signal — the verifier-registry dispatch on
   * `PrivateSettlement` keys off this byte to pick the matching
   * `AuthorizeVerifier` for the proof. Optional for transitional
   * back-compat: clients that haven't upgraded yet implicitly mean
   * tier 16 (the only ceremony shipped today). New clients should
   * always set it explicitly off the SDK's `pickTier(recipientCount)`
   * helper.
   */
  tier?: 16 | 64 | 128;
}

// ─── Stored order (in-memory + SQLite) ──────────────────────────

/**
 * Order lifecycle. Two generations coexist for one release:
 *
 *   Legacy (pre-async): pending → matched → settled | cancelled | expired
 *   Async FSM         : accepted → settling → settled
 *                                  → retrying → settling → settled
 *                                  → failed | dead_letter
 *                       cancelled | expired (orderly parallel states)
 *
 * Old clients keep working because the GET response surfaces both forms;
 * see docs/design/async-settlement-protocol.md §2.3 + §5.
 */
export type AuthorizeOrderStatus =
  | "pending"
  | "matched"
  | "accepted"
  | "settling"
  | "retrying"
  | "settled"
  | "failed"
  | "dead_letter"
  | "cancelled"
  | "expired";

/**
 * Status categories. Single source of truth so the route handler, worker,
 * sweeper, and idempotency mapper all agree on what counts as "live" vs
 * "in-flight" vs "terminal". Mutating this set without updating the union
 * above will break TypeScript narrowing — the assertion below is the
 * canary.
 *
 *   LIVE      — sitting in the queue, eligible to be claimed by the worker.
 *   IN_FLIGHT — the worker is mid-tx (do not purge / do not match against).
 *   TERMINAL  — final outcome reached; safe to drop from in-memory cache.
 */
export const LIVE_STATUSES = new Set<AuthorizeOrderStatus>([
  "pending", "accepted", "retrying",
]);
export const IN_FLIGHT_STATUSES = new Set<AuthorizeOrderStatus>([
  "matched", "settling",
]);
export const TERMINAL_STATUSES = new Set<AuthorizeOrderStatus>([
  "settled", "cancelled", "failed", "dead_letter", "expired",
]);

export function isLiveStatus(s: string): boolean {
  return LIVE_STATUSES.has(s as AuthorizeOrderStatus);
}
export function isInFlightStatus(s: string): boolean {
  return IN_FLIGHT_STATUSES.has(s as AuthorizeOrderStatus);
}
export function isTerminalStatus(s: string): boolean {
  return TERMINAL_STATUSES.has(s as AuthorizeOrderStatus);
}

export interface StoredAuthorizeOrder {
  order: AuthorizeOrderFile;
  status: AuthorizeOrderStatus;
  submittedAt: number;
  settleTxHash?: string;
  crossRelayer?: boolean;
  /** User's claimed EdDSA pubKey (verified via pubKeyBind). For compliance logging. */
  pubKeyAx?: string | null;
  pubKeyAy?: string | null;
}

export interface AuthorizeMatch {
  maker: StoredAuthorizeOrder;
  taker: StoredAuthorizeOrder;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert a public-signal field that encodes a uint160 as a decimal string
 * (e.g. `sellToken`, `buyToken`, `relayer`) into a 0x-prefixed 20-byte
 * hex address. Lowercase, no checksum — pass through `ethers.getAddress`
 * separately when checksumming is desired.
 */
export function publicSignalToAddress(decimalStr: string): string {
  return "0x" + BigInt(decimalStr).toString(16).padStart(40, "0");
}

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
  // Compare as BigInt, not string, to handle equivalent values with
  // different string formatting (e.g., "0123" vs "123").
  return (
    BigInt(maker.sellToken) === BigInt(taker.buyToken) &&
    BigInt(taker.sellToken) === BigInt(maker.buyToken)
  );
}

// ─── Validation ─────────────────────────────────────────────────

const BN254_FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Canonical order of the 15 authorize public signals — the same order the
 * circuit emits and the on-chain verifier consumes. The flat
 * `publicSignalsArray[i]` MUST equal the named `publicSignals[field]` at this
 * index. Single source of truth shared by `validateAuthorizeOrder` and
 * `checkTakerSignalsConsistent` so the two can't drift.
 */
export const AUTHORIZE_PUBLIC_SIGNAL_ORDER: (keyof AuthorizePublicSignals)[] = [
  "pubKeyBind",
  "commitmentRoot", "nullifier", "nonceNullifier", "newCommitment",
  "sellToken", "buyToken", "sellAmount", "buyAmount",
  "maxFee", "expiry", "claimsRoot", "totalLocked",
  "relayer", "orderHash",
];

/**
 * Structural + array↔named consistency check for an order whose Groth16 proof
 * will be verified against its `publicSignalsArray`. Ensures the verified
 * array can't diverge from the named `publicSignals` that compatibility
 * checks and settlement actually consume — otherwise a peer could submit a
 * proof that verifies against one set of signals while we settle a different
 * (more favourable) set.
 *
 * Unlike `validateAuthorizeOrder`, this does NOT enforce this-relayer
 * binding (the cross-relayer P2P path leaves that to on-chain `settleAuth`),
 * so it's safe to run against a taker order received from a peer. Returns
 * null when consistent, or an error message string.
 */
export function checkTakerSignalsConsistent(order: AuthorizeOrderFile): string | null {
  if (!order.proof?.a || !order.proof?.b || !order.proof?.c) {
    return "Missing proof components";
  }
  if (!order.publicSignalsArray || order.publicSignalsArray.length !== 15) {
    return "publicSignalsArray must have exactly 15 elements";
  }
  const ps = order.publicSignals;
  for (let i = 0; i < AUTHORIZE_PUBLIC_SIGNAL_ORDER.length; i++) {
    const field = AUTHORIZE_PUBLIC_SIGNAL_ORDER[i]!;
    if (ps[field] === undefined || ps[field] === null) {
      return `Missing required public signal: ${field}`;
    }
    if (order.publicSignalsArray[i] !== ps[field]) {
      return `publicSignalsArray[${i}] (${field}) does not match named publicSignals`;
    }
  }
  return null;
}

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
  if (!order.publicSignalsArray || order.publicSignalsArray.length !== 15) {
    return "publicSignalsArray must have exactly 15 elements";
  }

  // All 15 named fields must be present
  const requiredFields = AUTHORIZE_PUBLIC_SIGNAL_ORDER;
  for (const field of requiredFields) {
    if (ps[field] === undefined || ps[field] === null) {
      return `Missing required public signal: ${field}`;
    }
  }

  // Field element range (all public signals must be < BN254 modulus)
  for (const field of requiredFields) {
    const val = ps[field];
    try {
      const v = BigInt(val);
      if (v < 0n || v >= BN254_FIELD_MODULUS) {
        return `${field} out of BN254 field range`;
      }
    } catch {
      return `${field} is not a valid bigint string`;
    }
  }

  // Consistency: publicSignalsArray must match named publicSignals
  if (order.publicSignalsArray) {
    const namedValues = requiredFields.map((f) => ps[f]);
    for (let i = 0; i < requiredFields.length; i++) {
      if (order.publicSignalsArray[i] !== namedValues[i]) {
        return `publicSignalsArray[${i}] (${requiredFields[i]}) does not match named publicSignals`;
      }
    }
  }

  // Expiry: must be in the future
  const expiry = Number(BigInt(ps.expiry));
  if (expiry <= nowSeconds) {
    return `Order expired (expiry=${expiry}, now=${nowSeconds})`;
  }

  // Relayer binding: the proof must be bound to this relayer
  const proofRelayer = publicSignalToAddress(ps.relayer);
  if (!eqAddr(proofRelayer, relayerAddress)) {
    return `Proof bound to relayer ${proofRelayer}, expected ${relayerAddress}`;
  }

  // Bit-width constraints (mirror settleAuth / authorize.circom bounds)
  const sellAmountBig = BigInt(ps.sellAmount);
  const buyAmountBig = BigInt(ps.buyAmount);
  const maxFeeBig = BigInt(ps.maxFee);
  const expiryBig = BigInt(ps.expiry);
  const totalLockedBig = BigInt(ps.totalLocked);

  if (sellAmountBig === 0n) return "sellAmount must be > 0";
  if (buyAmountBig === 0n) return "buyAmount must be > 0";
  if (totalLockedBig === 0n) return "totalLocked must be > 0";
  if (sellAmountBig >= (1n << 128n)) return "sellAmount exceeds uint128";
  if (buyAmountBig >= (1n << 128n)) return "buyAmount exceeds uint128";
  if (maxFeeBig >= (1n << 16n)) return "maxFee exceeds uint16";
  if (expiryBig >= (1n << 64n)) return "expiry exceeds uint64";
  if (totalLockedBig >= (1n << 128n)) return "totalLocked exceeds uint128";

  // Address-range checks
  const sellToken = BigInt(ps.sellToken);
  const buyToken = BigInt(ps.buyToken);
  const relayerVal = BigInt(ps.relayer);
  if (sellToken >= (1n << 160n)) return "sellToken exceeds uint160";
  if (buyToken >= (1n << 160n)) return "buyToken exceeds uint160";
  if (relayerVal >= (1n << 160n)) return "relayer exceeds uint160";

  // Nullifiers must be nonzero
  if (BigInt(ps.nullifier) === 0n) return "nullifier must be nonzero";
  if (BigInt(ps.nonceNullifier) === 0n) return "nonceNullifier must be nonzero";

  // Tier (optional during the multi-tier rollout — see AuthorizeOrderFile
  // jsdoc). When present, must be one of the wired tiers; missing means
  // legacy client and is read as tier 16 by the consumer.
  if (order.tier !== undefined && !ALLOWED_TIERS.has(order.tier)) {
    // JSON.stringify renders `"16"` and `16` distinguishably, and
    // surfaces `null` / `{}` as themselves rather than the JS
    // coercion string. (`undefined` never reaches here — the outer
    // `!== undefined` guard short-circuits the legacy-client path.)
    // Include `typeof` for non-string/number payloads so the operator
    // can tell a malformed body apart from a wrong-but-valid number.
    return `tier must be one of 16 / 64 / 128 (got ${JSON.stringify(order.tier)} of type ${typeof order.tier})`;
  }

  return null;
}

/** Tier values the on-chain verifier registry knows how to dispatch.
 *  Keep in sync with `@zkscatter/sdk/zk` TIERS. Hardcoded here rather
 *  than imported from the SDK so this types module stays free of cross-
 *  package dependencies — the SDK is the canonical authority and any
 *  drift surfaces in tests. */
const ALLOWED_TIERS = new Set<number>([16, 64, 128]);

/** Resolve the dispatch tier off an order, falling back to tier 16 for
 *  transitional clients that haven't upgraded yet. Centralised here so
 *  the relayer's authorize-submitter and the matcher use the same rule. */
export function tierForOrder(order: AuthorizeOrderFile): 16 | 64 | 128 {
  return order.tier ?? 16;
}

