"use client";

import { useState, useEffect, useCallback } from "react";
import { UserPlus, ShieldCheck, AlertCircle, Loader2, CheckCircle, XCircle } from "lucide-react";
import {
  approveBondToken,
  explainRegistryError,
  loadRegistrationStatus,
  MAX_RELAYER_FEE_BPS,
  NATIVE_BOND_TOKEN,
  needsBondApproval,
  registerRelayer,
  type RegistrationStatus,
} from "@zkscatter/sdk/relayer";
import { useWallet } from "../../lib/wallet";
import { getRelayerRegistryAddress } from "../../lib/config";
import { getReadProvider } from "../../lib/provider";

type Phase = "idle" | "checking" | "not-connected" | "not-verified" | "already-registered" | "ready" | "approving" | "submitting" | "success" | "error";

export default function RelayerRegisterPage() {
  const { account, signer } = useWallet();

  const [phase, setPhase] = useState<Phase>("idle");
  const [isVerified, setIsVerified] = useState(false);
  const [verifiedUntil, setVerifiedUntil] = useState<number>(0);
  const [minBond, setMinBond] = useState<bigint>(0n);
  const [minBondEth, setMinBondEth] = useState<string>("");
  const [bondToken, setBondToken] = useState<string>(NATIVE_BOND_TOKEN);
  const [bondAllowance, setBondAllowance] = useState<bigint>(0n);
  const [errorMsg, setErrorMsg] = useState("");
  const [txHash, setTxHash] = useState("");

  const [url, setUrl] = useState("");
  const [feeBps, setFeeBps] = useState("30");
  const [bondEth, setBondEth] = useState("0.1");

  const checkStatus = useCallback(async () => {
    // Reset derived state up front so a disconnect / account switch
    // never leaves a stale "Verified until …" / minimum bond /
    // error banner from the prior account visible on screen.
    setIsVerified(false);
    setVerifiedUntil(0);
    setMinBond(0n);
    setMinBondEth("");
    setErrorMsg("");

    if (!account) {
      setPhase("not-connected");
      return;
    }
    setPhase("checking");
    try {
      const status = await loadRegistrationStatus(getRelayerRegistryAddress(), account, getReadProvider());
      setIsVerified(status.isVerified);
      setVerifiedUntil(status.verifiedUntil);
      setMinBond(status.minBond);
      setMinBondEth(status.minBondEth);
      setBondToken(status.bondToken);
      setBondAllowance(status.bondAllowance);
      if (!status.isVerified) setPhase("not-verified");
      else if (status.alreadyRegistered) setPhase("already-registered");
      else setPhase("ready");
    } catch (err: unknown) {
      console.error("Failed to load registration status", err);
      setErrorMsg(err instanceof Error ? err.message : "Failed to check status");
      setPhase("error");
    }
  }, [account]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleRegister = async () => {
    if (!account) return;
    // `account` can be set without a signer when wallet.tsx fails to
    // attach one (e.g. injected provider lost the request handler).
    // Surface that as an error instead of a silent no-op click.
    if (!signer) {
      setErrorMsg("Wallet signer is unavailable. Reconnect your wallet and try again.");
      setPhase("error");
      return;
    }
    setErrorMsg("");
    try {
      // ERC20 mode: pre-approve the registry if existing allowance
      // is insufficient. Native mode skips this entirely.
      const status: RegistrationStatus = {
        isVerified, verifiedUntil, alreadyRegistered: false,
        minBond, minBondEth,
        bondToken, isErc20Bond: bondToken !== NATIVE_BOND_TOKEN, bondAllowance,
      };
      if (needsBondApproval(status, bondEth)) {
        setPhase("approving");
        const approveTx = await approveBondToken(bondToken, getRelayerRegistryAddress(), bondEth, signer);
        await approveTx.wait();
      }
      setPhase("submitting");
      const tx = await registerRelayer(
        getRelayerRegistryAddress(),
        { url, feeBps: parseInt(feeBps, 10), bondEth, bondToken },
        signer,
      );
      const receipt = await tx.wait();
      setTxHash(receipt?.hash ?? tx.hash);
      setPhase("success");
    } catch (err: unknown) {
      console.error("Registration failed", err);
      setErrorMsg(explainRegistryError(err, minBond));
      setPhase("error");
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

          {phase === "not-connected" && (
            <div className="flex items-center gap-2 text-sm text-on-surface-variant">
              <AlertCircle className="w-4 h-4" />
              Connect your wallet to check verification status
            </div>
          )}

          {phase === "checking" && (
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

          {phase === "not-verified" && (
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
        {(phase === "ready" || phase === "submitting" || phase === "error") && (
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
                    max={MAX_RELAYER_FEE_BPS}
                    className="w-32 px-4 py-2.5 rounded-lg bg-surface border border-outline-variant/20 text-sm text-on-surface focus:border-primary focus:outline-none font-mono"
                  />
                  <span className="text-xs text-on-surface-variant">
                    = {(Number(feeBps) / 100).toFixed(2)}% per trade (max {(MAX_RELAYER_FEE_BPS / 100).toFixed(0)}%)
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
                {minBondEth && (
                  <p className="text-[10px] text-on-surface-variant/50 mt-1">
                    Minimum bond: {minBondEth} ETH
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
                disabled={!url || phase === "submitting"}
                className="w-full py-3 gradient-btn text-on-primary-fixed rounded-lg font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {phase === "submitting" ? (
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
        {phase === "already-registered" && (
          <div className="bg-surface-container rounded-xl border border-primary/20 p-6">
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle className="w-4 h-4" />
              You are already registered as a relayer
            </div>
          </div>
        )}

        {/* Success */}
        {phase === "success" && (
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
