"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { Gift, Loader2, AlertCircle, Check, Upload, Eye, CheckCircle2, Download, Wallet, Radio } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getTokenList } from "../../lib/tokens";
import { getPrivateSettlementAddress } from "../../lib/config";
import { generateClaimProof } from "../../lib/zk/claim-prover";
import { toAddressHex } from "../../lib/zk/commitment";
import { useClaimStatuses } from "../../lib/zk/useClaimStatuses";
import { friendlyError } from "../../lib/error-messages";

type ClaimStatus = "idle" | "generating" | "submitting" | "success" | "error";
type ClaimMode = "relayer" | "wallet";

const CLAIM_WITH_PROOF_ABI = [
  "function claimWithProof(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimWithProofBatch((uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime)[] claims) external",
];

// Mirrors PrivateSettlement.MAX_CLAIM_BATCH_SIZE.
const MAX_BATCH_SIZE = 20;

// Solidity tuple. NOTE: `claim-prover.ts` already returns proof.b in Solidity
// [imag, real] G2 order (see claim-prover.ts:96-102), so we DO NOT swap again
// here — double-swap was a pre-existing bug in the single-claim wallet path.
function toSolidityProofTuple(p: { a: string[]; b: string[][]; c: string[] }) {
  return {
    a: p.a.map(BigInt),
    b: p.b.map((row: string[]) => row.map(BigInt)),
    c: p.c.map(BigInt),
  };
}

type BuiltProof = {
  proofResult: { proof: { a: string[]; b: string[][]; c: string[] } };
  claimsRootHex: string;
  nullifierHex: string;
  amount: bigint;
  tokenAddr: string;
  recipientAddr: string;
  releaseTime: bigint;
};

function toClaimParams(p: BuiltProof) {
  const t = toSolidityProofTuple(p.proofResult.proof);
  return {
    proofA: t.a,
    proofB: t.b,
    proofC: t.c,
    claimsRoot: p.claimsRootHex,
    claimNullifier: p.nullifierHex,
    amount: p.amount,
    token: p.tokenAddr,
    recipient: p.recipientAddr,
    releaseTime: p.releaseTime,
  };
}

interface ClaimData {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
  leafIndex: number;
  allLeaves: string[];
  relayerUrl?: string; // relayer that settled this order
  ephemeralPubKey?: string; // present if stealth address was used
}

export default function PrivateClaimPage() {
  const tokens = getTokenList();
  const { signer } = useWallet();

  const [claimJson, setClaimJson] = useState("");
  const [allClaims, setAllClaims] = useState<ClaimData[]>([]);
  const [selectedClaimIdx, setSelectedClaimIdx] = useState(0);
  const [claimData, setClaimData] = useState<ClaimData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [bundleRelayerUrl, setBundleRelayerUrl] = useState<string | null>(null);
  // Tracks whether the loaded bundle is a market-order (DEX Trade) bundle.
  // Market claims aren't routed through the relayer path, so the Gasless
  // button is disabled when this is true.
  const [bundleIsMarket, setBundleIsMarket] = useState<boolean>(false);
  const [claimMode, setClaimMode] = useState<ClaimMode>("relayer");
  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [batchProgress, setBatchProgress] = useState<{
    chunk: number;
    totalChunks: number;
    claims: number;
    phase: "generating" | "submitting";
    proofDone?: number;
  } | null>(null);

  const claimedMap = useClaimStatuses(allClaims, { includeTxHash: true });

  // Claims submitted via zk-relayer (no direct contract address needed)

  // Validate a single claim entry — checks presence and BigInt parsability
  function validateSingleClaim(c: any): ClaimData {
    if (!c.secret || !c.recipient || !c.token || !c.amount || !c.releaseTime) {
      throw new Error("Missing required fields: secret, recipient, token, amount, releaseTime");
    }
    // Verify BigInt-parsable
    for (const field of ["secret", "recipient", "token", "amount", "releaseTime"] as const) {
      try { BigInt(c[field]); } catch { throw new Error(`${field} is not a valid number`); }
    }
    if (c.leafIndex === undefined || !Number.isFinite(Number(c.leafIndex)) || Number(c.leafIndex) < 0) {
      throw new Error("leafIndex must be a non-negative integer");
    }
    if (!c.allLeaves || !Array.isArray(c.allLeaves) || c.allLeaves.length !== 16) {
      throw new Error("allLeaves must be an array of 16 elements");
    }
    for (let i = 0; i < c.allLeaves.length; i++) {
      try { BigInt(c.allLeaves[i]); } catch { throw new Error(`allLeaves[${i}] is not a valid number`); }
    }
    // Validate ephemeralPubKey format if present
    if (c.ephemeralPubKey !== undefined) {
      if (typeof c.ephemeralPubKey !== "string" || !/^0x[0-9a-fA-F]+$/.test(c.ephemeralPubKey)) {
        throw new Error("ephemeralPubKey must be a hex string starting with 0x");
      }
    }
    return c as ClaimData;
  }

  // Parse claim JSON — supports single claim or bundled { claims: [...] }
  function parseClaims(parsed: any): ClaimData[] {
    if (parsed.claims && Array.isArray(parsed.claims)) {
      if (parsed.claims.length === 0) throw new Error("No claims in bundle");
      return parsed.claims.map((c: any, i: number) => {
        try { return validateSingleClaim(c); }
        catch (e) { throw new Error(`Claim #${i + 1}: ${e instanceof Error ? e.message : "invalid"}`); }
      });
    }
    return [validateSingleClaim(parsed)];
  }

  function loadClaims(text: string) {
    setParseError(null);
    try {
      const parsed = JSON.parse(text);
      const claims = parseClaims(parsed);
      setAllClaims(claims);
      setSelectedClaimIdx(0);
      setClaimData(claims[0]);
      // Read relayer URL: from bundle top-level, or from individual claim entry
      const url = parsed.relayerUrl ?? claims[0]?.relayerUrl ?? null;
      setBundleRelayerUrl(validRelayerUrl(url));
      // Detect market-order bundle so the Gasless button can be disabled.
      // Works for both bundled format (`parsed.order.type`) and split
      // single-claim files (`parsed.orderType` injected at zip-export time).
      setBundleIsMarket(parsed?.order?.type === "market" || parsed?.orderType === "market");
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      setAllClaims([]);
      setSelectedClaimIdx(0);
      setClaimData(null);
      setBundleRelayerUrl(null);
      setBundleIsMarket(false);
    }
  }

  const handleParseClaim = useCallback(() => {
    loadClaims(claimJson);
  }, [claimJson]);

  const handleLoadFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 1_000_000) { setParseError("File too large (max 1MB)"); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setClaimJson(text);
        loadClaims(text);
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  /** Validate relayer URL format — must be absolute http/https.
   *  SSRF protection is enforced server-side via /api/relay allowlist. */
  function validRelayerUrl(url: unknown): string | null {
    if (typeof url !== "string") return null;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch { /* invalid */ }
    return null;
  }

  // Shared proof generation (pure function of ClaimData — no component state captured)
  async function buildProof(cd: ClaimData) {
    const secret = BigInt(cd.secret);
    const recipient = BigInt(cd.recipient);
    const token = BigInt(cd.token);
    const amount = BigInt(cd.amount);
    const releaseTime = BigInt(cd.releaseTime);
    const allLeaves = cd.allLeaves.map((l) => BigInt(l));

    const now = Math.floor(Date.now() / 1000);
    if (now < Number(releaseTime)) {
      const remaining = Number(releaseTime) - now;
      const mins = Math.ceil(remaining / 60);
      throw new Error(`Not yet claimable. Release in ${mins} minute${mins > 1 ? "s" : ""}.`);
    }

    const proofResult = await generateClaimProof({
      secret, recipient, token, amount, releaseTime,
      leafIndex: cd.leafIndex, allClaimLeaves: allLeaves,
    });

    return {
      proofResult,
      claimsRootHex: "0x" + proofResult.claimsRoot.toString(16).padStart(64, "0"),
      nullifierHex: "0x" + proofResult.nullifier.toString(16).padStart(64, "0"),
      tokenAddr: "0x" + token.toString(16).padStart(40, "0"),
      recipientAddr: "0x" + recipient.toString(16).padStart(40, "0"),
      amount,
      releaseTime,
    };
  }

  // Mode 1: Gasless claim via relayer
  const handleClaimViaRelayer = useCallback(async () => {
    if (!claimData) return;
    setStatus("generating");
    setError(null);
    setTxHashes([]);
    try {
      const p = await buildProof(claimData);
      setStatus("submitting");
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relayerUrl: bundleRelayerUrl || undefined,
          proofA: p.proofResult.proof.a,
          proofB: p.proofResult.proof.b,
          proofC: p.proofResult.proof.c,
          claimsRoot: p.claimsRootHex,
          claimNullifier: p.nullifierHex,
          amount: p.amount.toString(),
          token: p.tokenAddr,
          recipient: p.recipientAddr,
          releaseTime: p.releaseTime.toString(),
        }),
      });
      if (!res.ok) {
        let errMsg = "Claim submission failed";
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch { /* */ }
        throw new Error(errMsg);
      }
      const result = await res.json();
      if (!result.txHash) throw new Error("Relayer response missing txHash.");
      setTxHashes([result.txHash]);
      setStatus("success");
    } catch (e: unknown) {
      setError(friendlyError(e));
      setStatus("error");
    }
  }, [claimData, bundleRelayerUrl]);

  const handleClaimViaWallet = useCallback(async () => {
    if (!claimData || !signer) return;
    setStatus("generating");
    setError(null);
    setTxHashes([]);
    try {
      const p = await buildProof(claimData);
      setStatus("submitting");
      const settlement = new ethers.Contract(getPrivateSettlementAddress(), CLAIM_WITH_PROOF_ABI, signer);
      const c = toClaimParams(p);
      const tx = await settlement.claimWithProof(
        c.proofA, c.proofB, c.proofC,
        c.claimsRoot, c.claimNullifier,
        c.amount, c.token, c.recipient, c.releaseTime,
      );
      const receipt = await tx.wait();
      const hash = receipt.hash ?? receipt.transactionHash;
      if (!hash) throw new Error("Tx receipt missing hash.");
      setTxHashes([hash]);
      setStatus("success");
    } catch (e: any) {
      console.error("Wallet claim failed:", e);
      setError(friendlyError(e));
      setStatus("error");
    }
  }, [claimData, signer]);

  const eligibleClaims = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return allClaims
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !claimedMap[i]?.claimed && now >= Number(c.releaseTime));
  }, [allClaims, claimedMap]);

  const handleClaimBatchViaWallet = useCallback(async () => {
    if (!signer || eligibleClaims.length === 0) return;
    setStatus("generating");
    setError(null);
    setTxHashes([]);
    setBatchProgress(null);

    try {
      // Per-chunk build-then-submit: first tx lands sooner (no wait for all N
      // proofs), and a later chunk failure doesn't waste CPU on unused proofs.
      const settlement = new ethers.Contract(getPrivateSettlementAddress(), CLAIM_WITH_PROOF_ABI, signer);
      const totalChunks = Math.ceil(eligibleClaims.length / MAX_BATCH_SIZE);
      const hashes: string[] = [];

      for (let ci = 0; ci < totalChunks; ci++) {
        const chunkClaims = eligibleClaims.slice(ci * MAX_BATCH_SIZE, (ci + 1) * MAX_BATCH_SIZE);

        // Proof gen is CPU-heavy and runs on the main thread — keep sequential
        // so the progress UI can repaint between proofs.
        setStatus("generating");
        const builtChunk: BuiltProof[] = [];
        for (let pi = 0; pi < chunkClaims.length; pi++) {
          setBatchProgress({
            chunk: ci + 1,
            totalChunks,
            claims: chunkClaims.length,
            phase: "generating",
            proofDone: pi,
          });
          builtChunk.push(await buildProof(chunkClaims[pi].c));
        }

        setStatus("submitting");
        setBatchProgress({
          chunk: ci + 1,
          totalChunks,
          claims: chunkClaims.length,
          phase: "submitting",
        });

        const params = builtChunk.map(toClaimParams);
        const tx = await settlement.claimWithProofBatch(params);
        const receipt = await tx.wait();
        const hash = receipt.hash ?? receipt.transactionHash;
        if (!hash) throw new Error(`Batch ${ci + 1} tx receipt missing hash.`);
        hashes.push(hash);
        setTxHashes([...hashes]);
      }

      setStatus("success");
      setBatchProgress(null);
    } catch (e: unknown) {
      console.error("Batch claim failed:", e);
      setError(friendlyError(e));
      setStatus("error");
      setBatchProgress(null);
    }
  }, [signer, eligibleClaims]);

  // Resolve token symbol
  const tokenSymbol = claimData
    ? tokens.find((t) => BigInt(t.address) === BigInt(claimData.token))?.symbol ?? "?"
    : "";

  // No wallet connection required — claims are gasless via zk-relayer

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Gift className="w-6 h-6 text-primary" />
          Private Claim
        </h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">
          Claim funds from a ZK private settlement using a zero-knowledge proof.
        </p>
      </div>

      {/* Input: Claim Data */}
      {(status === "idle" || status === "error") && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-headline font-bold text-sm text-on-surface">Claim Data</h3>
            <button
              onClick={handleLoadFile}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary-container font-bold"
            >
              <Upload className="w-3.5 h-3.5" /> Load JSON File
            </button>
          </div>

          <textarea
            value={claimJson}
            onChange={(e) => setClaimJson(e.target.value)}
            placeholder='{"secret": "...", "recipient": "...", "token": "...", "amount": "...", "releaseTime": "...", "leafIndex": 0, "allLeaves": [...]}'
            className="w-full h-40 bg-surface-container-low border border-outline-variant/20 rounded-md p-3 text-xs font-mono focus:ring-1 focus:ring-primary text-on-surface resize-none"
          />

          {parseError && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" /> {parseError}
            </div>
          )}

          {!claimData && (
            <button
              onClick={handleParseClaim}
              disabled={!claimJson.trim()}
              className="w-full py-3 rounded-md bg-surface-bright text-on-surface font-bold text-sm hover:bg-surface-bright/80 transition-colors disabled:opacity-50"
            >
              Parse Claim Data
            </button>
          )}

          {/* Claim Selector (for multi-claim bundles) */}
          {allClaims.length > 1 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-on-surface-variant uppercase">Select Claim ({allClaims.length} available)</label>
                <button
                  onClick={async () => {
                    const JSZip = (await import("jszip")).default;
                    const zip = new JSZip();
                    allClaims.forEach((c, i) => {
                      const addr = toAddressHex(c.recipient);
                      const shortAddr = addr.slice(0, 6) + "..." + addr.slice(-4);
                      const filename = `claim-${i + 1}-${shortAddr}.json`;
                      // Mark each split claim with the bundle's order type so
                      // the claim page can detect market-order claims even
                      // after zip extraction (the `order` field only exists
                      // at the bundle level and would otherwise be lost).
                      const marked = bundleIsMarket ? { ...c, orderType: "market" as const } : c;
                      zip.file(filename, JSON.stringify(marked, null, 2));
                    });
                    const blob = await zip.generateAsync({ type: "blob" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `zkscatter-claims-split.zip`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="flex items-center gap-1 text-[10px] text-primary font-bold hover:text-primary-container transition-colors"
                >
                  <Download className="w-3 h-3" /> Export as ZIP
                </button>
              </div>
              <div className="space-y-1.5">
                {allClaims.map((c, i) => {
                  const claimTokenBig = BigInt(c.token);
                  const tokenInfo = tokens.find((t) => BigInt(t.address) === claimTokenBig);
                  const sym = tokenInfo?.symbol ?? "?";
                  const dec = tokenInfo?.decimals ?? 18;
                  const cs = claimedMap[i];
                  const isClaimed = cs?.claimed === true;
                  return (
                    <button
                      key={i}
                      onClick={() => { setSelectedClaimIdx(i); setClaimData(allClaims[i]); setBundleRelayerUrl(validRelayerUrl(allClaims[i].relayerUrl)); }}
                      disabled={isClaimed}
                      className={`w-full flex items-center justify-between p-3 rounded-md text-left transition-colors ${
                        isClaimed
                          ? "bg-emerald-500/5 border border-emerald-500/15 opacity-60 cursor-default"
                          : selectedClaimIdx === i
                          ? "bg-primary/10 border border-primary/30"
                          : "bg-surface-container-low border border-outline-variant/10 hover:bg-surface-bright/50"
                      }`}
                    >
                      <span className="text-xs font-mono font-bold text-on-surface">
                        #{i + 1} — {ethers.formatUnits(c.amount, dec)} {sym}
                      </span>
                      <div className="flex items-center gap-2">
                        {isClaimed && (
                          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> Claimed
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-on-surface-variant">
                          leaf #{c.leafIndex}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Preview */}
          {claimData && (
            <div className="bg-surface-container-low/50 rounded-lg p-4 border border-outline-variant/5 space-y-2">
              <h4 className="text-xs font-bold text-on-surface-variant uppercase">Claim Preview</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-on-surface-variant">Amount:</span>
                  <span className="font-mono font-bold text-on-surface ml-2">
                    {ethers.formatUnits(claimData.amount, tokens.find((t) => BigInt(t.address) === BigInt(claimData.token))?.decimals ?? 18)} {tokenSymbol}
                  </span>
                </div>
                <div>
                  <span className="text-on-surface-variant">Recipient:</span>
                  <span className="font-mono text-on-surface ml-2">
                    {"0x" + BigInt(claimData.recipient).toString(16).padStart(40, "0").slice(0, 10)}...
                  </span>
                </div>
                <div>
                  <span className="text-on-surface-variant">Release:</span>
                  <span className="font-mono text-on-surface ml-2">
                    {new Date(Number(claimData.releaseTime) * 1000).toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-on-surface-variant">Leaf Index:</span>
                  <span className="font-mono text-on-surface ml-2">#{claimData.leafIndex}</span>
                </div>
              </div>

              {bundleRelayerUrl && (
                <div className="flex items-center gap-2 text-xs pt-2 border-t border-outline-variant/10">
                  <span className="text-on-surface-variant">Relayer:</span>
                  <span className="font-mono text-on-surface">{bundleRelayerUrl}</span>
                </div>
              )}

              {Date.now() / 1000 < Number(claimData.releaseTime) && (
                <div className="text-xs p-2 rounded bg-tertiary/10 text-tertiary">
                  Not yet claimable. Unlocks at {new Date(Number(claimData.releaseTime) * 1000).toLocaleString()}.
                </div>
              )}

              {claimedMap[selectedClaimIdx]?.claimed && (
                <div className="text-xs p-3 rounded-md bg-emerald-500/5 border border-emerald-500/15 space-y-1">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Already Claimed
                  </div>
                  {claimedMap[selectedClaimIdx]?.txHash && (
                    <div className="font-mono text-[11px] text-on-surface-variant/60 break-all">
                      Tx: {claimedMap[selectedClaimIdx].txHash}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Stealth indicator */}
          {claimData?.ephemeralPubKey && (
            <div className="flex items-center gap-2 text-xs text-primary bg-primary/5 px-3 py-2 rounded-md">
              <Eye className="w-3.5 h-3.5" />
              Stealth claim — tokens will be sent to a one-time stealth address. Your connected wallet pays gas only.
            </div>
          )}

          {error && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
          )}

          {allClaims.length > 1 && eligibleClaims.length >= 2 && (
            <button
              onClick={handleClaimBatchViaWallet}
              disabled={!signer}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-md bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 font-bold text-sm transition-colors disabled:opacity-50"
            >
              <Wallet className="w-4 h-4" />
              {signer
                ? `Claim All ${eligibleClaims.length} via Wallet${
                    Math.ceil(eligibleClaims.length / MAX_BATCH_SIZE) > 1
                      ? ` (${Math.ceil(eligibleClaims.length / MAX_BATCH_SIZE)} txs)`
                      : ""
                  }`
                : "Connect Wallet to Batch Claim"}
            </button>
          )}

          {claimData && !claimedMap[selectedClaimIdx]?.claimed && (() => {
            // Market-order claims aren't routed through the relayer today —
            // settleWithDex is a single-party permissionless path and the
            // relayer has no order context to pay gas against. Force wallet
            // mode for those claims so the UI doesn't offer a dead option.
            // The bundle-level flag is set by parseClaims; individual claim
            // entries don't carry `order` since the loader flattens them.
            const isMarketClaim = bundleIsMarket
              || (claimData as { order?: { type?: string } })?.order?.type === "market";
            return (
            <div className="space-y-4">
              {/* Mode selector */}
              <div className="flex gap-2">
                <button
                  onClick={() => !isMarketClaim && setClaimMode("relayer")}
                  disabled={isMarketClaim}
                  title={isMarketClaim ? "Market-order claims must be submitted from your wallet" : undefined}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold transition-colors ${
                    isMarketClaim
                      ? "bg-surface-container-low/50 text-on-surface-variant/40 border border-outline-variant/10 cursor-not-allowed"
                      : claimMode === "relayer"
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "bg-surface-container-low text-on-surface-variant border border-outline-variant/10 hover:bg-surface-bright/50"
                  }`}
                >
                  <Radio className="w-4 h-4" />
                  Gasless (Relayer){isMarketClaim && " — N/A for Market"}
                </button>
                <button
                  onClick={() => setClaimMode("wallet")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold transition-colors ${
                    claimMode === "wallet"
                      ? "bg-tertiary/15 text-tertiary border border-tertiary/30"
                      : "bg-surface-container-low text-on-surface-variant border border-outline-variant/10 hover:bg-surface-bright/50"
                  }`}
                >
                  <Wallet className="w-4 h-4" />
                  Wallet (Pay Gas)
                </button>
              </div>

              {/* Claim button */}
              {!isMarketClaim && claimMode === "relayer" ? (
                <button
                  onClick={handleClaimViaRelayer}
                  className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest"
                >
                  Generate Proof & Claim (Gasless)
                </button>
              ) : (
                <button
                  onClick={handleClaimViaWallet}
                  disabled={!signer}
                  className="w-full bg-tertiary/80 hover:bg-tertiary text-on-tertiary-container py-4 rounded-md font-bold text-sm uppercase tracking-widest transition-colors disabled:opacity-50"
                >
                  {signer ? "Generate Proof & Claim (Wallet)" : "Connect Wallet First"}
                </button>
              )}
            </div>
            );
          })()}

          <div className="text-xs text-on-surface-variant/40 text-center space-y-1">
            <p>ZK proof generated in your browser. No one can see which settlement this claim belongs to.</p>
            {claimMode === "relayer"
              ? <p>Gasless — the relayer submits the transaction and pays gas on your behalf.</p>
              : <p>You will sign the transaction with MetaMask and pay gas directly.</p>
            }
          </div>
        </div>
      )}

      {/* Generating proof */}
      {status === "generating" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-on-surface font-medium">
            {batchProgress
              ? `Generating proof ${(batchProgress.proofDone ?? 0) + 1} of ${batchProgress.claims} (batch ${batchProgress.chunk}/${batchProgress.totalChunks})...`
              : "Generating ZK proof..."}
          </p>
          <p className="text-xs text-on-surface-variant">This may take a few seconds.</p>
          {batchProgress && txHashes.length > 0 && (
            <div className="text-[11px] font-mono text-on-surface-variant/60 space-y-1">
              {txHashes.map((h, i) => (
                <div key={i} className="break-all">batch #{i + 1}: {h}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Submitting */}
      {status === "submitting" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-on-surface font-medium">
            {batchProgress
              ? `Submitting batch ${batchProgress.chunk}/${batchProgress.totalChunks} (${batchProgress.claims} claims)...`
              : "Submitting claim on-chain..."}
          </p>
          <p className="text-xs text-on-surface-variant">
            {batchProgress
              ? "Confirm each transaction in MetaMask."
              : claimMode === "relayer" ? "Relayer is submitting the claim on-chain (gasless)." : "Confirm the transaction in MetaMask."}
          </p>
          {batchProgress && txHashes.length > 0 && (
            <div className="text-[11px] font-mono text-on-surface-variant/60 space-y-1">
              {txHashes.map((h, i) => (
                <div key={i} className="break-all">batch #{i + 1}: {h}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Success */}
      {status === "success" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Check className="w-12 h-12 text-emerald-400 mx-auto" />
          <p className="text-on-surface font-bold text-lg">Claim Successful!</p>
          <p className="text-sm text-on-surface-variant/70">
            Funds have been transferred to the recipient address.
          </p>
          {txHashes.length === 1 && txHashes[0] && (
            <div className="text-xs font-mono text-primary bg-primary/5 rounded-md p-3 break-all">
              tx: {txHashes[0]}
            </div>
          )}
          {txHashes.length > 1 && (
            <div className="text-xs font-mono text-primary bg-primary/5 rounded-md p-3 space-y-1 text-left">
              {txHashes.map((h, i) => (
                <div key={i} className="break-all">batch #{i + 1}: {h}</div>
              ))}
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
              onClick={() => { setStatus("idle"); setClaimData(null); setAllClaims([]); setSelectedClaimIdx(0); setClaimJson(""); setTxHashes([]); setBundleRelayerUrl(null); setBundleIsMarket(false); }}
              className="px-5 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
            >
              Claim Another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
