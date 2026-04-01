"use client";

import { useState, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { Loader2, Copy, Check, Clock, Shield, Lock, Plus, Trash2, AlertCircle, Save, FolderOpen, Download } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getSettlementAddress, getEnv } from "../../lib/config";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { signOrder, generateSecret, buildClaimLink } from "../../lib/signing";
import type { OrderInput, ClaimInput } from "../../lib/signing";
import { RelayerClient } from "../../lib/relayerApi";
import { isMetaAddress, generateStealthAddress, buildStealthClaimLink } from "../../lib/stealth";
import { useRelayers, type RelayerInfo } from "../../lib/useRelayers";
import PricePanel from "../../components/PricePanel";

type Side = "buy" | "sell";
type ExpiryOption = "1H" | "1D" | "1W" | "GTC";
type RecipientMode = "standard" | "stealth";
type OrderStatus = "idle" | "signing" | "submitting" | "success" | "error";

const EXPIRY_SECONDS: Record<ExpiryOption, number> = {
  "1H": 3600,
  "1D": 86400,
  "1W": 604800,
  "GTC": 365 * 86400,
};

const MAX_CLAIMS = 10; // matches MAX_CLAIMS_PER_ORDER in ScatterSettlement
const MIN_RELEASE_DELAY = 1; // 1 second — configurable via setMinReleaseDelay() on contract

interface ClaimRow {
  id: number;
  mode: RecipientMode;
  address: string;      // standard address or meta-address
  amount: string;       // claim amount
  delay: string;        // numeric value
  delayUnit: "min" | "hr" | "day";
}

export default function OrderPage() {
  const { account, chainId, signer } = useWallet();
  const tokens = useMemo(() => getTokenList().filter((t) => !t.isNative), []);
  const nextClaimId = useRef(1);
  const { relayers } = useRelayers();
  const onlineRelayers = relayers.filter((r) => r.online);
  const [selectedRelayerIdx, setSelectedRelayerIdx] = useState(0);
  const activeRelayer = onlineRelayers[selectedRelayerIdx] ?? null;

  // Token pair
  const [sellTokenIdx, setSellTokenIdx] = useState(0);
  const [buyTokenIdx, setBuyTokenIdx] = useState(tokens.length > 1 ? 1 : 0);

  // Order
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [expiry, setExpiry] = useState<ExpiryOption>("1D");
  const [maxFee, setMaxFee] = useState("30");
  const [feeMode, setFeeMode] = useState<"mine" | "both">("mine");

  // Claims (multiple recipients)
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" },
  ]);

  // Submission
  const [status, setStatus] = useState<OrderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [claimLinks, setClaimLinks] = useState<string[]>([]);
  const [copied, setCopied] = useState<number | null>(null);

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

  // Same-token mode = scheduled transfer
  const isSameToken = sellToken && buyToken && sellToken.address.toLowerCase() === buyToken.address.toLowerCase();

  // Which token the user receives
  const receiveToken = side === "sell" ? buyToken : sellToken;

  // Total value
  const totalValue = useMemo(() => {
    if (!amount || !price) return "";
    try {
      return (parseFloat(amount) * parseFloat(price)).toLocaleString("en-US", { maximumFractionDigits: 6 });
    } catch { return ""; }
  }, [amount, price]);

  // Claims total
  const claimTotal = useMemo(() => {
    return claims.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  }, [claims]);

  // Distributable amount — what recipients can claim after all fees.
  // "My side only": takerFee deducted from counterparty's sell → reduces your receive
  // "Cover both sides": makerFee is your total cost → reduces your effective value
  const distributable = useMemo(() => {
    if (!amount || (!isSameToken && !price)) return 0;
    const amt = parseFloat(amount);
    const p = isSameToken ? 1 : parseFloat(price);
    const buyAmt = side === "buy" ? amt : amt * p;
    const baseBps = parseInt(maxFee) || 0;
    if (feeMode === "both") {
      // You cover both: your fee = 2×baseBps on sell side. Effective distributable = buyAmt - makerFee equivalent.
      const sellAmt = side === "buy" ? amt * p : amt;
      const makerFeeAmt = sellAmt * baseBps * 2 / 10000;
      return buyAmt - makerFeeAmt;
    }
    // My side only: takerFee deducted from counterparty's sell → reduces your receive
    return buyAmt * (1 - baseBps / 10000);
  }, [amount, price, maxFee, feeMode, side, isSameToken]);

  // Fill remaining amount for a specific claim (floor to avoid exceeding distributable)
  const fillRest = (id: number) => {
    const othersTotal = claims.reduce((sum, c) => c.id === id ? sum : sum + (parseFloat(c.amount) || 0), 0);
    const rest = Math.max(0, distributable - othersTotal);
    const floored = Math.floor(rest * 10000) / 10000; // truncate to 4 decimals
    updateClaim(id, "amount", floored > 0 ? floored.toString() : "0");
  };

  const addClaim = () => {
    if (claims.length >= MAX_CLAIMS) return;
    setClaims([...claims, { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" }]);
  };

  const removeClaim = (id: number) => {
    if (claims.length <= 1) return;
    setClaims(claims.filter((c) => c.id !== id));
  };

  const updateClaim = (id: number, field: keyof ClaimRow, value: string) => {
    setClaims(claims.map((c) => c.id === id ? { ...c, [field]: value } : c));
  };

  // Draft save (JSON file download) / load (file upload)
  const [draftSaved, setDraftSaved] = useState(false);
  const saveDraft = () => {
    const draft = { side, sellTokenIdx, buyTokenIdx, amount, price, expiry, maxFee, feeMode, claims };
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `order-draft-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDraftSaved(true);
    setTimeout(() => setDraftSaved(false), 2000);
  };
  const loadDraft = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const d = JSON.parse(reader.result as string);
          if (d.side) setSide(d.side);
          if (d.sellTokenIdx !== undefined) setSellTokenIdx(d.sellTokenIdx);
          if (d.buyTokenIdx !== undefined) setBuyTokenIdx(d.buyTokenIdx);
          if (d.amount) setAmount(d.amount);
          if (d.price) setPrice(d.price);
          if (d.expiry) setExpiry(d.expiry);
          if (d.maxFee) setMaxFee(d.maxFee);
          if (d.feeMode) setFeeMode(d.feeMode);
          if (d.claims?.length) {
            nextClaimId.current = Math.max(...d.claims.map((c: ClaimRow) => c.id)) + 1;
            setClaims(d.claims);
          }
        } catch { /* ignore corrupt file */ }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleSubmit = async () => {
    if (!signer || !account || !chainId || !sellToken || !buyToken) return;
    if (!isSameToken && (!amount || !price)) return;
    if (isSameToken && !amount) return;

    setStatus("signing");
    setError(null);
    setClaimLinks([]);

    try {
      const settlementAddr = getSettlementAddress();

      const orderSellToken = side === "sell" ? sellToken : buyToken;
      const orderBuyToken = side === "sell" ? buyToken : sellToken;
      const sellDecimals = orderSellToken.decimals;
      const buyDecimals = orderBuyToken.decimals;

      // Use BigInt arithmetic to avoid floating-point precision errors.
      const amountBig = ethers.parseUnits(amount, sellDecimals);

      // For same-token: sellAmount == buyAmount, price is implicitly 1:1
      const priceBig = isSameToken ? ethers.parseUnits("1", buyDecimals) : ethers.parseUnits(price, buyDecimals);
      const crossAmount = (amountBig * priceBig) / (BigInt(10) ** BigInt(sellDecimals));

      const sellAmount = side === "sell" ? amountBig.toString() : crossAmount.toString();
      const buyAmount = side === "sell" ? crossAmount.toString() : amountBig.toString();

      // Build claims
      const links: string[] = [];
      const claimInputs: ClaimInput[] = claims.map((c, index) => {
        const secret = generateSecret();
        let recipient: string;
        let ephemeralPubKey: string | undefined;

        if (!c.address) {
          recipient = account;
        } else if (c.mode === "stealth" && isMetaAddress(c.address)) {
          const stealth = generateStealthAddress(c.address);
          recipient = stealth.stealthAddress;
          ephemeralPubKey = stealth.ephemeralPubKey;
        } else if (ethers.isAddress(c.address)) {
          recipient = c.address;
        } else {
          throw new Error(`Invalid recipient address for claim #${index + 1}`);
        }

        const delaySec = (parseInt(c.delay) || 1) * (c.delayUnit === "day" ? 86400 : c.delayUnit === "hr" ? 3600 : 60);
        if (delaySec < MIN_RELEASE_DELAY) {
          throw new Error(`Release delay for claim #${index + 1} must be at least ${MIN_RELEASE_DELAY} second(s)`);
        }

        const claimAmount = c.amount
          ? ethers.parseUnits(c.amount, receiveToken?.decimals ?? 18).toString()
          : "";

        if (ephemeralPubKey) {
          links.push(buildStealthClaimLink(secret, ephemeralPubKey));
        } else {
          links.push(buildClaimLink(secret));
        }

        return {
          recipient,
          amount: claimAmount,
          releaseDelay: Math.max(MIN_RELEASE_DELAY, delaySec),
          secret,
        };
      });

      // Compute on-chain distributable: buyAmount minus takerFee
      const buyAmountBig = BigInt(buyAmount);
      const takerFeeBps = feeMode === "both" ? BigInt(0) : BigInt(parseInt(maxFee) || 30);
      const takerFeeAmt = (buyAmountBig * takerFeeBps) / BigInt(10000);
      const distributableBig = buyAmountBig - takerFeeAmt;

      // Validate / auto-distribute claim amounts against distributable
      const filledSum = claimInputs.reduce(
        (sum, c) => sum + (c.amount ? BigInt(c.amount) : BigInt(0)), BigInt(0)
      );
      const emptyCount = claimInputs.filter((c) => !c.amount).length;

      if (emptyCount > 0) {
        if (filledSum > distributableBig) {
          throw new Error("Sum of specified claim amounts exceeds distributable amount");
        }
        const remaining = distributableBig - filledSum;
        const perEmpty = remaining / BigInt(emptyCount);
        let distributed = BigInt(0);
        claimInputs.forEach((c, i) => {
          if (!c.amount) {
            const isLast = claimInputs.slice(i + 1).every((x) => x.amount);
            c.amount = isLast ? (remaining - distributed).toString() : perEmpty.toString();
            distributed += BigInt(c.amount);
          }
        });
      } else {
        if (filledSum > distributableBig) {
          throw new Error(
            `Sum of claim amounts (${ethers.formatUnits(filledSum, receiveToken?.decimals ?? 18)}) ` +
            `exceeds distributable (${ethers.formatUnits(distributableBig, receiveToken?.decimals ?? 18)})`
          );
        }
      }

      const nonceBuf = crypto.getRandomValues(new Uint8Array(6));
      const nonce = Number(BigInt("0x" + [...nonceBuf].map(b => b.toString(16).padStart(2, "0")).join("")));

      const orderInput: OrderInput = {
        sellToken: orderSellToken.address,
        buyToken: orderBuyToken.address,
        sellAmount,
        buyAmount,
        maxFee: (parseInt(maxFee) || 30) * (feeMode === "both" ? 2 : 1),
        expiry: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry],
        nonce,
        claims: claimInputs,
      };

      const { signature, orderData } = await signOrder(signer, account, orderInput, chainId, settlementAddr);

      setStatus("submitting");
      if (!activeRelayer) throw new Error("No online relayer selected");
      const relayer = new RelayerClient(activeRelayer.url);
      await relayer.submitOrder(orderData, signature, feeMode === "both" ? "cover_taker" : undefined);

      setClaimLinks(links);
      setStatus("success");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Order failed");
    }
  };

  const handleCopy = async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(idx);
      setTimeout(() => setCopied(null), 2000);
    } catch { /* clipboard unavailable */ }
  };

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center py-32 gap-6">
        <Lock className="w-16 h-16 text-on-surface-variant/40" />
        <p className="text-on-surface-variant text-lg">Connect your wallet to create orders</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col xl:flex-row gap-6">
      {/* Left: Order Form */}
      <div className="flex-1 max-w-4xl">
        <h1 className="font-headline text-2xl font-extrabold tracking-tight text-on-surface mb-4">
          Create Trade Order
        </h1>

        <div className="glass-card rounded-xl p-6 border border-outline-variant/10 space-y-5">
          {/* Token Pair + Side */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex bg-surface-container-high rounded-md p-1 w-[180px]">
              <button
                onClick={() => setSide("buy")}
                className={`flex-1 py-1.5 rounded-md font-bold text-sm transition-colors ${
                  side === "buy" ? "bg-surface-bright text-tertiary" : "text-on-surface-variant"
                }`}
              >Buy</button>
              <button
                onClick={() => setSide("sell")}
                className={`flex-1 py-1.5 rounded-md font-bold text-sm transition-colors ${
                  side === "sell" ? "bg-surface-bright text-error" : "text-on-surface-variant"
                }`}
              >Sell</button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <select
                value={sellTokenIdx}
                onChange={(e) => setSellTokenIdx(Number(e.target.value))}
                className="bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-1.5 px-2 text-sm font-bold"
              >
                {tokens.map((t, i) => <option key={`s-${t.symbol}-${i}`} value={i}>{t.symbol}</option>)}
              </select>
              <span className="text-on-surface-variant">/</span>
              <select
                value={buyTokenIdx}
                onChange={(e) => setBuyTokenIdx(Number(e.target.value))}
                className="bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-1.5 px-2 text-sm font-bold"
              >
                {tokens.map((t, i) => <option key={`b-${t.symbol}-${i}`} value={i}>{t.symbol}</option>)}
              </select>
            </div>
          </div>

          {/* Amount + Price */}
          <div className={isSameToken ? "" : "grid grid-cols-2 gap-4"}>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">
                {isSameToken ? `Transfer Amount (${sellToken?.symbol})` : side === "buy" ? `Buy Amount (${sellToken?.symbol})` : `Sell Amount (${sellToken?.symbol})`}
              </label>
              <input
                type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2 px-3 text-lg font-mono"
              />
            </div>
            {!isSameToken && (
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">
                  Price ({buyToken?.symbol} per {sellToken?.symbol})
                </label>
                <input
                  type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2 px-3 text-lg font-mono"
                />
                {totalValue && (
                  <div className="text-[10px] text-on-surface-variant">
                    {side === "buy"
                      ? `You pay: ${totalValue} ${buyToken?.symbol}`
                      : `You receive: ${totalValue} ${buyToken?.symbol}`}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Fee + Expiry */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Relay Fee</label>
              {/* Fee mode: mine only vs both sides */}
              <div className="flex bg-surface-container-high rounded-md p-0.5">
                <button
                  type="button"
                  onClick={() => setFeeMode("mine")}
                  className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${
                    feeMode === "mine" ? "bg-surface-bright text-on-surface" : "text-on-surface-variant"
                  }`}
                >My side only</button>
                <button
                  type="button"
                  onClick={() => setFeeMode("both")}
                  className={`flex-1 py-1 rounded text-[10px] font-bold transition-colors ${
                    feeMode === "both" ? "bg-surface-bright text-on-surface" : "text-on-surface-variant"
                  }`}
                >Cover both sides</button>
              </div>
              {/* Fee rate presets */}
              <div className="flex gap-1.5">
                {[
                  { label: "0.1%", bps: "10" },
                  { label: "0.3%", bps: "30" },
                  { label: "0.5%", bps: "50" },
                  { label: "1%", bps: "100" },
                ].map((opt) => (
                  <button
                    key={opt.bps}
                    type="button"
                    onClick={() => setMaxFee(opt.bps)}
                    className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${
                      maxFee === opt.bps
                        ? "bg-primary text-on-primary"
                        : "bg-surface-container-low text-on-surface-variant hover:bg-surface-bright"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setMaxFee("")}
                  className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${
                    !["10", "30", "50", "100"].includes(maxFee)
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-low text-on-surface-variant hover:bg-surface-bright"
                  }`}
                >
                  Custom
                </button>
              </div>
              {!["10", "30", "50", "100"].includes(maxFee) && (
                <div className="relative">
                  <input
                    type="number" value={maxFee} onChange={(e) => setMaxFee(e.target.value)}
                    placeholder="bps (1 bps = 0.01%)"
                    className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2 px-3 pr-16 text-sm font-mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-variant font-mono">
                    {maxFee ? `${(parseInt(maxFee) / 100).toFixed(2)}%` : ""}
                  </span>
                </div>
              )}
              {feeMode === "both" && (
                <p className="text-[9px] text-tertiary">Taker pays 0% — you cover the full relay fee</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Expires</label>
              <div className="flex gap-1.5">
                {(["1H", "1D", "1W", "GTC"] as ExpiryOption[]).map((opt) => (
                  <button
                    key={opt} onClick={() => setExpiry(opt)}
                    className={`flex-1 py-2 rounded-md text-xs font-bold transition-colors ${
                      expiry === opt
                        ? "bg-surface-bright text-primary border border-primary/50"
                        : "border border-outline-variant/20 text-on-surface-variant hover:bg-surface-container"
                    }`}
                  >{opt}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Order Summary + Fee — combined */}
          {amount && (isSameToken || (price && maxFee)) && (() => {
            const total = isSameToken ? parseFloat(amount) : parseFloat(amount) * parseFloat(price);
            const amt = parseFloat(amount);
            const baseBps = parseInt(maxFee) || 0;
            const isBoth = feeMode === "both";

            // makerFee (on your sell) — affects what counterparty receives
            const makerFeeBps = isBoth ? baseBps * 2 : baseBps;
            // takerFee (on counterparty's sell) — affects what you receive
            const takerFeeBps = isBoth ? 0 : baseBps;

            const sellAmt = side === "buy" ? total : amt;
            const sellSym = side === "buy" ? buyToken?.symbol : sellToken?.symbol;
            const makerFeeAmt = sellAmt * makerFeeBps / 10000;
            const buyAmt = side === "buy" ? amt : total;
            const recvSym = side === "buy" ? sellToken?.symbol : buyToken?.symbol;
            const takerFeeAmt = buyAmt * takerFeeBps / 10000;
            // Effective receive: for "cover both", deduct your makerFee cost
            const recvAmt = isBoth ? buyAmt - makerFeeAmt : buyAmt - takerFeeAmt;

            return (
              <div className="bg-surface-container-low/30 rounded-lg px-4 py-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">You send</span>
                  <span className="font-mono text-on-surface">{sellAmt.toFixed(4)} {sellSym}</span>
                </div>
                <div className="flex justify-between text-error/80">
                  <span>Relay fee ({(makerFeeBps / 100).toFixed(2)}%{isBoth ? " — covers both" : ""})</span>
                  <span className="font-mono">−{makerFeeAmt.toFixed(4)} {sellSym}</span>
                </div>
                <div className="flex justify-between text-on-surface-variant/60">
                  <span>Counterparty receives</span>
                  <span className="font-mono">{(sellAmt - makerFeeAmt).toFixed(4)} {sellSym}</span>
                </div>
                <div className="flex justify-between font-bold text-tertiary pt-1 border-t border-outline-variant/10">
                  <span>You receive</span>
                  <span className="font-mono">{recvAmt.toFixed(4)} {recvSym}</span>
                </div>
                {!isBoth && takerFeeAmt > 0 && (
                  <div className="flex justify-between text-[10px] text-on-surface-variant/50">
                    <span>Taker fee deducted</span>
                    <span className="font-mono">−{takerFeeAmt.toFixed(4)} {recvSym}</span>
                  </div>
                )}
                {isSameToken ? (
                  <div className="flex justify-between text-[10px] text-on-surface-variant pt-0.5">
                    <span>Scheduled transfer (1:1)</span>
                    <span>{isBoth ? "Taker pays 0%" : `Relay fee ${(baseBps / 100).toFixed(2)}%`}</span>
                  </div>
                ) : (
                  <div className="flex justify-between text-[10px] text-on-surface-variant pt-0.5">
                    <span>@ {parseFloat(price).toLocaleString()} {buyToken?.symbol} per {sellToken?.symbol}</span>
                    <span>{isBoth ? "Taker pays 0%" : `Taker pays ${(baseBps / 100).toFixed(2)}%`}</span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Recipients (Claims) */}
          <div className="pt-4 border-t border-outline-variant/10">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Recipients (Scatter)
                {receiveToken && (
                  <span className="text-[10px] font-normal text-on-surface-variant bg-surface-container-low px-1.5 py-0.5 rounded">
                    receives {receiveToken.symbol}
                  </span>
                )}
              </h3>
              <button
                onClick={addClaim}
                disabled={claims.length >= MAX_CLAIMS}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary-container font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" /> Add {claims.length >= MAX_CLAIMS ? `(max ${MAX_CLAIMS})` : ""}
              </button>
            </div>

            {isSameToken && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-tertiary/10 border border-tertiary/20 text-xs mb-3">
                <AlertCircle className="w-4 h-4 text-tertiary flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold text-tertiary mb-0.5">Scheduled Transfer</div>
                  <div className="text-on-surface-variant/70">
                    Same-token transfer — your {sellToken?.symbol} will be deposited and scheduled for release on-chain.
                    No counterparty needed. Relayer submits the transaction.
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {claims.map((c, idx) => (
                <div key={c.id} className="bg-surface-container-low/50 rounded-lg p-3 border border-outline-variant/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] text-on-surface-variant font-bold">#{idx + 1}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => updateClaim(c.id, "mode", "standard")}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          c.mode === "standard" ? "bg-surface-container-highest text-on-surface" : "text-on-surface-variant"
                        }`}
                      >Standard</button>
                      <button
                        onClick={() => updateClaim(c.id, "mode", "stealth")}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          c.mode === "stealth" ? "bg-primary/10 text-primary" : "text-on-surface-variant"
                        }`}
                      >Stealth</button>
                    </div>
                    <div className="flex-1" />
                    {claims.length > 1 && (
                      <button onClick={() => removeClaim(c.id)} className="text-on-surface-variant hover:text-error">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-12 gap-2">
                    <div className="col-span-6">
                      <input
                        type="text" value={c.address}
                        onChange={(e) => updateClaim(c.id, "address", e.target.value)}
                        placeholder={c.mode === "stealth" ? "st:eth:0x..." : "0x... (empty = self)"}
                        className={`w-full bg-surface-container-low border rounded-md p-2 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface ${
                          c.mode === "stealth" && c.address && !isMetaAddress(c.address) ? "border-error/50" : "border-outline-variant/20"
                        }`}
                      />
                    </div>
                    <div className="col-span-3">
                      <div className="flex gap-1">
                        <input
                          type="text" inputMode="decimal" value={c.amount}
                          onChange={(e) => updateClaim(c.id, "amount", e.target.value)}
                          placeholder="Amount"
                          className="flex-1 min-w-0 bg-surface-container-low border border-outline-variant/20 rounded-md p-2 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
                        />
                        <button
                          type="button"
                          onClick={() => fillRest(c.id)}
                          className="px-2 py-1 bg-primary/10 text-primary text-[10px] font-bold rounded-md hover:bg-primary/20 transition-colors flex-shrink-0"
                          title="Fill remaining amount after fee"
                        >
                          Rest
                        </button>
                      </div>
                    </div>
                    <div className="col-span-3">
                      <div className="flex items-center gap-1 bg-surface-container-low border border-outline-variant/20 rounded-md p-2" title="Release delay — time after settlement before recipient can claim">
                        <Clock className="w-3 h-3 text-on-surface-variant flex-shrink-0" />
                        <input
                          type="number" value={c.delay}
                          onChange={(e) => updateClaim(c.id, "delay", e.target.value)}
                          className="w-12 bg-transparent border-none p-0 text-xs font-mono focus:ring-0 text-on-surface"
                          min="1"
                        />
                        <select
                          value={c.delayUnit}
                          onChange={(e) => updateClaim(c.id, "delayUnit", e.target.value)}
                          className="bg-transparent border-none p-0 text-[10px] font-mono focus:ring-0 text-on-surface-variant"
                        >
                          <option value="min">min</option>
                          <option value="hr">hr</option>
                          <option value="day">day</option>
                        </select>
                      </div>
                      <p className="text-[9px] text-on-surface-variant mt-0.5">
                        Claimable {c.delay || "?"} {c.delayUnit === "day" ? (c.delay === "1" ? "day" : "days") : c.delayUnit === "hr" ? (c.delay === "1" ? "hour" : "hours") : (c.delay === "1" ? "minute" : "minutes")} after settlement
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {receiveToken && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] text-on-surface-variant flex justify-between">
                  <span>Claims total: {claimTotal} {receiveToken.symbol}</span>
                  <span>Distributable: {distributable > 0 ? distributable.toFixed(4) : "—"} {receiveToken.symbol}</span>
                </div>
                {distributable > 0 && claimTotal > 0 && claimTotal <= distributable && (
                  <div className="text-[10px] flex justify-between">
                    <span className="text-on-surface-variant">
                      Remaining: {(distributable - claimTotal).toFixed(4)} {receiveToken.symbol}
                    </span>
                    {distributable - claimTotal > 0 && distributable - claimTotal < distributable * 0.001 && (
                      <span className="text-on-surface-variant/50">dust → relayer</span>
                    )}
                  </div>
                )}
                {distributable > 0 && claimTotal > distributable && (
                  <div className="text-[10px] text-error font-bold">
                    Claims ({claimTotal.toFixed(4)}) exceed distributable ({distributable.toFixed(4)} {receiveToken.symbol})
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Relayer selector */}
          <div className="bg-surface rounded-lg p-3 border border-outline-variant/10">
            <label className="text-[10px] text-on-surface-variant/50 uppercase tracking-wider block mb-1.5">Relayer</label>
            {onlineRelayers.length === 0 ? (
              <div className="text-xs text-error">No online relayers available</div>
            ) : (
              <select
                value={selectedRelayerIdx}
                onChange={(e) => setSelectedRelayerIdx(Number(e.target.value))}
                className="w-full bg-surface-container border border-outline-variant/20 rounded-md px-3 py-2 text-xs font-mono text-on-surface"
              >
                {onlineRelayers.map((r, i) => (
                  <option key={r.address} value={i}>
                    {r.address.slice(0, 10)}... — Fee {(r.fee / 100).toFixed(2)}% — {r.api?.orderCount ?? 0} orders
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={status === "signing" || status === "submitting" || !amount || (!isSameToken && !price) || !activeRelayer || (claimTotal > 0 && distributable > 0 && claimTotal > distributable)}
            className="w-full gradient-btn py-4 rounded-md text-on-primary-fixed font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {status === "signing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Signing...</>
            ) : status === "submitting" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>
            ) : (
              <><Lock className="w-4 h-4" /> {isSameToken ? "Sign & Submit Transfer" : "Sign & Submit to Relayer"}</>
            )}
          </button>
          <div className="flex gap-2">
            <button onClick={saveDraft} className="flex-1 flex items-center justify-center gap-1 py-2 text-xs font-bold text-primary bg-primary/10 hover:bg-primary/20 rounded-md transition-colors">
              {draftSaved ? <><Check className="w-3.5 h-3.5" /> Saved</> : <><Save className="w-3.5 h-3.5" /> Save Draft</>}
            </button>
            <button onClick={loadDraft} className="flex-1 flex items-center justify-center gap-1 py-2 text-xs font-bold text-on-surface-variant bg-surface-container-low hover:bg-surface-container rounded-md transition-colors">
              <FolderOpen className="w-3.5 h-3.5" /> Load Draft
            </button>
          </div>
          <p className="text-center text-[10px] text-on-surface-variant">
            EIP-712 signature — no gas required. Relayer executes the {isSameToken ? "scheduled transfer" : "trade"}.
          </p>

          {status === "error" && error && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
          )}
        </div>

        {/* Success: Claim Links */}
        {status === "success" && claimLinks.length > 0 && (
          <div className="mt-4 bg-surface-container-low border-2 border-dashed border-primary/20 p-6 rounded-xl">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-tertiary/10 flex items-center justify-center">
                <Check className="w-4 h-4 text-tertiary" />
              </div>
              <div>
                <h4 className="font-headline font-bold text-on-surface text-sm">Order Submitted</h4>
                <p className="text-on-surface-variant text-xs">Share claim links securely with recipients.</p>
              </div>
            </div>
            <div className="space-y-2">
              {claimLinks.map((link, i) => (
                <div key={i} className="flex items-center gap-2 bg-surface-container-highest rounded-md p-2 border border-outline-variant/20">
                  <span className="text-[10px] text-on-surface-variant font-bold">#{i + 1}</span>
                  <code className="text-[11px] text-primary truncate flex-1 font-mono">{link}</code>
                  <button onClick={() => handleCopy(link, i)} className="p-1.5 hover:bg-surface-bright rounded text-on-surface-variant">
                    {copied === i ? <Check className="w-3.5 h-3.5 text-tertiary" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => {
                const text = claimLinks.map((link, i) => `Claim #${i + 1}: ${link}`).join("\n");
                const blob = new Blob([text], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `claim-links-${Date.now()}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="mt-3 w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-primary/10 text-primary text-xs font-bold hover:bg-primary/20 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Download All Claim Links
            </button>
          </div>
        )}
      </div>

      {/* Right: Price Reference + Orderbook */}
      <div className="w-full xl:w-[340px]">
        <div className="sticky top-20">
          <PricePanel
            sellSymbol={sellToken?.symbol}
            buySymbol={buyToken?.symbol}
            sellTokenAddress={sellToken?.address}
            buyTokenAddress={buyToken?.address}
            sellDecimals={sellToken?.decimals}
            buyDecimals={buyToken?.decimals}
            relayerUrl={activeRelayer?.url ?? "http://localhost:3001"}
            side={side}
            onSelectPrice={setPrice}
          />
        </div>
      </div>
    </div>
  );
}
