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
 *  porting the per-claim UX (regular / stealth, address, amount,
 *  delay) translates straight into our SDK's `ClaimEntry`. */
export interface RecipientRow {
  /** Stable id for React keys; set on push. */
  id: number;
  mode: "regular" | "stealth";
  /** Address (regular) or `st:eth:...` meta-address (stealth).
   *  Empty = "send to my own connected wallet" (same-wallet shortcut). */
  address: string;
  /** Amount in the **buy-side** token (display string, decimals
   *  applied at submit). Sum across rows must cover the post-fee
   *  receive total. */
  amount: string;
  /** Release delay number + unit. Default 0 hr = immediate. */
  delay: string;
  delayUnit: "min" | "hr" | "day";
}

let nextRowId = 1;

function freshRow(): RecipientRow {
  return { id: nextRowId++, mode: "regular", address: "", amount: "", delay: "0", delayUnit: "hr" };
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

  /** Advanced settings collapsed by default; expanding reveals
   *  multi-recipient list + expiry + maxFee. */
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

  /** Order expiry as preset chip key. Default 1h. Custom expiry
   *  (number + unit picker) is a follow-up — the preset chips cover
   *  the common range and avoid a typo-prone manual entry on the
   *  hot path. */
  expiry: "15m" | "1h" | "4h" | "24h" | "7d";
  setExpiry(v: TradeFormState["expiry"]): void;

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
  const [recipients, setRecipients] = useState<RecipientRow[]>(() => [freshRow()]);
  const [expiry, setExpiry] = useState<TradeFormState["expiry"]>("1h");
  const [maxFeeBps, setMaxFeeBps] = useState(30);

  const setPairBy = useCallback((display: string) => {
    const next = findPair(display);
    if (next) setPair(next);
  }, []);

  const addRecipient = useCallback(() => {
    setRecipients((prev) => (prev.length >= 16 ? prev : [...prev, freshRow()]));
  }, []);

  const removeRecipient = useCallback((id: number) => {
    setRecipients((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  }, []);

  const updateRecipient = useCallback(
    <K extends keyof RecipientRow>(id: number, field: K, value: RecipientRow[K]) => {
      setRecipients((prev) =>
        prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
      );
    },
    [],
  );

  const resetRecipients = useCallback(() => {
    setRecipients([freshRow()]);
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
      expiry,
      setExpiry,
      maxFeeBps,
      setMaxFeeBps,
    }),
    [
      pair, setPairBy,
      side, price, size,
      advancedOpen,
      recipients, addRecipient, removeRecipient, updateRecipient, resetRecipients,
      expiry, maxFeeBps,
    ],
  );

  return <TradeFormCtx.Provider value={value}>{children}</TradeFormCtx.Provider>;
}

/** Convert preset expiry chip → seconds. Used at submit time when
 *  building the AuthorizeProofInput. */
export function expirySeconds(key: TradeFormState["expiry"]): number {
  switch (key) {
    case "15m": return 15 * 60;
    case "1h":  return 60 * 60;
    case "4h":  return 4 * 60 * 60;
    case "24h": return 24 * 60 * 60;
    case "7d":  return 7 * 24 * 60 * 60;
  }
}

/** Convert a recipient row's delay into seconds. */
export function delaySeconds(row: Pick<RecipientRow, "delay" | "delayUnit">): number {
  const n = Number(row.delay);
  if (!Number.isFinite(n) || n < 0) return 0;
  const mult = row.delayUnit === "min" ? 60 : row.delayUnit === "hr" ? 3600 : 86400;
  return Math.floor(n * mult);
}
