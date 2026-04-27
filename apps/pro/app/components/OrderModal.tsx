"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateStealthAddress,
  isMetaAddress,
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
import { useCommitmentTree, getMerkleProofWithFallback } from "../lib/commitmentTree";
import { computeCommitment } from "@zkscatter/sdk/zk";
import { formatTokenAmount } from "../lib/format";
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
 *
 *  Stealth mode: row carries an `st:eth:0x...` meta-address. We
 *  derive a fresh one-time recipient via `generateStealthAddress`
 *  per row; the returned `ephemeralPubKey` is surfaced parallel to
 *  the claim so the caller can persist it (the recipient needs it
 *  to derive their stealth private key later). Each call uses
 *  fresh ephemeral randomness — never reuse across recipients. */
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

interface ResolvedClaim {
  claim: ClaimEntry;
  /** Set when the recipient was derived from a stealth meta-address.
   *  The recipient needs this to spend the resulting stealth
   *  address (`deriveStealthPrivateKey`). */
  ephemeralPubKey?: string;
}


function resolveClaims(
  rows: readonly RecipientRow[],
  defaultRecipient: string,
  buyTokenAddress: string,
  buyTokenDecimals: number,
  buyAmount: bigint,
): ResolvedClaim[] {
  // Auto-fill convention: a single row with no amount = "send the
  // entire buyAmount to this recipient". In every other case (single
  // row with explicit amount, or multi-row), the sum of all
  // explicit amounts must equal buyAmount — including the single-
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
  if (!autoFillSingle && total !== buyAmount) {
    const diff = total > buyAmount ? total - buyAmount : buyAmount - total;
    throw new Error(
      `Recipient amounts must sum to the order's buy amount. Off by ${
        total > buyAmount ? "+" : "−"
      }${formatTokenAmount(diff, buyTokenDecimals)}.`,
    );
  }

  // Trim once; reuse for both validation and build.
  const trimmedAddrs = rows.map((r) => r.address.trim());

  // Block stealth rows beyond row 0 until per-recipient claim
  // history surfaces (A.3). The OrderRecord only carries one
  // ephemeralPubKey today; persisting only the first would
  // permanently strand funds for stealth rows 2+ since the key
  // isn't recoverable from chain. Single-stealth and multi-regular
  // remain fully functional.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.mode === "stealth") {
      throw new Error(
        `Recipient #${i + 1} uses stealth, but multi-recipient stealth orders aren't supported yet (the ephemeralPubKey for rows 2+ would be lost). Move the stealth row to position 1, or use regular addresses for the others.`,
      );
    }
  }

  // Validate recipient addresses up front so a typo doesn't surface
  // mid-prove with a cryptic BigInt parse error. Stealth rows must
  // carry a well-formed meta-address; regular rows must be a 0x…
  // wallet address (or empty for self).
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const trimmed = trimmedAddrs[i]!;
    if (r.mode === "stealth") {
      if (!trimmed) {
        throw new Error(
          `Recipient #${i + 1} (stealth) is missing a meta-address. Paste an "st:eth:0x…" address.`,
        );
      }
      if (!isMetaAddress(trimmed)) {
        throw new Error(
          `Recipient #${i + 1} stealth meta-address is malformed. Expected "st:eth:0x" followed by 132 hex characters.`,
        );
      }
      continue;
    }
    if (!trimmed) continue; // empty = self
    if (!ADDR_RE.test(trimmed)) {
      throw new Error(
        `Recipient #${i + 1} address "${trimmed}" is not a valid 0x… address.`,
      );
    }
  }

  return rows.map((r, i) => {
    const trimmed = trimmedAddrs[i]!;
    let recipient: string;
    let ephemeralPubKey: string | undefined;
    if (r.mode === "stealth") {
      // Each call mints a fresh ephemeral pubkey — calling twice
      // for the same meta-address yields different stealth
      // addresses, which is exactly the unlinkability we want.
      const stealth = generateStealthAddress(trimmed);
      recipient = stealth.stealthAddress;
      ephemeralPubKey = stealth.ephemeralPubKey;
    } else if (!trimmed) {
      recipient = defaultRecipient;
    } else {
      recipient = trimmed;
    }
    const amount = autoFillSingle
      ? buyAmount
      : parseUnits(r.amount.replace(/,/g, ""), buyTokenDecimals);
    const claim: ClaimEntry = {
      secret: randomFieldElement(),
      recipient,
      token: buyTokenAddress,
      amount,
      // releaseTime is patched in the submit flow with `nowSec + delaySeconds(row)`.
      releaseTime: 0n,
    };
    return ephemeralPubKey ? { claim, ephemeralPubKey } : { claim };
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
  const commitmentTree = useCommitmentTree();
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
    let resolved: ResolvedClaim[];
    try {
      resolved = resolveClaims(
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
      const claims: ClaimEntry[] = resolved.map((r, i) => ({
        ...r.claim,
        releaseTime: nowSec + BigInt(delaySeconds(recipients[i]!)),
      }));

      const commitment = await computeCommitment(note.note);
      const { merkleProof, leafIndex } = await getMerkleProofWithFallback(
        commitmentTree,
        commitment,
        () => buildEmptyTreeProof(note.note),
      );
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
      // Persist the first claim only — `resolveClaims` rejects any
      // non-first stealth row, so the persisted ephemeralPubKey (if
      // present) is the order's only stealth recipient. Per-recipient
      // claim history lands with A.3.
      const firstClaim = claims[0]!;
      const firstEphemeralPubKey = resolved[0]!.ephemeralPubKey;
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
          ...(firstEphemeralPubKey && { ephemeralPubKey: firstEphemeralPubKey }),
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
    deriveEdDSA, addOrder, toast, commitmentTree,
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
