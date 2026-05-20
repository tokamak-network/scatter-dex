// `import type` is erased at compile time, so format.ts has no
// runtime dependency on the zk module — but the helpers stay in
// lockstep with `CommitmentNote` if its fields ever change.
import type { CommitmentNote } from "../zk/commitment";

/** Truncate a transaction hash (or any long hex string) to the
 *  canonical `0xabcd1234…01234` form used across status banners,
 *  modal confirmations, and inline notes. Defaults match the
 *  10/6 split Pay/Pro converged on; pass `prefixLen` / `suffixLen`
 *  for surfaces that want a tighter or looser truncation. */
export function shortTxHash(
  hash: string,
  opts: { prefixLen?: number; suffixLen?: number } = {},
): string {
  const prefixLen = opts.prefixLen ?? 10;
  const suffixLen = opts.suffixLen ?? 6;
  if (!hash) return "";
  if (hash.length <= prefixLen + suffixLen) return hash;
  return `${hash.slice(0, prefixLen)}…${hash.slice(-suffixLen)}`;
}

/** Human time-until for an expiry unix-seconds timestamp. Returns
 *  `"expired"` once the moment passes; otherwise the largest
 *  meaningful unit pair (`Nd Nh`, `Nh Nm`, or `Nm`). */
export function formatExpiry(unixSec: number): string {
  const delta = unixSec - Math.floor(Date.now() / 1000);
  if (delta <= 0) return "expired";
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Render a fixed-point token amount as a decimal string without
 *  pulling `ethers` into the consumer (the SDK already lists it,
 *  apps don't have to). Trims trailing zeros from the fractional
 *  part — `1.5`, not `1.500000`. Negative inputs render with a
 *  leading minus. `decimals === 0` short-circuits to the integer.
 *  Shared by every list view that surfaces raw `bigint` balances
 *  (operators treasury / leaderboard, pro orders, …). */
export function formatTokenAmount(amount: bigint, decimals: number): string {
  // Defend against `decimals <= 0` — `10n ** BigInt(-1)` throws,
  // so an unexpected zero/negative slips through as the integer
  // form rather than a runtime error.
  if (decimals <= 0) return amount.toString();
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Render a wei bigint as ETH for callers that hold a raw
 *  `RelayerOnChain.bond` / `FeeVault.balances` value and want to
 *  display it without their own ethers dependency. Note: trims
 *  trailing zeros (`"1"`, not `"1.0"`), so output diverges from
 *  `ethers.formatEther` and from `OperatorRow.bondEth` (which is
 *  built via `ethers.formatEther` and always keeps `".0"`). Keep
 *  this distinction in mind when picking between fields rendered
 *  side-by-side from both sources. */
export function formatEther(wei: bigint): string {
  return formatTokenAmount(wei, 18);
}

/** Compact hex string for storing a non-negative `bigint` in JSON
 *  (`"0x" + v.toString(16)`). Mirrored across every wire-format
 *  call site — IDB notes adapter, folder notes adapter, frontend's
 *  `note-storage.ts` — so the format stays in lockstep when one
 *  side changes.
 *
 *  Throws for negative inputs because `"0x-1"` is not valid
 *  `BigInt(...)` syntax — the round-trip would silently corrupt.
 *  Every caller in the codebase passes a zk field element
 *  (commitment, ownerSecret, salt, …) which is always ≥ 0; the
 *  guard catches an accidental signed value before it lands on
 *  disk. Use a different encoding if signed support is ever
 *  needed. */
export function bigintToHex(v: bigint): string {
  if (v < 0n) {
    throw new Error("bigintToHex: negative bigints are not supported");
  }
  return "0x" + v.toString(16);
}

/** Hex-encoded mirror of a `CommitmentNote`. The shape every notes
 *  adapter writes to disk for the preimage half of a `StoredNote`.
 *
 *  `pubKeyAx` / `pubKeyAy` are optional because v1 deposit records
 *  (predating the BabyJub binding) sit on disk in some users'
 *  notes folders. Writers always populate both — `notePreimageToHex`
 *  doesn't accept a v1 input. Readers (`notePreimageFromHex`) check
 *  at runtime and surface the canonical "re-deposit required" error
 *  when they're missing, rather than dropping the record silently. */
export interface NotePreimageHex {
  ownerSecret: string;
  token: string;
  amount: string;
  salt: string;
  pubKeyAx?: string;
  pubKeyAy?: string;
}

/** Hex-encode a `CommitmentNote` for a wire-format note record.
 *  Adapters previously inlined six `bigintToHex` calls; this keeps
 *  the conversion in one place so the format stays consistent (and
 *  any future field addition lands once instead of three times). */
export function notePreimageToHex(n: CommitmentNote): NotePreimageHex {
  return {
    ownerSecret: bigintToHex(n.ownerSecret),
    token: bigintToHex(n.token),
    amount: bigintToHex(n.amount),
    salt: bigintToHex(n.salt),
    pubKeyAx: bigintToHex(n.pubKeyAx),
    pubKeyAy: bigintToHex(n.pubKeyAy),
  };
}

/** Inverse of {@link notePreimageToHex}. Throws when `pubKeyAx` /
 *  `pubKeyAy` are missing — a v1-format note that can't be spent
 *  with v2 circuits. Callers should catch and surface "re-deposit
 *  required" rather than dropping the record silently. */
export function notePreimageFromHex(h: NotePreimageHex): CommitmentNote {
  if (!h.pubKeyAx || !h.pubKeyAy) {
    throw new Error(
      "Note missing pubKeyAx/pubKeyAy — v1 note that cannot be used with v2 circuits. Re-deposit required.",
    );
  }
  return {
    ownerSecret: BigInt(h.ownerSecret),
    token: BigInt(h.token),
    amount: BigInt(h.amount),
    salt: BigInt(h.salt),
    pubKeyAx: BigInt(h.pubKeyAx),
    pubKeyAy: BigInt(h.pubKeyAy),
  };
}
