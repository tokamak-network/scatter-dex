"use client";

import { Pill, StatusDot } from "./Pill";

export interface ConnectWalletPillViewProps {
  account: string | null;
  /** Pre-truncated address (`shortAddr(account)`) — let the caller
   *  decide the truncation form so this view stays SDK-agnostic. */
  shortAccount: string;
  walletName: string | null;
  connect: () => void;
  disconnect: () => void;
  connectError: string | null;
  /** Network label for the connected pill (e.g. "Sepolia (testnet)"). */
  networkLabel: string;
  /** True when the wallet's chain doesn't match the app's expected
   *  network — flips the dot to "warn" and shows a switch hint. */
  wrongChain: boolean;
}

/** Presentational header pill — rendered identically across every
 *  zkScatter app. Apps own the SDK glue (read `useWallet()`, derive
 *  the network label from their own `NetworkConfig`) and pass the
 *  results in as props, so this stays in `packages/ui` without
 *  pulling `@zkscatter/sdk` into ui's peer deps. */
export function ConnectWalletPillView({
  account,
  shortAccount,
  walletName,
  connect,
  disconnect,
  connectError,
  networkLabel,
  wrongChain,
}: ConnectWalletPillViewProps) {
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
        {shortAccount}
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
