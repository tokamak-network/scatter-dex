"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { ethers } from "ethers";
import { useSearchParams } from "next/navigation";
import { Shield, Download, Copy, Check, Eye, EyeOff, Loader2, Lock, Wallet, Zap, AlertCircle } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { getSettlementAddress, getEnv } from "../lib/config";
import { SETTLEMENT_ABI } from "../lib/contracts";
import { generateMetaAddress, deriveStealthPrivateKey, stealthWallet } from "../lib/stealth";
import { toSecretBytes, signGaslessClaim } from "../lib/signing";
import { RelayerClient } from "../lib/relayerApi";
import { shortenAddress } from "../lib/utils";
import type { MetaAddress } from "../lib/stealth";

const RELAYER_URL = getEnv("NEXT_PUBLIC_RELAYER_URL") || "http://localhost:3001";

type ClaimMethod = "standard" | "stealth" | "gasless";

export default function ClaimPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-32 text-on-surface-variant">Loading...</div>}>
      <ClaimPageInner />
    </Suspense>
  );
}

function ClaimPageInner() {
  const { account, signer, readProvider } = useWallet();
  const searchParams = useSearchParams();

  // Stealth Setup
  const [meta, setMeta] = useState<MetaAddress | null>(null);
  const [metaCopied, setMetaCopied] = useState(false);

  // Claim form (from URL params or manual input)
  const [secretInput, setSecretInput] = useState(searchParams.get("secret") || "");
  const [epk, setEpk] = useState(searchParams.get("epk") || "");
  const [showSecret, setShowSecret] = useState(false);

  // Claim preview
  const [preview, setPreview] = useState<{ token: string; symbol: string; amount: string; releaseTime: number; claimed: boolean; isWeth: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Claim execution
  const [claimMethod, setClaimMethod] = useState<ClaimMethod>("standard");
  const [claimStatus, setClaimStatus] = useState<"idle" | "claiming" | "success" | "error">("idle");
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimTxHash, setClaimTxHash] = useState<string | null>(null);
  const [claimAsETH, setClaimAsETH] = useState(false);
  const [decimalWarning, setDecimalWarning] = useState(false);

  // ─── Stealth Meta-Address Generation ────────────────────────

  const handleGenerate = () => {
    const m = generateMetaAddress();
    setMeta(m);
  };

  const handleDownload = () => {
    if (!meta) return;
    const data = JSON.stringify({
      metaAddress: meta.metaAddress,
      spendingKey: meta.spendingKey,
      viewingKey: meta.viewingKey,
      warning: "Keep these keys secret. Anyone with these keys can claim your funds.",
      generatedAt: new Date().toISOString(),
    }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zkscatter-stealth-${meta.metaAddress.slice(12, 20).replace(/[^a-zA-Z0-9]/g, "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyMeta = async () => {
    if (!meta) return;
    try {
      await navigator.clipboard.writeText(meta.metaAddress);
      setMetaCopied(true);
      setTimeout(() => setMetaCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  };

  // ─── Claim Preview ─────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    if (!secretInput || !readProvider) return;
    // Allow preview without wallet if stealth keys + epk are available
    if (!account && !(epk && meta)) return;

    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setDecimalWarning(false);

    try {
      const settlementAddr = getSettlementAddress();
      const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, readProvider);

      // Compute claimHash
      const secretBytes = toSecretBytes(secretInput);

      // Determine recipient address
      let recipient: string;
      if (epk && meta) {
        // Stealth: derive the stealth address
        const privKey = deriveStealthPrivateKey(meta.spendingKey, meta.viewingKey, epk);
        const wallet = new ethers.Wallet(privKey);
        recipient = wallet.address;
      } else {
        recipient = account!;
      }

      const claimHash = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [secretBytes, recipient])
      );

      const schedule = await settlement.schedules(claimHash);
      if (schedule.amount === BigInt(0)) {
        setPreviewError("No claim found for this secret + address combination");
      } else {
        // Query token metadata and WETH status in parallel
        let decimals = 18;
        let symbol = "";
        let isWeth = false;
        const tokenContract = new ethers.Contract(schedule.token, ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], readProvider);
        const [metaResult, wethResult] = await Promise.allSettled([
          Promise.all([tokenContract.decimals(), tokenContract.symbol()]),
          settlement.weth(),
        ]);
        if (metaResult.status === "fulfilled") {
          decimals = Number(metaResult.value[0]);
          symbol = metaResult.value[1];
        } else {
          setDecimalWarning(true);
        }
        if (wethResult.status === "fulfilled") {
          isWeth = schedule.token.toLowerCase() === (wethResult.value as string).toLowerCase();
        }

        setPreview({
          token: schedule.token,
          symbol,
          amount: ethers.formatUnits(schedule.amount, decimals),
          releaseTime: Number(schedule.releaseTime),
          claimed: schedule.claimed,
          isWeth,
        });
        if (isWeth) setClaimAsETH(true);
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }, [secretInput, readProvider, account, epk, meta]);

  // Auto-preview when URL has secret
  useEffect(() => {
    if (searchParams.get("secret") && readProvider && (account || (epk && meta))) {
      handlePreview();
    }
  }, [searchParams, readProvider, account, epk, meta, handlePreview]);

  // ─── Claim Execution ───────────────────────────────────────

  const handleClaim = async () => {
    if (!secretInput) return;
    setClaimStatus("claiming");
    setClaimError(null);
    setClaimTxHash(null);

    try {
      const settlementAddr = getSettlementAddress();
      const secretBytes = toSecretBytes(secretInput);

      if (claimMethod === "gasless") {
        // ─── Gasless Claim: EIP-712 signature + relayer submission ───
        if (!signer || !account) throw new Error("Connect wallet to sign gasless claim");

        const relayer = new RelayerClient(RELAYER_URL);
        const relayerInfo = await relayer.getInfo();

        // Determine recipient
        let recipient = account;
        if (epk && meta) {
          const privKey = deriveStealthPrivateKey(meta.spendingKey, meta.viewingKey, epk);
          recipient = new ethers.Wallet(privKey).address;
        }

        // Query gasless nonce from contract
        const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, readProvider ?? signer);
        const gaslessNonce = await settlement.gaslessNonces(recipient);

        const chainId = Number((await signer.provider!.getNetwork()).chainId);
        const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour deadline
        const relayerTip = "0"; // minimal tip — relayer decides acceptance

        // Sign the gasless claim with the recipient signer (stealth or connected)
        const claimSigner = (epk && meta && readProvider)
          ? stealthWallet(meta.spendingKey, meta.viewingKey, epk, readProvider)
          : signer;

        const recipientAddr = await claimSigner.getAddress();
        const signature = await signGaslessClaim(
          claimSigner,
          {
            secret: secretInput,
            recipient: recipientAddr,
            relayer: relayerInfo.address,
            relayerTip,
            deadline,
            nonce: BigInt(gaslessNonce),
          },
          chainId,
          settlementAddr
        );

        // Submit to relayer for execution via claimReleaseFor
        const res = await fetch(`${RELAYER_URL}/api/claim-gasless`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: secretBytes,
            recipient: recipientAddr,
            relayerTip,
            deadline,
            signature,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Gasless claim submission failed");
        }
        const result = await res.json();
        setClaimTxHash(result.txHash || "submitted");
        setClaimStatus("success");
      } else {
        // ─── Standard / Stealth direct claim ───
        if (!signer) throw new Error("Connect wallet to claim");

        const claimSigner = (claimMethod === "stealth" && epk && meta && readProvider)
          ? stealthWallet(meta.spendingKey, meta.viewingKey, epk, readProvider)
          : signer;

        const settlement = new ethers.Contract(settlementAddr, SETTLEMENT_ABI, claimSigner);
        const tx = claimAsETH && preview?.isWeth
          ? await settlement.claimReleaseAsETH(secretBytes)
          : await settlement.claimRelease(secretBytes);
        await tx.wait();

        setClaimTxHash(tx.hash);
        setClaimStatus("success");
      }
    } catch (e) {
      setClaimStatus("error");
      setClaimError(e instanceof Error ? e.message : "Claim failed");
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-8">
      <div className="mb-6">
        <h1 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface mb-2">
          Claim Assets
        </h1>
        <p className="text-on-surface-variant text-sm max-w-2xl">
          Generate stealth addresses for privacy or claim funds using a secret.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Stealth Setup */}
        <div className="lg:col-span-5 space-y-6">
          {/* Stealth Address Generation */}
          <div className="bg-surface-container rounded-xl p-6 border border-outline-variant/10">
            <div className="flex items-center gap-2 mb-4">
              <Shield className="w-5 h-5 text-primary" />
              <h3 className="font-headline font-bold text-lg">Stealth Address Setup</h3>
            </div>
            <p className="text-sm text-on-surface-variant mb-5 leading-relaxed">
              Generate a meta-address to receive funds privately. Share only the meta-address — keep the keys secret.
            </p>

            <div className="space-y-3">
              <button
                onClick={handleGenerate}
                className="w-full py-3 bg-surface-bright border border-outline-variant/30 rounded-md flex items-center justify-center gap-2 hover:bg-surface-container-highest transition-colors text-sm font-medium"
              >
                <Shield className="w-4 h-4" />
                {meta ? "Regenerate" : "Generate Stealth Address"}
              </button>

              {meta && (
                <>
                  {/* Meta-Address */}
                  <div className="p-3 bg-surface-container-low rounded-md border border-outline-variant/10">
                    <label className="text-[10px] uppercase tracking-widest text-on-surface-variant block mb-1">
                      Meta-Address (share this)
                    </label>
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-primary truncate flex-1 font-mono">
                        {meta.metaAddress.slice(0, 20)}...{meta.metaAddress.slice(-12)}
                      </code>
                      <button onClick={handleCopyMeta} className="text-on-surface-variant hover:text-primary">
                        {metaCopied ? <Check className="w-4 h-4 text-tertiary" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Download */}
                  <button
                    onClick={handleDownload}
                    className="w-full py-3 bg-secondary-container text-on-secondary-container rounded-md text-xs font-medium flex items-center justify-center gap-2 hover:brightness-110 transition-all"
                  >
                    <Download className="w-4 h-4" />
                    Download Keys (JSON)
                  </button>

                  <p className="text-[10px] text-error/80 text-center">
                    Save this file securely. You need the keys to claim funds sent to this meta-address.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Load existing keys */}
          <div className="bg-surface-container-low rounded-xl p-6 border border-outline-variant/10">
            <h3 className="font-headline font-bold text-sm mb-3">Load Existing Keys</h3>
            <label className="block">
              <span className="text-[10px] uppercase tracking-widest text-on-surface-variant">Upload JSON Key File</span>
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    try {
                      const data = JSON.parse(ev.target?.result as string);
                      if (data.metaAddress && data.spendingKey && data.viewingKey) {
                        setMeta(data as MetaAddress);
                      }
                    } catch { setPreviewError("Invalid JSON key file. Please upload a valid stealth key file."); }
                  };
                  reader.readAsText(file);
                }}
                className="mt-1 block w-full text-xs text-on-surface-variant file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-surface-bright file:text-on-surface hover:file:bg-surface-container-highest"
              />
            </label>
          </div>
        </div>

        {/* Right: Claim Interface */}
        <div className="lg:col-span-7 space-y-6">
          {/* Claim Card */}
          <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
            <h3 className="font-headline font-bold text-lg mb-5">Claim Funds</h3>

            {/* Secret Input */}
            <div className="mb-5">
              <label className="block text-sm font-medium text-on-surface-variant mb-2">Claim Secret</label>
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={secretInput}
                    onChange={(e) => setSecretInput(e.target.value)}
                    placeholder="Enter your 32-byte secret (0x...)..."
                    className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-3 px-4 pr-10 text-sm font-mono"
                  />
                  <button
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-3 top-3 text-on-surface-variant hover:text-on-surface"
                  >
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <button
                  onClick={handlePreview}
                  disabled={!secretInput || !readProvider || (!account && !(epk && meta)) || previewLoading}
                  className="px-5 py-3 bg-surface-bright text-primary border border-primary/20 rounded-md font-semibold text-sm hover:bg-primary/10 transition-all disabled:opacity-50"
                >
                  {previewLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Preview"}
                </button>
              </div>
              {epk && (
                <div className="mt-2 text-[10px] text-on-surface-variant">
                  Ephemeral Public Key detected (stealth claim)
                </div>
              )}
            </div>

            {/* Preview */}
            {preview && (
              <div className="grid grid-cols-3 gap-4 p-4 bg-surface-container-low/40 rounded-xl border border-outline-variant/10 mb-5">
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Token</p>
                  <p className="font-bold text-sm">{preview.symbol || <span className="font-mono">{shortenAddress(preview.token)}</span>}</p>
                  {preview.symbol && <p className="text-[10px] text-on-surface-variant font-mono mt-0.5">{shortenAddress(preview.token)}</p>}
                </div>
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Amount</p>
                  <p className="font-bold text-sm">{preview.amount} {preview.symbol}</p>
                </div>
                <div>
                  <p className="text-[10px] text-on-surface-variant uppercase tracking-widest mb-1">Status</p>
                  {preview.claimed ? (
                    <p className="text-error font-bold text-sm">Claimed</p>
                  ) : Date.now() / 1000 >= preview.releaseTime ? (
                    <p className="text-tertiary font-bold text-sm flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5" /> Unlocked
                    </p>
                  ) : (
                    <p className="text-on-surface-variant font-bold text-sm">
                      Locked until {new Date(preview.releaseTime * 1000).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            )}

            {decimalWarning && preview && (
              <div className="text-xs p-3 rounded-md bg-warning/5 text-yellow-500 mb-5 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                Could not verify token decimals — amount shown assumes 18 decimals and may be inaccurate.
              </div>
            )}

            {previewError && (
              <div className="text-xs p-3 rounded-md bg-error/5 text-error mb-5 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {previewError}
              </div>
            )}

            {/* Claim as ETH toggle */}
            {preview && !preview.claimed && preview.isWeth && (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-tertiary/10 border border-tertiary/20 mb-5">
                <label className="flex items-center gap-2 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={claimAsETH}
                    onChange={(e) => setClaimAsETH(e.target.checked)}
                    className="rounded border-outline-variant/30"
                  />
                  <span className="text-sm font-medium text-on-surface">Receive as ETH</span>
                  <span className="text-xs text-on-surface-variant">(unwrap WETH automatically)</span>
                </label>
              </div>
            )}

            {/* Claim Method Selection */}
            {preview && !preview.claimed && (
              <>
                <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">
                  Claim Method
                </h4>
                <div className="space-y-2 mb-6">
                  <button
                    onClick={() => setClaimMethod("standard")}
                    className={`w-full flex items-center gap-3 p-3 rounded-md border transition-all ${
                      claimMethod === "standard" ? "border-primary/40 bg-primary/5" : "border-outline-variant/10 hover:border-primary/20"
                    }`}
                  >
                    <Wallet className="w-5 h-5 text-primary" />
                    <div className="text-left flex-1">
                      <p className="font-bold text-sm">Standard Claim</p>
                      <p className="text-xs text-on-surface-variant">Claim to your connected wallet</p>
                    </div>
                  </button>

                  {epk && meta && (
                    <button
                      onClick={() => setClaimMethod("stealth")}
                      className={`w-full flex items-center gap-3 p-3 rounded-md border transition-all ${
                        claimMethod === "stealth" ? "border-primary/40 bg-primary/5" : "border-outline-variant/10 hover:border-primary/20"
                      }`}
                    >
                      <EyeOff className="w-5 h-5 text-primary" />
                      <div className="text-left flex-1">
                        <p className="font-bold text-sm">Stealth Claim</p>
                        <p className="text-xs text-on-surface-variant">Claim via derived stealth address (privacy)</p>
                      </div>
                    </button>
                  )}

                  <button
                    onClick={() => setClaimMethod("gasless")}
                    className={`w-full flex items-center gap-3 p-3 rounded-md border transition-all ${
                      claimMethod === "gasless" ? "border-primary/40 bg-primary/5" : "border-outline-variant/10 hover:border-primary/20"
                    }`}
                  >
                    <Zap className="w-5 h-5 text-primary" />
                    <div className="text-left flex-1">
                      <p className="font-bold text-sm">Gasless Claim (Relayer)</p>
                      <p className="text-xs text-on-surface-variant">Relayer pays gas, you pay a small tip</p>
                    </div>
                  </button>
                </div>

                {/* Execute */}
                <button
                  onClick={handleClaim}
                  disabled={claimStatus === "claiming" || !account}
                  className="w-full gradient-btn py-4 rounded-md text-on-primary-fixed font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
                >
                  {claimStatus === "claiming" ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Claiming...</>
                  ) : (
                    "Execute Claim"
                  )}
                </button>
              </>
            )}

            {/* Claim Result */}
            {claimStatus === "success" && claimTxHash && (
              <div className="mt-4 text-xs p-3 rounded-md bg-tertiary/5 text-tertiary">
                <div className="font-semibold mb-1">Claim successful!</div>
                <div className="font-mono truncate">TX: {claimTxHash}</div>
              </div>
            )}
            {claimStatus === "error" && claimError && (
              <div className="mt-4 text-xs p-3 rounded-md bg-error/5 text-error">{claimError}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
