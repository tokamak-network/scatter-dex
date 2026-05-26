"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  LAUNCH_PAIRS,
  findPair,
  type WhitelistedPair,
} from "@zkscatter/sdk";
import { pickActiveTier, type CircuitTier } from "@zkscatter/sdk/zk";
import type { ParsedRecipient } from "@zkscatter/recipients";

const FEATURED = LAUNCH_PAIRS.find((p) => p.featured)?.display ?? "ETH/USDC";

/** Per-claim recipient row. Structural extension of the shared
 *  `ParsedRecipient` — Pro promotes `name` and `releaseAt` from
 *  optional to required (the form initialises both to empty
 *  strings), which means `RecipientRow[]` flows into the shared
 *  `<RecipientsEditor>` with no cast. */
export interface RecipientRow extends ParsedRecipient {
  /** Required in Pro (the form always seeds `""`); free-text label. */
  name: string;
  /** Required in Pro; `datetime-local` string or `""` for "release
   *  immediately on settle." */
  releaseAt: string;
}

/** Largest active authorize-circuit tier. Caps each individual order
 *  so the relayer can always pick a single batch — multi-batch
 *  fallback is a future SDK concern, not the form's. Sourced from
 *  the SDK so the cap drifts in lockstep with `ACTIVE_TIERS`. */
export const MAX_RECIPIENTS = 128;

function freshRow(): RecipientRow {
  return { name: "", address: "", amount: "", releaseAt: "" };
}

interface TradeFormState {
  pair: WhitelistedPair;
  setPairBy(display: string): void;

  side: "sell" | "buy";
  setSide(s: "sell" | "buy"): void;

  price: string;
  setPrice(p: string): void;

  size: string;
  setSize(s: string): void;

  /** Multi-recipient distribution. Default: 1 row, empty
   *  (interpreted as "send to my own wallet"). */
  recipients: RecipientRow[];
  addRecipient(): void;
  removeRecipient(index: number): void;
  updateRecipient(index: number, patch: Partial<RecipientRow>): void;
  resetRecipients(): void;
  /** Replace the recipients list wholesale (e.g. after picking
   *  multiple entries from the address book, or after the shared
   *  editor returns a new array). Caps at MAX_RECIPIENTS. */
  setRecipients(next: RecipientRow[]): void;
  /** Helper: spread the projected receive-side total across all
   *  recipient rows evenly using base-unit BigInt math so the sum
   *  reconstructs exactly at submit-time `parseUnits`. Caller
   *  passes both the display string and the token's `decimals`. */
  splitEqually(total: string, decimals: number): void;
  /** Tier auto-selected from `recipients.length` — surfaced in copy
   *  by RecipientsSection and threaded into the authorize-body by
   *  OrderModal so they can't disagree on which circuit ran. */
  activeTier: CircuitTier;

  /** Bulk "Claim from (all)" datetime. Lifted out of the shared
   *  RecipientsEditor's internal state so AutoSettleIndicator can
   *  honour it as a fallback when per-row `releaseAt` is empty —
   *  otherwise a user who types the bulk value (but never clicks
   *  Apply to all) gets a default `now + 1h` settle estimate that
   *  can land *after* their intended claim time. */
  bulkClaimFrom: string;
  setBulkClaimFrom(value: string): void;

  /** "Take mode" payload — populated when the user lands on the
   *  workbench via the Shared OB Take Order button. Carries the
   *  maker's *exact* wei-string sellAmount + buyAmount so the submit
   *  path can sign them verbatim (no size×price composition, no
   *  rounding drift). Workbench hides the Price / Size inputs while
   *  this is set; clearing it restores the regular limit-order form.
   *  `takeId` is the maker's offerHandle — kept so we can refuse a
   *  duplicate take when the user navigates back. */
  takeMode: {
    sellWei: bigint;
    buyWei: bigint;
    takeId: string;
    /** Pair the prefill landed on. Workbench auto-clears takeMode
     *  when the user flips PairSelector / Side off this combination
     *  so a stale lock can't sign wei against the wrong token. */
    pair: string;
    side: "sell" | "buy";
  } | null;
  setTakeMode(mode: TradeFormState["takeMode"]): void;
}

const TradeFormCtx = createContext<TradeFormState | null>(null);

export function useTradeForm(): TradeFormState {
  const ctx = useContext(TradeFormCtx);
  if (!ctx) throw new Error("useTradeForm must be used inside <TradeFormProvider>");
  return ctx;
}

export function TradeFormProvider({ children }: { children: ReactNode }) {
  const [pair, setPair] = useState<WhitelistedPair>(
    () => findPair(FEATURED) ?? LAUNCH_PAIRS[0]!,
  );
  const [side, setSide] = useState<"sell" | "buy">("sell");
  const [price, setPrice] = useState("4,205");
  const [size, setSize] = useState("2.0");
  const [recipients, setRecipientsState] = useState<RecipientRow[]>(() => [freshRow()]);
  const [bulkClaimFrom, setBulkClaimFrom] = useState("");
  const [takeMode, setTakeMode] = useState<TradeFormState["takeMode"]>(null);

  const setPairBy = useCallback((display: string) => {
    const next = findPair(display);
    if (next) setPair(next);
  }, []);

  const addRecipient = useCallback(() => {
    setRecipientsState((prev) =>
      prev.length >= MAX_RECIPIENTS ? prev : [...prev, freshRow()],
    );
  }, []);

  const removeRecipient = useCallback((index: number) => {
    setRecipientsState((prev) =>
      prev.length <= 1 ? prev : prev.filter((_, i) => i !== index),
    );
  }, []);

  const updateRecipient = useCallback(
    (index: number, patch: Partial<RecipientRow>) => {
      setRecipientsState((prev) =>
        prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const resetRecipients = useCallback(() => {
    setRecipientsState([freshRow()]);
  }, []);

  const setRecipients = useCallback((next: RecipientRow[]) => {
    setRecipientsState(next.slice(0, MAX_RECIPIENTS));
  }, []);

  // `splitEqually` runs in base units (BigInt) instead of `Number` so
  // a 1.0 split across 3 rows actually sums back to 1.0 after the
  // submit-time `parseUnits` round-trip. The remainder (always
  // `< prev.length`) goes to the first row so the total is exact.
  // Lives outside the callback so it stays a pure helper.
  const splitEqually = useCallback(
    (total: string, decimals: number) => {
      setRecipientsState((prev) => {
        if (prev.length === 0) return prev;
        const cleaned = total.replace(/,/g, "");
        if (!cleaned) return prev;
        let totalUnits: bigint;
        try {
          totalUnits = parseUnitsExact(cleaned, decimals);
        } catch {
          return prev;
        }
        if (totalUnits <= 0n) return prev;
        const n = BigInt(prev.length);
        const base = totalUnits / n;
        const rem = totalUnits - base * n;
        return prev.map((r, i) => ({
          ...r,
          amount: formatUnitsExact(i === 0 ? base + rem : base, decimals),
        }));
      });
    },
    [],
  );

  // Recipients always include at least one row (the form initializes
  // with `[freshRow()]` and `removeRecipient` refuses to drop the
  // last). `pickActiveTier` therefore never sees zero — no clamp
  // needed.
  const activeTier = useMemo(
    () => pickActiveTier(recipients.length),
    [recipients.length],
  );

  const value = useMemo<TradeFormState>(
    () => ({
      pair,
      setPairBy,
      side,
      setSide,
      price,
      setPrice,
      size,
      setSize,
      recipients,
      addRecipient,
      removeRecipient,
      updateRecipient,
      resetRecipients,
      setRecipients,
      splitEqually,
      activeTier,
      bulkClaimFrom,
      setBulkClaimFrom,
      takeMode,
      setTakeMode,
    }),
    [
      pair, setPairBy,
      side, price, size,
      recipients, addRecipient, removeRecipient, updateRecipient,
      resetRecipients, setRecipients, splitEqually, activeTier,
      bulkClaimFrom, setBulkClaimFrom,
      takeMode,
    ],
  );

  return <TradeFormCtx.Provider value={value}>{children}</TradeFormCtx.Provider>;
}

/** Convert a recipient row's `releaseAt` to an absolute Unix
 *  timestamp (seconds). Empty value = release immediately on
 *  settle, expressed as `nowSec` (or the current second when
 *  unspecified). The optional `nowSec` parameter lets the caller
 *  capture a single timestamp once and thread it through all the
 *  per-order calls (expiry + every claim's release) so they can't
 *  drift across a second boundary mid-build. */
export function releaseAtToUnixSec(
  row: Pick<RecipientRow, "releaseAt">,
  nowSec?: bigint,
): bigint {
  if (row.releaseAt) {
    const ms = Date.parse(row.releaseAt);
    if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
  }
  return nowSec ?? BigInt(Math.floor(Date.now() / 1000));
}

// Inline replacements for `parseUnits` / `formatUnits` used by
// `splitEqually` — the existing helpers in `lib/parseUnits` only
// expose `parseUnits`; we need a matching formatter that strips
// trailing zeros for display without losing precision. Keep both
// self-contained so this file stays free of a back-import on the
// component layer.
function parseUnitsExact(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".");
  if (whole === undefined) throw new Error(`invalid amount: ${value}`);
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) {
    throw new Error(`invalid amount: ${value}`);
  }
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function formatUnitsExact(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const denom = 10n ** BigInt(decimals);
  const whole = units / denom;
  const frac = (units % denom).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}
