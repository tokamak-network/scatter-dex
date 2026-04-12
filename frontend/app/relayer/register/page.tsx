"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { UserPlus, ShieldCheck, AlertCircle, Loader2, CheckCircle, XCircle } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getRelayerRegistryAddress } from "../../lib/config";
import { RELAYER_REGISTRY_ABI } from "../../lib/contracts";
import { getReadProvider } from "../../lib/provider";

const RELAYER_REGISTRY_EXTENDED_ABI = [
  ...RELAYER_REGISTRY_ABI,
  "function identityRegistry() external view returns (address)",
];

const IDENTITY_REGISTRY_ABI = [
  "function isVerified(address user) external view returns (bool)",
  "function verifiedUntil(address user) external view returns (uint64)",
];

type RegistrationStatus = "idle" | "checking" | "not-connected" | "not-verified" | "already-registered" | "ready" | "submitting" | "success" | "error";

export default function RelayerRegisterPage() {
  const { account, signer } = useWallet();

  const [status, setStatus] = useState<RegistrationStatus>("idle");
  const [isVerified, setIsVerified] = useState(false);
  const [verifiedUntil, setVerifiedUntil] = useState<number>(0);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [minBond, setMinBond] = useState<bigint>(0n);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  // Form
  const [url, setUrl] = useState("");
  const [feeBps, setFeeBps] = useState("30"); // 0.3% default
  const [bondEth, setBondEth] = useState("0.1");

  const checkStatus = useCallback(async () => {
    if (!account) {
      setStatus("not-connected");
      return;
    }

    setStatus("checking");
    try {
      const provider = getReadProvider();
      const registryAddr = getRelayerRegistryAddress();
      const registry = new ethers.Contract(registryAddr, RELAYER_REGISTRY_EXTENDED_ABI, provider);

      // Get identity registry address from RelayerRegistry
      const idRegistryAddr = await registry.identityRegistry();
      const idRegistry = new ethers.Contract(idRegistryAddr, IDENTITY_REGISTRY_ABI, provider);

      // Check verification
      const verified = await idRegistry.isVerified(account);
      setIsVerified(verified);

      if (verified) {
        const until = await idRegistry.verifiedUntil(account);
        setVerifiedUntil(Number(until));
      }

      // Check if already registered
      const isActive = await registry.isActiveRelayer(account);
      setAlreadyRegistered(isActive);

      // Get min bond
      const bond = await registry.minBond();
      setMinBond(bond);

      if (!verified) {
        setStatus("not-verified");
      } else if (isActive) {
        setStatus("already-registered");
      } else {
        setStatus("ready");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to check status");
      setStatus("error");
    }
  }, [account]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleRegister = async () => {
    if (!account) return;

    setStatus("submitting");
    setErrorMsg("");
    try {
      if (!signer) throw new Error("No signer available");

      const registryAddr = getRelayerRegistryAddress();
      const registry = new ethers.Contract(registryAddr, RELAYER_REGISTRY_ABI, signer);

      const feeNum = parseInt(feeBps, 10);
      if (isNaN(feeNum) || feeNum < 0 || feeNum > 500) throw new Error("FeeTooHigh");
      const fee = BigInt(feeNum);
      let bond: bigint;
      try { bond = ethers.parseEther(bondEth || "0"); }
      catch { throw new Error("Invalid bond amount"); }

      const tx = await registry.register(url, fee, { value: bond });
      const receipt = await tx.wait();
      setTxHash(receipt.hash);
      setStatus("success");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Registration failed";
      const errorMap: Record<string, string> = {
        NotVerified: "zk-X509 identity not verified. Please register your identity first.",
        AlreadyRegistered: "This address is already registered as a relayer.",
        InsufficientBond: `Insufficient bond. Minimum: ${ethers.formatEther(minBond)} ETH`,
        FeeTooHigh: "Fee too high. Maximum: 500 bps (5%).",
        "Invalid bond": "Invalid bond amount. Enter a valid ETH value.",
      };
      const matched = Object.entries(errorMap).find(([key]) => msg.includes(key));
      setErrorMsg(matched ? matched[1] : msg);
      setStatus("error");
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
          <UserPlus className="w-7 h-7 text-primary" />
          Relayer Registration
        </h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">
          Register as a relayer to match private orders and earn fees
        </p>
      </div>

      <div className="max-w-xl space-y-6">
        {/* Step 1: Identity Verification Status */}
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-6">
          <h3 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Step 1: zk-X509 Identity Verification
          </h3>

          {status === "not-connected" && (
            <div className="flex items-center gap-2 text-sm text-on-surface-variant">
              <AlertCircle className="w-4 h-4" />
              Connect your wallet to check verification status
            </div>
          )}

          {status === "checking" && (
            <div className="flex items-center gap-2 text-sm text-on-surface-variant">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking identity status...
            </div>
          )}

          {isVerified && (
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle className="w-4 h-4" />
              Verified until {new Date(verifiedUntil * 1000).toLocaleDateString()}
            </div>
          )}

          {status === "not-verified" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-error">
                <XCircle className="w-4 h-4" />
                Not verified
              </div>
              <p className="text-xs text-on-surface-variant">
                You must register your identity via zk-X509 before becoming a relayer.
                This requires a valid X.509 certificate from a trusted CA.
              </p>
            </div>
          )}
        </div>

        {/* Step 2: Registration Form */}
        {(status === "ready" || status === "submitting" || status === "error") && (
          <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-6">
            <h3 className="text-sm font-semibold text-on-surface flex items-center gap-2 mb-4">
              <UserPlus className="w-4 h-4 text-primary" />
              Step 2: Register as Relayer
            </h3>

            <div className="space-y-4">
              {/* URL */}
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                  Relayer Service URL
                </label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-relayer.example.com"
                  className="w-full px-4 py-2.5 rounded-lg bg-surface border border-outline-variant/20 text-sm text-on-surface placeholder:text-on-surface-variant/30 focus:border-primary focus:outline-none font-mono"
                />
                <p className="text-[10px] text-on-surface-variant/50 mt-1">
                  Your relayer API endpoint. Must be publicly accessible for order matching.
                </p>
              </div>

              {/* Fee */}
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                  Fee (basis points)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    value={feeBps}
                    onChange={(e) => setFeeBps(e.target.value)}
                    min="0"
                    max="500"
                    className="w-32 px-4 py-2.5 rounded-lg bg-surface border border-outline-variant/20 text-sm text-on-surface focus:border-primary focus:outline-none font-mono"
                  />
                  <span className="text-xs text-on-surface-variant">
                    = {(Number(feeBps) / 100).toFixed(2)}% per trade (max 5%)
                  </span>
                </div>
              </div>

              {/* Bond */}
              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1.5">
                  Bond (ETH)
                </label>
                <input
                  type="text"
                  value={bondEth}
                  onChange={(e) => setBondEth(e.target.value)}
                  className="w-32 px-4 py-2.5 rounded-lg bg-surface border border-outline-variant/20 text-sm text-on-surface focus:border-primary focus:outline-none font-mono"
                />
                {minBond > 0n && (
                  <p className="text-[10px] text-on-surface-variant/50 mt-1">
                    Minimum bond: {ethers.formatEther(minBond)} ETH
                  </p>
                )}
              </div>

              {/* Error */}
              {errorMsg && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-error-container/10 border border-error/20 text-error text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {/* Submit */}
              <button
                onClick={handleRegister}
                disabled={!url || status === "submitting"}
                className="w-full py-3 gradient-btn text-on-primary-fixed rounded-lg font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {status === "submitting" ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Registering...
                  </span>
                ) : (
                  "Register Relayer"
                )}
              </button>
            </div>
          </div>
        )}

        {/* Already registered */}
        {status === "already-registered" && (
          <div className="bg-surface-container rounded-xl border border-primary/20 p-6">
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle className="w-4 h-4" />
              You are already registered as a relayer
            </div>
          </div>
        )}

        {/* Success */}
        {status === "success" && (
          <div className="bg-surface-container rounded-xl border border-primary/20 p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle className="w-5 h-5" />
              Registration successful!
            </div>
            {txHash && (
              <p className="text-xs font-mono text-on-surface-variant break-all">
                TX: {txHash}
              </p>
            )}
            <p className="text-xs text-on-surface-variant">
              Your relayer is now active. Start your relayer service at the registered URL
              to begin matching orders.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
