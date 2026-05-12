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

const FEATURED = LAUNCH_PAIRS.find((p) => p.featured)?.display ?? "ETH/USDC";

/** Per-claim recipient row. Mirrors `frontend/`'s ClaimRow shape so
 *  porting the per-claim UX (address, amount, release time)
 *  translates straight into our SDK's `ClaimEntry`. */
export interface RecipientRow {
  /** Stable id for React keys; set on push. */
  id: number;
  /** Recipient EOA. Empty = "send to my own connected wallet"
   *  (same-wallet shortcut). */
  address: string;
  /** Amount in the **buy-side** token (display string, decimals
   *  applied at submit). Sum across rows must cover the post-fee
   *  receive total. */
  amount: string;
  /** Absolute release time as a local `datetime-local` value
   *  (`YYYY-MM-DDTHH:mm`). Empty = release immediately on settle.
   *  Replaces the previous delay-from-now model so users specify
   *  "when can this be claimed" instead of mental-math from now. */
  releaseAt: string;
}

let nextRowId = 1;

function freshRow(): RecipientRow {
  return { id: nextRowId++, address: "", amount: "", releaseAt: "" };
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

  /** Advanced settings collapsed by default; expanding reveals the
   *  max-fee tuner. Expiry surfaces in the main form because the
   *  user is now picking an absolute deadline, not a preset. */
  advancedOpen: boolean;
  setAdvancedOpen(v: boolean): void;

  /** Multi-recipient distribution. Default: 1 row, empty
   *  (interpreted as "send to my own wallet"). */
  recipients: RecipientRow[];
  addRecipient(): void;
  removeRecipient(id: number): void;
  updateRecipient<K extends keyof RecipientRow>(
    id: number,
    field: K,
    value: RecipientRow[K],
  ): void;
  resetRecipients(): void;
  /** Replace the recipients list wholesale (e.g. after picking
   *  multiple entries from the address book). Caps at 16. */
  setRecipients(next: RecipientRow[]): void;
  /** Helper: spread the projected receive-side total across all
   *  recipient rows evenly using base-unit BigInt math so the sum
   *  reconstructs exactly at submit-time `parseUnits`. Caller
   *  passes both the display string and the token's `decimals`. */
  splitEqually(total: string, decimals: number): void;

  /** Order's "must settle by" deadline as a local `datetime-local`
   *  value (`YYYY-MM-DDTHH:mm`). Empty = use a 1-hour default at
   *  submit. Surfaced as an absolute date so the user doesn't have
   *  to mental-math a preset against the current clock. */
  expiry: string;
  setExpiry(v: string): void;

  /** Max relayer fee in basis points. Range 0–100 (0–1%). Default
   *  30 mirrors the frontend reference impl. */
  maxFeeBps: number;
  setMaxFeeBps(n: number): void;
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recipients, setRecipientsState] = useState<RecipientRow[]>(() => [freshRow()]);
  const [expiry, setExpiry] = useState<string>("");
  const [maxFeeBps, setMaxFeeBps] = useState(30);

  const setPairBy = useCallback((display: string) => {
    const next = findPair(display);
    if (next) setPair(next);
  }, []);

  const addRecipient = useCallback(() => {
    setRecipientsState((prev) => (prev.length >= 16 ? prev : [...prev, freshRow()]));
  }, []);

  const removeRecipient = useCallback((id: number) => {
    setRecipientsState((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }, []);

  const updateRecipient = useCallback(
    <K extends keyof RecipientRow>(id: number, field: K, value: RecipientRow[K]) => {
      setRecipientsState((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
      );
    },
    [],
  );

  const resetRecipients = useCallback(() => {
    setRecipientsState([freshRow()]);
  }, []);

  const setRecipients = useCallback((next: RecipientRow[]) => {
    setRecipientsState(next.slice(0, 16));
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
      advancedOpen,
      setAdvancedOpen,
      recipients,
      addRecipient,
      removeRecipient,
      updateRecipient,
      resetRecipients,
      setRecipients,
      splitEqually,
      expiry,
      setExpiry,
      maxFeeBps,
      setMaxFeeBps,
    }),
    [
      pair, setPairBy,
      side, price, size,
      advancedOpen,
      recipients, addRecipient, removeRecipient, updateRecipient,
      resetRecipients, setRecipients, splitEqually,
      expiry, maxFeeBps,
    ],
  );

  return <TradeFormCtx.Provider value={value}>{children}</TradeFormCtx.Provider>;
}

/** Convert the `datetime-local` expiry string to an absolute Unix
 *  timestamp (seconds). Empty / malformed input falls back to
 *  `nowSec + 1h`. The optional `nowSec` parameter lets the caller
 *  capture a single timestamp once and thread it through all the
 *  per-order calls (expiry + every claim's release) so they can't
 *  drift across a second boundary mid-build. */
export function expiryToUnixSec(value: string, nowSec?: bigint): bigint {
  if (value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
  }
  const base = nowSec ?? BigInt(Math.floor(Date.now() / 1000));
  return base + 3600n;
}

/** Convert a recipient row's `releaseAt` to an absolute Unix
 *  timestamp (seconds). Empty value = release immediately on
 *  settle, expressed as `nowSec` (or the current second when
 *  unspecified). See `expiryToUnixSec` for the rationale on
 *  threading a shared `nowSec`. */
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
