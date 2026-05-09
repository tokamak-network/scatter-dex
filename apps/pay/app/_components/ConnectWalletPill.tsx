"use client";

import Link from "next/link";
import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

/** Pay-app pill — binds the SDK wallet hook to the shared
 *  presentational view via `useConnectWalletPill`, so every app
 *  ships the same connect / disconnect dropdown UX. Adds a
 *  Pay-specific "View wallet" menu item that points at /wallet
 *  (per-token balances + send affordances on whitelisted tokens). */
export function ConnectWalletPill() {
  return (
    <ConnectWalletPillView
      {...useConnectWalletPill(getNetworkConfig())}
      extraMenuItems={
        <Link
          href="/wallet"
          className="block w-full px-3 py-1.5 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] focus:bg-[var(--color-bg)] focus:outline-none"
        >
          View wallet
        </Link>
      }
    />
  );
}
