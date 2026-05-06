/** Per-recipient claim payload sent from the operator who settled
 *  the run to each recipient. Carries the per-claim secret + the
 *  inclusion proof needed to claim against `PrivateSettlement`.
 *
 *  Wire format: JSON-serializable strings (decimal-encoded bigints)
 *  so the package can travel through URLs, QR codes, email bodies,
 *  etc. without per-consumer BigInt-awareness. Decoding into native
 *  bigints happens once at the recipient before proving. */
export interface ClaimPackage {
  version: 1;
  chainId: number;
  /** Address of `PrivateSettlement` that holds the claims group. */
  settlementAddress: string;
  /** Bytes32 hex of the claims-tree root the settle stamped. */
  claimsRoot: string;
  /** Recipient EOA — must equal the wallet submitting the claim;
   *  the circuit binds the signed recipient to the proof. */
  recipient: string;
  token: string;
  /** Display symbol (e.g. "USDC") shown to the recipient. The
   *  authoritative on-chain mapping is `token`; this is purely UX
   *  copy so the recipient page can show "1 USDC" instead of
   *  "0x2279…". */
  tokenSymbol: string;
  /** ERC-20 decimals for `token`. Carried in the package so the
   *  recipient page can format the amount without an extra RPC
   *  call (and so the package stays self-contained across chains). */
  tokenDecimals: number;
  /** Decimal string preserving bigint precision across JSON. */
  amount: string;
  /** Unix-seconds release time, decimal string. */
  releaseTime: string;
  /** Per-claim secret, decimal string. */
  secret: string;
  /** 0..15 — leaf index within the 16-leaf claims tree. */
  leafIndex: number;
  /** Decimal-string siblings on the path from the leaf to the root. */
  pathElements: string[];
  /** 0/1 bits for `pathElements`: 1 means the sibling is the left
   *  child at that level. */
  pathIndices: number[];
  /** Optional display labels — purely informational, not signed. */
  senderLabel?: string;
  runLabel?: string;
  /** Optional relayer base URL the operator settled through. When
   *  present, the recipient page can offer a gasless claim path
   *  (`POST <relayerUrl>/api/private-claim`) — the relayer pays gas
   *  in exchange for having settled the run. Absent for runs whose
   *  relayer was unreachable / offline at settle time. */
  relayerUrl?: string;
  /** EIP-5564 ephemeral public key — set only for stealth recipients.
   *  When present, `recipient` is the one-time stealth address (not
   *  the recipient's normal EOA), and the receiver derives the
   *  matching private key locally with their meta-address keys. Sent
   *  alongside the package via the same off-chain channel (email /
   *  messenger), never on-chain — stealth privacy depends on the
   *  ephPub staying off-chain so a leaked viewing key alone doesn't
   *  unmask all incoming claims. */
  ephemeralPubKey?: string;
}

const VERSION = 1 as const;

/** Base64url-encode a ClaimPackage. The result is URL-fragment safe
 *  (no `+`, `/`, or `=` chars) so callers can drop it into the hash
 *  segment of a claim link without further escaping. */
export function encodeClaimPackage(pkg: ClaimPackage): string {
  const json = JSON.stringify(pkg);
  const bytes = new TextEncoder().encode(json);
  return base64UrlEncode(bytes);
}

/** Decode a base64url-encoded ClaimPackage. Throws with a clear
 *  message when the payload is malformed, the JSON is invalid, or
 *  the version / shape doesn't match — so a caller doesn't have to
 *  unwrap a chain of `unknown` checks before showing the user. */
export function decodeClaimPackage(encoded: string): ClaimPackage {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch {
    throw new Error("decodeClaimPackage: malformed base64url payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("decodeClaimPackage: payload is not valid JSON");
  }
  if (!isClaimPackage(parsed)) {
    throw new Error("decodeClaimPackage: payload does not match ClaimPackage v1 shape");
  }
  return parsed;
}

// Loose hex matchers — strict on-chain checksum / case is verified
// later by ethers.getAddress when the recipient's claim page builds
// the proof input. These guard against obvious tampering / corruption
// rather than full schema-level enforcement.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^\d+$/;

// Mirrors the consensus-critical claims-tree shapes the authorize
// circuits produce, one entry per active tier (TIER_16/64/128 →
// depth 4/6/7, cap 16/64/128). Hardcoded here so the SDK notes
// module stays dependency-free relative to the zk constants —
// adding a tier requires extending both lists.
const CLAIMS_PATH_LENS = [4, 6, 7] as const;
const MAX_LEAF_COUNT = 128; // largest tier cap

export function isClaimPackage(v: unknown): v is ClaimPackage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== VERSION) return false;
  if (typeof o.chainId !== "number" || !Number.isInteger(o.chainId)) return false;
  if (typeof o.settlementAddress !== "string" || !ADDRESS_RE.test(o.settlementAddress)) return false;
  if (typeof o.claimsRoot !== "string" || !BYTES32_RE.test(o.claimsRoot)) return false;
  if (typeof o.recipient !== "string" || !ADDRESS_RE.test(o.recipient)) return false;
  if (typeof o.token !== "string" || !ADDRESS_RE.test(o.token)) return false;
  if (typeof o.tokenSymbol !== "string") return false;
  if (typeof o.tokenDecimals !== "number" || !Number.isInteger(o.tokenDecimals)) return false;
  if (typeof o.amount !== "string" || !DECIMAL_RE.test(o.amount)) return false;
  if (typeof o.releaseTime !== "string" || !DECIMAL_RE.test(o.releaseTime)) return false;
  if (typeof o.secret !== "string" || !DECIMAL_RE.test(o.secret)) return false;
  if (
    typeof o.leafIndex !== "number" ||
    !Number.isInteger(o.leafIndex) ||
    o.leafIndex < 0 ||
    o.leafIndex >= MAX_LEAF_COUNT
  )
    return false;
  if (
    !Array.isArray(o.pathElements) ||
    !(CLAIMS_PATH_LENS as readonly number[]).includes(o.pathElements.length) ||
    !o.pathElements.every((e) => typeof e === "string" && DECIMAL_RE.test(e))
  )
    return false;
  if (
    !Array.isArray(o.pathIndices) ||
    o.pathIndices.length !== o.pathElements.length ||
    !o.pathIndices.every((i) => i === 0 || i === 1)
  )
    return false;
  if (o.relayerUrl !== undefined && !isPlausibleHttpUrl(o.relayerUrl)) return false;
  if (
    o.ephemeralPubKey !== undefined &&
    !isCompressedPubkeyHex(o.ephemeralPubKey)
  ) {
    return false;
  }
  return true;
}

/** Shared shape check for an EIP-5564 compressed secp256k1 pubkey
 *  (the `0x` + 33 hex bytes that goes into `ephemeralPubKey` and
 *  similar fields). Exported so storage modules and ABI callers
 *  share one definition. */
export function isCompressedPubkeyHex(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{66}$/.test(v);
}

/** Reject anything that won't reach a real HTTP(S) endpoint. Also
 *  requires a non-empty hostname because `new URL("http:foo")`
 *  parses with `protocol === "http:"` but empty `hostname` (legal
 *  opaque-path URL) and would fail at fetch time with an opaque
 *  error rather than this clear up-front rejection. */
function isPlausibleHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length === 0 || v.length > 2048) return false;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname.length > 0;
  } catch {
    return false;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
