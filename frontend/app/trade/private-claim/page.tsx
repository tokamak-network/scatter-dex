"use client";

import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { Gift, Loader2, AlertCircle, Check, Upload } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getTokenList } from "../../lib/tokens";
import { generateClaimProof } from "../../lib/zk/claim-prover";

const PRIVATE_SETTLEMENT_ABI = [
  "function claimWithProof(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, bytes32 claimsRoot, bytes32 claimNullifier, uint256 amount, address token, address recipient, uint256 releaseTime) external",
  "function claimsGroups(bytes32) view returns (address token, uint96 totalLocked, uint96 totalClaimed, uint48 expiry)",
];

type ClaimStatus = "idle" | "generating" | "submitting" | "success" | "error";

interface ClaimData {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
  leafIndex: number;
  // All 16 leaves for Merkle proof (padded with "0")
  allLeaves: string[];
}

export default function PrivateClaimPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList();

  const [claimJson, setClaimJson] = useState("");
  const [allClaims, setAllClaims] = useState<ClaimData[]>([]);
  const [selectedClaimIdx, setSelectedClaimIdx] = useState(0);
  const [claimData, setClaimData] = useState<ClaimData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [status, setStatus] = useState<ClaimStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const privateSettlementAddr = process.env.NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS || "";

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
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      setAllClaims([]);
      setSelectedClaimIdx(0);
      setClaimData(null);
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

  // Submit claim with ZK proof
  const handleClaim = useCallback(async () => {
    if (!signer || !claimData || !privateSettlementAddr) return;
    setStatus("generating");
    setError(null);
    setTxHash(null);

    try {
      const secret = BigInt(claimData.secret);
      const recipient = BigInt(claimData.recipient);
      const token = BigInt(claimData.token);
      const amount = BigInt(claimData.amount);
      const releaseTime = BigInt(claimData.releaseTime);
      const leafIndex = claimData.leafIndex;
      const allLeaves = claimData.allLeaves.map((l) => BigInt(l));

      // Check release time
      const now = Math.floor(Date.now() / 1000);
      if (now < Number(releaseTime)) {
        const remaining = Number(releaseTime) - now;
        const mins = Math.ceil(remaining / 60);
        throw new Error(`Not yet claimable. Release in ${mins} minute${mins > 1 ? "s" : ""}.`);
      }

      // Generate ZK proof in browser
      console.log("Generating claim ZK proof...");
      const proofResult = await generateClaimProof({
        secret,
        recipient,
        token,
        amount,
        releaseTime,
        leafIndex,
        allClaimLeaves: allLeaves,
      });
      console.log("Claim proof generated!");

      // Submit on-chain
      setStatus("submitting");
      const contract = new ethers.Contract(privateSettlementAddr, PRIVATE_SETTLEMENT_ABI, signer);

      const claimsRootHex = "0x" + proofResult.claimsRoot.toString(16).padStart(64, "0");
      const nullifierHex = "0x" + proofResult.nullifier.toString(16).padStart(64, "0");
      const tokenAddr = "0x" + token.toString(16).padStart(40, "0");
      const recipientAddr = "0x" + recipient.toString(16).padStart(40, "0");

      const tx = await contract.claimWithProof(
        proofResult.proof.a.map(BigInt),
        proofResult.proof.b.map((row: string[]) => row.map(BigInt)),
        proofResult.proof.c.map(BigInt),
        claimsRootHex,
        nullifierHex,
        amount,
        tokenAddr,
        recipientAddr,
        releaseTime,
      );

      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? receipt?.transactionHash ?? "");
      setStatus("success");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Claim failed");
      setStatus("error");
    }
  }, [signer, claimData, privateSettlementAddr]);

  // Resolve token symbol
  const tokenSymbol = claimData
    ? tokens.find((t) => BigInt(t.address) === BigInt(claimData.token))?.symbol ?? "?"
    : "";

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <Gift className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to claim</p>
        <button onClick={connect} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (!privateSettlementAddr) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium">PrivateSettlement not configured</p>
        <p className="text-sm mt-2">Set NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS in .env.local</p>
      </div>
    );
  }

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
              <label className="text-xs font-bold text-on-surface-variant uppercase">Select Claim ({allClaims.length} available)</label>
              <div className="space-y-1.5">
                {allClaims.map((c, i) => {
                  const claimTokenBig = BigInt(c.token);
                  const tokenInfo = tokens.find((t) => BigInt(t.address) === claimTokenBig);
                  const sym = tokenInfo?.symbol ?? "?";
                  const dec = tokenInfo?.decimals ?? 18;
                  return (
                    <button
                      key={i}
                      onClick={() => { setSelectedClaimIdx(i); setClaimData(allClaims[i]); }}
                      className={`w-full flex items-center justify-between p-3 rounded-md text-left transition-colors ${
                        selectedClaimIdx === i
                          ? "bg-primary/10 border border-primary/30"
                          : "bg-surface-container-low border border-outline-variant/10 hover:bg-surface-bright/50"
                      }`}
                    >
                      <span className="text-xs font-mono font-bold text-on-surface">
                        #{i + 1} — {ethers.formatUnits(c.amount, dec)} {sym}
                      </span>
                      <span className="text-[10px] font-mono text-on-surface-variant">
                        leaf #{c.leafIndex}
                      </span>
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

              {Date.now() / 1000 < Number(claimData.releaseTime) && (
                <div className="text-xs p-2 rounded bg-tertiary/10 text-tertiary">
                  Not yet claimable. Unlocks at {new Date(Number(claimData.releaseTime) * 1000).toLocaleString()}.
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs p-3 rounded-md bg-error/5 text-error">{error}</div>
          )}

          {claimData && (
            <button
              onClick={handleClaim}
              className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest"
            >
              Generate Proof & Claim
            </button>
          )}

          <div className="text-xs text-on-surface-variant/40 text-center">
            ZK proof generated in your browser. No one can see which settlement this claim belongs to.
          </div>
        </div>
      )}

      {/* Generating proof */}
      {status === "generating" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-on-surface font-medium">Generating ZK proof...</p>
          <p className="text-xs text-on-surface-variant">This may take a few seconds.</p>
        </div>
      )}

      {/* Submitting */}
      {status === "submitting" && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="text-on-surface font-medium">Submitting claim on-chain...</p>
          <p className="text-xs text-on-surface-variant">Confirm the transaction in MetaMask.</p>
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
          {txHash && (
            <div className="text-xs font-mono text-primary bg-primary/5 rounded-md p-3 break-all">
              tx: {txHash}
            </div>
          )}
          <button
            onClick={() => { setStatus("idle"); setClaimData(null); setAllClaims([]); setSelectedClaimIdx(0); setClaimJson(""); setTxHash(null); }}
            className="px-6 py-2.5 rounded-md bg-surface-bright text-on-surface text-sm font-medium hover:bg-surface-bright/80 transition-colors"
          >
            Claim Another
          </button>
        </div>
      )}
    </div>
  );
}
