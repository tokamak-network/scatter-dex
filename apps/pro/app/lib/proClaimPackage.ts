/** Build a full `ClaimPackage` (the wire format Pay generates for
 *  recipients) from a Pro `OrderRecord` + a target recipient row.
 *  The shape is identical to Pay's, so a link produced here decodes
 *  through `decodeClaimPackage` and lands in Pay/Pro's shared
 *  `/claims` inbox unchanged.
 *
 *  Heavy lift: reconstruct the order's 16-leaf claims tree on demand
 *  via `buildClaimsTree` and pull the per-leaf inclusion proof via
 *  `getMerkleProof`. The Pro order persists the leaves' raw fields
 *  (secret/recipient/token/amount/releaseTime/leafIndex) but not
 *  the path elements, so we have to derive them when the user
 *  clicks Copy / Email rather than at order-submit time. Cost is
 *  ~ms-scale (Poseidon over 31 internal nodes); acceptable for an
 *  on-click action. */

import { encodeClaimPackage, type ClaimPackage } from "@zkscatter/sdk/notes";
import { buildClaimsTree, getMerkleProof } from "@zkscatter/sdk/zk";
import type { OrderClaim, OrderRecord } from "./orders";

export interface BuildClaimPackageInput {
  order: OrderRecord;
  /** Target row in `order.claims` (or the legacy singular `claim`)
   *  the operator is sharing the link for. */
  target: OrderClaim;
  chainId: number;
  /** PrivateSettlement address that holds the claims group on-chain.
   *  Sourced from `network.contracts.privateSettlement`. */
  settlementAddress: string;
  /** Token list from active network — used to attach `tokenSymbol` +
   *  `tokenDecimals` so the recipient's claim page can format the
   *  amount without an extra RPC. */
  tokens: readonly { address: string; symbol: string; decimals: number }[];
  /** Optional display labels the recipient page surfaces — sender
   *  name / order label. Both are purely informational and not
   *  bound into the proof. */
  senderLabel?: string;
  /** Optional relayer base URL for the gasless claim path. Comes
   *  from `order.relayer.url` when present. */
  relayerUrl?: string;
}

export async function buildClaimPackageFromOrder(
  input: BuildClaimPackageInput,
): Promise<ClaimPackage> {
  const { order, target, chainId, settlementAddress, tokens, senderLabel, relayerUrl } = input;

  // Source of truth for the tree is `order.claims` (the full
  // recipient list captured at submit). Legacy rows that only have
  // the singular `claim` fall back to wrapping that as a singleton
  // so the tree still builds (1 leaf + 15 zero pads).
  const allClaims: OrderClaim[] =
    order.claims && order.claims.length > 0
      ? order.claims
      : order.claim
        ? [order.claim]
        : [];
  if (allClaims.length === 0) {
    throw new Error("buildClaimPackageFromOrder: order has no claim material");
  }
  if (target.leafIndex < 0 || target.leafIndex >= 16) {
    // Tier-16 cap is the only authorize tier today. Higher tiers
    // would need to pass through buildClaimsTree's `tier` arg.
    throw new Error(
      `buildClaimPackageFromOrder: leafIndex ${target.leafIndex} out of range`,
    );
  }

  // buildClaimsTree zero-pads sub-cap claims and Poseidon-hashes
  // every leaf in tier order, so passing the raw OrderClaim list
  // (in their natural index order) produces a tree whose root
  // matches the one stamped on-chain at settle time.
  const ordered = [...allClaims].sort((a, b) => a.leafIndex - b.leafIndex);
  const { root, layers } = await buildClaimsTree(
    ordered.map((c) => ({
      secret: c.secret,
      recipient: BigInt(c.recipient),
      token: BigInt(c.token),
      amount: c.amount,
      releaseTime: c.releaseTime,
    })),
  );
  const { pathElements, pathIndices } = getMerkleProof(layers, target.leafIndex);

  // `claimsRoot` on the OrderClaim was captured at submit when
  // available; cross-check it against the rebuilt root and warn
  // (don't reject) — a mismatch is a sign of a stale persisted
  // record but the live tree we just built is still authoritative
  // for the link we hand the recipient.
  if (target.claimsRoot && BigInt(target.claimsRoot) !== root) {
    console.warn(
      "[proClaimPackage] persisted claimsRoot differs from rebuilt root",
      { persisted: target.claimsRoot, rebuilt: "0x" + root.toString(16) },
    );
  }

  // Token symbol/decimals lookup — fall back to a generic 18-dec
  // "(unknown)" stub if the chain config doesn't include this token
  // so the package still decodes. The recipient page renders raw
  // wei in that fallback case.
  const tokenLower = target.token.toLowerCase();
  const tok = tokens.find((t) => t.address.toLowerCase() === tokenLower);
  const tokenSymbol = tok?.symbol ?? "TOKEN";
  const tokenDecimals = tok?.decimals ?? 18;

  return {
    version: 1,
    chainId,
    settlementAddress,
    claimsRoot: "0x" + root.toString(16).padStart(64, "0"),
    recipient: target.recipient,
    token: target.token,
    tokenSymbol,
    tokenDecimals,
    amount: target.amount.toString(),
    releaseTime: target.releaseTime.toString(),
    secret: target.secret.toString(),
    leafIndex: target.leafIndex,
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices,
    senderLabel,
    runLabel: order.label,
    relayerUrl,
  };
}

/** Compose the recipient-facing URL: `{origin}/claim?id={runId}_{leaf}#<encoded>`.
 *  Matches Pay's `buildClaimUrl` shape so the inbox / claim page
 *  parses it identically. */
export function buildClaimLink(origin: string, order: OrderRecord, pkg: ClaimPackage): string {
  const id = `${order.id}_${pkg.leafIndex}`;
  return `${origin}/claim?id=${id}#${encodeClaimPackage(pkg)}`;
}
