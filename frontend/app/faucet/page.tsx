"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { Droplet, AlertTriangle } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { getReadProvider } from "../lib/provider";
import { getTokenList } from "../lib/tokens";
import { ERC20_ABI } from "../lib/contracts";
import { EXPECTED_CHAIN_ID } from "../lib/config";
import { shortenAddress } from "../lib/utils";

const LOCAL_CHAIN_ID = 31337;

type RequestState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; ethTxHash: string; usdcTxHash: string }
  | { kind: "error"; message: string };

export default function FaucetPage() {
  const { account } = useWallet();
  const [address, setAddress] = useState("");
  const [state, setState] = useState<RequestState>({ kind: "idle" });

  const [ethBalance, setEthBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");

  const usdcToken = useMemo(
    () => getTokenList().find((t) => t.symbol.toUpperCase() === "USDC" && !t.isNative) ?? null,
    [],
  );

  const isLocal = EXPECTED_CHAIN_ID === LOCAL_CHAIN_ID;
  const target = address || account || "";
  const targetValid = ethers.isAddress(target);

  const refreshBalances = useCallback(async () => {
    if (!targetValid) {
      setEthBalance("—");
      setUsdcBalance("—");
      return;
    }
    const provider = getReadProvider();
    try {
      const usdcContract = usdcToken
        ? new ethers.Contract(usdcToken.address, ERC20_ABI, provider)
        : null;
      const [eth, usdc] = await Promise.all([
        provider.getBalance(target),
        usdcContract ? usdcContract.balanceOf(target) : Promise.resolve(0n),
      ]);
      setEthBalance(Number(ethers.formatEther(eth)).toFixed(4));
      if (usdcToken) {
        setUsdcBalance(Number(ethers.formatUnits(usdc as bigint, usdcToken.decimals)).toFixed(2));
      }
    } catch (e) {
      console.warn("[faucet] balance refresh failed:", e);
      setEthBalance("—");
      setUsdcBalance("—");
    }
  }, [target, targetValid, usdcToken]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  async function handleClaim() {
    if (!targetValid) {
      setState({ kind: "error", message: "Enter a valid address." });
      return;
    }
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: target }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setState({ kind: "error", message: data.error || `Request failed (${res.status})` });
        return;
      }
      setState({ kind: "success", ethTxHash: data.eth.txHash, usdcTxHash: data.usdc.txHash });
      refreshBalances();
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "Network error",
      });
    }
  }

  return (
    <div className="pt-28 pb-32 px-6 max-w-[720px] mx-auto">
      <div className="text-center mb-10">
        <Droplet className="w-12 h-12 text-primary mx-auto mb-4" />
        <h1 className="text-3xl font-headline font-bold text-on-surface mb-3">Local Faucet</h1>
        <p className="text-on-surface-variant">
          Drip test ETH and USDC on the local anvil chain for development and E2E testing.
        </p>
      </div>

      {!isLocal && (
        <div className="rounded-xl border border-error/30 bg-error/10 p-4 flex items-center gap-3 mb-8">
          <AlertTriangle className="w-5 h-5 text-error" />
          <span className="text-sm text-error">
            Faucet is disabled on chain {EXPECTED_CHAIN_ID}. Switch to localhost ({LOCAL_CHAIN_ID}).
          </span>
        </div>
      )}

      <div className="rounded-2xl border border-outline-variant/10 bg-surface-container p-6 md:p-8">
        <label className="block text-xs font-mono text-on-surface-variant mb-2">
          Recipient address
        </label>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder={account || "0x…"}
          className="w-full bg-surface border border-outline-variant/20 rounded-md px-4 py-3 font-mono text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
          disabled={!isLocal}
        />
        {!address && account && (
          <p className="text-xs text-on-surface-variant mt-2">
            Using connected wallet: <span className="font-mono">{shortenAddress(account)}</span>
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 mt-6">
          <div className="rounded-md bg-surface px-4 py-3">
            <div className="text-[10px] font-mono text-on-surface-variant uppercase">ETH balance</div>
            <div className="text-lg font-mono text-on-surface mt-1">{ethBalance}</div>
          </div>
          <div className="rounded-md bg-surface px-4 py-3">
            <div className="text-[10px] font-mono text-on-surface-variant uppercase">USDC balance</div>
            <div className="text-lg font-mono text-on-surface mt-1">{usdcBalance}</div>
          </div>
        </div>

        <button
          onClick={handleClaim}
          disabled={!isLocal || state.kind === "loading" || !targetValid}
          className="w-full mt-6 gradient-btn text-on-primary-fixed px-5 py-3 rounded-md font-semibold text-sm active:scale-95 duration-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state.kind === "loading" ? "Sending…" : "Drip 10 ETH + 10,000 USDC"}
        </button>

        {state.kind === "error" && (
          <div className="mt-4 text-sm text-error">{state.message}</div>
        )}
        {state.kind === "success" && (
          <div className="mt-4 space-y-2">
            <div className="text-sm text-tertiary">
              Sent 10 ETH + 10,000 USDC to {shortenAddress(target)}
            </div>
            <div className="text-xs font-mono text-on-surface-variant space-y-1">
              <div>ETH tx: {state.ethTxHash}</div>
              <div>USDC tx: {state.usdcTxHash}</div>
            </div>
          </div>
        )}
      </div>

      <p className="text-xs text-on-surface-variant text-center mt-6">
        Rate-limited to 3 requests per hour per IP. Localhost only.
      </p>
    </div>
  );
}
