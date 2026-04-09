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
const MAX_AMOUNT_128 = (1n << 128n) - 1n; // matches settle.circom Num2Bits(128)
const MAX_FEE_16_BIT = (1n << 16n) - 1n;  // matches settle.circom Num2Bits(16) for fee bps

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

// ─── [M8] Combined parse-and-validate helpers ────────────────────
// Collapse the recurring "toBigInt → validate" pattern that
// parsePrivateOrder used at every numeric field. Centralising the logic
// removes copy-paste drift and makes it impossible to forget the range
// check on a new field.

/** Parse + validate as a BN254 field element. */
function toFieldBigInt(val: unknown, name: string): bigint {
  const v = toBigInt(val, name);
  validateField(v, name);
  return v;
}

/** Parse + validate as a 128-bit unsigned amount. */
function toAmount128BigInt(val: unknown, name: string): bigint {
  const v = toBigInt(val, name);
  validateAmount128(v, name);
  return v;
}

/** Parse + validate as a 160-bit ERC20 address packed into a bigint. */
function toAddressBigInt(val: unknown, name: string): bigint {
  const v = toBigInt(val, name);
  validateAddress(v, name);
  return v;
}

export function parsePrivateOrder(raw: Record<string, unknown>): PrivateOrder {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid order");

  // [M8] Token addresses (160-bit) — parsed and range-checked together.
  const sellToken = toAddressBigInt(raw.sellToken, "sellToken");
  const buyToken = toAddressBigInt(raw.buyToken, "buyToken");

  // [M8] Trade amounts — parsed and 128-bit range-checked together.
  const sellAmount = toAmount128BigInt(raw.sellAmount, "sellAmount");
  const buyAmount = toAmount128BigInt(raw.buyAmount, "buyAmount");
  if (sellAmount <= 0n) throw new Error("sellAmount must be > 0");
  if (buyAmount <= 0n) throw new Error("buyAmount must be > 0");

  // [M8] maxFee is a 16-bit bps value (matches settle.circom Num2Bits(16)).
  const maxFee = toBigInt(raw.maxFee, "maxFee");
  if (maxFee < 0n) throw new Error("maxFee must be >= 0");
  if (maxFee > MAX_FEE_16_BIT) throw new Error("maxFee exceeds 16-bit range");

  // [M8] Order metadata — Poseidon inputs / replay-protection scalars.
  const expiry = toFieldBigInt(raw.expiry, "expiry");
  const nonce = toFieldBigInt(raw.nonce, "nonce");

  // [M8] EdDSA components — must all live in BN254.
  const pubKeyAx = toFieldBigInt(raw.pubKeyAx, "pubKeyAx");
  const pubKeyAy = toFieldBigInt(raw.pubKeyAy, "pubKeyAy");
  const sigS = toFieldBigInt(raw.sigS, "sigS");
  const sigR8x = toFieldBigInt(raw.sigR8x, "sigR8x");
  const sigR8y = toFieldBigInt(raw.sigR8y, "sigR8y");

  // [M8] Escrow material — secret/salt are field elements, balance is 128-bit.
  const ownerSecret = toFieldBigInt(raw.ownerSecret, "ownerSecret");
  const balance = toAmount128BigInt(raw.balance, "balance");
  const salt = toFieldBigInt(raw.salt, "salt");

  const leafIndex = Number(raw.leafIndex);
  if (!Number.isInteger(leafIndex) || leafIndex < 0) throw new Error("invalid leafIndex");

  // [M8] Change-commitment Poseidon inputs / outputs.
  const newSalt = toFieldBigInt(raw.newSalt, "newSalt");
  const expectedChangeCommitment = toFieldBigInt(raw.expectedChangeCommitment, "expectedChangeCommitment");

  const rawClaims = raw.claims as Array<Record<string, unknown>>;
  if (!Array.isArray(rawClaims) || rawClaims.length === 0 || rawClaims.length > MAX_CLAIMS) {
    throw new Error(`claims must be 1-${MAX_CLAIMS}`);
  }

  const claims: ClaimLeafData[] = rawClaims.map((c, i) => ({
    // [M8] Every Poseidon input for the claim leaf hash is parsed and
    //      range-checked through the same helpers as the order body.
    secret: toFieldBigInt(c.secret, `claims[${i}].secret`),
    recipient: toAddressBigInt(c.recipient, `claims[${i}].recipient`),
    token: toAddressBigInt(c.token, `claims[${i}].token`),
    amount: toAmount128BigInt(c.amount, `claims[${i}].amount`),
    releaseTime: toFieldBigInt(c.releaseTime, `claims[${i}].releaseTime`),
  }));

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
