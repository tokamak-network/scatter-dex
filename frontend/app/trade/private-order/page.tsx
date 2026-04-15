"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { ethers } from "ethers";
import { Shield, Key, Loader2, Check, Plus, Trash2, Clock, FolderOpen, Wallet, ArrowLeftRight } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers } from "../../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { applyFeeBig } from "../../lib/fee";
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
import { useTokenEthPrice } from "../../lib/useTokenEthPrice";
import { estimateMinFeeBps, type GasEstimate } from "../../lib/gasEstimate";
import FeeBreakdown from "../../components/FeeBreakdown";
import PricePanel from "../../components/PricePanel";
import { friendlyError } from "../../lib/error-messages";
import { buildOrderProof, type ClaimRow } from "../_shared/buildOrderProof";

// EdDSA key is AES-GCM encrypted and stored in the notes folder (File System API).
// This protects against extension/physical access. Does NOT protect against XSS.
const MAX_CLAIMS = 10;

type Step = "setup_key" | "create_order" | "signing" | "submitted" | "error";

// Truncate a decimal string to `maxDecimals` digits after the dot without
// round-tripping through `Number`, so large wei-scale values (e.g. a 1e30
// cap) display accurately instead of as `1e30.0000`. Caller is expected
// to pass the canonical string from `ethers.formatUnits`.
function truncateDecimals(s: string, maxDecimals: number): string {
  const dot = s.indexOf(".");
  if (dot < 0) return maxDecimals > 0 ? `${s}.${"0".repeat(maxDecimals)}` : s;
  const currentDecimals = s.length - dot - 1;
  if (currentDecimals <= maxDecimals) return s + "0".repeat(maxDecimals - currentDecimals);
  return s.slice(0, dot + 1 + maxDecimals);
}

// Next 16 requires useSearchParams callers to sit inside a Suspense
// boundary. Wrap the whole page; the inner component depends on `?type=`
// at render time. Fallback shows a placeholder so the route doesn't
// flash empty during the suspend window on initial entry.
export default function PrivateOrderPage() {
  return (
    <Suspense fallback={<PrivateOrderLoading />}>
      <PrivateOrderPageInner />
    </Suspense>
  );
}

function PrivateOrderLoading() {
  return (
    <div className="flex items-center justify-center min-h-[400px] text-on-surface-variant/60">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  );
}

function PrivateOrderPageInner() {
  const { account, signer, readProvider, chainId, connect } = useWallet();
  const { relayers } = useRelayers();
  const tokens = getTokenList().filter((t) => !t.isNative);

  // ZK relayers (filter by name containing "ZK")
  const zkRelayers = useMemo(() =>
    relayers.filter((r) => r.online && r.api?.name?.includes("ZK")),
    [relayers]
  );
  const [selectedRelayerIdx, setSelectedRelayerIdx] = useState(0);
  // Preselect a relayer if the URL carries ?relayer=<address> (deep-link
  // from the Shared Orderbook "Take" flow).
  const didPrefillRelayerRef = useRef(false);

  const [step, setStep] = useState<Step>("setup_key");
  // Stepped status shown next to the spinner during proof generation —
  // populated by buildOrderProof's onProgress callback so the user sees
  // which sub-step they're waiting on (~30s wait is otherwise opaque).
  const [signingProgress, setSigningProgress] = useState<string>("");
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notes (commitment deposits)
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [spentNotes, setSpentNotes] = useState<Set<string>>(new Set());
  const [selectedCommitment, setSelectedCommitment] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  // Order form
  const [sellTokenIdx, setSellTokenIdx] = useState(0);
  const [buyTokenIdx, setBuyTokenIdx] = useState(1);
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [expiry, setExpiry] = useState("24");
  const [price, setPrice] = useState("");
  const [changeSalt, setChangeSalt] = useState<bigint | null>(null);
  const [maxFeeBps, setMaxFeeBps] = useState("30"); // basis points
  const searchParams = useSearchParams();
  const router = useRouter();
  // Backwards-compat: old sidebar/bookmarks used ?type=market to pick the
  // DEX tab on this page. That mode now lives at /trade/dex-trade.
  useEffect(() => {
    if (searchParams.get("type") === "market") {
      router.replace("/trade/dex-trade");
    }
  }, [searchParams, router]);

  // Claims
  const nextClaimId = useRef(1);
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" },
  ]);

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

  // Same-token orders are direct distributions, not trades — the contract
  // enforces `totalLocked + fee <= sellAmount` (SettleVerifyLib.
  // validateScatterAuth), so the signed `buyAmount` (= distributed total)
  // is capped at `sellAmount − fee`. `buyAmount` is reinterpreted as
  // "amount distributed to recipients" in this mode.
  const isScatterMode = !!sellToken && !!buyToken && sellToken.address.toLowerCase() === buyToken.address.toLowerCase();

  // Scatter mode has no price ratio — sell and buy are the same token.
  // Pin `price` to "1" while scatter is active so the gas-estimate
  // useEffect (which multiplies sell × price to size the tx) doesn't
  // reuse a stale cross-token quote.
  useEffect(() => {
    if (isScatterMode && price !== "1") setPrice("1");
  }, [isScatterMode, price]);

  // Relayer preselect from ?relayer=<address>
  useEffect(() => {
    if (didPrefillRelayerRef.current) return;
    if (zkRelayers.length === 0) return;
    const want = searchParams.get("relayer");
    if (!want) return;
    const idx = zkRelayers.findIndex((r) => r.address.toLowerCase() === want.toLowerCase());
    if (idx >= 0) setSelectedRelayerIdx(idx);
    didPrefillRelayerRef.current = true;
  }, [zkRelayers, searchParams]);

  // ── Prefill form from URL params (for "Take order" deep-links from the
  // Shared Orderbook page). Runs once after the token list loads.
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
    const ba = searchParams.get("buyAmount");
    if (sa) setSellAmount(sa);
    if (ba) setBuyAmount(ba);
    const mf = searchParams.get("maxFee");
    if (mf) setMaxFeeBps(mf);
    const eh = searchParams.get("expiryHours");
    if (eh) setExpiry(eh);
    didPrefillRef.current = true;
  }, [tokens, searchParams]);

  // Check which notes are spent on-chain (parallel)
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

  // Filter notes by sell token, exclude spent
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

  // Reset note selection only when SELL token changes — commitments
  // are scoped to their sell-side token, so swapping the buy token has
  // no bearing on which note is valid. Bundling buyTokenIdx into the
  // deps used to clear the user's selection every time they tweaked
  // the buy dropdown.
  useEffect(() => {
    setSelectedCommitment(null);
  }, [sellTokenIdx]);
  // Clear selection if selected note no longer exists in available list
  useEffect(() => {
    if (selectedCommitment && !availableNotes.some((n) => n.commitment === selectedCommitment)) {
      setSelectedCommitment(null);
    }
  }, [availableNotes, selectedCommitment]);

  // When a note is picked and the user has *not* yet entered a sellAmount,
  // default it to the full note balance. Do not overwrite an existing
  // sellAmount — the change (remainder) commitment is derived from the
  // current sellAmount, so clicking a note shouldn't stomp the user's
  // intent.
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
  const buyTokenSymbol = buyToken?.symbol;

  // Sum claim amounts as BigInt wei, tolerating rows the user is still
  // typing into. Shared between the shortfall check (gates submit), the
  // display total (was a parseFloat sum before), and fillRest (auto-fills
  // one row). Keeping all three in BigInt land is what lets the UI match
  // the circuit's integer equality — floats silently drop the fee-sized
  // tail.
  const sumClaimWei = useCallback((excludeId?: number): bigint => {
    if (buyTokenDecimals == null) return 0n;
    return claims.reduce((acc, c) => {
      if (c.id === excludeId || !c.amount) return acc;
      try { return acc + ethers.parseUnits(c.amount, buyTokenDecimals); }
      catch { return acc; }
    }, 0n);
  }, [claims, buyTokenDecimals]);

  // Display-only aggregate derived from the same BigInt sum so the
  // summary line cannot disagree with the shortfall gate (e.g. showing
  // "1.0000" while validation sees 0.9996 wei).
  const claimTotalWei = useMemo(() => sumClaimWei(), [sumClaimWei]);
  const claimTotalDisplay = useMemo(() => {
    if (buyTokenDecimals == null) return "0";
    return ethers.formatUnits(claimTotalWei, buyTokenDecimals);
  }, [claimTotalWei, buyTokenDecimals]);

  const feeBps = parseInt(maxFeeBps) || 0;
  const feePercent = feeBps / 100;

  // Gas-inclusive minimum fee
  const { ethPerToken } = useTokenEthPrice(buyToken?.address, buyToken?.decimals, chainId ?? undefined, readProvider);
  const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
  const [feeBreakdownOpen, setFeeBreakdownOpen] = useState(false);

  useEffect(() => {
    if (!readProvider || !sellAmount || !buyToken || !ethPerToken) {
      setGasEstimate(null);
      return;
    }
    let cancelled = false;
    const sell = parseFloat(sellAmount);
    const p = parseFloat(price);
    if (!sell || !p) { setGasEstimate(null); return; }
    const grossBuy = sell * p;
    const sellBig = ethers.parseUnits(grossBuy.toFixed(Math.min(buyToken.decimals, 18)), buyToken.decimals);
    if (sellBig <= 0n) { setGasEstimate(null); return; }

    estimateMinFeeBps(readProvider, claims.length, sellBig, ethPerToken, buyToken.decimals)
      .then((r) => { if (!cancelled) setGasEstimate(r); })
      .catch((e) => { if (!cancelled) { console.warn("Gas estimation failed:", e); setGasEstimate(null); } });
    return () => { cancelled = true; };
  }, [readProvider, sellAmount, price, claims.length, buyToken?.address, buyToken?.decimals, ethPerToken]);

  const minFeeBps = gasEstimate?.minFeeBps ?? 0;
  const effectiveFeeBps = Math.max(feeBps, minFeeBps);

  // BigInt check — recipients must together cover the *post-fee* receive
  // (maker pays the relayer fee out of buyAmount, then distributes the
  // remainder to claim recipients).
  const claimShortfall = useMemo((): bigint | null => {
    if (buyTokenDecimals == null || !buyAmount) return null;
    try {
      const gross = ethers.parseUnits(buyAmount, buyTokenDecimals);
      if (gross === 0n) return null;
      const { net: need } = applyFeeBig(gross, effectiveFeeBps);
      return claimTotalWei >= need ? 0n : need - claimTotalWei;
    } catch {
      return null;
    }
  }, [claimTotalWei, buyAmount, buyTokenDecimals, effectiveFeeBps]);

  // Scatter-mode cap: the contract's `validateScatterAuth` enforces
  // `totalLocked + fee <= sellAmount`, so the distributed amount (which
  // equals the signed `buyAmount` in scatter semantics) cannot exceed
  // `sellAmount × (10000 − maxFee) / 10000`. Returned in wei; null when
  // not in scatter mode or when sellAmount isn't yet parseable.
  const sellTokenDecimals = sellToken?.decimals;
  const scatterMaxDistributeWei = useMemo((): bigint | null => {
    if (!isScatterMode || sellTokenDecimals == null || !sellAmount) return null;
    try {
      const sell = ethers.parseUnits(sellAmount, sellTokenDecimals);
      // Match the contract's integer math:
      //   validateScatterAuth checks `totalLocked + fee <= sellAmount`
      //   where fee = floor(sell * feeBps / 10000).
      // Compute the cap as `sell - fee` rather than
      // `sell * (10000 - fee) / 10000`; the two differ by a 1-wei
      // rounding that otherwise false-blocks distribute=sell at
      // sub-10000-wei amounts.
      return applyFeeBig(sell, effectiveFeeBps).net;
    } catch { return null; }
  }, [isScatterMode, sellAmount, sellTokenDecimals, effectiveFeeBps]);

  // How much the user's typed distribute amount (buyAmount) exceeds the
  // scatter cap. 0n when within the cap, positive wei when over, null
  // when the inputs aren't parseable yet.
  const scatterExcessWei = useMemo((): bigint | null => {
    if (!isScatterMode || scatterMaxDistributeWei === null || buyTokenDecimals == null || !buyAmount) return null;
    try {
      const buy = ethers.parseUnits(buyAmount, buyTokenDecimals);
      return buy > scatterMaxDistributeWei ? buy - scatterMaxDistributeWei : 0n;
    } catch { return null; }
  }, [isScatterMode, scatterMaxDistributeWei, buyAmount, buyTokenDecimals]);

  // Recompute buyAmount.
  //   - Cross-token: sell * price.
  //   - Scatter mode: clamp to `sellAmount - fee` so the scatter-excess
  //     gate (which compares the buyAmount field against the cap) doesn't
  //     fire just because the price=1 path produced sellAmount × 1 wei.
  const recomputeBuyAmount = useCallback((sell: string, p: string, _bps: number) => {
    if (isScatterMode && sellTokenDecimals != null) {
      try {
        const sellWei = ethers.parseUnits(sell, sellTokenDecimals);
        const capWei = applyFeeBig(sellWei, effectiveFeeBps).net;
        setBuyAmount(ethers.formatUnits(capWei, sellTokenDecimals));
      } catch {
        /* sellAmount mid-typing — leave buyAmount alone */
      }
      return;
    }
    const grossBuy = parseFloat(sell) * parseFloat(p);
    if (isNaN(grossBuy)) return;
    const dec = Math.min(buyToken?.decimals ?? 18, 18);
    setBuyAmount(grossBuy.toFixed(dec));
  }, [buyToken, isScatterMode, sellTokenDecimals, effectiveFeeBps]);

  // User-edited-buyAmount guard: once the user types into the Buy field
  // directly, stop auto-rewriting it from sell × price × fee changes.
  // A fresh price selection (handlePriceSelect) or sell edit via onChange
  // explicitly overrides and resets this flag.
  const userEditedBuyRef = useRef(false);

  const handlePriceSelect = useCallback((p: string) => {
    setPrice(p);
    userEditedBuyRef.current = false;
    if (sellAmount) recomputeBuyAmount(sellAmount, p, effectiveFeeBps);
  }, [sellAmount, effectiveFeeBps, recomputeBuyAmount]);

  useEffect(() => {
    if (userEditedBuyRef.current) return;
    if (sellAmount && price) recomputeBuyAmount(sellAmount, price, effectiveFeeBps);
  }, [effectiveFeeBps, sellAmount, price, recomputeBuyAmount]);

  // Net amount after relay fee — this is the distributable pot for claims.
  //   maker receives buyAmount gross; fee deducted for the relayer;
  //   recipients share (buyAmount × (1 − fee)).
  const netBuyAmount = (parseFloat(buyAmount) || 0) * (1 - effectiveFeeBps / 10000);

  // Change (remainder) calculation
  const changeAmount = useMemo(() => {
    if (!selectedNote || !sellAmount || !sellToken) return 0n;
    try {
      const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
      const rem = selectedNote.note.amount - parsedSell;
      return rem > 0n ? rem : 0n;
    } catch { return 0n; }
  }, [selectedNote, sellAmount, sellToken]);

  // Generate changeSalt when change exists
  useEffect(() => {
    if (changeAmount > 0n) {
      setChangeSalt(randomFieldElement());
    } else {
      setChangeSalt(null);
    }
  }, [changeAmount]);

  // Target in BigInt wei: gross `buyAmount` for cross-token trades
  // (authorize 8b requires `sum(claims) >= buyAmount`), but the scatter
  // cap `sellAmount - fee` in same-token mode — pressing Rest there
  // must not push the distribute total past what `validateScatterAuth`
  // will accept. Capped at parsedBuy so a user who typed a smaller
  // buyAmount than the scatter max still gets their exact target.
  const fillRest = (id: number) => {
    if (buyTokenDecimals == null || !buyAmount) return;
    try {
      const parsedBuy = ethers.parseUnits(buyAmount, buyTokenDecimals);
      // Recipients share the amount *after* the relay fee — maker keeps
      // buyAmount × (1 − fee).
      const netBuyWei = applyFeeBig(parsedBuy, effectiveFeeBps).net;
      const target =
        isScatterMode && scatterMaxDistributeWei !== null && scatterMaxDistributeWei < netBuyWei
          ? scatterMaxDistributeWei
          : netBuyWei;
      const othersBig = sumClaimWei(id);
      const restBig = target > othersBig ? target - othersBig : 0n;
      updateClaim(id, "amount", ethers.formatUnits(restBig, buyTokenDecimals));
    } catch {
      /* buyAmount still being typed; no-op */
    }
  };

  const [hasStoredKey, setHasStoredKey] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !hasFolderSelected()) return;
    if (!account) return;
    loadEdDSAKeyFromFolder(account).then((saved) => setHasStoredKey(!!saved));
  }, [folderName, account]);

  // Derive or unlock EdDSA key — only triggered by button click (no auto-popup)
  const handleDeriveKey = useCallback(async () => {
    if (!signer || !account) return;
    if (!hasFolderSelected()) {
      setError("Select a notes folder first");
      return;
    }
    setKeyLoading(true);
    setError(null);
    try {
      // Check if key file exists in folder
      const saved = await loadEdDSAKeyFromFolder(account);
      if (saved && isEncryptedKeyPair(saved)) {
        // Unlock existing key
        const signature = await signer.signMessage(DERIVE_MESSAGE);
        const kp = await deserializeKeyPairEncrypted(saved, signature, account);
        setKeyPair(kp);
        setStep("create_order");
      } else {
        // Generate new key and save encrypted
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

  // Submit limit order — generate proof + send to relayer
  const handleSubmit = useCallback(async () => {
    if (!sellToken || !buyToken || !sellAmount || !buyAmount || !selectedNote || !signer || !account) return;

    const kp = keyPair;
    if (!kp) { setError("Unlock or generate a trading key first"); return; }

    setStep("signing");
    setSigningProgress("Preparing order data...");
    setError(null);

    try {
      const selectedZkRelayer = zkRelayers[selectedRelayerIdx];
      if (!selectedZkRelayer) throw new Error("No ZK relayer selected");

      const { proofResult, claimData, claimDataWithEpk, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment } = await buildOrderProof({
        sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account,
        selectedNote, changeSalt, maxFee: BigInt(effectiveFeeBps || 30),
        onProgress: setSigningProgress,
        relayerAddress: selectedZkRelayer.address, eddsaPrivateKey: kp.privateKey,
        zkRelayerUrl: selectedZkRelayer.url,
      });

      const relayerUrl = selectedZkRelayer.url;

      // Submit proof to relayer (no secrets transmitted)
      // Map snarkjs string[] to named public signals (circom 2: output first)
      const ps = proofResult.publicSignals;
      const namedSignals = {
        pubKeyBind: ps[0],      // [0] circuit output
        commitmentRoot: ps[1],  // [1..14] public inputs
        nullifier: ps[2],
        nonceNullifier: ps[3],
        newCommitment: ps[4],
        sellToken: ps[5],
        buyToken: ps[6],
        sellAmount: ps[7],
        buyAmount: ps[8],
        maxFee: ps[9],
        expiry: ps[10],
        claimsRoot: ps[11],
        totalLocked: ps[12],
        relayer: ps[13],
        orderHash: ps[14],
      };
      setSigningProgress("Submitting to ZK relayer...");
      const res = await fetch(`${relayerUrl}/api/authorize-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: proofResult.proof,
          publicSignals: namedSignals,
          publicSignalsArray: proofResult.publicSignals,
          // pubKey for compliance logging (relayer verifies via pubKeyBind)
          pubKeyAx: kp.publicKey[0].toString(),
          pubKeyAy: kp.publicKey[1].toString(),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit order");
      }

      // Save all claim files as a single bundled JSON download
      // Each entry contains the data needed for claimWithProof on the Private Claim page
      const claimFiles = claimDataWithEpk.map((c, idx) => ({
        secret: c.secret,
        recipient: c.recipient,
        token: c.token,
        amount: c.amount,
        releaseTime: c.releaseTime,
        leafIndex: idx,
        allLeaves: padded.map((l) => l.toString()),
        relayerUrl,
        ...(c.ephemeralPubKey ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
      }));
      const bundle = {
        order: {
          sellToken: sellToken.address,
          buyToken: buyToken.address,
          sellAmount: parsedSell.toString(),
          buyAmount: parsedBuy.toString(),
          maxFee: effectiveFeeBps,
          expiry: expiryTimestamp.toString(),
          nonce: nonce.toString(),
          leafIndex: selectedNote.leafIndex,
        },
        change: change > 0n ? {
          amount: change.toString(),
          salt: newSalt.toString(),
          expectedCommitment: expectedChangeCommitment.toString(),
        } : null,
        claims: claimFiles,
        relayerUrl,
        relayerAddress: selectedZkRelayer.address,
        note: "Each entry can be loaded individually in Private Claim. Keep this file secret.",
        createdAt: new Date().toISOString(),
      };
      const bundleJson = JSON.stringify(bundle, null, 2);
      const claimsFilename = `zkscatter-claims-${Date.now()}.json`;

      // Save to notes folder
      try {
        await saveFileToFolder(claimsFilename, bundleJson);
      } catch (e) {
        console.warn("Failed to save claims to folder:", e);
      }

      // Also trigger browser download
      const blob = new Blob([bundleJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = claimsFilename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      // Pre-save change note to folder (leafIndex TBD — will be verified after settlement)
      if (change > 0n && changeSalt) {
        const changeStoredNote: StoredNote = {
          note: {
            ownerSecret: selectedNote.note.ownerSecret,
            token: selectedNote.note.token,
            amount: change,
            salt: changeSalt,
            pubKeyAx: selectedNote.note.pubKeyAx,
            pubKeyAy: selectedNote.note.pubKeyAy,
          },
          commitment: "0x" + expectedChangeCommitment.toString(16),
          tokenSymbol: sellToken.symbol,
          tokenAddress: sellToken.address,
          amount: ethers.formatUnits(changeAmount, sellToken.decimals),
          leafIndex: -1, // placeholder — updated after on-chain settlement
          txHash: "", // pending settlement
          createdAt: Date.now(),
        };
        try {
          await saveNote(changeStoredNote);
        } catch (e) {
          console.warn("Failed to save change note:", e);
        }
      }

      setSigningProgress("");
      setStep("submitted");
      setSellAmount("");
      setBuyAmount("");
      setPrice("");
      setSelectedCommitment(null);
      setClaims([{ id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" }]);
    } catch (e: unknown) {
      setError(friendlyError(e));
      setSigningProgress("");
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, maxFeeBps]);

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <Shield className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to create private orders</p>
        <button onClick={() => connect()} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
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
            Privacy-preserving Trade (Limit Order)
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            ZK-private limit order. Your identity and trade details are hidden on-chain.
          </p>
        </div>

        {/* Order Form — always visible */}
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
                  onChange={(e) => setSellTokenIdx(Number(e.target.value))}
                  className="w-full bg-white/10 border border-outline-variant/30 focus:ring-1 focus:ring-primary text-on-surface rounded-lg py-3 px-4 text-base"
                >
                  {tokens.map((t, i) => (
                    <option key={i} value={i}>{t.symbol}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => {
                  const s = sellTokenIdx, b = buyTokenIdx;
                  setSellTokenIdx(b);
                  setBuyTokenIdx(s);
                }}
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
                  onChange={(e) => setBuyTokenIdx(Number(e.target.value))}
                  className="w-full bg-white/10 border border-outline-variant/30 focus:ring-1 focus:ring-primary text-on-surface rounded-lg py-3 px-4 text-base"
                >
                  {tokens.map((t, i) => (
                    <option key={i} value={i}>{t.symbol}</option>
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
                  onChange={(e) => {
                    setSellAmount(e.target.value);
                    if (price && e.target.value) {
                      userEditedBuyRef.current = false;
                      recomputeBuyAmount(e.target.value, price, effectiveFeeBps);
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
                  <div className="text-xs text-error mt-1">
                    Exceeds note balance ({selectedNote.amount} {sellToken?.symbol})
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2 text-right">
                  Buy Amount
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  // Scatter: display the gross transaction total (`sellAmount`) in this
                  // read-only input to show the 1:1 amount before fees. The state var
                  // `buyAmount` is already the post-fee distributable that recipients
                  // split (i.e. `buyAmount = sellAmount − fee`), and that is what the
                  // circuit signs.
                  value={isScatterMode ? sellAmount : buyAmount}
                  // Guard the setter with the readOnly condition so a stray programmatic
                  // change event (autofill, form reset) can't desync `buyAmount` from
                  // the `sellAmount` it's mirroring while the field is read-only.
                  onChange={isScatterMode ? undefined : (e) => { userEditedBuyRef.current = true; setBuyAmount(e.target.value); }}
                  readOnly={isScatterMode}
                  className={`w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3 text-right ${
                    isScatterMode ? "opacity-70" : ""
                  }`}
                  placeholder="0.00"
                />
                {sellAmount && buyAmount && parseFloat(sellAmount) > 0 && (
                  <div className="text-xs text-on-surface-variant mt-1 text-right">
                    Price: {isScatterMode ? "1.000000" : (parseFloat(buyAmount) / parseFloat(sellAmount)).toFixed(6)} {buyToken?.symbol}/{sellToken?.symbol}
                  </div>
                )}
              </div>
            </div>

            </div>

            {/* 3. Fee & Expiry */}
            <div className="bg-surface-container/30 rounded-xl p-6 border border-outline-variant/10 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Max Relay Fee</label>
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
                      onClick={() => setMaxFeeBps(opt.bps)}
                      className={`flex-1 py-2 rounded-md text-xs font-bold transition-all ${
                        maxFeeBps === opt.bps
                          ? "bg-primary text-on-primary"
                          : "bg-surface-container-low text-on-surface-variant hover:bg-surface-bright"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {minFeeBps > feeBps && (
                  <div className="text-xs text-warning mt-1">
                    Min fee {(minFeeBps / 100).toFixed(2)}% required (gas coverage for {claims.length} claim{claims.length > 1 ? "s" : ""})
                  </div>
                )}
                {sellAmount && price && (
                  <div className="text-xs text-on-surface-variant mt-1">
                    Fee ≈ {(parseFloat(sellAmount) * parseFloat(price) * effectiveFeeBps / 10000).toFixed(4)} {buyToken?.symbol}
                    {effectiveFeeBps > feeBps && <span className="text-warning ml-1">(adjusted)</span>}
                  </div>
                )}
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

            {sellAmount && buyAmount && (
              <div className="bg-surface-container-low/30 rounded-lg px-4 py-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Buy amount</span>
                  <span className="font-mono text-on-surface">
                    {isScatterMode
                      ? parseFloat(sellAmount).toFixed(4)
                      : parseFloat(buyAmount).toFixed(4)} {buyToken?.symbol}
                  </span>
                </div>
                <button
                  type="button"
                  aria-expanded={feeBreakdownOpen}
                  className="flex w-full justify-between text-error/80 cursor-pointer hover:text-error transition-colors"
                  onClick={() => setFeeBreakdownOpen(!feeBreakdownOpen)}
                >
                  <span>Relay fee ({(effectiveFeeBps / 100).toFixed(2)}%) ▾</span>
                  <span className="font-mono">
                    −{(parseFloat(buyAmount) * effectiveFeeBps / 10000).toFixed(4)} {buyToken?.symbol}
                  </span>
                </button>
                {feeBreakdownOpen && gasEstimate && (
                  <FeeBreakdown gasEstimate={gasEstimate} baseFeeBps={feeBps} minFeeBps={minFeeBps} effectiveFeeBps={effectiveFeeBps} claimCount={claims.length} />
                )}
                <div className="flex justify-between font-bold text-tertiary pt-1 border-t border-outline-variant/10">
                  <span>{isScatterMode ? "Recipients receive" : "You receive"}</span>
                  <span className="font-mono">
                    {(parseFloat(buyAmount) * (1 - effectiveFeeBps / 10000)).toFixed(4)} {buyToken?.symbol}
                  </span>
                </div>
              </div>
            )}

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
                          title="Send to a meta-address (st:eth:…). A one-time stealth address is derived per claim; the recipient's identity isn't linkable on-chain. Claiming can be completed either gaslessly via relayer or from the claimant's own wallet, depending on the claim mode they pick."
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
                  {isScatterMode && (
                    <div className="text-[11px] text-primary/80 bg-primary/5 border border-primary/20 rounded-md px-2 py-1">
                      Scatter mode — {sellToken?.symbol} → {sellToken?.symbol} is a direct distribution (no counterparty, no matching). The relayer settles via <code>scatterDirectAuth</code>; your {sellToken?.symbol} commitment pays the fee.
                    </div>
                  )}
                  <div className="text-xs text-on-surface-variant flex justify-between">
                    <span>
                      Claims total: {parseFloat(claimTotalDisplay).toFixed(4)} {buyToken.symbol}
                    </span>
                    <span>
                      Recipients receive (after fee): {isScatterMode
                        ? (scatterMaxDistributeWei !== null ? truncateDecimals(ethers.formatUnits(scatterMaxDistributeWei, buyToken.decimals), 4) : "—")
                        : netBuyAmount.toFixed(4)} {buyToken.symbol}
                    </span>
                  </div>
                  {claimShortfall !== null && claimShortfall > 0n && (!isScatterMode || scatterExcessWei === 0n) && (
                    <div className="text-xs text-error font-bold">
                      Claims must total at least {netBuyAmount.toFixed(4)} {buyToken.symbol} (buyAmount − fee). Short by {ethers.formatUnits(claimShortfall, buyToken.decimals)} {buyToken.symbol}.
                    </div>
                  )}
                  {claimShortfall === null && buyAmount !== "" && (
                    <div className="text-xs text-error font-bold">
                      Buy Amount &quot;{isScatterMode ? sellAmount : buyAmount}&quot; isn&apos;t a valid {buyToken.symbol} value (max {buyToken.decimals} decimals).
                    </div>
                  )}
                  {isScatterMode && scatterExcessWei !== null && scatterExcessWei > 0n && scatterMaxDistributeWei !== null && (
                    <div className="text-xs text-error font-bold">
                      Recipients total exceeds Sell − fee. Max: {truncateDecimals(ethers.formatUnits(scatterMaxDistributeWei, buyToken.decimals), 4)} {buyToken.symbol}. Over by {ethers.formatUnits(scatterExcessWei, buyToken.decimals)} {buyToken.symbol}.
                    </div>
                  )}
                  {!isScatterMode && parseFloat(buyAmount) > 0 && effectiveFeeBps > 0 && (
                    <div className="text-[11px] text-on-surface-variant/60">
                      For a match, the counterparty must sell ≥ {buyAmount} + fee ≈ {(parseFloat(buyAmount) * (1 + effectiveFeeBps / 10000)).toFixed(4)} {buyToken.symbol}.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5. ZK Relayer & Trading Key & Submit */}
            <div className="bg-surface-container/60 rounded-xl p-6 border border-outline-variant/10 space-y-4">

            {/* ZK Relayer selection */}
            <div className="space-y-3">
              <h3 className="font-headline font-bold text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                ZK Relayer
              </h3>
              {zkRelayers.length === 0 ? (
                <p className="text-sm text-error/70">No ZK relayers online. Check the Relayers page.</p>
              ) : (
                <select
                  value={selectedRelayerIdx}
                  onChange={(e) => setSelectedRelayerIdx(Number(e.target.value))}
                  className="w-full bg-white/10 border border-outline-variant/30 rounded-lg px-4 py-3 text-base font-mono text-on-surface"
                >
                  {zkRelayers.map((r, i) => (
                    <option key={r.address} value={i}>
                      {r.api?.name} — {r.url}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Trading Key */}
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
              onClick={!keyPair ? handleDeriveKey : handleSubmit}
              disabled={!sellAmount || !buyAmount || !selectedNote || zkRelayers.length === 0 || claimShortfall === null || claimShortfall > 0n || (isScatterMode && (scatterExcessWei === null || scatterExcessWei > 0n)) || keyLoading || (changeAmount > 0n && !changeSalt)}
              className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50"
            >
              {keyLoading ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Unlocking Key...</span>
              ) : !selectedNote ? "Select a Commitment Note" : !keyPair ? "Unlock Trading Key" : "Submit Limit Order"}
            </button>

            <div className="text-xs text-on-surface-variant/40 text-center">
              Order signed with EdDSA (Baby Jubjub). Hidden on-chain via ZK proof.
            </div>
          </div>
          </div>
        )}

        {/* Signing */}
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

        {/* Submitted */}
        {step === "submitted" && (
          <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
            <Check className="w-12 h-12 text-emerald-400 mx-auto" />
            <p className="text-on-surface font-bold text-lg">
              Privacy-preserving Trade (Limit Order) Submitted
            </p>
            <p className="text-sm text-on-surface-variant/70">
              Your order is in the private order book. When matched, a ZK proof will be generated and settled on-chain without revealing your identity.
            </p>
            <div className="bg-surface-container-low/60 border border-outline-variant/10 rounded-lg px-4 py-3 text-xs text-on-surface-variant/75 text-left space-y-1.5">
              <p className="font-semibold text-on-surface">What happens next</p>
              <ol className="list-decimal list-outside ml-4 space-y-1">
                <li>Relayer holds your order and watches for a matching counterparty.</li>
                <li>When matched, settlement runs on-chain (no extra action from you).</li>
                <li>Recipients claim their tokens on the <Link href="/trade/private-claim" className="text-primary hover:underline">Private Claim</Link> page. You can track status under <Link href="/trade/private-history" className="text-primary hover:underline">My Orders</Link>.</li>
                <li>Want to cancel before it matches? Open it under <Link href="/trade/private-history" className="text-primary hover:underline">My Orders</Link> — cancel rotates your escrow to a fresh commitment.</li>
              </ol>
            </div>
            {process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL && (
              <div
                className="bg-primary/5 border border-primary/15 rounded-lg px-4 py-3 text-xs text-on-surface-variant/60 text-left"
                title="Cross-relayer matching lets a relayer you didn't submit to match your order against a counterparty on their book. The shared summary includes sell/buy token addresses, amounts, maxFee, expiry, nonce, and your EdDSA pubkey (needed for match verification). Your escrow preimage, claim secrets, recipient list, and wallet address are NOT published."
              >
                <span className="text-primary font-semibold">Shared Orderbook:</span> Your order summary is also published to the shared orderbook, enabling cross-relayer matching with other relayers for better liquidity.
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              <Link
                href="/trade/private-history"
                className="px-5 py-2.5 rounded-md bg-primary text-on-primary text-sm font-semibold hover:bg-primary/90 transition-colors"
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

      {/* Right: Price Reference panel. */}
      <div className="w-full xl:w-[340px] xl:pt-32">
        <div className="sticky top-20">
          <PricePanel
            sellSymbol={sellToken?.symbol}
            buySymbol={buyToken?.symbol}
            sellTokenAddress={sellToken?.address}
            buyTokenAddress={buyToken?.address}
            sellDecimals={sellToken?.decimals}
            buyDecimals={buyToken?.decimals}
            relayerUrl={process.env.NEXT_PUBLIC_ZK_RELAYER_URL || process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3002"}
            side="sell"
            onSelectPrice={handlePriceSelect}
            disableAutoApply={searchParams.has("sell") || searchParams.has("buy") || searchParams.has("sellAmount") || searchParams.has("buyAmount")}
          />
        </div>
      </div>
    </div>
  );
}
