"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { Shield, Key, Loader2, AlertCircle, Check, Plus, Trash2, Clock, FolderOpen, Wallet } from "lucide-react";
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
import { poseidonHash, buildMerkleTree, randomFieldElement } from "../../lib/zk/commitment";
import {
  isFileSystemAvailable,
  selectNotesFolder,
  hasFolderSelected,
  getFolderName,
  loadNotes,
  type StoredNote,
} from "../../lib/zk/note-storage";
import PricePanel from "../../components/PricePanel";

// SECURITY WARNING: EdDSA private key is stored in localStorage for UX convenience.
// Any XSS vulnerability could expose this key. In production, use Web Crypto API
// with a user-derived wrapping key or hardware wallet integration.
const EDDSA_KEY_STORAGE = "zkscatter_eddsa_key";
const MAX_CLAIMS = 10;

type Step = "setup_key" | "create_order" | "signing" | "submitted" | "error";

interface ClaimRow {
  id: number;
  address: string;
  amount: string;
  delay: string;
  delayUnit: "min" | "hr" | "day";
}

export default function PrivateOrderPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList().filter((t) => !t.isNative);

  const [step, setStep] = useState<Step>("setup_key");
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notes (commitment deposits)
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [selectedCommitment, setSelectedCommitment] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  // Order form
  const [sellTokenIdx, setSellTokenIdx] = useState(0);
  const [buyTokenIdx, setBuyTokenIdx] = useState(1);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [expiry, setExpiry] = useState("24");
  const [price, setPrice] = useState("");

  // Claims
  const nextClaimId = useRef(1);
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, address: "", amount: "", delay: "1", delayUnit: "hr" },
  ]);

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

  // Filter notes by sell token
  const availableNotes = useMemo(() => {
    if (!sellToken) return [];
    return notes.filter((n) => n.tokenAddress.toLowerCase() === sellToken.address.toLowerCase());
  }, [notes, sellToken]);

  const selectedNote = useMemo(
    () => availableNotes.find((n) => n.commitment === selectedCommitment) ?? null,
    [availableNotes, selectedCommitment],
  );

  // Reset note selection when sell token changes or notes list changes
  useEffect(() => {
    setSelectedCommitment(null);
  }, [sellTokenIdx]);

  // Clear selection if selected note no longer exists in available list
  useEffect(() => {
    if (selectedCommitment && !availableNotes.some((n) => n.commitment === selectedCommitment)) {
      setSelectedCommitment(null);
    }
  }, [availableNotes, selectedCommitment]);

  // Auto-fill sellAmount from selected note
  useEffect(() => {
    if (selectedNote) {
      setSellAmount(selectedNote.amount);
    }
  }, [selectedNote]);

  // Load notes from folder
  const handleOpenFolder = useCallback(async () => {
    if (!isFileSystemAvailable()) {
      setError("File System Access API is not supported in this browser. Use Chrome or Edge.");
      return;
    }
    const ok = await selectNotesFolder();
    if (ok) {
      setFolderName(getFolderName());
      const loaded = await loadNotes();
      setNotes(loaded);
    }
  }, []);

  const refreshNotes = useCallback(async () => {
    if (!hasFolderSelected()) return;
    const loaded = await loadNotes();
    setNotes(loaded);
  }, []);

  // Compute buy amount from price
  const handlePriceSelect = useCallback((p: string) => {
    setPrice(p);
    if (sellAmount) {
      const buy = parseFloat(sellAmount) * parseFloat(p);
      if (!isNaN(buy)) setBuyAmount(buy.toFixed(6));
    }
  }, [sellAmount]);

  // Claims helpers
  const addClaim = () => {
    if (claims.length >= MAX_CLAIMS) return;
    setClaims([...claims, { id: nextClaimId.current++, address: "", amount: "", delay: "1", delayUnit: "hr" }]);
  };
  const removeClaim = (id: number) => {
    if (claims.length <= 1) return;
    setClaims(claims.filter((c) => c.id !== id));
  };
  const updateClaim = (id: number, field: keyof ClaimRow, value: string) => {
    setClaims(claims.map((c) => c.id === id ? { ...c, [field]: value } : c));
  };

  const claimTotal = useMemo(() => {
    return claims.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  }, [claims]);

  const fillRest = (id: number) => {
    const buyAmt = parseFloat(buyAmount) || 0;
    const othersTotal = claims.reduce((sum, c) => c.id === id ? sum : sum + (parseFloat(c.amount) || 0), 0);
    const rest = Math.max(0, buyAmt - othersTotal);
    const floored = Math.floor(rest * 10000) / 10000;
    updateClaim(id, "amount", floored > 0 ? floored.toString() : "0");
  };

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
    if (!keyPair || !sellToken || !buyToken || !sellAmount || !buyAmount || !selectedNote) return;
    setStep("signing");
    setError(null);

    try {
      const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
      const parsedBuy = ethers.parseUnits(buyAmount, buyToken.decimals);
      const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 3600);
      const nonce = BigInt(Date.now());

      // Validate sell amount doesn't exceed note balance
      if (parsedSell > selectedNote.note.amount) {
        throw new Error(`Sell amount exceeds note balance (${selectedNote.amount} ${sellToken.symbol})`);
      }

      // Build claims data
      const claimData = claims.map((c, idx) => {
        if (c.address && !ethers.isAddress(c.address)) {
          throw new Error(`Claim #${idx + 1}: Invalid recipient address`);
        }
        const recipient = c.address || account || ethers.ZeroAddress;
        const delaySec = (parseInt(c.delay) || 1) * (c.delayUnit === "day" ? 86400 : c.delayUnit === "hr" ? 3600 : 60);
        const releaseTime = BigInt(Math.floor(Date.now() / 1000) + delaySec);
        const claimSecret = randomFieldElement();
        const claimAmount = c.amount
          ? ethers.parseUnits(c.amount, buyToken.decimals).toString()
          : "0";

        return {
          secret: claimSecret.toString(),
          recipient: BigInt(recipient).toString(),
          token: BigInt(buyToken.address).toString(),
          amount: claimAmount,
          releaseTime: releaseTime.toString(),
        };
      });

      // Compute claim leaf hashes and claimsRoot
      const claimLeafHashes = await Promise.all(
        claimData.map((c) => poseidonHash([
          BigInt(c.secret), BigInt(c.recipient), BigInt(c.token), BigInt(c.amount), BigInt(c.releaseTime),
        ]))
      );
      const padded = [...claimLeafHashes];
      while (padded.length < 16) padded.push(0n);
      const { root: claimsRoot } = await buildMerkleTree(padded, 4);

      // Compute order hash and sign with EdDSA
      const orderHash = await hashOrder({
        sellToken: BigInt(sellToken.address),
        buyToken: BigInt(buyToken.address),
        sellAmount: parsedSell,
        buyAmount: parsedBuy,
        maxFee: 60n,
        expiry: expiryTimestamp,
        nonce,
        claimsRoot,
      });

      const sig = await signEdDSA(keyPair.privateKey, orderHash);

      // Submit to zk-relayer with commitment info from note
      const relayerUrl = process.env.NEXT_PUBLIC_ZK_RELAYER_URL || "http://localhost:3002";
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
          // Commitment info from note
          ownerSecret: selectedNote.note.ownerSecret.toString(),
          balance: selectedNote.note.amount.toString(),
          salt: selectedNote.note.salt.toString(),
          leafIndex: selectedNote.leafIndex,
          claims: claimData,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit order");
      }

      setStep("submitted");
      setSellAmount("");
      setBuyAmount("");
      setPrice("");
      setSelectedCommitment(null);
      setClaims([{ id: nextClaimId.current++, address: "", amount: "", delay: "1", delayUnit: "hr" }]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Order submission failed");
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote]);

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
    <div className="flex flex-col xl:flex-row gap-6">
      {/* Left: Order Form */}
      <div className="flex-1 max-w-4xl space-y-6">
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

            {/* Notes Folder */}
            <div className="bg-surface-container-low/50 rounded-lg p-4 border border-outline-variant/5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-primary" />
                  Commitment (Escrow Balance)
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenFolder}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary-container font-bold"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    {folderName ? `${folderName}` : "Open Notes Folder"}
                  </button>
                  {folderName && (
                    <button
                      onClick={refreshNotes}
                      className="text-xs text-on-surface-variant hover:text-on-surface font-bold"
                    >
                      Refresh
                    </button>
                  )}
                </div>
              </div>

              {availableNotes.length > 0 ? (
                <div className="space-y-1.5">
                  {availableNotes.map((n, i) => (
                    <button
                      key={n.commitment}
                      onClick={() => setSelectedCommitment(n.commitment)}
                      className={`w-full flex items-center justify-between p-3 rounded-md text-left transition-colors ${
                        selectedCommitment === n.commitment
                          ? "bg-primary/10 border border-primary/30"
                          : "bg-surface-container-low border border-outline-variant/10 hover:bg-surface-bright/50"
                      }`}
                    >
                      <div>
                        <span className="text-xs font-mono font-bold text-on-surface">
                          {n.amount} {n.tokenSymbol}
                        </span>
                        <span className="text-[10px] text-on-surface-variant ml-2">
                          leaf #{n.leafIndex}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-on-surface-variant">
                        {n.txHash.slice(0, 10)}...
                      </span>
                    </button>
                  ))}
                </div>
              ) : folderName ? (
                <div className="text-xs text-on-surface-variant/60 text-center py-4">
                  No {sellToken?.symbol} notes found. Deposit in Private Escrow first.
                </div>
              ) : (
                <div className="text-xs text-on-surface-variant/60 text-center py-4">
                  Open your notes folder to select an escrow commitment.
                </div>
              )}

              {selectedNote && (
                <div className="text-[10px] text-on-surface-variant flex justify-between bg-surface-container-low rounded-md px-3 py-2">
                  <span>Selected balance: {selectedNote.amount} {selectedNote.tokenSymbol}</span>
                  <span>Leaf index: {selectedNote.leafIndex}</span>
                </div>
              )}
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
                  onChange={(e) => {
                    setSellAmount(e.target.value);
                    if (price && e.target.value) {
                      const buy = parseFloat(e.target.value) * parseFloat(price);
                      if (!isNaN(buy)) setBuyAmount(buy.toFixed(6));
                    }
                  }}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3"
                  placeholder="0.00"
                />
                {selectedNote && sellAmount && (() => {
                  try {
                    return ethers.parseUnits(sellAmount, sellToken?.decimals ?? 18) > selectedNote.note.amount;
                  } catch { return false; }
                })() && (
                  <div className="text-[10px] text-error mt-1">
                    Exceeds note balance ({selectedNote.amount} {sellToken?.symbol})
                  </div>
                )}
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
                {sellAmount && buyAmount && parseFloat(sellAmount) > 0 && (
                  <div className="text-[10px] text-on-surface-variant mt-1">
                    Price: {(parseFloat(buyAmount) / parseFloat(sellAmount)).toFixed(6)} {buyToken?.symbol}/{sellToken?.symbol}
                  </div>
                )}
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

            {/* Claims (multiple recipients) */}
            <div className="pt-4 border-t border-outline-variant/10">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-headline font-bold text-sm flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary" />
                  Recipients (Scatter)
                  {buyToken && (
                    <span className="text-[10px] font-normal text-on-surface-variant bg-surface-container-low px-1.5 py-0.5 rounded">
                      receives {buyToken.symbol}
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

              <div className="space-y-3">
                {claims.map((c, idx) => (
                  <div key={c.id} className="bg-surface-container-low/50 rounded-lg p-3 border border-outline-variant/5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[10px] text-on-surface-variant font-bold">#{idx + 1}</span>
                      <div className="flex-1" />
                      {claims.length > 1 && (
                        <button onClick={() => removeClaim(c.id)} className="text-on-surface-variant hover:text-error">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-5">
                        <input
                          type="text" value={c.address}
                          onChange={(e) => updateClaim(c.id, "address", e.target.value)}
                          placeholder="0x... (empty = self)"
                          className="w-full bg-surface-container-low border border-outline-variant/20 rounded-md p-2 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
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
                            title="Fill remaining amount"
                          >
                            Rest
                          </button>
                        </div>
                      </div>
                      <div className="col-span-4">
                        <div className="flex items-center gap-1 bg-surface-container-low border border-outline-variant/20 rounded-md p-2" title="Release delay">
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
                          Claimable after {c.delay || "?"} {c.delayUnit}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {buyToken && (
                <div className="mt-2 space-y-1">
                  <div className="text-[10px] text-on-surface-variant flex justify-between">
                    <span>Claims total: {claimTotal.toFixed(4)} {buyToken.symbol}</span>
                    <span>Buy amount: {buyAmount || "—"} {buyToken.symbol}</span>
                  </div>
                  {parseFloat(buyAmount) > 0 && claimTotal > parseFloat(buyAmount) && (
                    <div className="text-[10px] text-error font-bold">
                      Claims ({claimTotal.toFixed(4)}) exceed buy amount ({buyAmount} {buyToken.symbol})
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!sellAmount || !buyAmount || !selectedNote || sellTokenIdx === buyTokenIdx || (claimTotal > 0 && parseFloat(buyAmount) > 0 && claimTotal > parseFloat(buyAmount))}
              className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50"
            >
              {!selectedNote ? "Select a Commitment Note" : "Submit Private Order"}
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
              onClick={() => { setStep("create_order"); refreshNotes(); }}
              className="px-6 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
            >
              Create Another Order
            </button>
          </div>
        )}
      </div>

      {/* Right: Price Reference */}
      <div className="w-full xl:w-[340px]">
        <div className="sticky top-20">
          <PricePanel
            sellSymbol={sellToken?.symbol}
            buySymbol={buyToken?.symbol}
            sellTokenAddress={sellToken?.address}
            buyTokenAddress={buyToken?.address}
            sellDecimals={sellToken?.decimals}
            buyDecimals={buyToken?.decimals}
            relayerUrl={process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001"}
            side="sell"
            onSelectPrice={handlePriceSelect}
          />
        </div>
      </div>
    </div>
  );
}
