"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  randomFieldElement,
  type AuthorizeProofInput,
  type ClaimEntry,
} from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";
import { useOrders } from "../lib/orders";
import { useEdDSAKey } from "../lib/eddsaKey";
import { getAuthorizeProver } from "../lib/authorizeProver";
import { parseUnits } from "../lib/parseUnits";
import { buildEmptyTreeProof } from "../lib/emptyTreeProof";
import type { VaultNote } from "../lib/vault";
import {
  delaySeconds,
  expirySeconds,
  useTradeForm,
  type RecipientRow,
} from "../lib/tradeForm";
import { DEMO_NETWORK } from "../lib/network";
import { Button, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { abortableSleep, isAbortError } from "../lib/abort";

const STEALTH_PLACEHOLDER = "0x0000000000000000000000000000000000005ea1";

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
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  /** The vault note funding this order. Null when the vault is
   *  empty — the modal still renders but the submit button is
   *  disabled with a clear message. */
  note: VaultNote | null;
}

// Relayer placeholder until relayer-registry context threads a real
// selection through. Phase 5d-followup reads this from `useRelayers().selected`.
const DEMO_RELAYER = "0x0000000000000000000000000000000000000099";

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
 *  buyAmount to my own connected wallet". Common path; no manual
 *  amount needed.
 *
 *  Multi-row case: every row needs an explicit amount; the sum must
 *  equal `buyAmount` (no auto-fill — fill-rest UX is a follow-up).
 *  Stealth mode currently uses a placeholder recipient address; the
 *  real `deriveStealthAddress` integration ships with the SDK
 *  stealth migration. */
function resolveClaims(
  rows: readonly RecipientRow[],
  defaultRecipient: string,
  buyTokenAddress: string,
  buyTokenDecimals: number,
  buyAmount: bigint,
): ClaimEntry[] {
  const single = rows.length === 1;
  const total = rows.reduce<bigint>((acc, r) => {
    if (single && !r.amount.trim()) return buyAmount;
    if (!r.amount.trim()) return acc;
    try {
      return acc + parseUnits(r.amount.replace(/,/g, ""), buyTokenDecimals);
    } catch {
      return acc;
    }
  }, 0n);
  if (!single && total !== buyAmount) {
    throw new Error(
      `Recipient amounts (sum) must equal the order's buy amount. Off by ${
        total > buyAmount ? "+" : "−"
      }${(total > buyAmount ? total - buyAmount : buyAmount - total).toString()} units.`,
    );
  }

  return rows.map((r) => {
    const recipient = (() => {
      const trimmed = r.address.trim();
      if (r.mode === "stealth") return STEALTH_PLACEHOLDER;
      if (!trimmed) return defaultRecipient;
      return trimmed;
    })();
    const amount =
      single && !r.amount.trim()
        ? buyAmount
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
  side,
  pair,
  price,
  size,
  note,
}: OrderModalProps) {
  const { add: addOrder } = useOrders();
  const { account } = useWallet();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const toast = useToast();
  // Pull the active pair object + advanced settings from the
  // trade-form context. The `pair` prop is the display string and
  // is still used for record-keeping (so the OrderRecord ends up
  // tagged with the user-facing label even if the form's active
  // pair changes mid-modal).
  const { pair: activePair, recipients, expiry: expiryKey, maxFeeBps } = useTradeForm();
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
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

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

    // Resolve recipient distribution from the trade-form context.
    // Default (single empty row) is interpreted as "send everything
    // to my own connected wallet". Multi-row mode requires explicit
    // amount entry per row; the sum must equal `buyAmount` post-fee.
    let resolvedClaims: ClaimEntry[];
    try {
      resolvedClaims = resolveClaims(
        recipients,
        account,
        buyToken.address,
        buyToken.decimals,
        buyAmount,
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

      // Capture once — using `Date.now()` separately for releaseTime
      // and expiry would race the second boundary in rare cases and
      // produce a 1-second discrepancy.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const expirySec = nowSec + BigInt(expirySeconds(expiryKey));

      // Apply per-claim release delays on top of `nowSec`.
      const claims: ClaimEntry[] = resolvedClaims.map((c, i) => ({
        ...c,
        releaseTime: nowSec + BigInt(delaySeconds(recipients[i]!)),
      }));

      // Single-leaf-at-0 empty Merkle tree — see lib/emptyTreeProof.ts.
      const { merkleProof, leafIndex } = await buildEmptyTreeProof(note.note);
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const nonce = randomFieldElement();

      const input: AuthorizeProofInput = {
        note: note.note,
        leafIndex,
        merkleProof,
        sellAmount,
        buyToken: buyToken.address,
        buyAmount,
        maxFee: BigInt(maxFeeBps),
        expiry: expirySec,
        nonce,
        relayer: DEMO_RELAYER,
        eddsaPrivateKey: eddsaKey.privateKey,
        claims,
      };

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      const prover = getAuthorizeProver();
      await prover.ready();
      await prover.prove(
        { circuitId: "authorize", input: input as unknown as Record<string, unknown> },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );

      setPhase({ kind: "submitting" });
      // Phase 5+ wires relayer submission. For now just simulate
      // the latency so the flow feels coherent.
      await abortableSleep(500, ctrl.signal);

      // Persist enough material on the order record that the user
      // can later run the claim flow without re-deriving from chain
      // events. Phase 5 swaps to reading this from a settled
      // on-chain event.
      // First claim's material is what apps/pro stores on the
      // OrderRecord — sufficient to drive the single-recipient claim
      // flow that today's UI exercises. Multi-claim history surfaces
      // when a per-recipient drawer / inbox lands.
      const firstClaim = claims[0]!;
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
        },
      });
      setPhase({ kind: "success", orderLabel: order.label });
      toast.push({
        kind: "success",
        title: `${order.label} submitted`,
        description: `${side === "sell" ? "Sell" : "Buy"} ${size} @ ${price} — matching now.`,
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
    activePair, recipients, expiryKey, maxFeeBps,
    deriveEdDSA, addOrder, toast,
  ]);

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Confirm private order">
      <TestnetNotice />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
        <Row k="Pair" v={pair} />
        <Row k="Side" v={side === "sell" ? "Sell" : "Buy"} />
        <Row k="Price" v={price} />
        <Row k="Size" v={size} />
        <Row k="Estimated fill" v={estimateFill(price, size)} />
        <Row k="vs Uniswap" v="−0.7% slippage" />
        <Row k="Fee" v="Free (launch event until Dec 31, 2026)" />
      </dl>

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
