"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { signGaslessClaim, toSecretBytes } from "@/lib/signing";
import { SETTLEMENT_ABI } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS } from "@/lib/config";

const DEFAULT_DEADLINE_SECONDS = 3600; // 1 hour from now

export default function GaslessClaimForm() {
  const { account, signer, readProvider, chainId } = useWallet();
  const [secret, setSecret] = useState("");
  const [relayerAddress, setRelayerAddress] = useState("");
  const [relayerTip, setRelayerTip] = useState("0.5"); // human-readable token amount
  const [status, setStatus] = useState<"idle" | "signing" | "preview" | "error">("idle");
  const [signedRequest, setSignedRequest] = useState<{
    secret: string;
    recipient: string;
    relayer: string;
    relayerTip: string;
    deadline: number;
    signature: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleSign = async () => {
    if (!signer || !account || !chainId) return;
    setStatus("signing");
    setError("");

    try {
      if (!secret) throw new Error("Secret is required");
      if (!ethers.isAddress(relayerAddress)) throw new Error("Invalid relayer address");

      // Check claim exists and is claimable
      if (readProvider) {
        const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);
        const secretBytes = toSecretBytes(secret);
        const claimHash = ethers.keccak256(
          ethers.solidityPacked(["bytes32", "address"], [secretBytes, account])
        );
        const [, releaseTime, claimed, , amount] = await settlement.schedules(claimHash);
        if (amount === BigInt(0)) throw new Error("No claim found for this secret + your address");
        if (claimed) throw new Error("Already claimed");
        if (Math.floor(Date.now() / 1000) < Number(releaseTime)) throw new Error("Claim not yet unlocked");

        // Get gasless nonce
        const nonce = await settlement.gaslessNonces(account);
        const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS;
        const tipWei = ethers.parseEther(relayerTip).toString();

        const signature = await signGaslessClaim(
          signer,
          {
            secret,
            recipient: account,
            relayer: relayerAddress,
            relayerTip: tipWei,
            deadline,
            nonce: Number(nonce),
          },
          chainId,
          SETTLEMENT_ADDRESS
        );

        setSignedRequest({
          secret: toSecretBytes(secret),
          recipient: account,
          relayer: relayerAddress,
          relayerTip: tipWei,
          deadline,
          signature,
        });
        setStatus("preview");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Signing failed");
      setStatus("error");
    }
  };

  const copyRequest = () => {
    if (!signedRequest) return;
    navigator.clipboard.writeText(JSON.stringify(signedRequest, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!account) return <p className="text-gray-500 text-sm">Connect wallet to use gasless claim</p>;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Gasless Claim (Mode B)</h2>
      <p className="text-xs text-gray-500">
        Sign a claim request off-chain. A gas payer will submit it for you.
        No ETH needed in this wallet.
      </p>

      <input
        type="password"
        placeholder="Secret (from sender's claim link)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <input
        placeholder="Gas payer address (relayer 0x...)"
        value={relayerAddress}
        onChange={(e) => setRelayerAddress(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <div className="flex items-center gap-2">
        <input
          placeholder="Tip amount"
          value={relayerTip}
          onChange={(e) => setRelayerTip(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
        />
        <span className="text-xs text-gray-500">tokens (gas compensation)</span>
      </div>

      <button
        onClick={handleSign}
        disabled={status === "signing"}
        className="w-full bg-purple-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-purple-500 disabled:opacity-50 transition"
      >
        {status === "signing" ? "Signing..." : "Sign Gasless Claim Request"}
      </button>

      {status === "preview" && signedRequest && (
        <div className="bg-gray-800 rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-medium text-green-400">Signed! Send this to the gas payer:</h3>
          <pre className="bg-gray-900 rounded p-3 text-xs text-gray-300 font-mono overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(signedRequest, null, 2)}
          </pre>
          <button
            onClick={copyRequest}
            className="w-full bg-gray-700 text-white py-2 rounded-lg text-sm hover:bg-gray-600 transition"
          >
            {copied ? "Copied!" : "Copy to Clipboard"}
          </button>
          <p className="text-xs text-gray-500">
            The gas payer calls claimReleaseFor() with this data.
            Expires in {DEFAULT_DEADLINE_SECONDS / 60} minutes.
          </p>
        </div>
      )}

      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
