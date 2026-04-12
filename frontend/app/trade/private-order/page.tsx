"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { Shield, Key, Loader2, AlertCircle, Check, Plus, Trash2, Clock, FolderOpen, Wallet, Zap, BookOpen } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers } from "../../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { isMetaAddress, generateStealthAddress } from "../../lib/stealth";
import {
  deriveEdDSAKey,
  signEdDSA,
  hashOrder,
  serializeKeyPairEncrypted,
  deserializeKeyPairEncrypted,
  isEncryptedKeyPair,
  deserializeKeyPair,
  DERIVE_MESSAGE,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";
import { poseidonHash, buildMerkleTree, randomFieldElement, computeCommitment, computeNullifier, toBytes32Hex, type CommitmentNote } from "../../lib/zk/commitment";
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
  listEdDSAKeysInFolder,
  type StoredNote,
} from "../../lib/zk/note-storage";
import { getPrivateSettlementAddress } from "../../lib/config";
import { getReadProvider } from "../../lib/provider";
import { PRIVATE_SETTLEMENT_ABI } from "../../lib/contracts";
import { useTokenEthPrice } from "../../lib/useTokenEthPrice";
import { estimateMinFeeBps, type GasEstimate } from "../../lib/gasEstimate";
import FeeBreakdown from "../../components/FeeBreakdown";
import PricePanel from "../../components/PricePanel";
import { useMainnetPrice } from "../../lib/useDexPrices";
import { friendlyError } from "../../lib/error-messages";

// EdDSA key is AES-GCM encrypted and stored in the notes folder (File System API).
// This protects against extension/physical access. Does NOT protect against XSS.
const MAX_CLAIMS = 10;

type OrderType = "limit" | "market";
type Step = "setup_key" | "create_order" | "signing" | "submitted" | "error";

type RecipientMode = "standard" | "stealth";

interface ClaimRow {
  id: number;
  mode: RecipientMode;
  address: string;
  amount: string;
  delay: string;
  delayUnit: "min" | "hr" | "day";
}

// ── Shared order-building logic (used by both limit and market handlers) ──

interface BuildOrderParams {
  sellToken: TokenInfo;
  buyToken: TokenInfo;
  sellAmount: string;
  buyAmount: string;
  expiry: string;
  claims: ClaimRow[];
  account: string;
  selectedNote: StoredNote;
  changeSalt: bigint | null;
  maxFee: bigint;
  relayerAddress: string;
  eddsaPrivateKey: Uint8Array;
  zkRelayerUrl?: string;
}

async function buildOrderProof(params: BuildOrderParams) {
  const { sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, changeSalt, maxFee, relayerAddress, eddsaPrivateKey, zkRelayerUrl } = params;

  const parsedSell = ethers.parseUnits(sellAmount, sellToken.decimals);
  const parsedBuy = ethers.parseUnits(buyAmount, buyToken.decimals);
  const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + Number(expiry) * 3600);
  const nonce = BigInt(Date.now());

  if (parsedSell > selectedNote.note.amount) {
    throw new Error(`Sell amount exceeds note balance (${selectedNote.amount} ${sellToken.symbol})`);
  }

  // Change commitment
  const change = selectedNote.note.amount - parsedSell;
  const newSalt = change > 0n && changeSalt ? changeSalt : 0n;
  let expectedChangeCommitment = 0n;
  if (change > 0n && changeSalt) {
    expectedChangeCommitment = await computeCommitment({
      ownerSecret: selectedNote.note.ownerSecret, token: selectedNote.note.token,
      amount: change, salt: changeSalt,
      pubKeyAx: selectedNote.note.pubKeyAx, pubKeyAy: selectedNote.note.pubKeyAy,
    });
  }

  // Build claims data (with optional ephemeralPubKey for stealth)
  const claimDataWithEpk = claims.map((c, idx) => {
    let recipient: string;
    let ephemeralPubKey: string | undefined;
    if (c.mode === "stealth") {
      if (!c.address || !isMetaAddress(c.address)) throw new Error(`Claim #${idx + 1}: Stealth mode requires a valid meta-address (st:eth:0x...)`);
      const stealth = generateStealthAddress(c.address);
      recipient = stealth.stealthAddress;
      ephemeralPubKey = stealth.ephemeralPubKey;
    } else if (c.address && !ethers.isAddress(c.address)) {
      throw new Error(`Claim #${idx + 1}: Invalid recipient address`);
    } else {
      recipient = c.address || account || ethers.ZeroAddress;
    }
    const delaySec = (parseInt(c.delay) || 1) * (c.delayUnit === "day" ? 86400 : c.delayUnit === "hr" ? 3600 : 60);
    const releaseTime = BigInt(Math.floor(Date.now() / 1000) + delaySec);
    const claimSecret = randomFieldElement();
    const claimAmount = c.amount ? ethers.parseUnits(c.amount, buyToken.decimals).toString() : "0";
    return { secret: claimSecret.toString(), recipient: BigInt(recipient).toString(), token: BigInt(buyToken.address).toString(), amount: claimAmount, releaseTime: releaseTime.toString(), ephemeralPubKey };
  });
  const claimData = claimDataWithEpk.map(({ ephemeralPubKey: _, ...rest }) => rest);

  // Compute claimsRoot
  const claimLeafHashes = await Promise.all(
    claimData.map((c) => poseidonHash([BigInt(c.secret), BigInt(c.recipient), BigInt(c.token), BigInt(c.amount), BigInt(c.releaseTime)]))
  );
  const padded = [...claimLeafHashes];
  while (padded.length < 16) padded.push(0n);
  const { root: claimsRoot } = await buildMerkleTree(padded, 4);

  // Fetch Merkle proof (relayer fast path, then on-chain fallback)
  let merkleProof: { root: bigint; pathElements: bigint[]; pathIndices: number[] };
  try {
    if (!zkRelayerUrl) throw new Error("no relayer");
    const mpRes = await fetch(`${zkRelayerUrl}/api/info/merkle-proof?leafIndex=${selectedNote.leafIndex}`);
    if (!mpRes.ok) throw new Error("unavailable");
    const mpData = await mpRes.json();
    merkleProof = { root: BigInt(mpData.root), pathElements: mpData.pathElements.map((e: string) => BigInt(e)), pathIndices: mpData.pathIndices };
  } catch {
    const provider = getReadProvider();
    const poolAddr = (await import("../../lib/config")).getCommitmentPoolAddress();
    const poolContract = new ethers.Contract(poolAddr, (await import("../../lib/contracts")).COMMITMENT_POOL_ABI, provider);
    const fromBlock = (await import("../../lib/provider")).getSafeFromBlock(provider);
    const events = await poolContract.queryFilter(poolContract.filters.CommitmentInserted(), await fromBlock);
    const leaves: bigint[] = [];
    for (const ev of events) { const e = ev as ethers.EventLog; const idx = Number(e.args.leafIndex); while (leaves.length <= idx) leaves.push(0n); leaves[idx] = BigInt(e.args.commitment); }
    const tree = await buildMerkleTree(leaves, 20);
    const proof = await import("../../lib/zk/commitment").then(m => m.getMerkleProof(tree.layers, selectedNote.leafIndex));
    merkleProof = { root: tree.root, pathElements: proof.pathElements, pathIndices: proof.pathIndices };
  }

  // Generate authorize proof in Web Worker
  const { generateAuthorizeProofInWorker } = await import("../../lib/zk/authorize-worker-client");
  const proofResult = await generateAuthorizeProofInWorker({
    note: selectedNote.note, leafIndex: selectedNote.leafIndex, merkleProof,
    sellAmount: parsedSell, buyToken: buyToken.address, buyAmount: parsedBuy,
    maxFee, expiry: expiryTimestamp, nonce, relayer: relayerAddress,
    eddsaPrivateKey,
    claims: claimData.map(c => ({ secret: BigInt(c.secret), recipient: c.recipient, token: c.token, amount: BigInt(c.amount), releaseTime: BigInt(c.releaseTime) })),
  });

  return { proofResult, claimData, claimDataWithEpk, claimsRoot, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment };
}

export default function PrivateOrderPage() {
  const { account, signer, readProvider, chainId, connect } = useWallet();
  const { relayers } = useRelayers();
  const tokens = getTokenList().filter((t) => !t.isNative);

  // ZK relayers (filter by name containing "ZK")
  const zkRelayers = useMemo(() =>
    relayers.filter((r) => r.online && r.api?.name?.includes("ZK")),
    [relayers]
  );
  const [selectedRelayerIdx, setSelectedRelayerIdx] = useState(0);

  const [step, setStep] = useState<Step>("setup_key");
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
  const [orderType, setOrderType] = useState<OrderType>("limit");
  // Snapshot of the order type at submission so the success screen's copy
  // and CTAs don't flip if the user toggles orderType after submitting.
  const [submittedOrderType, setSubmittedOrderType] = useState<OrderType | null>(null);
  const [slippageBps, setSlippageBps] = useState("50"); // 0.5% default
  const [manualPrice, setManualPrice] = useState(""); // fallback when DEX prices fail

  // Claims
  const nextClaimId = useRef(1);
  const [claims, setClaims] = useState<ClaimRow[]>([
    { id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" },
  ]);

  const sellToken = tokens[sellTokenIdx] as TokenInfo | undefined;
  const buyToken = tokens[buyTokenIdx] as TokenInfo | undefined;

  // DEX prices for market order mode (only fetched when market tab is active)
  const dexPrices = useMainnetPrice(
    orderType === "market" ? sellToken?.symbol : undefined,
    orderType === "market" ? buyToken?.symbol : undefined,
    "sell",
  );
  const { marketPrice, marketPriceSource } = useMemo(() => {
    const rec = dexPrices.find((p) => p.recommended && p.netPrice !== null);
    if (rec?.netPrice) return { marketPrice: rec.netPrice, marketPriceSource: rec.source ?? "DEX" };
    // Fallback: manual price input
    const manual = parseFloat(manualPrice);
    if (!isNaN(manual) && manual > 0) return { marketPrice: manual, marketPriceSource: "manual" };
    return { marketPrice: null, marketPriceSource: null };
  }, [dexPrices, manualPrice]);

  // [#23] Reset price/amount when switching between Limit and Market.
  // MUST be declared BEFORE auto-compute so React runs it first on tab switch.
  useEffect(() => {
    setBuyAmount("");
    setPrice("");
    setManualPrice("");
  }, [orderType]);

  // Auto-compute buyAmount in market mode (BigInt floor to avoid rounding up)
  useEffect(() => {
    if (orderType !== "market" || !marketPrice || !sellAmount || !buyToken) return;
    const sell = parseFloat(sellAmount);
    if (isNaN(sell) || sell <= 0) return;
    const slip = parseInt(slippageBps) || 50;
    const grossWei = ethers.parseUnits(
      (sell * marketPrice).toFixed(Math.min(buyToken.decimals, 18)),
      buyToken.decimals,
    );
    const minReceiveWei = grossWei * BigInt(10000 - slip) / 10000n;
    setBuyAmount(ethers.formatUnits(minReceiveWei, buyToken.decimals));
  }, [orderType, marketPrice, sellAmount, slippageBps, buyToken?.decimals]);

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

  // Reset note selection + manual price when sell/buy token changes
  useEffect(() => {
    setSelectedCommitment(null);
    setManualPrice("");
  }, [sellTokenIdx, buyTokenIdx]);

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

  const claimTotal = useMemo(() => {
    return claims.reduce((sum, c) => sum + (parseFloat(c.amount) || 0), 0);
  }, [claims]);

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

  // Recompute buyAmount from sell * price (fee is deducted at settlement, not here)
  const recomputeBuyAmount = useCallback((sell: string, p: string, _bps: number) => {
    const grossBuy = parseFloat(sell) * parseFloat(p);
    if (isNaN(grossBuy)) return;
    const dec = Math.min(buyToken?.decimals ?? 18, 18);
    setBuyAmount(grossBuy.toFixed(dec));
  }, [buyToken]);

  const handlePriceSelect = useCallback((p: string) => {
    setPrice(p);
    if (sellAmount) recomputeBuyAmount(sellAmount, p, effectiveFeeBps);
  }, [sellAmount, effectiveFeeBps, recomputeBuyAmount]);

  useEffect(() => {
    if (sellAmount && price) recomputeBuyAmount(sellAmount, price, effectiveFeeBps);
  }, [effectiveFeeBps, sellAmount, price, recomputeBuyAmount]);

  // Net amount after fee — this is the distributable amount for claims
  const netBuyAmount = parseFloat(buyAmount) * (1 - effectiveFeeBps / 10000) || 0;

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

  const fillRest = (id: number) => {
    const othersTotal = claims.reduce((sum, c) => c.id === id ? sum : sum + (parseFloat(c.amount) || 0), 0);
    const rest = Math.max(0, netBuyAmount - othersTotal);
    const floored = Math.floor(rest * 10000) / 10000;
    updateClaim(id, "amount", floored > 0 ? floored.toString() : "0");
  };

  // List available EdDSA keys in folder
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [availableKeys, setAvailableKeys] = useState<{ accountSuffix: string; filename: string }[]>([]);
  useEffect(() => {
    if (typeof window === "undefined" || !hasFolderSelected()) return;
    listEdDSAKeysInFolder().then(setAvailableKeys);
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
    setError(null);

    try {
      const selectedZkRelayer = zkRelayers[selectedRelayerIdx];
      if (!selectedZkRelayer) throw new Error("No ZK relayer selected");

      const { proofResult, claimData, claimDataWithEpk, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment } = await buildOrderProof({
        sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account,
        selectedNote, changeSalt, maxFee: BigInt(effectiveFeeBps || 30),
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

      setSubmittedOrderType("limit");
      setStep("submitted");
      setSellAmount("");
      setBuyAmount("");
      setPrice("");
      setSelectedCommitment(null);
      setClaims([{ id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" }]);
    } catch (e: unknown) {
      setError(friendlyError(e));
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, maxFeeBps]);

  // ── Market Order Submit: generate proof + call settleWithDex on-chain ──
  const handleMarketSubmit = useCallback(async () => {
    if (!sellToken || !buyToken || !sellAmount || !buyAmount || !selectedNote || !signer || !account) return;
    const kp = keyPair;
    if (!kp) { setError("Unlock or generate a trading key first"); return; }

    setStep("signing");
    setError(null);

    try {
      const { proofResult, claimData, claimDataWithEpk, padded, parsedSell, parsedBuy, expiryTimestamp, nonce, change, newSalt, expectedChangeCommitment } = await buildOrderProof({
        sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account,
        selectedNote, changeSalt, maxFee: 0n,
        relayerAddress: account, eddsaPrivateKey: kp.privateKey,
        zkRelayerUrl: zkRelayers[selectedRelayerIdx]?.url,
      });

      // Call settleWithDex on-chain
      const ps = proofResult.publicSignals;
      const settlementAddr = getPrivateSettlementAddress();
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, signer);

      // Read on-chain platform fee and compute post-fee swap amount.
      const settlementRead = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, readProvider);
      const platformFeeBps = Number(await settlementRead.dexPlatformFeeBps?.() ?? 0n);
      const swapAmountIn = platformFeeBps > 0
        ? parsedSell - (parsedSell * BigInt(platformFeeBps) / 10000n)
        : parsedSell;

      // Get best swap route via DEX aggregator (1inch → Uniswap fallback)
      const { getBestSwapRoute } = await import("../../lib/dex-aggregator");
      const currentChainId = chainId ?? 1;
      // Select fee tier from recommended DEX price
      const bestDexPrice = dexPrices.find(p => p.recommended && p.netPrice !== null);
      const feeParsed = Math.round(parseFloat(bestDexPrice?.fee ?? "0") * 10000);
      const feeTier = [100, 500, 3000, 10000].includes(feeParsed) ? feeParsed : 3000;

      const swapRoute = await getBestSwapRoute({
        chainId: currentChainId,
        sellToken: sellToken.address,
        buyToken: buyToken.address,
        sellAmount: swapAmountIn,
        minReceive: parsedBuy,
        recipient: settlementAddr,
        slippageBps: parseInt(slippageBps) || 50,
        feeTier,
      });
      if (process.env.NODE_ENV === "development") {
        console.log(`DEX route: ${swapRoute.source} (estimated: ${ethers.formatUnits(swapRoute.estimatedOutput, buyToken.decimals)} ${buyToken.symbol})`);
      }

      // Build settleWithDex params
      const totalLocked = claimData.reduce((sum, c) => sum + BigInt(c.amount), 0n);
      const proofA = [BigInt(proofResult.proof.a[0]), BigInt(proofResult.proof.a[1])];
      const proofB = [
        [BigInt(proofResult.proof.b[0][0]), BigInt(proofResult.proof.b[0][1])],
        [BigInt(proofResult.proof.b[1][0]), BigInt(proofResult.proof.b[1][1])],
      ];
      const proofC = [BigInt(proofResult.proof.c[0]), BigInt(proofResult.proof.c[1])];

      const tx = await settlement.settleWithDex({
        proof: {
          proofA, proofB, proofC,
          pubKeyBind: ps[0],
          commitmentRoot: ps[1],
          nullifier: ps[2],
          nonceNullifier: ps[3],
          newCommitment: ps[4],
          sellToken: sellToken.address,
          buyToken: buyToken.address,
          sellAmount: parsedSell,
          buyAmount: parsedBuy,
          maxFee: 0,
          expiry: expiryTimestamp,
          claimsRoot: ps[11],
          totalLocked,
          relayer: account,
          orderHash: ps[14],
        },
        dexRouter: swapRoute.dexRouter,
        dexCalldata: swapRoute.dexCalldata,
        deadline: expiryTimestamp, // use proof's expiry (derived from chain time + 24h)
      });
      await tx.wait();

      // Save claim files
      const claimFiles = claimDataWithEpk.map((c, idx) => ({
        secret: c.secret, recipient: c.recipient, token: c.token,
        amount: c.amount, releaseTime: c.releaseTime, leafIndex: idx,
        allLeaves: padded.map((l) => l.toString()),
        ...(c.ephemeralPubKey ? { ephemeralPubKey: c.ephemeralPubKey } : {}),
      }));
      const bundle = {
        order: { sellToken: sellToken.address, buyToken: buyToken.address, sellAmount: parsedSell.toString(), buyAmount: parsedBuy.toString(), maxFee: 0, expiry: expiryTimestamp.toString(), nonce: nonce.toString(), leafIndex: selectedNote.leafIndex, type: "market" },
        change: change > 0n ? { amount: change.toString(), salt: newSalt.toString(), expectedCommitment: expectedChangeCommitment.toString() } : null,
        claims: claimFiles,
        txHash: tx.hash,
        note: "Market order settled via DEX. Each entry can be loaded in Private Claim.",
        createdAt: new Date().toISOString(),
      };
      const bundleJson = JSON.stringify(bundle, null, 2);
      const claimsFilename = `zkscatter-market-claims-${Date.now()}.json`;
      try { await saveFileToFolder(claimsFilename, bundleJson); } catch { /* */ }
      const blob = new Blob([bundleJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = claimsFilename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      if (change > 0n && changeSalt) {
        try {
          await saveNote({ note: { ownerSecret: selectedNote.note.ownerSecret, token: selectedNote.note.token, amount: change, salt: changeSalt, pubKeyAx: selectedNote.note.pubKeyAx, pubKeyAy: selectedNote.note.pubKeyAy },
            commitment: "0x" + expectedChangeCommitment.toString(16), tokenSymbol: sellToken.symbol, tokenAddress: sellToken.address,
            amount: ethers.formatUnits(change, sellToken.decimals), leafIndex: -1, txHash: tx.hash, createdAt: Date.now() });
        } catch { /* */ }
      }

      setSubmittedOrderType("market");
      setStep("submitted");
      setSellAmount(""); setBuyAmount(""); setPrice(""); setSelectedCommitment(null);
      setClaims([{ id: nextClaimId.current++, mode: "standard", address: "", amount: "", delay: "1", delayUnit: "hr" }]);
    } catch (e: unknown) {
      setError(friendlyError(e));
      setStep("error");
    }
  }, [keyPair, sellToken, buyToken, sellAmount, buyAmount, expiry, claims, account, selectedNote, signer, changeSalt, changeAmount, dexPrices, zkRelayers, selectedRelayerIdx]);

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
            Private Order
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            ZK-private order. Your identity and trade details are hidden on-chain.
          </p>
          {/* Order Type Toggle */}
          <div className="flex gap-1 mt-3 bg-surface-container-low/50 p-1 rounded-lg w-fit">
            <button
              onClick={() => setOrderType("limit")}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-bold transition-all ${
                orderType === "limit"
                  ? "bg-primary text-on-primary shadow-sm"
                  : "text-on-surface-variant hover:bg-surface-bright/50"
              }`}
            >
              <BookOpen className="w-4 h-4" />
              Limit
            </button>
            <button
              onClick={() => setOrderType("market")}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-bold transition-all ${
                orderType === "market"
                  ? "bg-tertiary text-on-tertiary shadow-sm"
                  : "text-on-surface-variant hover:bg-surface-bright/50"
              }`}
            >
              <Zap className="w-4 h-4" />
              Market
            </button>
          </div>
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
            <div className="grid grid-cols-2 gap-4">
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
                <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">
                  {orderType === "market" ? "Min Receive (after slippage)" : "Buy Amount"}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={buyAmount}
                  onChange={(e) => setBuyAmount(e.target.value)}
                  readOnly={orderType === "market"}
                  className={`w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md font-mono py-2.5 px-3 ${
                    orderType === "market" ? "opacity-70" : ""
                  }`}
                  placeholder="0.00"
                />
                {orderType === "market" && marketPrice && sellAmount && parseFloat(sellAmount) > 0 && (
                  <div className="text-xs text-on-surface-variant mt-1">
                    {marketPriceSource === "manual" ? "Manual" : "DEX"} rate: {marketPrice.toFixed(6)} {buyToken?.symbol}/{sellToken?.symbol}
                    <span className={`ml-1 ${marketPriceSource === "manual" ? "text-warning" : "text-tertiary"}`}>({marketPriceSource})</span>
                  </div>
                )}
                {orderType === "limit" && sellAmount && buyAmount && parseFloat(sellAmount) > 0 && (
                  <div className="text-xs text-on-surface-variant mt-1">
                    Price: {(parseFloat(buyAmount) / parseFloat(sellAmount)).toFixed(6)} {buyToken?.symbol}/{sellToken?.symbol}
                  </div>
                )}
              </div>
            </div>

            </div>

            {/* 3. Fee & Expiry */}
            <div className="bg-surface-container/30 rounded-xl p-6 border border-outline-variant/10 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {orderType === "limit" ? (
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
              ) : (
              <div>
                <label className="block text-sm font-bold text-on-surface-variant uppercase mb-2">Slippage Tolerance</label>
                <div className="flex gap-1.5">
                  {[
                    { label: "0.1%", bps: "10" },
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
                {marketPrice && sellAmount && parseFloat(sellAmount) > 0 && (
                  <div className="text-xs text-on-surface-variant mt-1">
                    Expected: ~{(parseFloat(sellAmount) * marketPrice).toFixed(4)} {buyToken?.symbol}
                    <span className="text-tertiary ml-1">(no relay fee)</span>
                  </div>
                )}
                {!marketPrice && dexPrices.some(p => p.loading) && (
                  <div className="text-xs text-warning mt-1">Loading DEX prices...</div>
                )}
                {!dexPrices.some(p => p.loading) && !dexPrices.some(p => p.recommended && p.netPrice !== null) && (
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
                )}
              </div>
              )}
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

            {/* Fee summary */}
            {sellAmount && buyAmount && price && (
              <div className="bg-surface-container-low/30 rounded-lg px-4 py-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Buy amount</span>
                  <span className="font-mono text-on-surface">{parseFloat(buyAmount).toFixed(4)} {buyToken?.symbol}</span>
                </div>
                <button
                  type="button"
                  aria-expanded={feeBreakdownOpen}
                  className="flex w-full justify-between text-error/80 cursor-pointer hover:text-error transition-colors"
                  onClick={() => setFeeBreakdownOpen(!feeBreakdownOpen)}
                >
                  <span>Relay fee ({(effectiveFeeBps / 100).toFixed(2)}%) ▾</span>
                  <span className="font-mono">−{(parseFloat(buyAmount) * effectiveFeeBps / 10000).toFixed(4)} {buyToken?.symbol}</span>
                </button>
                {feeBreakdownOpen && gasEstimate && (
                  <FeeBreakdown gasEstimate={gasEstimate} baseFeeBps={feeBps} minFeeBps={minFeeBps} effectiveFeeBps={effectiveFeeBps} claimCount={claims.length} />
                )}
                <div className="flex justify-between font-bold text-tertiary pt-1 border-t border-outline-variant/10">
                  <span>You receive</span>
                  <span className="font-mono">{(parseFloat(buyAmount) * (1 - effectiveFeeBps / 10000)).toFixed(4)} {buyToken?.symbol}</span>
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
                      <span className="text-xs text-on-surface-variant font-bold">#{idx + 1}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => updateClaim(c.id, "mode", "standard")}
                          className={`px-2 py-0.5 rounded text-xs font-bold ${
                            c.mode === "standard" ? "bg-surface-container-highest text-on-surface" : "text-on-surface-variant"
                          }`}
                        >Standard</button>
                        <button
                          onClick={() => updateClaim(c.id, "mode", "stealth")}
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
                        <input
                          type="text" value={c.address}
                          onChange={(e) => updateClaim(c.id, "address", e.target.value)}
                          placeholder={c.mode === "stealth" ? "st:eth:0x..." : "0x... (empty = self)"}
                          className="w-full bg-white/10 border border-outline-variant/30 rounded-lg p-2.5 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface"
                        />
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
                    <span>Claims total: {claimTotal.toFixed(4)} {buyToken.symbol}</span>
                    <span>Net amount: {netBuyAmount.toFixed(4)} {buyToken.symbol}</span>
                  </div>
                  {netBuyAmount > 0 && claimTotal > netBuyAmount + 0.0001 && (
                    <div className="text-xs text-error font-bold">
                      Claims ({claimTotal.toFixed(4)}) exceed net amount ({netBuyAmount.toFixed(4)} {buyToken.symbol})
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5. ZK Relayer & Trading Key & Submit */}
            <div className="bg-surface-container/60 rounded-xl p-6 border border-outline-variant/10 space-y-4">

            {/* ZK Relayer selection — only for limit orders */}
            {orderType === "limit" && (
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
                      {r.api?.name} — {r.url} (Fee {(r.fee / 100).toFixed(2)}%)
                    </option>
                  ))}
                </select>
              )}
            </div>
            )}

            {/* Market order info */}
            {orderType === "market" && (
            <div className="bg-tertiary/5 border border-tertiary/15 rounded-lg px-4 py-3 space-y-1">
              <div className="flex items-center gap-2 text-sm font-bold text-tertiary">
                <Zap className="w-4 h-4" />
                Direct DEX Settlement
              </div>
              <p className="text-xs text-on-surface-variant/70">
                Your order will be routed through the best available DEX (1inch aggregator or Uniswap V3) for optimal pricing. No relayer needed — you submit the transaction yourself.
              </p>
            </div>
            )}

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

            {orderType === "limit" ? (
            <button
              onClick={!keyPair ? handleDeriveKey : handleSubmit}
              disabled={!sellAmount || !buyAmount || !selectedNote || zkRelayers.length === 0 || (claimTotal > 0 && netBuyAmount > 0 && claimTotal > netBuyAmount + 0.0001) || keyLoading}
              className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50"
            >
              {keyLoading ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Unlocking Key...</span>
              ) : !selectedNote ? "Select a Commitment Note" : !keyPair ? "Unlock Trading Key" : "Submit Limit Order"}
            </button>
            ) : (
            <button
              onClick={!keyPair ? handleDeriveKey : handleMarketSubmit}
              disabled={!sellAmount || !buyAmount || !selectedNote || !marketPrice || keyLoading || (claimTotal > 0 && parseFloat(buyAmount) > 0 && claimTotal > parseFloat(buyAmount) + 0.0001)}
              className="w-full bg-tertiary text-on-tertiary py-4 rounded-md font-bold text-sm uppercase tracking-widest disabled:opacity-50 hover:bg-tertiary/90 transition-colors"
            >
              {keyLoading ? (
                <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Unlocking Key...</span>
              ) : !selectedNote ? "Select a Commitment Note" : !keyPair ? "Unlock Trading Key" : !marketPrice ? "Waiting for DEX Price..." : "Execute Market Order"}
            </button>
            )}

            <div className="text-xs text-on-surface-variant/40 text-center">
              {orderType === "limit"
                ? "Order signed with EdDSA (Baby Jubjub). Hidden on-chain via ZK proof."
                : "Market order executed directly via DEX. ZK proof hides your identity on-chain."}
            </div>
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
            <p className="text-on-surface font-bold text-lg">
              {submittedOrderType === "market" ? "Market Order Executed" : "Private Order Submitted"}
            </p>
            <p className="text-sm text-on-surface-variant/70">
              {submittedOrderType === "market"
                ? "Your market order has been settled via DEX on-chain. Claim your tokens on the Private Claim page."
                : "Your order is in the private order book. When matched, a ZK proof will be generated and settled on-chain without revealing your identity."}
            </p>
            {process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL && (
              <div className="bg-primary/5 border border-primary/15 rounded-lg px-4 py-3 text-xs text-on-surface-variant/60 text-left">
                <span className="text-primary font-semibold">Shared Orderbook:</span> Your order summary is also published to the shared orderbook, enabling cross-relayer matching with other relayers for better liquidity.
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              {submittedOrderType === "market" ? (
                <>
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
                </>
              ) : (
                <Link
                  href="/trade/private-history"
                  className="px-5 py-2.5 rounded-md bg-primary text-on-primary text-sm font-semibold hover:bg-primary/90 transition-colors"
                >
                  View My Orders
                </Link>
              )}
              <button
                onClick={() => { setStep("create_order"); setSubmittedOrderType(null); refreshNotes(); }}
                className="px-5 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
              >
                Create Another Order
              </button>
            </div>
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
