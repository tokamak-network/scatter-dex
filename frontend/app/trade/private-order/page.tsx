"use client";

import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import { Shield, Key, Loader2, AlertCircle, Check } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  deriveEdDSAKey,
  signEdDSA,
  hashOrder,
  serializeKeyPair,
  deserializeKeyPair,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";

// NOTE: Storing EdDSA private key in localStorage is a known XSS risk.
// This is an acceptable trade-off for the MVP. In production, use encrypted
// storage (e.g., Web Crypto API with user-derived wrapping key) or hardware
// wallet integration to protect the key material.
const EDDSA_KEY_STORAGE = "zkscatter_eddsa_key";

type Step = "setup_key" | "create_order" | "signing" | "submitted" | "error";

export default function PrivateOrderPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList().filter((t) => !t.isNative);

  const [step, setStep] = useState<Step>("setup_key");
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Order form
  const [sellTokenIdx, setSellTokenIdx] = useState(0);
  const [buyTokenIdx, setBuyTokenIdx] = useState(1);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [expiry, setExpiry] = useState("24"); // hours

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

  // Load saved key
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(EDDSA_KEY_STORAGE);
    if (saved) {
      try {
        const kp = deserializeKeyPair(saved);
        setKeyPair(kp);
        setStep("create_order");
      } catch { /* invalid stored key */ }
    }
  }, []);

  // Derive EdDSA key from MetaMask
  const handleDeriveKey = useCallback(async () => {
    if (!signer) return;
    setKeyLoading(true);
    setError(null);
    try {
      const kp = await deriveEdDSAKey(signer);
      setKeyPair(kp);
      localStorage.setItem(EDDSA_KEY_STORAGE, serializeKeyPair(kp));
      setStep("create_order");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Key derivation failed");
    } finally {
      setKeyLoading(false);
    }
  }, [signer]);

  // Submit private order
  const handleSubmit = useCallback(async () => {
    if (!keyPair || !sellToken || !buyToken || !sellAmount || !buyAmount) return;
    setStep("signing");
    setError(null);

    try {
      const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
      const parsedBuy = ethers.parseUnits(buyAmount, buyToken.decimals);
      const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 3600);
      const nonce = BigInt(Date.now());

      // Compute order hash and sign with EdDSA
      const orderHash = await hashOrder({
        sellToken: BigInt(sellToken.address),
        buyToken: BigInt(buyToken.address),
        sellAmount: parsedSell,
        buyAmount: parsedBuy,
        maxFee: 60n,
        expiry: expiryTimestamp,
        nonce,
      });

      const sig = await signEdDSA(keyPair.privateKey, orderHash);

      // Submit to relayer
      const relayerUrl = process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";
      const res = await fetch(`${relayerUrl}/api/private-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellToken: sellToken.address,
          buyToken: buyToken.address,
          sellAmount: parsedSell.toString(),
          buyAmount: parsedBuy.toString(),
          maxFee: "60",
          expiry: expiryTimestamp.toString(),
          nonce: nonce.toString(),
          pubKeyAx: keyPair.publicKey[0].toString(),
          pubKeyAy: keyPair.publicKey[1].toString(),
          sigS: sig.S.toString(),
          sigR8x: sig.R8x.toString(),
          sigR8y: sig.R8y.toString(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit order");
      }

      setStep("submitted");
      setSellAmount("");
      setBuyAmount("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Order submission failed");
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry]);

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <Shield className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to create private orders</p>
        <button onClick={connect} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
          Connect Wallet
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          Private Order
        </h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">
          ZK-private order. Your identity and trade details are hidden on-chain.
        </p>
      </div>

      {/* Step 1: EdDSA Key Setup */}
      {step === "setup_key" && !keyPair && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 space-y-6">
          <div className="text-center">
            <Key className="w-12 h-12 text-primary mx-auto mb-4" />
            <h3 className="font-headline text-lg font-bold text-on-surface">Generate Trading Key</h3>
            <p className="text-sm text-on-surface-variant/70 mt-2">
              Sign a message with MetaMask to derive your ZK trading key.
              This key is used to sign private orders. It does not access your funds.
            </p>
          </div>

          {error && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <button
            onClick={handleDeriveKey}
            disabled={keyLoading}
            className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50"
          >
            {keyLoading ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Signing...
              </span>
            ) : (
              "Generate Key"
            )}
          </button>
        </div>
      )}

      {/* Step 2: Create Order */}
      {(step === "create_order" || step === "error") && keyPair && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 space-y-6">
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md">
            <Check className="w-3.5 h-3.5" />
            Trading key active: {keyPair.publicKey[0].toString().slice(0, 10)}...
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Sell</label>
              <select
                value={sellTokenIdx}
                onChange={(e) => setSellTokenIdx(Number(e.target.value))}
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3"
              >
                {tokens.map((t, i) => (
                  <option key={i} value={i}>{t.symbol}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Buy</label>
              <select
                value={buyTokenIdx}
                onChange={(e) => setBuyTokenIdx(Number(e.target.value))}
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3"
              >
                {tokens.map((t, i) => (
                  <option key={i} value={i}>{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Sell Amount</label>
              <input
                type="text"
                inputMode="decimal"
                value={sellAmount}
                onChange={(e) => setSellAmount(e.target.value)}
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Buy Amount</label>
              <input
                type="text"
                inputMode="decimal"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
                className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3"
                placeholder="0.00"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Expiry</label>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3"
            >
              <option value="1">1 hour</option>
              <option value="6">6 hours</option>
              <option value="24">24 hours</option>
              <option value="168">7 days</option>
            </select>
          </div>

          {error && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
          )}

          <button
            onClick={handleSubmit}
            disabled={!sellAmount || !buyAmount || sellTokenIdx === buyTokenIdx}
            className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50"
          >
            Submit Private Order
          </button>

          <div className="text-xs text-on-surface-variant/40 text-center">
            Order signed with EdDSA (Baby Jubjub). Hidden on-chain via ZK proof.
          </div>
        </div>
      )}

      {/* Signing */}
      {step === "signing" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
          <p className="text-on-surface font-medium">Signing order with EdDSA...</p>
        </div>
      )}

      {/* Submitted */}
      {step === "submitted" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Check className="w-12 h-12 text-emerald-400 mx-auto" />
          <p className="text-on-surface font-bold text-lg">Private Order Submitted</p>
          <p className="text-sm text-on-surface-variant/70">
            Your order is in the private order book. When matched, a ZK proof will be generated and settled on-chain without revealing your identity.
          </p>
          <button
            onClick={() => setStep("create_order")}
            className="px-6 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
          >
            Create Another Order
          </button>
        </div>
      )}
    </div>
  );
}
