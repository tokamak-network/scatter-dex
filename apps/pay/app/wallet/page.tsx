"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  ERC20_ABI,
  formatTokenLabel,
  type WhitelistedToken,
} from "@zkscatter/sdk";
import { shortAddr, useMounted, useWallet } from "@zkscatter/sdk/react";
import { WorkspaceBar } from "../_components/WorkspaceBar";
import { getNetworkConfig } from "../_lib/network";
import { SendModal } from "./_SendModal";
import type { BalanceRow } from "./_types";

const ZERO = "0x0000000000000000000000000000000000000000";

export default function WalletPage() {
  // `getNetworkConfig()` returns a freshly-built object every call;
  // memoise so identity-stable cfg pieces can drive effect deps
  // without retriggering on every render.
  const cfg = useMemo(() => getNetworkConfig(), []);
  const { account, signer } = useWallet();
  const mounted = useMounted();
  const [rows, setRows] = useState<BalanceRow[]>(() => initialRows(cfg.tokens));
  const [sendingFor, setSendingFor] = useState<BalanceRow | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  // One JsonRpcProvider instance per cfg.rpcUrl — without this the
  // effect would spin up a fresh provider on every refresh tick and
  // every render, leaking sockets and racing pending requests.
  const provider = useMemo(
    () => new ethers.JsonRpcProvider(cfg.rpcUrl),
    [cfg.rpcUrl],
  );

  useEffect(() => {
    if (!mounted || !account) return;
    let cancelled = false;
    void (async () => {
      const next = await Promise.all(
        cfg.tokens.map(async (token): Promise<BalanceRow> => {
          try {
            if (token.isNative) {
              const raw = await provider.getBalance(account);
              return { token, address: ZERO, raw, loading: false, error: null };
            }
            if (!token.address || token.address === ZERO) {
              return {
                token,
                address: ZERO,
                raw: 0n,
                loading: false,
                error: "address not configured",
              };
            }
            const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
            const raw = (await erc20.balanceOf(account)) as bigint;
            return { token, address: token.address, raw, loading: false, error: null };
          } catch (err) {
            return {
              token,
              address: token.address,
              raw: 0n,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      if (!cancelled) setRows(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [mounted, account, cfg.rpcUrl, cfg.tokens, tick]);

  if (!account) {
    return (
      <div className="space-y-4">
        <Crumb />
        <WorkspaceBar />
        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
          Connect a wallet from the header to see your balances.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Crumb />
      <WorkspaceBar />
      <header className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          Connected wallet
        </div>
        <div className="mt-1 font-mono text-sm">{account}</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Chain {cfg.chainId} · {cfg.name ?? `Chain ${cfg.chainId}`}
        </div>
        <div className="mt-3 flex gap-2 text-xs">
          <button
            onClick={refresh}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 hover:bg-[var(--color-primary-soft)]"
          >
            Refresh balances
          </button>
        </div>
      </header>

      <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-4 py-2 text-left">Token</th>
              <th className="px-4 py-2 text-right">Balance</th>
              <th className="px-4 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const hasBalance = r.raw > 0n && !r.error;
              return (
                <tr key={r.token.symbol} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-3">
                    <div className="font-medium">{formatTokenLabel(r.token.symbol)}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {r.token.name}
                      {r.address !== ZERO && (
                        <>
                          {" · "}
                          <span className="font-mono">{shortAddr(r.address)}</span>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {r.error ? (
                      <span
                        title={r.error}
                        className="text-[var(--color-warning)]"
                      >
                        {r.error === "address not configured" ? "—" : "err"}
                      </span>
                    ) : r.loading ? (
                      "…"
                    ) : (
                      ethers.formatUnits(r.raw, r.token.decimals)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={!hasBalance || !signer}
                      onClick={() => setSendingFor(r)}
                      title={
                        !signer
                          ? "Connect a wallet to send"
                          : !hasBalance
                            ? "Zero balance — nothing to send"
                            : "Send to a recipient"
                      }
                      className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
                    >
                      Send
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <p className="text-xs text-[var(--color-text-muted)]">
        Balances are read live from {cfg.rpcUrl} via the connected wallet&apos;s
        address. Sending opens a transfer modal — ERC-20 tokens can optionally
        route through the operator&apos;s relayer (gasless via EIP-7702) when
        configured; ETH is wallet-paid only.
      </p>

      {sendingFor && (
        <SendModal
          row={sendingFor}
          onClose={() => {
            setSendingFor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Crumb() {
  return (
    <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
      <Link href="/dashboard" className="hover:text-[var(--color-text)]">
        Dashboard
      </Link>
      <span>/</span>
      <span>Wallet</span>
    </div>
  );
}

function initialRows(tokens: WhitelistedToken[]): BalanceRow[] {
  return tokens.map((token) => ({
    token,
    address: token.address,
    raw: 0n,
    loading: true,
    error: null,
  }));
}
