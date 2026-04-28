"use client";

import { useMemo } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import type { TokenBalance } from "@zkscatter/sdk/notes";
import { ethers } from "ethers";
import { useVault } from "../_lib/vault";

const PRIMARY_TOKEN_SYMBOL = "USDC";

export function PoolBalanceCard() {
  const { account } = useWallet();
  const { notes, loaded } = useVault();

  const balances = useMemo<TokenBalance[]>(() => {
    if (!loaded || notes.length === 0) return [];
    const byToken = new Map<string, TokenBalance>();
    for (const n of notes) {
      const token = "0x" + n.note.token.toString(16).padStart(40, "0");
      const cur = byToken.get(token);
      if (cur) cur.raw += n.note.amount;
      else byToken.set(token, { token, symbol: n.symbol, raw: n.note.amount });
    }
    return [...byToken.values()].sort((a, b) =>
      a.raw === b.raw ? 0 : a.raw < b.raw ? 1 : -1,
    );
  }, [notes, loaded]);

  const state: State = !account
    ? { kind: "disconnected" }
    : !loaded
      ? { kind: "loading" }
      : { kind: "ready", balances };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            Pool balance
          </div>
          <Headline state={state} />
          <Subline state={state} />
        </div>
        <div className="flex gap-2">
          <button
            disabled
            title="Top up arrives in Phase B"
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white opacity-40"
          >
            Top up
          </button>
          <button
            disabled
            title="Withdraw arrives in Phase B"
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm opacity-40"
          >
            Withdraw
          </button>
        </div>
      </div>
    </div>
  );
}

type State =
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "ready"; balances: TokenBalance[] };

function Headline({ state }: { state: State }) {
  if (state.kind === "disconnected") {
    return <div className="mt-2 text-2xl font-semibold text-[var(--color-text-muted)]">— USDC</div>;
  }
  if (state.kind === "loading") {
    return <div className="mt-2 text-2xl font-semibold">…</div>;
  }
  const primary = state.balances.find((b) => b.symbol === PRIMARY_TOKEN_SYMBOL);
  const display = primary
    ? formatBalance(primary.raw, decimalsFor(primary.symbol))
    : "0";
  return <div className="mt-2 text-2xl font-semibold">{display} USDC</div>;
}

function Subline({ state }: { state: State }) {
  if (state.kind === "disconnected") {
    return (
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        Connect your wallet to see your available balance.
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        Reading from your local notes…
      </div>
    );
  }
  if (state.balances.length === 0) {
    return (
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        No deposits yet. Top up USDC to start sending.
      </div>
    );
  }
  const others = state.balances.filter((b) => b.symbol !== PRIMARY_TOKEN_SYMBOL);
  const tail =
    others.length > 0
      ? ` · plus ${others.length} other token${others.length > 1 ? "s" : ""}`
      : "";
  return (
    <div className="mt-1 text-xs text-[var(--color-text-muted)]">
      Available to send to recipients{tail}
    </div>
  );
}

function decimalsFor(symbol: string): number {
  return LAUNCH_TOKENS[symbol]?.decimals ?? 18;
}

function formatBalance(raw: bigint, decimals: number): string {
  const fixed = ethers.formatUnits(raw, decimals);
  const [intPart, fracRaw = ""] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, 2).replace(/0+$/, "");
  return frac ? `${grouped}.${frac}` : grouped;
}
