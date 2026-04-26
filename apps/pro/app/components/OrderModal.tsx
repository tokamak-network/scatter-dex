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
import { useToast } from "./Toast";

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

// Demo placeholders. Phase 5 reads these from on-chain state /
// user choice (relayer registry + token list).
const DEMO_BUY_TOKEN = "0x0000000000000000000000000000000000000002";
const DEMO_RELAYER = "0x0000000000000000000000000000000000000099";
const ORDER_LIFETIME_MS = 60 * 60 * 1000; // 1h

function isAbortError(e: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof DOMException !== "undefined" && e instanceof DOMException) {
    return e.name === "AbortError";
  }
  return (e as Error)?.name === "AbortError";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // useRef instead of useState — we never need a re-render on
  // controller changes, only synchronous access from `close()`,
  // and the previous useState pattern had a brief window after
  // `setAbortCtrl(ctrl)` where a sibling close() could read a
  // stale ref.
  const abortCtrlRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  // Escape-to-close + initial focus into the dialog. Only attach
  // while open. This is *not* a full focus trap — Tab can still
  // reach focusable elements behind the backdrop because we don't
  // mark the rest of the page inert. Good enough for a confirm
  // dialog where the underlying page is mostly non-interactive
  // while the modal is up; a sentinel-pair trap can land later if
  // we add modals over more interactive surfaces.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    initial?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      // Restore focus to whatever was focused before the modal
      // opened, so Esc-then-Tab feels right.
      previouslyFocused?.focus?.();
    };
  }, [open, close]);

  const submit = useCallback(async () => {
    if (!account) {
      setPhase({ kind: "error", message: "Connect a wallet first." });
      return;
    }
    if (!note) {
      setPhase({ kind: "error", message: "Deposit to your vault before placing an order." });
      return;
    }
    if (side !== "sell") {
      // The proof always sells the deposited token; supporting "Buy"
      // requires the user to have a quote-token note in the vault and
      // a token-aware decimals lookup. Phase 5 wires the token list +
      // proper side handling.
      setPhase({
        kind: "error",
        message:
          "Buy side isn't wired yet — this demo only supports selling the deposited token. Phase 5 adds proper side handling against the token list.",
      });
      return;
    }

    let sellAmount: bigint;
    let buyAmount: bigint;
    try {
      // Demo decimals — Phase 5 derives these from a real token list.
      // Sell side: deposited token (assume 18 dec like ETH/WETH);
      // Buy side: USDC-shaped quote token (6 dec).
      sellAmount = parseUnits(size.replace(/,/g, ""), 18);
      const priceUnits = parseUnits(price.replace(/,/g, ""), 6);
      const sizeUnits = parseUnits(size.replace(/,/g, ""), 18);
      buyAmount = (priceUnits * sizeUnits) / 10n ** 18n;
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
    // Circuit invariant: sellAmount ≤ note.amount (overspending the
    // escrow is rejected by authorize.circom). Catching it here saves
    // the user a 1–2 s proof followed by the SDK's pre-check throw.
    if (sellAmount > note.note.amount) {
      setPhase({
        kind: "error",
        message: `Order size (${size}) exceeds the vault note's balance.`,
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
      const horizonSec = nowSec + BigInt(Math.floor(ORDER_LIFETIME_MS / 1000));

      // Build a single-claim distribution: the user receives
      // `buyAmount` of the buy token at their own EOA. Phase 4 adds
      // multi-claim + stealth address support.
      const claim: ClaimEntry = {
        secret: randomFieldElement(),
        recipient: account,
        token: DEMO_BUY_TOKEN,
        amount: buyAmount,
        releaseTime: horizonSec,
      };

      // Single-leaf-at-0 empty Merkle tree — see lib/emptyTreeProof.ts.
      // This is enough for the prover to produce a self-consistent
      // proof; the resulting root won't match an on-chain
      // CommitmentPool root (Phase 5 wires the real one).
      const { merkleProof, leafIndex } = await buildEmptyTreeProof(note.note);
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const input: AuthorizeProofInput = {
        note: note.note,
        leafIndex,
        merkleProof,
        sellAmount,
        buyToken: DEMO_BUY_TOKEN,
        buyAmount,
        // 50 bps cap. Phase 5 derives this from chosen relayer terms.
        maxFee: 50n,
        expiry: horizonSec,
        nonce: randomFieldElement(),
        relayer: DEMO_RELAYER,
        eddsaPrivateKey: eddsaKey.privateKey,
        claims: [claim],
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
      const order = addOrder({
        side,
        pair,
        price,
        size,
        claim: {
          secret: claim.secret,
          recipient: claim.recipient,
          token: claim.token,
          amount: claim.amount,
          releaseTime: claim.releaseTime,
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
  }, [side, pair, price, size, account, note, deriveEdDSA, addOrder, toast]);

  if (!open) return null;

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      // Backdrop click closes — only when the click landed on the
      // backdrop itself, not bubbled up from the dialog.
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-title"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 id="order-title" className="text-lg font-semibold">
            Confirm private order
          </h2>
          <button
            onClick={close}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="mb-4 rounded-md border border-[var(--color-warning-soft)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          <strong>Demo mode</strong> — a real authorize Groth16 proof is
          generated locally in a Web Worker, but the Merkle tree is empty
          (no on-chain CommitmentPool yet) and no relayer is contacted.
          Phase 5 wires both.
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
          <Row k="Pair" v={pair} />
          <Row k="Side" v={side === "sell" ? "Sell" : "Buy"} />
          <Row k="Price" v={price} />
          <Row k="Size" v={size} />
          <Row k="Estimated fill" v={estimateFill(price, size)} />
          <Row k="vs Uniswap" v="−0.7% slippage" />
          <Row
            k="Fee"
            v="Free (launch event until Dec 31, 2026)"
          />
        </dl>

        <PhaseStatus phase={phase} />

        <div className="mt-5 flex justify-end gap-2">
          {phase.kind === "success" ? (
            <button
              onClick={close}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Done
            </button>
          ) : (
            <>
              {/* Cancel stays enabled mid-submit — escape hatch fires
                  the AbortController which unwinds the prover and
                  the simulated submission. */}
              <button
                onClick={close}
                className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
              >
                {busy ? "Cancel" : "Close"}
              </button>
              <button
                onClick={submit}
                disabled={busy || isDeriving || !account || !note}
                title={
                  !account
                    ? "Connect a wallet first"
                    : !note
                    ? "Deposit to your vault first"
                    : undefined
                }
                className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {busy
                  ? "Working…"
                  : isDeriving
                  ? "Awaiting signature…"
                  : "Sign & submit"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
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
