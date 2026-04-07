"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { ShieldCheck, AlertCircle, Loader2, CheckCircle, XCircle, ExternalLink } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { getIdentityGateAddress, getZkX509Url } from "../lib/config";
import { IDENTITY_GATE_ABI } from "../lib/contracts";
import { getReadProvider } from "../lib/provider";

type Status = "idle" | "checking" | "verified" | "not-verified" | "error";

export default function IdentityPage() {
  const { account } = useWallet();
  const [status, setStatus] = useState<Status>("idle");
  const [verifiedUntil, setVerifiedUntil] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState("");

  const checkIdentity = useCallback(async () => {
    if (!account) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    try {
      const provider = getReadProvider();
      const gate = new ethers.Contract(getIdentityGateAddress(), IDENTITY_GATE_ABI, provider);
      const verified = await gate.isVerified(account);
      if (verified) {
        const until = await gate.verifiedUntil(account);
        setVerifiedUntil(Number(until));
        setStatus("verified");
      } else {
        setStatus("not-verified");
      }
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to check identity");
      setStatus("error");
    }
  }, [account]);

  useEffect(() => { checkIdentity(); }, [checkIdentity]);

  const zkX509Url = getZkX509Url();

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)] px-6">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center mb-8">
          <ShieldCheck className="w-12 h-12 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-headline font-bold text-on-surface">Identity Verification</h1>
          <p className="text-sm text-on-surface-variant mt-2">
            zkScatter requires zk-X509 identity verification for trading and relayer operations.
          </p>
        </div>

        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-6">
          {!account && (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-on-surface-variant/40 mx-auto mb-3" />
              <p className="text-sm text-on-surface-variant">Connect your wallet to check verification status</p>
            </div>
          )}

          {status === "checking" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-on-surface-variant">
              <Loader2 className="w-5 h-5 animate-spin" />
              Checking identity...
            </div>
          )}

          {status === "verified" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-6 h-6 text-primary" />
                <div>
                  <p className="text-sm font-semibold text-primary">Verified</p>
                  <p className="text-xs text-on-surface-variant">
                    Valid until {new Date(verifiedUntil * 1000).toLocaleDateString("en-US", {
                      year: "numeric", month: "long", day: "numeric",
                    })}
                  </p>
                </div>
              </div>
              <div className="bg-surface rounded-lg p-4 text-xs text-on-surface-variant">
                <p>Your wallet is verified via zk-X509. You can:</p>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  <li>Deposit assets into the commitment pool</li>
                  <li>Create and settle private orders</li>
                  <li>Register as a relayer</li>
                </ul>
              </div>
            </div>
          )}

          {status === "not-verified" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <XCircle className="w-6 h-6 text-error" />
                <div>
                  <p className="text-sm font-semibold text-error">Not Verified</p>
                  <p className="text-xs text-on-surface-variant">
                    Your wallet has not been registered with zk-X509.
                  </p>
                </div>
              </div>
              <div className="bg-surface rounded-lg p-4 text-xs text-on-surface-variant space-y-3">
                <p>
                  To use zkScatter, you need to verify your identity through the zk-X509 system.
                  This is a one-time process using your X.509 certificate from a trusted Certificate Authority.
                </p>
                <p>
                  Your privacy is preserved — zk-X509 uses zero-knowledge proofs to verify
                  your certificate without revealing personal information on-chain.
                </p>
              </div>
              <a
                href={zkX509Url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 w-full py-3 gradient-btn text-on-primary-fixed rounded-lg font-semibold text-sm transition-all"
              >
                Register via zk-X509
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          )}

          {status === "error" && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-error-container/10 border border-error/20 text-error text-xs">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
