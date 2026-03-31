"use client";

import { useState, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { Loader2, Copy, Check, Clock, Shield, Lock, Plus, Trash2, AlertCircle } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getSettlementAddress, getEnv } from "../../lib/config";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { signOrder, generateSecret, buildClaimLink } from "../../lib/signing";
import type { OrderInput, ClaimInput } from "../../lib/signing";
import { RelayerClient } from "../../lib/relayerApi";
import { isMetaAddress, generateStealthAddress, buildStealthClaimLink } from "../../lib/stealth";

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

const RELAYER_URL = getEnv("NEXT_PUBLIC_RELAYER_URL") || "http://localhost:3001";
const MAX_CLAIMS = 10; // matches MAX_CLAIMS_PER_ORDER in ScatterSettlement
const MIN_RELEASE_DELAY = 3600; // 1 hour — matches MIN_RELEASE_DELAY in contract

interface ClaimRow {
  id: number;
  mode: RecipientMode;
  address: string;      // standard address or meta-address
  amount: string;       // claim amount
  delay: string;        // seconds
}

export default function OrderPage() {
  const { account, chainId, signer } = useWallet();
  const tokens = useMemo(() => getTokenList().filter((t) => !t.isNative), []);
  const nextClaimId = useRef(1);

  // Token pair
  const [sellTokenIdx, setSellTokenIdx] = useState(0);
  const [buyTokenIdx, setBuyTokenIdx] = useState(tokens.length > 1 ? 1 : 0);

  // Order
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [expiry, setExpiry] = useState<ExpiryOption>("1D");
  const [maxFee, setMaxFee] = useState("30");

  // Claims (multiple recipients)
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "3600" },
  ]);

  // Submission
  const [status, setStatus] = useState<OrderStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [claimLinks, setClaimLinks] = useState<string[]>([]);
  const [copied, setCopied] = useState<number | null>(null);

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

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

  const addClaim = () => {
    if (claims.length >= MAX_CLAIMS) return;
    setClaims([...claims, { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "3600" }]);
  };

  const removeClaim = (id: number) => {
    if (claims.length <= 1) return;
    setClaims(claims.filter((c) => c.id !== id));
  };

  const updateClaim = (id: number, field: keyof ClaimRow, value: string) => {
    setClaims(claims.map((c) => c.id === id ? { ...c, [field]: value } : c));
  };

  const handleSubmit = async () => {
    if (!signer || !account || !chainId || !sellToken || !buyToken) return;
    if (!amount || !price) return;

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
      // Compute cross amount: amount * price using integer math at combined precision.
      const amountBig = ethers.parseUnits(amount, sellDecimals);
      const priceBig = ethers.parseUnits(price, buyDecimals);
      // crossAmount = amount * price (scaled to buyDecimals)
      const crossAmount = (amountBig * priceBig) / (10n ** BigInt(sellDecimals));

      const sellAmount = side === "sell" ? amountBig.toString() : crossAmount.toString();
      const buyAmount = side === "sell" ? crossAmount.toString() : amountBig.toString();

      // Build claims
      const links: string[] = [];
      const claimInputs: ClaimInput[] = claims.map((c, index) => {
        const secret = generateSecret();
        let recipient: string;
        let ephemeralPubKey: string | undefined;

        if (!c.address) {
          // No recipient specified: default to self
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

        // Validate releaseDelay
        const parsedDelay = parseInt(c.delay, 10);
        if (!Number.isNaN(parsedDelay) && parsedDelay < MIN_RELEASE_DELAY) {
          throw new Error(`Release delay for claim #${index + 1} must be at least ${MIN_RELEASE_DELAY} seconds (1 hour)`);
        }

        const claimAmount = c.amount
          ? ethers.parseUnits(c.amount, receiveToken?.decimals ?? 18).toString()
          : ""; // will be filled after validation

        // Build claim link
        if (ephemeralPubKey) {
          links.push(buildStealthClaimLink(secret, ephemeralPubKey));
        } else {
          links.push(buildClaimLink(secret));
        }

        return {
          recipient,
          amount: claimAmount,
          releaseDelay: !Number.isNaN(parsedDelay) ? parsedDelay : MIN_RELEASE_DELAY,
          secret,
        };
      });

      // Validate / auto-distribute claim amounts
      const buyAmountBig = BigInt(buyAmount);
      const filledSum = claimInputs.reduce(
        (sum, c) => sum + (c.amount ? BigInt(c.amount) : 0n), 0n
      );
      const emptyCount = claimInputs.filter((c) => !c.amount).length;

      if (emptyCount > 0) {
        if (filledSum > buyAmountBig) {
          throw new Error("Sum of specified claim amounts exceeds order buy amount");
        }
        // Distribute remaining amount evenly among empty claims
        const remaining = buyAmountBig - filledSum;
        const perEmpty = remaining / BigInt(emptyCount);
        let distributed = 0n;
        claimInputs.forEach((c, i) => {
          if (!c.amount) {
            // Last empty claim gets remainder to avoid rounding dust
            const isLast = claimInputs.slice(i + 1).every((x) => x.amount);
            c.amount = isLast ? (remaining - distributed).toString() : perEmpty.toString();
            distributed += BigInt(c.amount);
          }
        });
      } else {
        // All amounts specified — verify sum matches
        if (filledSum !== buyAmountBig) {
          throw new Error(
            `Sum of claim amounts (${ethers.formatUnits(filledSum, receiveToken?.decimals ?? 18)}) ` +
            `does not match order buy amount (${ethers.formatUnits(buyAmountBig, receiveToken?.decimals ?? 18)})`
          );
        }
      }

      // Use crypto-random nonce to avoid collisions at millisecond precision
      const nonceBuf = crypto.getRandomValues(new Uint8Array(6));
      const nonce = Number(BigInt("0x" + [...nonceBuf].map(b => b.toString(16).padStart(2, "0")).join("")));

      const orderInput: OrderInput = {
        sellToken: orderSellToken.address,
        buyToken: orderBuyToken.address,
        sellAmount,
        buyAmount,
        maxFee: parseInt(maxFee) || 30,
        expiry: Math.floor(Date.now() / 1000) + EXPIRY_SECONDS[expiry],
        nonce,
        claims: claimInputs,
      };

      const { signature, orderData } = await signOrder(signer, account, orderInput, chainId, settlementAddr);

      setStatus("submitting");
      const relayer = new RelayerClient(RELAYER_URL);
      await relayer.submitOrder(orderData, signature);

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

          {/* Amount + Price + Expiry */}
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Amount</label>
              <input
                type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2 px-3 text-lg font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Price</label>
              <input
                type="text" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2 px-3 text-lg font-mono"
              />
              {totalValue && (
                <div className="text-[10px] text-on-surface-variant">
                  Total: {totalValue} {side === "sell" ? buyToken?.symbol : sellToken?.symbol}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Expires</label>
              <div className="flex gap-1">
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

          {/* Recipients (Claims) */}
          <div className="pt-4 border-t border-outline-variant/10">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Recipients (Scatter)
              </h3>
              <button
                onClick={addClaim}
                disabled={claims.length >= MAX_CLAIMS}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary-container font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" /> Add {claims.length >= MAX_CLAIMS && `(max ${MAX_CLAIMS})`}
              </button>
            </div>

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
                      <input
                        type="text" inputMode="decimal" value={c.amount}
                        onChange={(e) => updateClaim(c.id, "amount", e.target.value)}
                        placeholder="Amount"
                        className="w-full bg-surface-container-low border border-outline-variant/20 rounded-md p-2 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
                      />
                    </div>
                    <div className="col-span-3">
                      <div className="flex items-center gap-1 bg-surface-container-low border border-outline-variant/20 rounded-md p-2">
                        <Clock className="w-3 h-3 text-on-surface-variant flex-shrink-0" />
                        <input
                          type="number" value={c.delay}
                          onChange={(e) => updateClaim(c.id, "delay", e.target.value)}
                          className="w-full bg-transparent border-none p-0 text-xs font-mono focus:ring-0 text-on-surface"
                          placeholder="3600"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {claims.length > 1 && receiveToken && (
              <div className="mt-2 text-[10px] text-on-surface-variant flex justify-between">
                <span>Claims total: {claimTotal} {receiveToken.symbol}</span>
                {totalValue && <span>Order total: {totalValue} {receiveToken.symbol}</span>}
              </div>
            )}
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={status === "signing" || status === "submitting" || !amount || !price}
            className="w-full gradient-btn py-4 rounded-md text-on-primary-fixed font-headline font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {status === "signing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Signing...</>
            ) : status === "submitting" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>
            ) : (
              <><Lock className="w-4 h-4" /> Sign & Submit to Relayer</>
            )}
          </button>
          <p className="text-center text-[10px] text-on-surface-variant">
            EIP-712 signature — no gas required. Relayer executes the trade.
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
          </div>
        )}
      </div>

      {/* Right: Order Summary */}
      <div className="w-full xl:w-[300px]">
        <div className="bg-surface-container-high rounded-xl p-5 border border-outline-variant/10 sticky top-20">
          <h3 className="font-headline font-bold text-sm text-on-surface mb-3">Order Summary</h3>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Side</span>
              <span className={`font-bold ${side === "buy" ? "text-tertiary" : "text-error"}`}>{side.toUpperCase()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Pair</span>
              <span className="font-mono text-on-surface">{sellToken?.symbol}/{buyToken?.symbol}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Amount</span>
              <span className="font-mono text-on-surface">{amount || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Price</span>
              <span className="font-mono text-on-surface">{price || "—"}</span>
            </div>
            {totalValue && (
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Total</span>
                <span className="font-mono text-on-surface">{totalValue}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Expiry</span>
              <span className="font-mono text-on-surface">{expiry}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-on-surface-variant">Recipients</span>
              <span className="font-mono text-on-surface">{claims.length}</span>
            </div>
            <div className="pt-2 border-t border-outline-variant/10 flex justify-between items-center font-bold">
              <span className="text-primary">Max Fee (bps)</span>
              <input
                type="number" min="0" max="10000" value={maxFee}
                onChange={(e) => setMaxFee(e.target.value)}
                className="w-16 bg-surface-container-low border border-outline-variant/20 rounded-md p-1 text-xs font-mono text-right text-on-surface focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
