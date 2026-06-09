"use client";

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { formatUnits } from "ethers";
import { eqAddr, isConfiguredAddress, RELAYER_REGISTRY_ABI } from "@zkscatter/sdk";
import { shortAddr, useNetworkTokens, useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../../lib/network";

const ABI = RELAYER_REGISTRY_ABI;

interface RelayerRow {
  addr: string;
  name: string;
  url: string;
  feeBps: number;
  bond: bigint;
  bondToken: string;
  exitRequestedAt: number;
  active: boolean;
}

/** Read-only list of registered relayers with their bond (token + amount),
 *  fee, and exit status. Iterates `relayerList` so it surfaces both active and
 *  exiting relayers (a relayer stays `active` until `executeExit`). Each bond is
 *  shown in the token THAT relayer recorded at register time (per-relayer
 *  `bondToken`), formatted via the whitelist's decimals/symbol. Self-contained:
 *  reads the registry + exit cooldown itself off the connected wallet's
 *  read provider. */
export function RelayersTable({ address }: { address: string }) {
  const { readProvider } = useWallet();
  const { tokens } = useNetworkTokens(DEMO_NETWORK);
  const [rows, setRows] = useState<RelayerRow[] | null>(null);
  const [exitCooldown, setExitCooldown] = useState<bigint | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    (async () => {
      try {
        const [count, cooldown] = await Promise.all([
          c.getRelayerCount() as Promise<bigint>,
          c.exitCooldown() as Promise<bigint>,
        ]);
        const addrs = await Promise.all(
          Array.from({ length: Number(count) }, (_, i) => c.relayerList(i) as Promise<string>),
        );
        const all = await Promise.all(
          addrs.map(async (a): Promise<RelayerRow> => {
            const r = await c.relayers(a);
            return {
              addr: a,
              name: r.name ?? "",
              url: r.url ?? "",
              feeBps: Number(r.fee),
              bond: r.bond as bigint,
              bondToken: r.bondToken as string,
              exitRequestedAt: Number(r.exitRequestedAt),
              active: r.active as boolean,
            };
          }),
        );
        if (!cancelled) {
          // Hide fully-exited entries (active=false); keep active + exiting.
          setRows(all.filter((r) => r.active));
          setExitCooldown(cooldown);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, readProvider]);

  // token address → { symbol, decimals } from the whitelist (native = ETH/18).
  const tokenMeta = (tok: string): { symbol: string; decimals: number } => {
    if (!tok || !isConfiguredAddress(tok)) return { symbol: "ETH", decimals: 18 };
    const t = tokens.find((x) => eqAddr(x.address, tok));
    return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: "?", decimals: 18 };
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3">
        <div className="font-medium">Registered relayers</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          Active and exiting operators with their bond, fee, and status. Bond is shown
          in the token each relayer staked.
        </div>
      </div>
      {error ? (
        <div className="px-5 py-4 text-sm text-[var(--color-danger)]">
          ⚠ Failed to read the relayer list from the chain.
        </div>
      ) : rows == null ? (
        <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">
          No relayers registered yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-2 text-left">Relayer</th>
              <th className="px-5 py-2 text-right">Bond</th>
              <th className="px-5 py-2 text-right">Fee</th>
              <th className="px-5 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = tokenMeta(r.bondToken);
              const exiting = r.exitRequestedAt > 0;
              const readyAt = exitCooldown != null ? r.exitRequestedAt + Number(exitCooldown) : null;
              return (
                <tr key={r.addr} className="border-t border-[var(--color-border)]">
                  <td className="px-5 py-3">
                    <div className="font-medium">{r.name || shortAddr(r.addr)}</div>
                    <div className="font-mono text-[10px] text-[var(--color-text-subtle)]">
                      {shortAddr(r.addr)}
                      {r.url ? ` · ${r.url}` : ""}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {formatUnits(r.bond, m.decimals)} {m.symbol}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">{(r.feeBps / 100).toFixed(2)}%</td>
                  <td className="px-5 py-3 text-right">
                    {exiting ? (
                      <span className="text-[var(--color-warning)]">
                        Exiting
                        {readyAt
                          ? ` · ready ${new Date(readyAt * 1000).toISOString().slice(0, 16).replace("T", " ")}`
                          : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--color-success)]">Active</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
