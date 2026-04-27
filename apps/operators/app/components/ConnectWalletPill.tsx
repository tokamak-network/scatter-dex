"use client";

import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { chainName } from "@zkscatter/sdk";
import { Pill, StatusDot } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Header pill: Connect button when disconnected, truncated
 *  address with a Disconnect action when connected. Mirrors the
 *  Pro app's pill so operators feel familiar, scoped here so
 *  apps don't cross-import each other. */
export function ConnectWalletPill() {
  const { account, walletName, connect, disconnect, connectError, chainId } =
    useWallet();

  const networkLabel = DEMO_NETWORK.name ?? chainName(DEMO_NETWORK.chainId);
  const wrongChain = chainId !== null && chainId !== DEMO_NETWORK.chainId;

  if (!account) {
    return (
      <button
        type="button"
        onClick={connect}
        className="rounded-full border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
        title={connectError ?? `Connect to ${networkLabel}`}
      >
        Connect wallet
      </button>
    );
  }

  return (
    <Pill>
      <StatusDot kind={wrongChain ? "warn" : "online"} />
      {wrongChain ? (
        <span className="text-[var(--color-warning)]">
          Wrong chain — switch to {networkLabel}
        </span>
      ) : (
        <span>{networkLabel}</span>
      )}
      <span aria-hidden="true" className="text-[var(--color-text-subtle)]">·</span>
      <span title={walletName ?? "Wallet"} className="font-mono">
        {shortAddr(account)}
      </span>
      <button
        type="button"
        onClick={disconnect}
        className="ml-1 text-[var(--color-text-subtle)] hover:text-[var(--color-danger)]"
        aria-label="Disconnect wallet"
      >
        ×
      </button>
    </Pill>
  );
}
