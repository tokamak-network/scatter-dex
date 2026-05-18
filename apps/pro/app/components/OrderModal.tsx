"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZERO_ADDRESS } from "@zkscatter/sdk";
import {
  randomFieldElement,
  type AuthorizeProofInput,
  type ClaimEntry,
} from "@zkscatter/sdk/zk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { useIdentityForAddresses, useIdentityGate } from "../lib/identity";
import { IdentityGateModal } from "./IdentityGateModal";
import { useOrders } from "../lib/orders";
import { useEdDSAKey } from "@zkscatter/sdk/react";
import { useRelayers } from "../lib/relayers";
import { authorizeProver } from "../lib/authorizeProver";
import { parseUnits } from "../lib/parseUnits";
import { buildEmptyTreeProof } from "../lib/emptyTreeProof";
import { useCommitmentTree, getMerkleProofWithFallback } from "../lib/commitmentTree";
import { buildClaimsTree, computeCommitment, toBytes32Hex } from "@zkscatter/sdk/zk";
import { formatTokenAmount, formatWhen } from "../lib/format";
import { applyFeeBig } from "../lib/fee";
import type { VaultNote } from "../lib/vault";
import {
  releaseAtToUnixSec,
  useTradeForm,
  type RecipientRow,
} from "../lib/tradeForm";
import { DEMO_NETWORK } from "../lib/network";
import { buildAuthorizeOrderBody, dispatchAuthorize } from "../lib/dispatch";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { isAbortError } from "../lib/abort";

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  // `orderLabel` is the display label (e.g. "ord-3"), not the
  // stable internal `OrderRecord.id`. Keeping the field name
  // honest about what it carries.
  | { kind: "success"; orderLabel: string }
  | { kind: "error"; message: string };

interface OrderModalProps {
  open: boolean;
  onClose: () => void;
  /** Fires once the order has been confirmed in `phase=success`.
   *  Page-level state (Sign & submit button, recipients list,
   *  bulk claim-from) resets here so the workbench doesn't stay
   *  on the just-submitted form after the user dismisses. */
  onSubmitted?: () => void;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  /** The vault note funding this order. Null when the vault is
   *  empty — the modal still renders but the submit button is
   *  disabled with a clear message. */
  note: VaultNote | null;
}

/** Format a quote-token-denominated estimated fill (price × size).
 *  Uses string-based parsing so an 18-decimal token doesn't lose
 *  precision and a fixed `en-US` locale so SSR and client agree. */
function estimateFill(price: string, size: string): string {
  try {
    // The form accepts comma-separated thousands ("4,205") and a
    // dot decimal. parseUnits doesn't tolerate commas, so strip
    // them first.
    const cleanPrice = price.replace(/,/g, "");
    const cleanSize = size.replace(/,/g, "");
    // Use 8 fractional digits — enough headroom for any pair, then
    // rebuild the display string.
    const priceUnits = parseUnits(cleanPrice, 8);
    const sizeUnits = parseUnits(cleanSize, 8);
    // (price * size) at 8+8 = 16 fractional digits. Format the
    // integer-part and a 2-digit fractional part for display.
    const product = priceUnits * sizeUnits;
    const denom = 10n ** 16n;
    const whole = product / denom;
    const frac = ((product % denom) * 100n) / denom; // 2 frac digits
    const wholeStr = whole.toLocaleString("en-US");
    const fracStr = frac.toString().padStart(2, "0");
    return `$${wholeStr}.${fracStr}`;
  } catch {
    return "—";
  }
}

/** Map the form's recipient rows into circuit `ClaimEntry`s.
 *
 *  Default single-row case: empty address → "send the full
 *  net receive (buyAmount − relayer fee) to my own connected
 *  wallet".
 *
 *  Multi-row case: every row needs an explicit amount; the sum must
 *  equal `netReceive` (= buyAmount − fee). The on-chain check is
 *  `totalLocked + fee ≤ sellAmount` (validateScatterAuth) /
 *  `maker.totalLocked + feeTokenMaker ≤ taker.sellAmount`
 *  (validateAuthorize) — so any larger sum would settle-revert with
 *  ClaimsCapExceeded after the prove burn. */
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function resolveClaims(
  rows: readonly RecipientRow[],
  defaultRecipient: string,
  buyTokenAddress: string,
  buyTokenDecimals: number,
  netReceive: bigint,
): ClaimEntry[] {
  // Auto-fill convention: a single row with no amount = "send the
  // entire net-receive to this recipient". In every other case
  // (single row with explicit amount, or multi-row), the sum of all
  // explicit amounts must equal netReceive — including the single-
  // row case, so a typo can't underspend the order silently.
  const autoFillSingle = rows.length === 1 && !rows[0]!.amount.trim();

  let total = 0n;
  for (const r of rows) {
    if (autoFillSingle) continue;
    if (!r.amount.trim()) {
      throw new Error(
        `Recipient #${rows.indexOf(r) + 1} is missing an amount.`,
      );
    }
    try {
      total += parseUnits(r.amount.replace(/,/g, ""), buyTokenDecimals);
    } catch {
      throw new Error(
        `Recipient #${rows.indexOf(r) + 1} amount "${r.amount}" is not a valid number.`,
      );
    }
  }
  if (!autoFillSingle && total !== netReceive) {
    const diff = total > netReceive ? total - netReceive : netReceive - total;
    throw new Error(
      `Recipient amounts must sum to the post-fee net receive. Off by ${
        total > netReceive ? "+" : "−"
      }${formatTokenAmount(diff, buyTokenDecimals)}.`,
    );
  }

  // Trim once; reuse for both validation and build.
  const trimmedAddrs = rows.map((r) => r.address.trim());

  // Validate recipient addresses up front so a typo doesn't surface
  // mid-prove with a cryptic BigInt parse error.
  for (let i = 0; i < rows.length; i++) {
    const trimmed = trimmedAddrs[i]!;
    if (!trimmed) continue; // empty = self
    if (!ADDR_RE.test(trimmed)) {
      throw new Error(
        `Recipient #${i + 1} address "${trimmed}" is not a valid 0x… address.`,
      );
    }
  }

  return rows.map((r, i) => {
    const trimmed = trimmedAddrs[i]!;
    const recipient = trimmed || defaultRecipient;
    const amount = autoFillSingle
      ? netReceive
      : parseUnits(r.amount.replace(/,/g, ""), buyTokenDecimals);
    return {
      secret: randomFieldElement(),
      recipient,
      token: buyTokenAddress,
      amount,
      // releaseTime is patched in the submit flow with `nowSec + delaySeconds(row)`.
      releaseTime: 0n,
    };
  });
}

export function OrderModal({
  open,
  onClose,
  onSubmitted,
  side,
  pair,
  price,
  size,
  note,
}: OrderModalProps) {
  const { state: identityState, blocking: identityBlocking } = useIdentityGate();

  const { add: addOrder } = useOrders();
  const { account } = useWallet();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const { selected: selectedRelayer } = useRelayers();
  const commitmentTree = useCommitmentTree();
  const toast = useToast();
  // Pull the active pair object + advanced settings from the
  // trade-form context. The `pair` prop is the display string and
  // is still used for record-keeping (so the OrderRecord ends up
  // tagged with the user-facing label even if the form's active
  // pair changes mid-modal).
  const {
    pair: activePair,
    recipients,
    activeTier,
  } = useTradeForm();

  // Gross buy in token-base units, computed from the form's `side` /
  // `price` / `size` once and reused by submit, the confirm-step
  // Relayer-fee row, and any future receive-breakdown rendering. Was
  // open-coded in two places with subtly different decimals
  // (Copilot/Gemini caught the second copy parsing price against the
  // buy-token decimals instead of the always-quote price scale).
  const confirmGrossBuy = useMemo<
    { gross: bigint; decimals: number; symbol: string } | null
  >(() => {
    const baseTok = DEMO_NETWORK.tokens.find((t) => t.symbol === activePair.base);
    const quoteTok = DEMO_NETWORK.tokens.find((t) => t.symbol === activePair.quote);
    const buyTok = side === "sell" ? quoteTok : baseTok;
    if (!baseTok || !quoteTok || !buyTok) return null;
    try {
      const cleanPrice = price.replace(/,/g, "");
      const cleanSize = size.replace(/,/g, "");
      if (!cleanPrice || !cleanSize) return null;
      // Price is always quote-per-base, so parse with quote decimals
      // regardless of side. Size is always in base.
      const priceUnits = parseUnits(cleanPrice, quoteTok.decimals);
      const sizeUnits = parseUnits(cleanSize, baseTok.decimals);
      if (sizeUnits <= 0n) return null;
      const gross = side === "sell"
        ? (priceUnits * sizeUnits) / 10n ** BigInt(baseTok.decimals)
        : sizeUnits;
      return { gross, decimals: buyTok.decimals, symbol: buyTok.symbol };
    } catch {
      return null;
    }
  }, [side, activePair.base, activePair.quote, price, size]);

  // Probe each non-empty recipient against the IdentityRegistry so
  // we can short-circuit submit before paying the 1–2 s prove cost
  // when a recipient hasn't completed zk-X509 verification. Empty
  // rows = `account` (self) and inherit the connected wallet's
  // status, which the parent gate already enforces. The batch hook
  // is shared with the address book + claim flow, so re-checking
  // the same address doesn't refetch.
  const recipientAddresses = useMemo(
    () => recipients.map((r) => r.address.trim()).filter(Boolean),
    [recipients],
  );
  const recipientIdentity = useIdentityForAddresses(recipientAddresses);

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // useRef instead of useState — we never need a re-render on
  // controller changes, only synchronous access from `close()`,
  // and the previous useState pattern had a brief window after
  // `setAbortCtrl(ctrl)` where a sibling close() could read a
  // stale ref.
  const abortCtrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    // Closing after a successful submit means the user has
    // acknowledged the confirmation — tell the page to reset its
    // post-order form so the workbench doesn't stay on the same
    // pre-submit state with Sign & submit still enabled. Fire
    // before mutating phase so the page reset and modal-close
    // happen in the same tick.
    const wasSuccess = phase.kind === "success";
    setPhase({ kind: "idle" });
    if (wasSuccess) onSubmitted?.();
    onClose();
  }, [onClose, onSubmitted, phase.kind]);

  const submit = useCallback(async () => {
    if (!account) {
      setPhase({ kind: "error", message: "Connect a wallet first." });
      return;
    }
    if (!note) {
      setPhase({ kind: "error", message: "Deposit to your vault before placing an order." });
      return;
    }

    // Resolve sell/buy tokens from the active pair + side. Sell side
    // means "sell `pair.base`" (sellToken = base, buyToken = quote);
    // buy side flips them. The vault note must be in the sell-side
    // token — surface that mismatch as a precise error before paying
    // the 1–2 s prove cost.
    const baseToken = DEMO_NETWORK.tokens.find((t) => t.symbol === activePair.base);
    const quoteToken = DEMO_NETWORK.tokens.find((t) => t.symbol === activePair.quote);
    if (!baseToken || !quoteToken) {
      setPhase({
        kind: "error",
        message: `Active network doesn't list ${activePair.display} — switch network or pair.`,
      });
      return;
    }
    const sellToken = side === "sell" ? baseToken : quoteToken;
    const buyToken = side === "sell" ? quoteToken : baseToken;
    if (note.note.token !== BigInt(sellToken.address)) {
      setPhase({
        kind: "error",
        message: `Vault note is in a different token than ${sellToken.symbol}. Deposit ${sellToken.symbol} or switch side / pair.`,
      });
      return;
    }

    let sellAmount: bigint;
    let buyAmount: bigint;
    try {
      const cleanPrice = price.replace(/,/g, "");
      const cleanSize = size.replace(/,/g, "");
      // Sell-side: size is in `base` units (sellAmount), price is
      //   `quote/base`, so buyAmount = size × price (in `quote` units).
      // Buy-side: size is in `base` units (buyAmount), sellAmount =
      //   size × price (in `quote` units).
      if (side === "sell") {
        sellAmount = parseUnits(cleanSize, baseToken.decimals);
        const priceUnits = parseUnits(cleanPrice, quoteToken.decimals);
        const sizeBaseUnits = parseUnits(cleanSize, baseToken.decimals);
        buyAmount =
          (priceUnits * sizeBaseUnits) / 10n ** BigInt(baseToken.decimals);
      } else {
        buyAmount = parseUnits(cleanSize, baseToken.decimals);
        const priceUnits = parseUnits(cleanPrice, quoteToken.decimals);
        const sizeBaseUnits = parseUnits(cleanSize, baseToken.decimals);
        sellAmount =
          (priceUnits * sizeBaseUnits) / 10n ** BigInt(baseToken.decimals);
      }
    } catch (e) {
      setPhase({
        kind: "error",
        message: (e as Error)?.message ?? "Invalid price or size.",
      });
      return;
    }
    if (sellAmount <= 0n || buyAmount <= 0n) {
      setPhase({ kind: "error", message: "Price and size must be positive." });
      return;
    }
    if (sellAmount > note.note.amount) {
      setPhase({
        kind: "error",
        message: `Order size (${size}) exceeds the vault note's balance.`,
      });
      return;
    }

    // Recipient CA gate. The on-chain `claim` call reverts for
    // wallets the `IdentityGate` doesn't see as verified, so reject
    // the order before prove instead of letting the user pay the
    // 1–2 s cost and the relayer pay the gas only to revert.
    // `recipientIdentity.get(addr)` returns `null` while a lookup is
    // pending (treated as OK so a slow RPC doesn't block); once it
    // resolves and reports `isVerified: false` we surface it.
    const unverified: string[] = [];
    for (const r of recipients) {
      const trimmed = r.address.trim();
      if (!trimmed) continue; // empty = self; the parent gate covers this
      const v = recipientIdentity.get(trimmed);
      if (v && !v.isVerified) unverified.push(trimmed);
    }
    if (unverified.length > 0) {
      // Show short-form addresses so the toast/error line stays
      // readable when 3 full 0x… strings would otherwise wrap.
      const preview = unverified.slice(0, 3).map(shortAddr).join(", ");
      const tail = unverified.length > 3 ? ` and ${unverified.length - 3} more` : "";
      setPhase({
        kind: "error",
        message: `Unverified recipient${unverified.length === 1 ? "" : "s"}: ${preview}${tail}. Every recipient must complete zk-X509 verification before the order can settle.`,
      });
      return;
    }

    // Compute the relayer fee that maker authorizes against this
    // buyAmount. `maxFeeBps` (user-signed) is the cap; the relayer's
    // currently-quoted `fee` is the projected actual charge. Until
    // the matcher reports a final fee, the safe upper bound for what
    // recipients receive is `buyAmount − fee_at_max(buyAmount, maxFee)`
    // — but for UX we plan against the relayer's quote (which the
    // matcher will respect), keeping the cap as a back-stop. Either
    // way, sum(claims) ≤ buyAmount − fee (on-chain ClaimsCapExceeded
    // otherwise).
    // Auto-derived fee cap. Was a user-facing slider in Advanced
    // Settings (defaulted to 30 bps), removed in favour of a derived
    // value: the relayer's currently-quoted fee + 10% headroom,
    // clamped to MAX_RELAYER_FEE_BPS=500 (matches the on-chain cap
    // in RelayerRegistry). Caps a hostile relayer that registers low
    // and then bumps their on-chain fee between sign and settle,
    // without making the operator manage a slider they almost always
    // left at default.
    const relayerFeeBps = selectedRelayer?.fee ?? 0;
    const REGISTRY_MAX_FEE_BPS = 500;
    const autoMaxFeeBps = Math.min(
      Math.max(Math.ceil(relayerFeeBps * 1.1), relayerFeeBps + 1),
      REGISTRY_MAX_FEE_BPS,
    );
    const projectedFeeBps = Math.min(relayerFeeBps, autoMaxFeeBps);
    const { net: netReceive } = applyFeeBig(buyAmount, projectedFeeBps);

    // Resolve recipient distribution from the trade-form context.
    // Default (single empty row) is interpreted as "send the net
    // receive to my own connected wallet". Multi-row mode requires
    // explicit amount entry per row; the sum must equal `netReceive`.
    let resolved: ClaimEntry[];
    try {
      resolved = resolveClaims(
        recipients,
        account,
        buyToken.address,
        buyToken.decimals,
        netReceive,
      );
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : "Recipients invalid.",
      });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      setPhase({ kind: "preparing" });
      const eddsaKey = await deriveEdDSA();
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Capture a single `nowSec` and thread it through every
      // timestamp helper so the order's expiry + each claim's
      // release time can't drift across a second boundary mid-
      // build. Falls back inside the helpers when the user left
      // the corresponding input empty.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));

      const claims: ClaimEntry[] = resolved.map((r, i) => ({
        ...r,
        releaseTime: releaseAtToUnixSec(recipients[i]!, nowSec),
      }));

      // Auto-derive settle-by from the (now-resolved) per-recipient
      // release times. Settle MUST be before earliest claim — capping
      // beyond it (a previous "max 1h from now" rule) would let the
      // order expire while claim times remain in the future, leaving
      // recipients with nothing to claim. Rule is just:
      //   - earliest claim minus 5min buffer (matches the indicator)
      //   - if no claim times set → now + 1h (legacy default)
      //   - if earliest claim < 6min away → refuse (no time to settle)
      const claimSecs = claims.map((c) => c.releaseTime).filter((s) => s > nowSec);
      const minClaim = claimSecs.length > 0
        ? claimSecs.reduce((a, b) => (a < b ? a : b))
        : null;
      let expirySec: bigint;
      if (minClaim === null) {
        expirySec = nowSec + 3600n;
      } else if (minClaim - nowSec < 360n) {
        throw new Error(
          `Earliest claim time is ${Number(minClaim - nowSec)} sec away — too tight to settle before. Push the claim time at least 6 minutes out.`,
        );
      } else {
        expirySec = minClaim - 300n;
      }

      const commitment = await computeCommitment(note.note);
      const { merkleProof, leafIndex } = await getMerkleProofWithFallback(
        commitmentTree,
        commitment,
        () => buildEmptyTreeProof(note.note),
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const nonce = randomFieldElement();

      // Relayer address is bound into the proof (and the order hash),
      // so the user's pick has to be cached before prove. Falls back
      // to the zero address when no relayer is selected — the
      // dispatch layer then short-circuits to a simulated submission
      // so the UI flow stays exercisable without a registry. Same
      // pattern the cancel modal uses.
      const relayerAddress = selectedRelayer?.address ?? ZERO_ADDRESS;

      const input: AuthorizeProofInput = {
        note: note.note,
        leafIndex,
        merkleProof,
        sellAmount,
        buyToken: buyToken.address,
        buyAmount,
        maxFee: BigInt(autoMaxFeeBps),
        expiry: expirySec,
        nonce,
        relayer: relayerAddress,
        eddsaPrivateKey: eddsaKey.privateKey,
        claims,
      };

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      await authorizeProver.ready();
      const proveResult = await authorizeProver.prove(
        { circuitId: "authorize", input: input as unknown as Record<string, unknown> },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // Hand off to the selected relayer's `POST /api/authorize-orders`
      // endpoint. Dispatch falls back to `simulated` when no relayer
      // is configured or the privateSettlement address isn't wired up
      // for the active network — the local order record still persists
      // in either case so the user can exercise the claim/cancel UI.
      // Same `activeTier` RecipientsSection rendered in its copy, so
      // the authorize circuit can't drift from the label the user
      // just read. Source-of-truth lives on the form context.
      const body = buildAuthorizeOrderBody(
        proveResult,
        eddsaKey.publicKey,
        activeTier.cap,
      );
      const dispatch = await dispatchAuthorize(
        selectedRelayer?.url ?? null,
        body,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Persist enough material on the order record that the user
      // can later run the claim flow without re-deriving from chain
      // events. Phase 5 swaps to reading this from a settled
      // on-chain event.
      // First claim's material is what apps/pro stores on the
      // OrderRecord — sufficient to drive the single-recipient claim
      // flow that today's UI exercises. Multi-claim history surfaces
      // when a per-recipient drawer / inbox lands.
      const firstClaim = claims[0]!;
      // Pre-compute the claims-tree root the same way the authorize
      // circuit will when the order eventually settles on-chain.
      // Stored on the order record so the claim reconciler can match
      // an emitted `PrivateClaim` event back to this order without
      // re-deriving from chain state.
      const { root: claimsRoot } = await buildClaimsTree(claims);
      // Honor a Cancel that landed during buildClaimsTree — without
      // this the order would still post to addOrder + the success
      // toast would fire after the user explicitly aborted.
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const order = addOrder({
        nonce,
        noteId: note.id,
        side,
        pair,
        price,
        size,
        claim: {
          secret: firstClaim.secret,
          recipient: firstClaim.recipient,
          token: firstClaim.token,
          amount: firstClaim.amount,
          releaseTime: firstClaim.releaseTime,
          leafIndex: 0,
          claimsRoot: toBytes32Hex(claimsRoot),
        },
      });
      setPhase({ kind: "success", orderLabel: order.label });
      const action = side === "sell" ? "Sell" : "Buy";
      const description =
        dispatch.kind === "relayer"
          ? `${action} ${size} @ ${price} — relayer accepted (status: ${dispatch.status.status}).`
          : dispatch.kind === "simulated"
            ? `${action} ${size} @ ${price} — simulated (${dispatch.reason}).`
            : `${action} ${size} @ ${price} — matching now.`;
      toast.push({
        kind: "success",
        title: `${order.label} submitted`,
        description,
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      console.error("[order]", e);
      const msg = e instanceof Error ? e.message : "Order failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Order failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [
    side, pair, price, size, account, note,
    activePair, recipients,
    deriveEdDSA, addOrder, toast, commitmentTree,
    selectedRelayer, recipientIdentity,
  ]);

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  // Identity gate — when the wallet's verification status is
  // unverified / expired / error, show the gate prompt in place
  // of the confirm-order content.
  if (open && identityBlocking) {
    return <IdentityGateModal state={identityState} onClose={close} />;
  }

  return (
    <Modal open={open} onClose={close} title="Confirm private order">
      <TestnetNotice />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
        <Row k="Pair" v={pair} />
        <Row k="Side" v={side === "sell" ? "Sell" : "Buy"} />
        <Row k="Price" v={price} />
        <Row k="Size" v={size} />
        <Row k="Estimated fill" v={estimateFill(price, size)} />
        {/* "vs Uniswap" was hardcoded `−0.7% slippage` regardless of
            pair / price / size — a confident-looking lie at the most
            critical decision point. Removed until we wire FillEstimate's
            real spot diff here (it's already computed on the trade
            form via useReferencePrice). */}
        {/* Relayer fee row — taken from the connected relayer's
            quoted bps, clamped to the user-signed maxFee cap. The
            "Free (launch event)" copy referred to a *platform* fee
            that doesn't apply here; this row is the actual amount
            deducted from buyAmount before recipient distribution. */}
        {(() => {
          // Confirm-row uses the relayer's quoted fee directly —
          // autoMaxFeeBps is the on-chain cap, not the displayed
          // charge. Mirrors the projection on the order form.
          const bps = selectedRelayer?.fee ?? 0;
          if (!confirmGrossBuy) {
            return <Row k="Relayer fee" v="—" />;
          }
          const { fee } = applyFeeBig(confirmGrossBuy.gross, bps);
          const feeStr = bps > 0
            ? `${formatTokenAmount(fee, confirmGrossBuy.decimals)} ${confirmGrossBuy.symbol} (${bps} bps)`
            : `0 ${confirmGrossBuy.symbol} (0 bps)`;
          return <Row k="Relayer fee" v={feeStr} />;
        })()}
      </dl>

      {/* Surface every row at confirm so an N-recipient vesting
          schedule isn't signed blind. Empty fields mirror runtime
          defaults (self / immediate). */}
      {recipients.length > 0 && (() => {
        const receiveSymbol = side === "sell" ? activePair.quote : activePair.base;
        // Normalize the row amount through parseUnits → formatTokenAmount
        // so the confirm-step display matches what gets signed
        // (e.g. "1,000.0" and "1000" both render as "1000"); fall
        // back to a "—" placeholder when the row can't parse so a typo
        // doesn't look like a valid amount at the most critical step.
        const receiveToken = DEMO_NETWORK.tokens.find((t) => t.symbol === receiveSymbol);
        const receiveDecimals = receiveToken?.decimals ?? 18;
        const formatRowAmount = (raw: string): string => {
          if (!raw.trim()) return "—";
          try {
            const wei = parseUnits(raw.replace(/,/g, ""), receiveDecimals);
            return formatTokenAmount(wei, receiveDecimals);
          } catch {
            return "—";
          }
        };
        return (
          <section className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
            <div className="border-b border-[var(--color-border)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Recipients ({recipients.length})
            </div>
            <ol className="divide-y divide-[var(--color-border)] text-xs">
              {recipients.map((r, i) => {
                const addr = r.address.trim();
                // Use releaseAtToUnixSec (same helper the submit path
                // uses) so the timestamp shown at confirm matches what
                // gets committed in the claim, byte-for-byte. Empty
                // releaseAt still surfaces as "immediate" — the submit
                // path falls back to `nowSec`, which is semantically
                // identical from the user's perspective.
                const releaseLabel = r.releaseAt.trim()
                  ? formatWhen(Number(releaseAtToUnixSec(r)) * 1000)
                  : "immediate";
                // Address may be blank (self), so key on address+index
                // — index alone is fragile if rows reorder.
                return (
                  <li
                    key={`${addr || "self"}-${i}`}
                    className="grid grid-cols-[24px_1fr_auto] items-center gap-3 px-3 py-2"
                  >
                    <span className="text-[var(--color-text-subtle)]">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono">
                        {addr ? shortAddr(addr) : "self (your wallet)"}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-subtle)]">
                        {releaseLabel}
                      </span>
                    </span>
                    <span className="font-mono">
                      {formatRowAmount(r.amount)} {receiveSymbol}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })()}

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            {/* Cancel stays enabled mid-submit — escape hatch fires
                the AbortController which unwinds the prover and the
                simulated submission. */}
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Close"}
            </Button>
            <Button
              onClick={submit}
              disabled={busy || isDeriving || !account || !note}
              title={
                !account
                  ? "Connect a wallet first"
                  : !note
                  ? "Deposit to your vault first"
                  : undefined
              }
            >
              {busy
                ? "Working…"
                : isDeriving
                ? "Awaiting signature…"
                : "Sign & submit"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "success") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Order submitted
        </div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          {phase.orderLabel} is now matching against the orderbook. Open
          the Orders page to track it.
        </div>
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing order…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK proof…"
      : "Submitting to relayer…";

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}
