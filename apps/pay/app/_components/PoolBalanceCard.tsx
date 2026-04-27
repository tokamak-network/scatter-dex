"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import {
  createIndexedDbNoteAdapter,
  getAvailableBalance,
  type TokenBalance,
} from "@zkscatter/sdk/notes";
import { ethers } from "ethers";

type State =
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; balances: TokenBalance[] };

const PRIMARY_TOKEN_SYMBOL = "USDC";

export function PoolBalanceCard() {
  const { account, chainId } = useWallet();
  const [state, setState] = useState<State>({ kind: "disconnected" });

  useEffect(() => {
    if (!account || chainId === null) {
      setState({ kind: "disconnected" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    (async () => {
      try {
        const adapter = createIndexedDbNoteAdapter({
          dbName: `zkscatter-pay-notes-${chainId}-${account.toLowerCase()}`,
        });
        const balances = await getAvailableBalance(adapter, { chainId });
        if (!cancelled) setState({ kind: "ready", balances });
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, chainId]);

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
            disabled={state.kind === "disconnected"}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
          >
            Top up
          </button>
          <button
            disabled={state.kind !== "ready" || state.balances.length === 0}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
          >
            Withdraw
          </button>
        </div>
      </div>
    </div>
  );
}

function Headline({ state }: { state: State }) {
  switch (state.kind) {
    case "disconnected":
      return <div className="mt-2 text-2xl font-semibold text-[var(--color-text-muted)]">— USDC</div>;
    case "loading":
      return <div className="mt-2 text-2xl font-semibold">…</div>;
    case "error":
      return <div className="mt-2 text-2xl font-semibold">— USDC</div>;
    case "ready": {
      const primary = state.balances.find((b) => b.symbol === PRIMARY_TOKEN_SYMBOL);
      const value = primary
        ? Number(ethers.formatUnits(primary.raw, decimalsFor(primary.symbol)))
        : 0;
      return (
        <div className="mt-2 text-2xl font-semibold">
          {value.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
        </div>
      );
    }
  }
}

function Subline({ state }: { state: State }) {
  switch (state.kind) {
    case "disconnected":
      return (
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Connect your wallet to see your available balance.
        </div>
      );
    case "loading":
      return (
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">Reading from your local notes…</div>
      );
    case "error":
      return (
        <div className="mt-1 text-xs text-[var(--color-error,#dc2626)]">{state.message}</div>
      );
    case "ready": {
      const others = state.balances.filter((b) => b.symbol !== PRIMARY_TOKEN_SYMBOL);
      if (state.balances.length === 0) {
        return (
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            No deposits yet. Top up USDC to start sending.
          </div>
        );
      }
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
  }
}

function decimalsFor(symbol: string): number {
  return LAUNCH_TOKENS[symbol]?.decimals ?? 18;
}
