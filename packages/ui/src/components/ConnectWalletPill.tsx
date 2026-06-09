"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Pill, StatusDot } from "./Pill";
import { useOutsideClick } from "./useOutsideClick";

export interface ConnectWalletPillViewProps {
  /** True when a wallet is connected. Drives the connected vs.
   *  disconnected branch — the view doesn't need the raw account
   *  address, the caller passes a pre-truncated string instead. */
  connected: boolean;
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
  /** Optional extra menu items rendered above the Disconnect row.
   *  Apps inject host-specific links (e.g. Pay's "View wallet"
   *  page) without this view having to know about Next routing. */
  extraMenuItems?: ReactNode;
}

/** Presentational header pill — rendered identically across every
 *  zkScatter app. Apps own the SDK glue (read `useWallet()`, derive
 *  the network label from their own `NetworkConfig`) and pass the
 *  results in as props, so this stays in `packages/ui` without
 *  pulling `@zkscatter/sdk` into ui's peer deps. */
export function ConnectWalletPillView({
  connected,
  shortAccount,
  walletName,
  connect,
  disconnect,
  connectError,
  networkLabel,
  wrongChain,
  extraMenuItems,
}: ConnectWalletPillViewProps) {
  if (!connected) {
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
    <ConnectedPill
      {...{ shortAccount, walletName, disconnect, wrongChain, extraMenuItems }}
    />
  );
}

interface ConnectedPillProps {
  shortAccount: string;
  walletName: string | null;
  disconnect: () => void;
  wrongChain: boolean;
  extraMenuItems?: ReactNode;
}

/** Address pill with a click-to-open menu carrying the explicit
 *  "Disconnect" action. Replaces the previous tiny `×` glyph that
 *  was easy to miss. */
function ConnectedPill({
  shortAccount,
  walletName,
  disconnect,
  wrongChain,
  extraMenuItems,
}: ConnectedPillProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  return (
    <div ref={wrapRef} className="relative inline-block">
      <Pill onClick={() => setOpen((v) => !v)} title={walletName ?? "Wallet"}>
        <StatusDot kind={wrongChain ? "warn" : "online"} />
        <span className="font-mono">{shortAccount}</span>
        <span aria-hidden="true" className="text-[var(--color-text-subtle)]">▾</span>
      </Pill>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
          onClick={close}
        >
          {extraMenuItems}
          <button
            type="button"
            onClick={() => {
              disconnect();
              close();
            }}
            className="block w-full px-3 py-1.5 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] hover:text-[var(--color-danger)] focus:bg-[var(--color-bg)] focus:outline-none"
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export interface WrongChainBannerViewProps {
  wrongChain: boolean;
  networkLabel: string;
  /** Move the wallet to the app's chain. May be async (the SDK's
   *  `switchChain` returns a Promise that rejects on user-cancel /
   *  wallet error) — the banner handles that, so callers can pass it
   *  straight through. */
  switchChain: () => void | Promise<void>;
  /** Chain the wallet is currently on. Shown in the banner so the user
   *  can see *which* wrong network they're on (a frequent source of
   *  confusion, e.g. a wallet still on a local 31337 dev chain). */
  currentChainId?: number | null;
  /** Friendly name for `currentChainId` when known. */
  currentChainLabel?: string | null;
}

/** Full-width banner shown directly below the header when the wallet
 *  is connected to the wrong chain. The button calls `switchChain`
 *  (e.g. `useConnectWalletPill().switchChain`, which runs
 *  `wallet_switchEthereumChain` with an add-chain fallback). */
export function WrongChainBannerView({
  wrongChain,
  networkLabel,
  switchChain,
  currentChainId,
  currentChainLabel,
}: WrongChainBannerViewProps) {
  if (!wrongChain) return null;
  // e.g. "Localhost (chain 31337)" when known, else "chain 31337".
  const on =
    currentChainId != null
      ? currentChainLabel
        ? `${currentChainLabel} (chain ${currentChainId})`
        : `chain ${currentChainId}`
      : null;
  return (
    <div className="bg-[var(--color-warning)]/10 px-6 py-2 text-center text-xs">
      <span className="text-[var(--color-warning)]">
        ⚠ Wrong chain — your wallet is on {on ?? "another network"}, not {networkLabel}.
      </span>{" "}
      <button
        type="button"
        onClick={() => {
          // `switchChain` may return a Promise that rejects (user cancels
          // the MetaMask prompt, wallet error). Swallow it here so the
          // click never surfaces as an unhandled promise rejection;
          // the banner simply stays up for a retry.
          void Promise.resolve(switchChain()).catch(() => {});
        }}
        className="font-medium text-[var(--color-warning)] underline underline-offset-2 hover:no-underline"
      >
        Switch to {networkLabel}
      </button>
    </div>
  );
}
