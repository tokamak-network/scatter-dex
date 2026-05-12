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
   *  recipient rows evenly. Caller computes `total`; this only
   *  fills the row strings. */
  splitEqually(total: string): void;

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

  const splitEqually = useCallback((total: string) => {
    setRecipientsState((prev) => {
      // Total parses as a decimal display string ("123.45"). Bail
      // cleanly on garbage input — the button shouldn't make the
      // form worse than not pressing it.
      const totalNum = Number(total.replace(/,/g, ""));
      if (!Number.isFinite(totalNum) || totalNum <= 0 || prev.length === 0) return prev;
      const each = totalNum / prev.length;
      // 8 fractional digits is plenty for the display string; the
      // canonical value comes from `parseUnits` at submit time.
      const display = each.toLocaleString("en-US", { maximumFractionDigits: 8 });
      return prev.map((r) => ({ ...r, amount: display }));
    });
  }, []);

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

/** Convert the `datetime-local` expiry string to an absolute
 *  Unix timestamp (seconds). Empty / malformed input falls back to
 *  one hour from now — a sensible default that beats letting the
 *  order revert at submit. */
export function expiryToUnixSec(value: string): bigint {
  if (value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
  }
  return BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
}

/** Convert a recipient row's `releaseAt` to an absolute Unix
 *  timestamp (seconds). Empty value = release immediately on
 *  settle, expressed as the current second. */
export function releaseAtToUnixSec(row: Pick<RecipientRow, "releaseAt">): bigint {
  if (row.releaseAt) {
    const ms = Date.parse(row.releaseAt);
    if (Number.isFinite(ms)) return BigInt(Math.floor(ms / 1000));
  }
  return BigInt(Math.floor(Date.now() / 1000));
}
