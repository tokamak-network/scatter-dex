"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract } from "ethers";
import { ZERO_ADDRESS, eqAddr } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const POOL_ABI = [
  "function setTokenWhitelist(address token, bool allowed) external",
  "function whitelistedTokens(address token) external view returns (bool)",
];

const SETTLEMENT_ABI = POOL_ABI;

interface Props {
  poolAddress: string;
  settlementAddress: string;
}

/** Shared whitelist editor — writes to both CommitmentPool and
 *  PrivateSettlement so the two mappings stay in lockstep. Callers
 *  pick which contracts to apply via the checkboxes. */
export function TokenWhitelistEditor({ poolAddress, settlementAddress }: Props) {
  const { signer, readProvider } = useWallet();
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState(true);
  const [applyPool, setApplyPool] = useState(true);
  const [applySettlement, setApplySettlement] = useState(true);
  const [readState, setReadState] = useState<{
    pool: boolean | null;
    settlement: boolean | null;
  }>({ pool: null, settlement: null });
  const [reloadKey, setReloadKey] = useState(0);

  // Both contracts revert on token == address(0), so reject that
  // explicitly rather than letting an obvious revert reach the user.
  const trimmed = token.trim();
  const valid = isValidEvmAddress(trimmed) && !eqAddr(trimmed, ZERO_ADDRESS);

  useEffect(() => {
    if (!valid) {
      setReadState({ pool: null, settlement: null });
      return;
    }
    let cancelled = false;
    const pool = new Contract(poolAddress, POOL_ABI, readProvider);
    const settlement = new Contract(settlementAddress, SETTLEMENT_ABI, readProvider);
    void Promise.allSettled([
      pool.whitelistedTokens(trimmed) as Promise<boolean>,
      settlement.whitelistedTokens(trimmed) as Promise<boolean>,
    ]).then(([p, s]) => {
      if (cancelled) return;
      setReadState({
        pool: p.status === "fulfilled" ? p.value : null,
        settlement: s.status === "fulfilled" ? s.value : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [token, valid, poolAddress, settlementAddress, readProvider, reloadKey]);

  const submit = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    // We submit *both* writes serially when both checkboxes are
    // selected. ethers returns the first tx so the AdminWriteCard's
    // confirmation banner reflects the Pool write; the Settlement
    // write also completes before we resolve.
    let firstTx: { hash: string; wait(): Promise<{ hash?: string } | null> } | null = null;
    if (applyPool) {
      const pool = new Contract(poolAddress, POOL_ABI, signer);
      const tx = (await pool.setTokenWhitelist(trimmed, allowed)) as {
        hash: string;
        wait(): Promise<{ hash?: string } | null>;
      };
      firstTx = tx;
      await tx.wait();
    }
    if (applySettlement) {
      const settlement = new Contract(settlementAddress, SETTLEMENT_ABI, signer);
      const tx = (await settlement.setTokenWhitelist(trimmed, allowed)) as {
        hash: string;
        wait(): Promise<{ hash?: string } | null>;
      };
      if (!firstTx) firstTx = tx;
      await tx.wait();
    }
    if (!firstTx) throw new Error("Select at least one target contract");
    return firstTx;
  }, [signer, valid, applyPool, applySettlement, token, allowed, poolAddress, settlementAddress]);

  const willChangePool = applyPool && readState.pool !== null && readState.pool !== allowed;
  const willChangeSettlement =
    applySettlement && readState.settlement !== null && readState.settlement !== allowed;

  return (
    <AdminWriteCard
      title="Token whitelist"
      description="Allow/deny an ERC20 across CommitmentPool + PrivateSettlement. Both contracts hold their own mapping; keep them in sync."
      submitLabel={allowed ? "Whitelist token" : "Remove from whitelist"}
      disabled={!valid || (!applyPool && !applySettlement)}
      onSubmit={submit}
      onSuccess={() => setReloadKey((k) => k + 1)}
    >
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Token address
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" checked={allowed} onChange={() => setAllowed(true)} /> Allow
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!allowed} onChange={() => setAllowed(false)} /> Disallow
        </label>
      </div>

      <div className="flex flex-wrap gap-4 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={applyPool}
            onChange={(e) => setApplyPool(e.target.checked)}
          />
          CommitmentPool ({shortAddr(poolAddress)})
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={applySettlement}
            onChange={(e) => setApplySettlement(e.target.checked)}
          />
          PrivateSettlement ({shortAddr(settlementAddress)})
        </label>
      </div>

      {valid && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <span>
              Pool current:{" "}
              <strong>
                {readState.pool === null ? "…" : readState.pool ? "Whitelisted" : "Not"}
              </strong>
              {willChangePool && (
                <span className="ml-1 text-[var(--color-primary)]">
                  → {allowed ? "Whitelist" : "Remove"}
                </span>
              )}
            </span>
            <span>
              Settlement current:{" "}
              <strong>
                {readState.settlement === null
                  ? "…"
                  : readState.settlement
                    ? "Whitelisted"
                    : "Not"}
              </strong>
              {willChangeSettlement && (
                <span className="ml-1 text-[var(--color-primary)]">
                  → {allowed ? "Whitelist" : "Remove"}
                </span>
              )}
            </span>
          </div>
        </div>
      )}
    </AdminWriteCard>
  );
}
