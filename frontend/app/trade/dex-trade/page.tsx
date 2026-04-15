"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { Shield, Key, Loader2, AlertCircle, Check, Plus, Trash2, Clock, FolderOpen, Wallet, Zap, ArrowLeftRight } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers } from "../../lib/useRelayers";
import { terminateAuthorizeWorker } from "../../lib/zk/authorize-worker-client";
import { useTerminateWorkerOnUnmount } from "../../lib/zk/useTerminateWorkerOnUnmount";
import { getTradableTokens } from "../../lib/tokens";
import EmptyState from "../../components/EmptyState";
import { useTokenPair } from "../../lib/useTokenPair";
import { AddressPicker } from "../../components/AddressPicker";
import {
  deriveEdDSAKey,
  serializeKeyPairEncrypted,
  deserializeKeyPairEncrypted,
  isEncryptedKeyPair,
  DERIVE_MESSAGE,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";
import { randomFieldElement, computeNullifier, toBytes32Hex } from "../../lib/zk/commitment";
import {
  isFileSystemAvailable,
  selectNotesFolder,
  hasFolderSelected,
  getFolderName,
  loadNotes,
  saveNote,
  saveFileToFolder,
  saveEdDSAKeyToFolder,
  loadEdDSAKeyFromFolder,
  type StoredNote,
} from "../../lib/zk/note-storage";
import { getPrivateSettlementAddress } from "../../lib/config";
import { getReadProvider } from "../../lib/provider";
import { PRIVATE_SETTLEMENT_ABI } from "../../lib/contracts";
import AggregatorQuotePanel from "../../components/AggregatorQuotePanel";
import { useMainnetPrice } from "../../lib/useDexPrices";
import { friendlyError } from "../../lib/error-messages";
import { buildOrderProof, type ClaimRow } from "../_shared/buildOrderProof";

const MAX_CLAIMS = 10;

type Step = "setup_key" | "create_order" | "signing" | "submitted" | "error";

export default function DexTradePage() {
  return (
    <Suspense fallback={<DexTradeLoading />}>
      <DexTradePageInner />
    </Suspense>
  );
}

function DexTradeLoading() {
  return (
    <div className="flex items-center justify-center min-h-[400px] text-on-surface-variant/60">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  );
}

function DexTradePageInner() {
  const { account, signer, chainId, connect } = useWallet();
  const { relayers } = useRelayers();
  useTerminateWorkerOnUnmount(terminateAuthorizeWorker);
  const tokens = useMemo(() => getTradableTokens(), []);

  const zkRelayers = useMemo(() =>
    relayers.filter((r) => r.online && r.api?.name?.includes("ZK")),
    [relayers]
  );
  const [selectedRelayerIdx, setSelectedRelayerIdx] = useState(0);
  const searchParams = useSearchParams();

  const [step, setStep] = useState<Step>("setup_key");
  const [signingProgress, setSigningProgress] = useState<string>("");
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notes (commitment deposits)
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [spentNotes, setSpentNotes] = useState<Set<string>>(new Set());
  const [selectedCommitment, setSelectedCommitment] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  // Order form — market mode uses sell/buy with auto-computed buy from DEX price.
  const { sellToken, buyToken, sellTokenIdx, buyTokenIdx, setSellTokenIdx, setBuyTokenIdx, swap: swapTokens, isReady: tokenPairReady } = useTokenPair(tokens);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [expiry, setExpiry] = useState("24");
  const [changeSalt, setChangeSalt] = useState<bigint | null>(null);
  const [slippageBps, setSlippageBps] = useState("50");
  const [manualPrice, setManualPrice] = useState("");

  // Claims
  const nextClaimId = useRef(1);
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" },
  ]);

  // Cached on mount / chainId change so submit doesn't pay an RPC round-trip
  // before the DEX route fetch.
  const [platformFeeBps, setPlatformFeeBps] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = new ethers.Contract(getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, getReadProvider());
        const v = Number(await c.dexPlatformFeeBps?.() ?? 0n);
        if (!cancelled) setPlatformFeeBps(v);
      } catch { if (!cancelled) setPlatformFeeBps(0); }
    })();
    return () => { cancelled = true; };
  }, [chainId]);

  // Relayer preselect from ?relayer=<address>
  const didPrefillRelayerRef = useRef(false);
  useEffect(() => {
    if (didPrefillRelayerRef.current) return;
    if (zkRelayers.length === 0) return;
    const want = searchParams.get("relayer");
    if (!want) return;
    const idx = zkRelayers.findIndex((r) => r.address.toLowerCase() === want.toLowerCase());
    if (idx >= 0) setSelectedRelayerIdx(idx);
    didPrefillRelayerRef.current = true;
  }, [zkRelayers, searchParams]);

  // Prefill form from URL params (for "Take order" deep-links).
  const didPrefillRef = useRef(false);
  useEffect(() => {
    if (didPrefillRef.current) return;
    if (tokens.length === 0) return;
    const sellSym = searchParams.get("sell");
    const buySym = searchParams.get("buy");
    if (!sellSym && !buySym) return;
    const si = sellSym ? tokens.findIndex((t) => t.symbol === sellSym) : -1;
    const bi = buySym ? tokens.findIndex((t) => t.symbol === buySym) : -1;
    if (si >= 0) setSellTokenIdx(si);
    if (bi >= 0) setBuyTokenIdx(bi);
    const sa = searchParams.get("sellAmount");
    if (sa) setSellAmount(sa);
    const eh = searchParams.get("expiryHours");
    if (eh) setExpiry(eh);
    didPrefillRef.current = true;
  }, [tokens, searchParams, setSellTokenIdx, setBuyTokenIdx]);

  // DEX prices (always active on this page).
  const { prices: dexPrices } = useMainnetPrice(sellToken?.symbol, buyToken?.symbol, "sell");

  const [aggregatorQuote, setAggregatorQuote] = useState<{
    estimatedOutput: bigint;
    effectivePrice: number;
    source: string;
  } | null>(null);
  const handleAggregatorQuote = useCallback(
    (q: { estimatedOutput: bigint; effectivePrice: number; source: string } | null) => {
      setAggregatorQuote(q);
      if (q === null) {
        setBuyAmount("");
      }
    },
    [],
  );

  const { marketPrice, marketPriceSource } = useMemo(() => {
    if (aggregatorQuote) return { marketPrice: aggregatorQuote.effectivePrice, marketPriceSource: aggregatorQuote.source };
    const rec = dexPrices.find((p) => p.recommended && p.netPrice !== null);
    if (rec?.netPrice) return { marketPrice: rec.netPrice, marketPriceSource: rec.source ?? "DEX" };
    const manual = parseFloat(manualPrice);
    if (!isNaN(manual) && manual > 0) return { marketPrice: manual, marketPriceSource: "manual" };
    return { marketPrice: null, marketPriceSource: null };
  }, [aggregatorQuote, dexPrices, manualPrice]);

  // Auto-compute buyAmount (BigInt floor to avoid rounding up).
  useEffect(() => {
    if (!marketPrice || !sellAmount || !buyToken) return;
    const sell = parseFloat(sellAmount);
    if (isNaN(sell) || sell <= 0) return;
    const slip = parseInt(slippageBps) || 50;
    const grossWei = ethers.parseUnits(
      (sell * marketPrice).toFixed(Math.min(buyToken.decimals, 18)),
      buyToken.decimals,
    );
    // Floor at 1 wei so a very small sell doesn't round to 0 and trip
    // the downstream `parsedBuy === 0n` gate (which surfaces
    // "isn't a valid amount" and blocks submit). If grossWei itself is
    // 0 the sell is genuinely below one wei of buy value — that's
    // unbounded-slippage territory and the user should raise their
    // input rather than having us fabricate a floor.
    const scaled = grossWei * BigInt(10000 - slip) / 10000n;
    const minReceiveWei = grossWei > 0n && scaled === 0n ? 1n : scaled;
    setBuyAmount(ethers.formatUnits(minReceiveWei, buyToken.decimals));
  }, [marketPrice, sellAmount, slippageBps, buyToken?.decimals]);

  // Check which notes are spent on-chain (parallel).
  useEffect(() => {
    if (notes.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = getReadProvider();
        const settlement = new ethers.Contract(
          getPrivateSettlementAddress(), PRIVATE_SETTLEMENT_ABI, provider
        );
        const activeNotes = notes.filter((n) => n.leafIndex >= 0);
        const results = await Promise.all(
          activeNotes.map(async (n) => {
            const nullifier = await computeNullifier(n.note);
            const isSpent = await settlement.nullifiers(toBytes32Hex(nullifier));
            return { commitment: n.commitment, isSpent };
          })
        );
        if (!cancelled) setSpentNotes(new Set(results.filter((r) => r.isSpent).map((r) => r.commitment)));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [notes]);

  const availableNotes = useMemo(() => {
    if (!sellToken) return [];
    return notes.filter((n) =>
      n.tokenAddress.toLowerCase() === sellToken.address.toLowerCase() &&
      n.leafIndex >= 0 &&
      !spentNotes.has(n.commitment)
    );
  }, [notes, sellToken, spentNotes]);

  const selectedNote = useMemo(
    () => availableNotes.find((n) => n.commitment === selectedCommitment) ?? null,
    [availableNotes, selectedCommitment],
  );

  useEffect(() => {
    setSelectedCommitment(null);
  }, [sellTokenIdx]);
  useEffect(() => {
    setManualPrice("");
  }, [sellTokenIdx, buyTokenIdx]);

  useEffect(() => {
    if (selectedCommitment && !availableNotes.some((n) => n.commitment === selectedCommitment)) {
      setSelectedCommitment(null);
    }
  }, [availableNotes, selectedCommitment]);

  useEffect(() => {
    if (selectedNote && !sellAmount) {
      setSellAmount(selectedNote.amount);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Claims helpers
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

  const buyTokenDecimals = buyToken?.decimals;

  const sumClaimWei = useCallback((excludeId?: number): bigint => {
    if (buyTokenDecimals == null) return 0n;
    return claims.reduce((acc, c) => {
      if (c.id === excludeId || !c.amount) return acc;
      try { return acc + ethers.parseUnits(c.amount, buyTokenDecimals); }
      catch { return acc; }
    }, 0n);
  }, [claims, buyTokenDecimals]);

  const claimTotalWei = useMemo(() => sumClaimWei(), [sumClaimWei]);
  const claimTotalDisplay = useMemo(() => {
    if (buyTokenDecimals == null) return "0";
    return ethers.formatUnits(claimTotalWei, buyTokenDecimals);
  }, [claimTotalWei, buyTokenDecimals]);

  // DEX path passes maxFee=0; circuit asserts totalLocked >= buyAmount,
  // so claims must cover the full buyAmount with no fee subtraction.
  const claimShortfall = useMemo((): bigint | null => {
    if (buyTokenDecimals == null || !buyAmount) return null;
    try {
      const parsedBuy = ethers.parseUnits(buyAmount, buyTokenDecimals);
      if (parsedBuy === 0n) return null;
      return claimTotalWei >= parsedBuy ? 0n : parsedBuy - claimTotalWei;
    } catch {
      return null;
    }
  }, [claimTotalWei, buyAmount, buyTokenDecimals]);

  // Fill the row to exactly parsedBuy − sum(others). No fee subtraction
  // because maxFee=0 in the DEX settle path; the platform fee is taken
  // separately from sellAmount and isn't part of totalLocked.
  const fillRest = (id: number) => {
    if (buyTokenDecimals == null || !buyAmount) return;
    try {
      const parsedBuy = ethers.parseUnits(buyAmount, buyTokenDecimals);
      const othersBig = sumClaimWei(id);
      const restBig = parsedBuy > othersBig ? parsedBuy - othersBig : 0n;
      updateClaim(id, "amount", ethers.formatUnits(restBig, buyTokenDecimals));
    } catch {
      /* buyAmount still being typed; no-op */
    }
  };

  // Change (remainder) calculation
  const changeAmount = useMemo(() => {
    if (!selectedNote || !sellAmount || !sellToken) return 0n;
    try {
      const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
      const rem = selectedNote.note.amount - parsedSell;
      return rem > 0n ? rem : 0n;
    } catch { return 0n; }
  }, [selectedNote, sellAmount, sellToken]);

  useEffect(() => {
    if (changeAmount > 0n) {
      setChangeSalt(randomFieldElement());
    } else {
      setChangeSalt(null);
    }
  }, [changeAmount]);

  const [hasStoredKey, setHasStoredKey] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !hasFolderSelected()) return;
    if (!account) return;
    loadEdDSAKeyFromFolder(account).then((saved) => setHasStoredKey(!!saved));
  }, [folderName, account]);

  const handleDeriveKey = useCallback(async () => {
    if (!signer || !account) return;
    if (!hasFolderSelected()) {
      setError("Select a notes folder first");
      return;
    }
    setKeyLoading(true);
    setError(null);
    try {
      const saved = await loadEdDSAKeyFromFolder(account);
      if (saved && isEncryptedKeyPair(saved)) {
        const signature = await signer.signMessage(DERIVE_MESSAGE);
        const kp = await deserializeKeyPairEncrypted(saved, signature, account);
        setKeyPair(kp);
        setStep("create_order");
      } else {
        const { keyPair: kp, signature } = await deriveEdDSAKey(signer);
        const encrypted = await serializeKeyPairEncrypted(kp, signature, account);
        await saveEdDSAKeyToFolder(encrypted, account);
        setHasStoredKey(true);
        setKeyPair(kp);
        setStep("create_order");
      }
    } catch (e: unknown) {
      setError(friendlyError(e));
    } finally {
      setKeyLoading(false);
    }
  }, [signer, account]);

  // Submit market order — generate proof + call settleWithDex on-chain.
  const handleMarketSubmit = useCallback(async () => {
    if (!sellToken || !buyToken || !sellAmount || !buyAmount || !selectedNote || !signer || !account) return;
    const kp = keyPair;
    if (!kp) { setError("Unlock or generate a trading key first"); return; }

    setStep("signing");
    setSigningProgress("Preparing market order...");
    setError(null);

    try {
      const { proofResult, claimData, claimDataWithEpk, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment } = await buildOrderProof({
        sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account,
        selectedNote, changeSalt, maxFee: 0n,
        relayerAddress: account, eddsaPrivateKey: kp.privateKey,
        zkRelayerUrl: zkRelayers[selectedRelayerIdx]?.url,
        onProgress: setSigningProgress,
      });

      setSigningProgress("Submitting market settle on-chain...");
      const ps = proofResult.publicSignals;
      const settlementAddr = getPrivateSettlementAddress();
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, signer);

      const platformFee = platformFeeBps ?? Number(
        await new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, getReadProvider()).dexPlatformFeeBps?.() ?? 0n
      );
      const swapAmountIn = platformFee > 0
        ? parsedSell - (parsedSell * BigInt(platformFee) / 10000n)
        : parsedSell;

      const { getBestSwapRoute } = await import("../../lib/dex-aggregator");
      const currentChainId = chainId ?? 1;
      const bestDexPrice = dexPrices.find(p => p.recommended && p.netPrice !== null);
      const feeParsed = Math.round(parseFloat(bestDexPrice?.fee ?? "0") * 10000);
      const feeTier = [100, 500, 3000, 10000].includes(feeParsed) ? feeParsed : undefined;

      // On-chain `settleWithDex` requires the DEX `amountOut >= totalLocked`.
      // Using totalLocked as minReceive (tighter than parsedBuy) matches the
      // contract's own check and prevents a revert when claims happen to sum
      // slightly above the signed buyAmount.
      const totalLocked = claimData.reduce((sum, c) => sum + BigInt(c.amount), 0n);

      const swapRoute = await getBestSwapRoute({
        chainId: currentChainId,
        sellToken: sellToken.address,
        buyToken: buyToken.address,
        sellAmount: swapAmountIn,
        minReceive: totalLocked,
        recipient: settlementAddr,
        slippageBps: parseInt(slippageBps) || 50,
        feeTier,
      });
      if (process.env.NODE_ENV === "development") {
        console.log(`DEX route: ${swapRoute.source} (estimated: ${ethers.formatUnits(swapRoute.estimatedOutput, buyToken.decimals)} ${buyToken.symbol})`);
      }
      const proofA = [BigInt(proofResult.proof.a[0]), BigInt(proofResult.proof.a[1])];
      const proofB = [
        [BigInt(proofResult.proof.b[0][0]), BigInt(proofResult.proof.b[0][1])],
        [BigInt(proofResult.proof.b[1][0]), BigInt(proofResult.proof.b[1][1])],
      ];
      const proofC = [BigInt(proofResult.proof.c[0]), BigInt(proofResult.proof.c[1])];

      const nullifierHex = toBytes32Hex(BigInt(ps[2]));
      const tx = await settlement.settleWithDex({
        proof: {
          proofA, proofB, proofC,
          pubKeyBind: toBytes32Hex(BigInt(ps[0])),
          commitmentRoot: ps[1],
          nullifier: nullifierHex,
          nonceNullifier: toBytes32Hex(BigInt(ps[3])),
          newCommitment: toBytes32Hex(BigInt(ps[4])),
          sellToken: sellToken.address,
          buyToken: buyToken.address,
          sellAmount: parsedSell,
          buyAmount: parsedBuy,
          maxFee: 0,
          expiry: expiryTimestamp,
          claimsRoot: toBytes32Hex(BigInt(ps[11])),
          totalLocked,
          relayer: account,
          orderHash: toBytes32Hex(BigInt(ps[14])),
        },
        dexRouter: swapRoute.dexRouter,
        dexCalldata: swapRoute.dexCalldata,
        deadline: expiryTimestamp,
      });
      await tx.wait();

      const claimFiles = claimDataWithEpk.map((c, idx) => ({
        secret: c.secret, recipient: c.recipient, token: c.token,
        amount: c.amount, releaseTime: c.releaseTime, leafIndex: idx,
        allLeaves: padded.map((l) => l.toString()),
        ...(c.ephemeralPubKey ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
      }));
      const bundle = {
        order: {
          sellToken: sellToken.address,
          buyToken: buyToken.address,
          sellAmount: parsedSell.toString(),
          buyAmount: parsedBuy.toString(),
          maxFee: 0,
          expiry: expiryTimestamp.toString(),
          nonce: nonce.toString(),
          leafIndex: selectedNote.leafIndex,
          type: "market" as const,
          nullifier: nullifierHex,
          slippageBps: parseInt(slippageBps) || 50,
          estimatedOutput: swapRoute.estimatedOutput.toString(),
          dexRouter: swapRoute.dexRouter,
          dexSource: swapRoute.source,
        },
        change: change > 0n ? { amount: change.toString(), salt: newSalt.toString(), expectedCommitment: expectedChangeCommitment.toString() } : null,
        claims: claimFiles,
        txHash: tx.hash,
        note: "Market order settled via DEX. Each entry can be loaded in Private Claim.",
        createdAt: new Date().toISOString(),
      };
      const bundleJson = JSON.stringify(bundle, null, 2);
      const claimsFilename = `zkscatter-market-claims-${Date.now()}.json`;
      try { await saveFileToFolder(claimsFilename, bundleJson); } catch (e) { console.error("Failed to save claims bundle to folder:", e); }
      const blob = new Blob([bundleJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = claimsFilename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (change > 0n && changeSalt) {
        try {
          await saveNote({ note: { ownerSecret: selectedNote.note.ownerSecret, token: selectedNote.note.token, amount: change, salt: changeSalt, pubKeyAx: selectedNote.note.pubKeyAx, pubKeyAy: selectedNote.note.pubKeyAy },
            commitment: toBytes32Hex(expectedChangeCommitment), tokenSymbol: sellToken.symbol, tokenAddress: sellToken.address,
            amount: ethers.formatUnits(change, sellToken.decimals), leafIndex: -1, txHash: tx.hash, createdAt: Date.now() });
        } catch (e) { console.error("Failed to save change note locally — the tx succeeded but the local record is missing:", e); }
      }

      setSigningProgress("");
      setStep("submitted");
      setSellAmount(""); setBuyAmount(""); setSelectedCommitment(null);
      setClaims([{ id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" }]);
    } catch (e: unknown) {
      setError(friendlyError(e));
      setSigningProgress("");
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, signer, changeSalt, dexPrices, zkRelayers, selectedRelayerIdx, chainId, slippageBps, platformFeeBps]);

  if (!account) {
    return (
      <EmptyState
        icon={Zap}
        title="Connect wallet to execute DEX trades"
        action={
          <button onClick={() => connect()} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
            Connect Wallet
          </button>
        }
      />
    );
  }

  if (!tokenPairReady) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Token list unavailable"
        description={<>At least two tokens must be configured via <code>NEXT_PUBLIC_TOKENS</code> for trading. Contact the deployment operator if you&apos;re seeing this on a production build.</>}
      />
    );
  }

  return (
    <div className="flex flex-col xl:flex-row gap-6">
      <div className="flex-1 max-w-4xl space-y-6">
        <div>
          <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
            <Zap className="w-6 h-6 text-tertiary" />
            DEX Trade
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            Public market order via DEX aggregator. Swap details are visible on-chain.
          </p>
        </div>

        {(step === "setup_key" || step === "create_order" || step === "error") && (
          <div className="space-y-4">
            {/* 1. Escrow Selection */}
            <div className="bg-surface-container/60 rounded-xl p-6 border border-outline-variant/10 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-headline font-bold text-base flex items-center gap-2">
                  <Wallet className="w-5 h-5 text-primary" />
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
                  {availableNotes.map((n) => (
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
                        <span className="text-sm font-mono font-bold text-on-surface">
                          {n.amount} {n.tokenSymbol}
                        </span>
                        <span className="text-xs text-on-surface-variant ml-2">
                          leaf #{n.leafIndex}
                        </span>
                      </div>
                      <span className="text-xs font-mono text-on-surface-variant">
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
                <div className="space-y-1">
                  <div className="text-sm text-on-surface-variant flex justify-between bg-surface-container-low rounded-md px-3 py-2">
                    <span>Selected balance: {selectedNote.amount} {selectedNote.tokenSymbol}</span>
                    <span>Leaf index: {selectedNote.leafIndex}</span>
                  </div>
                  {changeAmount > 0n && sellToken && (
                    <div className="text-sm bg-tertiary/10 text-tertiary rounded-md px-3 py-2 space-y-1">
                      <div className="flex justify-between font-bold">
                        <span>Change (remainder)</span>
                        <span className="font-mono">{ethers.formatUnits(changeAmount, sellToken.decimals)} {sellToken.symbol}</span>
                      </div>
                      {changeSalt && (
                        <div className="flex justify-between text-tertiary/70">
                          <span>Salt</span>
                          <span className="font-mono truncate ml-4">{changeSalt.toString().slice(0, 16)}...</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 2. Token & Amount */}
            <div className="bg-surface-container/40 rounded-xl p-6 border border-outline-variant/10 space-y-4">
              <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Sell</label>
                  <select
                    value={sellTokenIdx}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setSellTokenIdx(next);
                      if (next === buyTokenIdx) {
                        const alt = tokens.findIndex((_, i) => i !== next);
                        if (alt >= 0) setBuyTokenIdx(alt);
                      }
                    }}
                    className="w-full bg-white/10 border border-outline-variant/30 focus:ring-1 focus:ring-primary text-on-surface rounded-lg py-3 px-4 text-base"
                  >
                    {tokens.map((t, i) => (
                      <option key={i} value={i} disabled={i === buyTokenIdx}>
                        {t.symbol}{i === buyTokenIdx ? " (in Buy)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={swapTokens}
                  title="Swap Sell / Buy tokens"
                  aria-label="Swap Sell and Buy tokens"
                  className="mb-1 w-10 h-10 flex items-center justify-center rounded-full bg-surface-container-low border border-outline-variant/20 text-on-surface-variant hover:bg-tertiary/20 hover:text-tertiary hover:border-tertiary/30 transition-colors"
                >
                  <ArrowLeftRight className="w-4 h-4" />
                </button>
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Buy</label>
                  <select
                    value={buyTokenIdx}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setBuyTokenIdx(next);
                      if (next === sellTokenIdx) {
                        const alt = tokens.findIndex((_, i) => i !== next);
                        if (alt >= 0) setSellTokenIdx(alt);
                      }
                    }}
                    className="w-full bg-white/10 border border-outline-variant/30 focus:ring-1 focus:ring-primary text-on-surface rounded-lg py-3 px-4 text-base"
                  >
                    {tokens.map((t, i) => (
                      <option key={i} value={i} disabled={i === sellTokenIdx}>
                        {t.symbol}{i === sellTokenIdx ? " (in Sell)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Sell Amount</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={sellAmount}
                    onChange={(e) => setSellAmount(e.target.value)}
                    className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3"
                    placeholder="0.00"
                  />
                  {selectedNote && sellAmount && (() => {
                    try {
                      return ethers.parseUnits(sellAmount, sellToken?.decimals ?? 18) > selectedNote.note.amount;
                    } catch { return false; }
                  })() && (
                    <div className="text-xs text-error mt-1">
                      Exceeds note balance ({selectedNote.amount} {sellToken?.symbol})
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2 text-right">
                    Min Receive (after slippage)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={buyAmount}
                    readOnly
                    className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3 text-right opacity-70"
                    placeholder="0.00"
                  />
                  {marketPrice && sellAmount && parseFloat(sellAmount) > 0 && (
                    <div className="text-xs text-on-surface-variant mt-1 text-right">
                      {marketPriceSource === "manual" ? "Manual" : "DEX"} rate: {marketPrice.toFixed(6)} {buyToken?.symbol}/{sellToken?.symbol}
                      <span className={`ml-1 ${marketPriceSource === "manual" ? "text-warning" : "text-tertiary"}`}>({marketPriceSource})</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 3. Slippage & Expiry */}
            <div className="bg-surface-container/30 rounded-xl p-6 border border-outline-variant/10 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Slippage Tolerance</label>
                  <div className="flex gap-1.5">
                    {[
                      { label: "0.1%", bps: "10" },
                      { label: "0.3%", bps: "30" },
                      { label: "0.5%", bps: "50" },
                      { label: "1%", bps: "100" },
                      { label: "3%", bps: "300" },
                    ].map((opt) => (
                      <button
                        key={opt.bps}
                        type="button"
                        onClick={() => setSlippageBps(opt.bps)}
                        className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${
                          slippageBps === opt.bps
                            ? "bg-tertiary text-on-tertiary"
                            : "bg-surface-container-low text-on-surface-variant hover:bg-surface-bright"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {marketPrice && sellAmount && parseFloat(sellAmount) > 0 && (() => {
                    const gross = parseFloat(sellAmount) * marketPrice;
                    const slip = (parseInt(slippageBps) || 50) / 10000;
                    const minReceive = gross * (1 - slip);
                    const surplusMax = gross - minReceive;
                    return (
                      <div className="text-xs text-on-surface-variant mt-1 space-y-0.5">
                        <div>
                          You receive (min): <span className="font-mono text-tertiary">{minReceive.toFixed(4)} {buyToken?.symbol}</span>
                        </div>
                        <div>
                          Platform surplus (max): <span className="font-mono text-warning">≤ {surplusMax.toFixed(4)} {buyToken?.symbol}</span>
                          <span className="ml-1 opacity-70">(positive slippage → treasury)</span>
                        </div>
                      </div>
                    );
                  })()}
                  {!marketPrice && dexPrices.some(p => p.loading) && (
                    <div className="text-xs text-warning mt-1">Loading DEX prices...</div>
                  )}
                  {/* Show the manual-price input whenever DEX prices are
                      unavailable OR the user is currently using a manual
                      value. Without the manual-source branch the input would
                      vanish the instant typing promotes `marketPrice` to the
                      parsed manual value, blocking further edits. */}
                  {(!dexPrices.some(p => p.loading) && !dexPrices.some(p => p.recommended && p.netPrice !== null)) || marketPriceSource === "manual" ? (
                    <div className="space-y-1 mt-1">
                      <div className="text-xs text-error" id="manual-price-label">DEX price unavailable. Enter price manually:</div>
                      <div className="flex gap-2 items-center">
                        <input
                          type="text" inputMode="decimal" value={manualPrice}
                          onChange={(e) => setManualPrice(e.target.value)}
                          placeholder={`1 ${sellToken?.symbol} = ? ${buyToken?.symbol}`}
                          aria-labelledby="manual-price-label"
                          className="flex-1 bg-white/10 border border-outline-variant/30 rounded-md p-2 text-xs font-mono focus:ring-1 focus:ring-tertiary text-on-surface"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Expiry</label>
                  <select
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="w-full bg-white/10 border border-outline-variant/30 focus:ring-1 focus:ring-primary text-on-surface rounded-lg py-3 px-4 text-base"
                  >
                    <option value="1">1 hour</option>
                    <option value="6">6 hours</option>
                    <option value="24">24 hours</option>
                    <option value="168">7 days</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 4. Recipients */}
            <div className="bg-surface-container/50 rounded-xl p-6 border border-outline-variant/10">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-headline font-bold text-base flex items-center gap-2">
                  <Shield className="w-5 h-5 text-primary" />
                  Recipients (Scatter)
                  {buyToken && (
                    <span className="text-xs font-normal text-on-surface-variant bg-surface-container-low px-1.5 py-0.5 rounded">
                      receives {buyToken.symbol}
                    </span>
                  )}
                </h3>
                <span
                  title={
                    claims.length >= MAX_CLAIMS
                      ? `Up to ${MAX_CLAIMS} recipients per order. The claims Merkle tree has depth 4 (16 leaves); a few slots are reserved for padding + the order-owner change note.`
                      : "Split this order across multiple recipients"
                  }
                >
                  <button
                    onClick={addClaim}
                    disabled={claims.length >= MAX_CLAIMS}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary-container font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add {claims.length >= MAX_CLAIMS ? `(max ${MAX_CLAIMS})` : ""}
                  </button>
                </span>
              </div>

              <div className="space-y-3">
                {claims.map((c, idx) => (
                  <div key={c.id} className="bg-surface-container-low/50 rounded-lg p-3 border border-outline-variant/5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs text-on-surface-variant font-bold">#{idx + 1}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => updateClaim(c.id, "mode", "standard")}
                          title="Send to a regular Ethereum address. Recipient claims directly from their wallet; the address is visible on-chain."
                          className={`px-2 py-0.5 rounded text-xs font-bold ${
                            c.mode === "standard" ? "bg-surface-container-highest text-on-surface" : "text-on-surface-variant"
                          }`}
                        >Standard</button>
                        <button
                          onClick={() => updateClaim(c.id, "mode", "stealth")}
                          title="Send to a meta-address (st:eth:…). A one-time stealth address is derived per claim; the recipient's identity isn't linkable on-chain."
                          className={`px-2 py-0.5 rounded text-xs font-bold ${
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
                      <div className="col-span-5">
                        <div className="flex items-center gap-1">
                          <input
                            type="text" value={c.address}
                            onChange={(e) => updateClaim(c.id, "address", e.target.value)}
                            placeholder={c.mode === "stealth" ? "st:eth:0x..." : "0x... (empty = self)"}
                            className="flex-1 min-w-0 bg-white/10 border border-outline-variant/30 rounded-lg p-2.5 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
                          />
                          {c.mode !== "stealth" && (
                            <AddressPicker onPick={(addr) => updateClaim(c.id, "address", addr)} />
                          )}
                        </div>
                      </div>
                      <div className="col-span-3">
                        <div className="flex gap-1">
                          <input
                            type="text" inputMode="decimal" value={c.amount}
                            onChange={(e) => updateClaim(c.id, "amount", e.target.value)}
                            placeholder="Amount"
                            className="flex-1 min-w-0 bg-white/10 border border-outline-variant/30 rounded-lg p-2.5 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
                          />
                          <button
                            type="button"
                            onClick={() => fillRest(c.id)}
                            className="px-2 py-1 bg-primary/10 text-primary text-xs font-bold rounded-md hover:bg-primary/20 transition-colors flex-shrink-0"
                            title="Fill remaining amount"
                          >
                            Rest
                          </button>
                        </div>
                      </div>
                      <div className="col-span-4">
                        <div className="flex items-center gap-1 bg-white/10 border border-outline-variant/30 rounded-lg p-2.5" title="Release delay">
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
                            className="bg-transparent border-none p-0 text-xs font-mono focus:ring-0 text-on-surface-variant"
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
                  <div className="text-xs text-on-surface-variant flex justify-between">
                    <span>
                      Claims total: {parseFloat(claimTotalDisplay).toFixed(4)} {buyToken.symbol}
                    </span>
                    <span>
                      Recipients receive: {parseFloat(buyAmount || "0").toFixed(4)} {buyToken.symbol}
                    </span>
                  </div>
                  {claimShortfall !== null && claimShortfall > 0n && (
                    <div className="text-xs text-error font-bold">
                      Claims must total at least {parseFloat(buyAmount).toFixed(4)} {buyToken.symbol}. Short by {ethers.formatUnits(claimShortfall, buyToken.decimals)} {buyToken.symbol}.
                    </div>
                  )}
                  {claimShortfall === null && buyAmount !== "" && (
                    <div className="text-xs text-error font-bold">
                      Buy Amount &quot;{buyAmount}&quot; isn&apos;t a valid {buyToken.symbol} value (max {buyToken.decimals} decimals).
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5. Trading Key & Submit */}
            <div className="bg-surface-container/60 rounded-xl p-6 border border-outline-variant/10 space-y-4">
              <div className="bg-tertiary/5 border border-tertiary/15 rounded-lg px-4 py-3 space-y-1">
                <div className="flex items-center gap-2 text-sm font-bold text-tertiary">
                  <Zap className="w-4 h-4" />
                  Direct DEX Settlement
                </div>
                <p className="text-xs text-on-surface-variant/70">
                  Your order will be routed through the best available DEX (1inch aggregator or Uniswap V3) for optimal pricing. No relayer needed — you submit the transaction yourself.
                </p>
              </div>

              <div className="pt-4 border-t border-outline-variant/10 space-y-3">
                <h3 className="font-headline font-bold text-base flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                  Trading Key
                </h3>
                {keyPair ? (
                  <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md">
                    <Check className="w-3.5 h-3.5" />
                    Key active: {keyPair.publicKey[0].toString().slice(0, 10)}...
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[11px] text-on-surface-variant/60">
                      {hasStoredKey
                        ? "Trading key found for this account. Sign with wallet to unlock."
                        : "No trading key for this account. Sign with wallet to generate."}
                    </p>
                    <button
                      type="button"
                      onClick={handleDeriveKey}
                      disabled={keyLoading || !account || !hasFolderSelected()}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-bold bg-primary text-on-primary hover:bg-primary/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {keyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                      {hasStoredKey ? "Unlock with Wallet" : "Generate with Wallet"}
                    </button>
                  </div>
                )}
              </div>

              {error && (
                <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
              )}

              <button
                onClick={!keyPair ? handleDeriveKey : handleMarketSubmit}
                disabled={!sellAmount || !buyAmount || !selectedNote || !marketPrice || keyLoading || claimShortfall === null || claimShortfall > 0n || (changeAmount > 0n && !changeSalt)}
                className="w-full bg-tertiary text-on-tertiary py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50 hover:bg-tertiary/90 transition-colors"
              >
                {keyLoading ? (
                  <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Unlocking Key...</span>
                ) : !selectedNote ? "Select a Commitment Note" : !keyPair ? "Unlock Trading Key" : !marketPrice ? "Waiting for DEX Price..." : "Execute DEX Trade"}
              </button>

              <div className="text-xs text-on-surface-variant/40 text-center">
                Market order executed directly via DEX. ZK proof hides your identity on-chain.
              </div>
            </div>
          </div>
        )}

        {step === "signing" && (
          <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center">
            <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
            <p className="text-on-surface font-medium">
              {signingProgress || "Generating ZK proof..."}
            </p>
            <p className="text-xs text-on-surface-variant/60 mt-2">
              The ZK proof step takes ~10–30s — claim hashing + EdDSA + Groth16 witness + proof. Window stays responsive.
            </p>
          </div>
        )}

        {step === "submitted" && (
          <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
            <Check className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-on-surface font-bold text-lg">DEX Trade Executed</p>
            <p className="text-sm text-on-surface-variant/70">
              Your market order has been settled via DEX on-chain. Claim your tokens on the Private Claim page.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              <Link
                href="/trade/private-claim"
                className="px-5 py-2.5 rounded-md bg-primary text-on-primary text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                Go to Claim
              </Link>
              <Link
                href="/trade/private-history"
                className="px-5 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
              >
                View My Orders
              </Link>
              <button
                onClick={() => { setStep("create_order"); refreshNotes(); }}
                className="px-5 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
              >
                Create Another Order
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right: Aggregator Quote */}
      <div className="w-full xl:w-[340px] xl:pt-32">
        <div className="sticky top-20">
          <AggregatorQuotePanel
            sellSymbol={sellToken?.symbol}
            buySymbol={buyToken?.symbol}
            sellTokenAddress={sellToken?.address}
            buyTokenAddress={buyToken?.address}
            sellDecimals={sellToken?.decimals}
            buyDecimals={buyToken?.decimals}
            sellAmount={sellAmount}
            slippageBps={parseInt(slippageBps) || 50}
            account={account ?? undefined}
            onQuote={handleAggregatorQuote}
          />
        </div>
      </div>
    </div>
  );
}
