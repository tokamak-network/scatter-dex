"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract } from "ethers";
import { ZERO_ADDRESS, eqAddr } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function whitelistedDexRouters(address router) external view returns (bool)",
  "function dexPlatformFeeBps() external view returns (uint256)",
  "function feeVault() external view returns (address)",
  "function setDexRouterWhitelist(address _router, bool _allowed) external",
  "function setDexPlatformFee(uint256 _bps) external",
];

// Matches PrivateSettlement.MAX_DEX_PLATFORM_FEE_BPS in contracts.
const MAX_DEX_PLATFORM_FEE_BPS = 500;

export function DexControls({ address }: { address: string }) {
  return (
    <div className="space-y-4">
      <DexRouterEditor address={address} />
      <DexPlatformFeeEditor address={address} />
    </div>
  );
}

function DexRouterEditor({ address }: { address: string }) {
  const { signer, readProvider } = useWallet();
  const [input, setInput] = useState("");
  const [allowed, setAllowed] = useState(true);
  const [currentlyWhitelisted, setCurrentlyWhitelisted] = useState<boolean | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const trimmed = input.trim();
  const isZero = eqAddr(trimmed, ZERO_ADDRESS);
  // Contract reverts on zero address regardless of `allowed`; surface as invalid.
  const valid = isValidEvmAddress(trimmed) && !isZero;

  useEffect(() => {
    if (!valid) {
      setCurrentlyWhitelisted(null);
      return;
    }
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void c
      .whitelistedDexRouters(trimmed)
      .then((v: boolean) => {
        if (!cancelled) setCurrentlyWhitelisted(v);
      })
      .catch(() => {
        if (!cancelled) setCurrentlyWhitelisted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [trimmed, valid, address, readProvider, reloadKey]);

  const submit = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    const c = new Contract(address, ABI, signer);
    return (await c.setDexRouterWhitelist(trimmed, allowed)) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [signer, valid, address, trimmed, allowed]);

  return (
    <AdminWriteCard
      title="DEX router whitelist"
      description="PrivateSettlement.setDexRouterWhitelist(address, bool). Allow/disallow a router to receive DEX-mode settle calls. Allowed routers must be deployed contracts."
      submitLabel={allowed ? "Allow router" : "Disallow router"}
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        setReloadKey((k) => k + 1);
      }}
    >
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Router address
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" checked={allowed} onChange={() => setAllowed(true)} /> Allow
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!allowed} onChange={() => setAllowed(false)} /> Disallow
        </label>
      </div>
      {valid && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs">
          Current:{" "}
          <strong>
            {currentlyWhitelisted === null
              ? "…"
              : currentlyWhitelisted
                ? "Whitelisted"
                : "Not whitelisted"}
          </strong>
        </div>
      )}
    </AdminWriteCard>
  );
}

function DexPlatformFeeEditor({ address }: { address: string }) {
  const { signer, readProvider } = useWallet();
  const [current, setCurrent] = useState<bigint | null>(null);
  // setDexPlatformFee reverts with FeeVaultRequired() when bps > 0 and
  // feeVault is the zero address — surface that prerequisite in the UI
  // so the operator doesn't waste gas on a guaranteed revert.
  const [feeVault, setFeeVault] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void Promise.allSettled([
      c.dexPlatformFeeBps() as Promise<bigint>,
      c.feeVault() as Promise<string>,
    ]).then(([feeRes, vaultRes]) => {
      if (cancelled) return;
      setCurrent(feeRes.status === "fulfilled" ? feeRes.value : null);
      setFeeVault(vaultRes.status === "fulfilled" ? vaultRes.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  const bps = parseBps(input);
  const vaultUnset = feeVault != null && eqAddr(feeVault, ZERO_ADDRESS);
  const wouldRequireVault = bps !== null && bps > 0n && vaultUnset;
  const valid = bps !== null && !wouldRequireVault;

  const submit = useCallback(async () => {
    if (!signer || bps == null) throw new Error("Invalid bps");
    const c = new Contract(address, ABI, signer);
    return (await c.setDexPlatformFee(bps)) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [signer, bps, address]);

  return (
    <AdminWriteCard
      title="DEX platform fee"
      description={`PrivateSettlement.setDexPlatformFee(uint256). Cap is ${MAX_DEX_PLATFORM_FEE_BPS / 100}% (${MAX_DEX_PLATFORM_FEE_BPS} bps). Applied immediately — no timelock — so this is intentionally high-risk.`}
      submitLabel={`Set to ${input || "—"} bps`}
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        setReloadKey((k) => k + 1);
      }}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current:{" "}
        <strong>
          {current != null ? `${current.toString()} bps (${Number(current) / 100}%)` : "…"}
        </strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New fee (bps — 100 = 1%)
        </span>
        <input
          type="number"
          min={0}
          max={MAX_DEX_PLATFORM_FEE_BPS}
          className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          placeholder="0"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      {input && bps === null && (
        <p className="text-xs text-[var(--color-danger)]">
          Must be an integer in 0–{MAX_DEX_PLATFORM_FEE_BPS}.
        </p>
      )}
      {wouldRequireVault && (
        <p className="text-xs text-[var(--color-danger)]">
          FeeVault is not set on PrivateSettlement. setDexPlatformFee reverts with
          <code className="ml-1 font-mono">FeeVaultRequired()</code> when bps &gt; 0. Set the
          fee vault first (or use 0 bps).
        </p>
      )}
    </AdminWriteCard>
  );
}

function parseBps(input: string): bigint | null {
  if (!input.trim()) return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DEX_PLATFORM_FEE_BPS) return null;
  return BigInt(n);
}

