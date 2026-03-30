"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { toSecretBytes } from "@/lib/signing";
import { SETTLEMENT_ABI } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS, RPC_URL } from "@/lib/config";
import { stealthWallet } from "@/lib/stealth";

// Reuse a single provider instance to avoid creating a new one on every claim
const stealthProvider = new ethers.JsonRpcProvider(RPC_URL);

interface ClaimPreview {
  token: string;
  amount: string;
  releaseTime: number;
  claimed: boolean;
  status: "claimable" | "locked" | "claimed" | "not_found";
}

function ClaimListInner() {
  const { account, signer, readProvider } = useWallet();
  const searchParams = useSearchParams();
  const [secret, setSecret] = useState("");
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "claiming" | "success" | "error">("idle");
  const [error, setError] = useState("");

  // Stealth address support
  const [ephemeralPubKey, setEphemeralPubKey] = useState("");
  const [spendingKey, setSpendingKey] = useState("");
  const [viewingKey, setViewingKey] = useState("");
  const [stealthMode, setStealthMode] = useState(false);
  const [stealthAddr, setStealthAddr] = useState("");

  // Auto-fill from URL parameters (?secret=0x...&epk=0x...)
  useEffect(() => {
    const urlSecret = searchParams.get("secret");
    const urlEpk = searchParams.get("epk");
    if (urlSecret) setSecret(urlSecret);
    if (urlEpk) {
      setEphemeralPubKey(urlEpk);
      setStealthMode(true);
    }
  }, [searchParams]);

  // Preview claim status with debounce to avoid excessive RPC calls
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // Determine claim address: stealth address or connected wallet
    let claimAddress: string | null = null;
    if (stealthMode && spendingKey && viewingKey && ephemeralPubKey) {
      try {
        const w = stealthWallet(spendingKey, viewingKey, ephemeralPubKey);
        claimAddress = w.address;
        setStealthAddr(w.address);
      } catch (err) {
        console.error("Failed to derive stealth wallet:", err);
        setStealthAddr("");
      }
    } else if (!stealthMode) {
      claimAddress = account;
    }

    if (!secret || !claimAddress || !readProvider) {
      setPreview(null);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);
        const secretBytes = toSecretBytes(secret);
        const claimHash = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "address"], [secretBytes, claimAddress!])
        );

        const [token, releaseTime, claimed, , amount] = await settlement.schedules(claimHash);

        if (amount === BigInt(0)) {
          setPreview({ token: "", amount: "0", releaseTime: 0, claimed: false, status: "not_found" });
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const rt = Number(releaseTime);
        let claimStatus: ClaimPreview["status"];
        if (claimed) claimStatus = "claimed";
        else if (now >= rt) claimStatus = "claimable";
        else claimStatus = "locked";

        setPreview({
          token,
          // TODO: fetch token decimals for accurate display (assumes 18 for now)
          amount: ethers.formatEther(amount),
          releaseTime: rt,
          claimed,
          status: claimStatus,
        });
      } catch (err) {
        console.error("Failed to fetch claim preview:", err);
        setPreview(null);
      }
    }, 500);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [secret, account, readProvider, stealthMode, spendingKey, viewingKey, ephemeralPubKey]);

  const handleClaim = async () => {
    setStatus("claiming");
    setError("");

    try {
      if (!secret) throw new Error("Secret is required");

      let claimSigner: ethers.Signer;
      if (stealthMode) {
        if (!spendingKey || !viewingKey || !ephemeralPubKey) {
          throw new Error("Stealth claim requires spending key, viewing key, and ephemeral public key");
        }
        claimSigner = stealthWallet(spendingKey, viewingKey, ephemeralPubKey, stealthProvider);
      } else {
        if (!signer) throw new Error("Wallet not connected");
        claimSigner = signer;
      }

      const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, claimSigner);
      const tx = await settlement.claimRelease(toSecretBytes(secret));
      await tx.wait();
      setStatus("success");
      setSecret("");
      setPreview(null);
    } catch (err: unknown) {
      const e = err as { reason?: string; message?: string };
      setError(e.reason || e.message || "Claim failed");
      setStatus("error");
    }
  };

  const timeRemaining = (releaseTime: number) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = releaseTime - now;
    if (diff <= 0) return "Now";
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  if (!account && !stealthMode) return <p className="text-gray-500 text-sm">Connect wallet to claim, or use a stealth claim link</p>;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Claim Funds</h2>

      <input
        type="password"
        placeholder="Secret (from sender's claim link)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      {/* Stealth address mode */}
      {stealthMode && (
        <div className="bg-gray-800 rounded-lg p-3 space-y-2">
          <p className="text-xs text-blue-400 font-medium">Stealth Address Claim</p>
          <input
            type="password"
            placeholder="Spending key"
            value={spendingKey}
            onChange={(e) => setSpendingKey(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600"
          />
          <input
            type="password"
            placeholder="Viewing key"
            value={viewingKey}
            onChange={(e) => setViewingKey(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600"
          />
          {stealthAddr && (
            <p className="text-xs text-gray-500">Stealth address: {stealthAddr.slice(0, 10)}...{stealthAddr.slice(-8)}</p>
          )}
          <p className="text-xs text-gray-600">Stealth address has no ETH — you may need to fund it with gas before claiming. Gasless stealth claiming is not yet supported.</p>
        </div>
      )}

      {!stealthMode && (
        <button
          onClick={() => setStealthMode(true)}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          Claiming with stealth address?
        </button>
      )}

      {/* Claim Preview */}
      {preview && preview.status !== "not_found" && (
        <div className="bg-gray-800 rounded-lg p-3 space-y-1">
          <p className="text-xs text-gray-400">Claim Preview</p>
          <p className="text-sm text-white">{preview.amount} tokens</p>
          <p className="text-xs text-gray-500">Token: {preview.token.slice(0, 10)}...</p>
          <p className={`text-xs ${
            preview.status === "claimable" ? "text-green-400" :
            preview.status === "locked" ? "text-blue-400" :
            "text-gray-400"
          }`}>
            {preview.status === "claimable" && "Ready to claim!"}
            {preview.status === "locked" && `Unlocks in ${timeRemaining(preview.releaseTime)}`}
            {preview.status === "claimed" && "Already claimed"}
          </p>
        </div>
      )}
      {preview && preview.status === "not_found" && (
        <p className="text-xs text-yellow-400">No claim found for this secret + your address</p>
      )}

      <button
        onClick={handleClaim}
        disabled={status === "claiming" || (preview !== null && preview.status !== "claimable") || (stealthMode && (!spendingKey || !viewingKey || !ephemeralPubKey))}
        className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-500 disabled:opacity-50 transition"
      >
        {status === "claiming" ? "Claiming..." : "Claim"}
      </button>

      {status === "success" && <p className="text-green-400 text-sm">Claimed successfully!</p>}
      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}

export default function ClaimList() {
  return (
    <Suspense fallback={<p className="text-gray-500 text-sm">Loading...</p>}>
      <ClaimListInner />
    </Suspense>
  );
}
