import type { ClaimLeafData } from "../core/zk-prover.js";

export interface PrivateOrder {
  sellToken: bigint;
  buyToken: bigint;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
  // EdDSA signature
  pubKeyAx: bigint;
  pubKeyAy: bigint;
  sigS: bigint;
  sigR8x: bigint;
  sigR8y: bigint;
  // Commitment info
  ownerSecret: bigint;
  balance: bigint;
  salt: bigint;
  leafIndex: number;
  // Change commitment — user-controlled salt
  newSalt: bigint;
  expectedChangeCommitment: bigint;
  // Claims
  claims: ClaimLeafData[];
}

export type PrivateOrderStatus = "pending" | "matched" | "settled" | "cancelled" | "expired";

export interface StoredPrivateOrder {
  order: PrivateOrder;
  status: PrivateOrderStatus;
  submittedAt: number;
  settleTxHash?: string;
  crossRelayer?: boolean;
}

export interface PrivateMatch {
  maker: StoredPrivateOrder;
  taker: StoredPrivateOrder;
}

// ─── Cross-relayer matching types (shared with @scatter-dex/types) ───

export type { OrderSummary, TradeOfferRequest, TradeOfferResponse } from "@scatter-dex/types";
import type { OrderSummary } from "@scatter-dex/types";

export interface CrossRelayerMatch {
  localOrder: StoredPrivateOrder;
  remoteOrder: OrderSummary;
  localSide: "maker" | "taker";
}

export type MatchResult = PrivateMatch | CrossRelayerMatch;

export function isCrossRelayerMatch(m: MatchResult): m is CrossRelayerMatch {
  return "remoteOrder" in m;
}

// Token pair key: sorted hex addresses joined with "-"
export function pairKey(tokenA: bigint, tokenB: bigint): string {
  const a = "0x" + tokenA.toString(16).padStart(40, "0");
  const b = "0x" + tokenB.toString(16).padStart(40, "0");
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${lo}-${hi}`;
}

const MAX_CLAIMS = 16;
const MAX_ADDRESS = (1n << 160n) - 1n;

// [M8] BN254 scalar field modulus. Every value passed into the ZK circuits
// (Poseidon inputs, EdDSA scalars, signatures, balances, …) must be a
// non-negative element of this field. Without this check the circuit
// would still reject the witness, but the user would just see an opaque
// "Assert Failed" — far harder to debug than a precise upstream error.
const BN254_FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_AMOUNT_128 = (1n << 128n) - 1n; // matches settle.circom range checks

function validateAddress(val: bigint, name: string): void {
  if (val < 0n || val > MAX_ADDRESS) throw new Error(`${name} must be a valid 160-bit address`);
}

/** [M8] Reject anything outside [0, BN254). */
function validateField(val: bigint, name: string): void {
  if (val < 0n) throw new Error(`${name} must be non-negative`);
  if (val >= BN254_FIELD_MODULUS) throw new Error(`${name} exceeds BN254 scalar field modulus`);
}

/** [M8] Stricter range used for amount-like signals (matches settle.circom Num2Bits(128)). */
function validateAmount128(val: bigint, name: string): void {
  if (val < 0n) throw new Error(`${name} must be non-negative`);
  if (val > MAX_AMOUNT_128) throw new Error(`${name} exceeds 128-bit range`);
}

function toBigInt(val: unknown, name: string): bigint {
  if (val === undefined || val === null) throw new Error(`missing ${name}`);
  try {
    return BigInt(val as string | number | bigint);
  } catch {
    throw new Error(`invalid ${name}: not a valid number`);
  }
}

export function parsePrivateOrder(raw: Record<string, unknown>): PrivateOrder {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid order");

  const sellToken = toBigInt(raw.sellToken, "sellToken");
  const buyToken = toBigInt(raw.buyToken, "buyToken");
  const sellAmount = toBigInt(raw.sellAmount, "sellAmount");
  const buyAmount = toBigInt(raw.buyAmount, "buyAmount");
  const maxFee = toBigInt(raw.maxFee, "maxFee");
  const expiry = toBigInt(raw.expiry, "expiry");
  const nonce = toBigInt(raw.nonce, "nonce");

  validateAddress(sellToken, "sellToken");
  validateAddress(buyToken, "buyToken");
  if (sellAmount <= 0n) throw new Error("sellAmount must be > 0");
  if (buyAmount <= 0n) throw new Error("buyAmount must be > 0");
  if (maxFee < 0n) throw new Error("maxFee must be >= 0");

  // [M8] Range checks matching the circuit's Num2Bits(128) for amounts
  // and Num2Bits(16) for fee bps. Out-of-range values would fail in the
  // circuit anyway but produce an opaque assertion error; rejecting them
  // here gives the user a clear message.
  validateAmount128(sellAmount, "sellAmount");
  validateAmount128(buyAmount, "buyAmount");
  if (maxFee > 65535n) throw new Error("maxFee exceeds 16-bit range");
  validateField(expiry, "expiry");
  validateField(nonce, "nonce");

  const pubKeyAx = toBigInt(raw.pubKeyAx, "pubKeyAx");
  const pubKeyAy = toBigInt(raw.pubKeyAy, "pubKeyAy");
  const sigS = toBigInt(raw.sigS, "sigS");
  const sigR8x = toBigInt(raw.sigR8x, "sigR8x");
  const sigR8y = toBigInt(raw.sigR8y, "sigR8y");

  // [M8] EdDSA components must all live in BN254.
  validateField(pubKeyAx, "pubKeyAx");
  validateField(pubKeyAy, "pubKeyAy");
  validateField(sigS, "sigS");
  validateField(sigR8x, "sigR8x");
  validateField(sigR8y, "sigR8y");

  const ownerSecret = toBigInt(raw.ownerSecret, "ownerSecret");
  const balance = toBigInt(raw.balance, "balance");
  const salt = toBigInt(raw.salt, "salt");
  const leafIndex = Number(raw.leafIndex);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) throw new Error("invalid leafIndex");

  // [M8] Escrow secrets must be field elements; balance is also range-checked
  // to 128 bits to match settle.circom Num2Bits(128).
  validateField(ownerSecret, "ownerSecret");
  validateField(salt, "salt");
  validateAmount128(balance, "balance");

  const newSalt = toBigInt(raw.newSalt, "newSalt");
  const expectedChangeCommitment = toBigInt(raw.expectedChangeCommitment, "expectedChangeCommitment");

  // [M8] newSalt + expectedChangeCommitment are Poseidon inputs / outputs.
  validateField(newSalt, "newSalt");
  validateField(expectedChangeCommitment, "expectedChangeCommitment");

  const rawClaims = raw.claims as Array<Record<string, unknown>>;
  if (!Array.isArray(rawClaims) || rawClaims.length === 0 || rawClaims.length > MAX_CLAIMS) {
    throw new Error(`claims must be 1-${MAX_CLAIMS}`);
  }

  const claims: ClaimLeafData[] = rawClaims.map((c, i) => {
    const recipient = toBigInt(c.recipient, `claims[${i}].recipient`);
    const token = toBigInt(c.token, `claims[${i}].token`);
    validateAddress(recipient, `claims[${i}].recipient`);
    validateAddress(token, `claims[${i}].token`);
    const claimSecret = toBigInt(c.secret, `claims[${i}].secret`);
    const claimAmount = toBigInt(c.amount, `claims[${i}].amount`);
    const claimReleaseTime = toBigInt(c.releaseTime, `claims[${i}].releaseTime`);
    // [M8] Validate every Poseidon input for the claim leaf hash.
    validateField(claimSecret, `claims[${i}].secret`);
    validateAmount128(claimAmount, `claims[${i}].amount`);
    validateField(claimReleaseTime, `claims[${i}].releaseTime`);
    return {
      secret: claimSecret,
      recipient,
      token,
      amount: claimAmount,
      releaseTime: claimReleaseTime,
    };
  });

  return {
    sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce,
    pubKeyAx, pubKeyAy, sigS, sigR8x, sigR8y,
    ownerSecret, balance, salt, leafIndex,
    newSalt, expectedChangeCommitment,
    claims,
  };
}

export interface PrivateOrderResponse {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: string;
  expiry: string;
  nonce: string;
  pubKeyAx: string;
  pubKeyAy: string;
  status: PrivateOrderStatus;
  submittedAt: number;
  settleTxHash?: string;
  crossRelayer?: boolean;
}

export function serializePrivateOrder(stored: StoredPrivateOrder): PrivateOrderResponse {
  const { order } = stored;
  return {
    sellToken: order.sellToken.toString(),
    buyToken: order.buyToken.toString(),
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    maxFee: order.maxFee.toString(),
    expiry: order.expiry.toString(),
    nonce: order.nonce.toString(),
    pubKeyAx: order.pubKeyAx.toString(),
    pubKeyAy: order.pubKeyAy.toString(),
    status: stored.status,
    submittedAt: stored.submittedAt,
    settleTxHash: stored.settleTxHash,
    crossRelayer: stored.crossRelayer,
  };
}
