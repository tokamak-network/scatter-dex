"use client";

import Link from "next/link";
import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { useActiveNetwork } from "../lib/activeNetwork";

/** Pro-app pill — binds the SDK wallet hook to the shared
 *  presentational view. Uses the live active-network so the pill's
 *  `networkLabel` / `wrongChain` reflect the user's runtime
 *  selection (matches `WrongChainBanner`); using the static
 *  `DEMO_NETWORK` instead would diverge once the network roster
 *  grows beyond one entry. Adds a "View wallet" menu item that
 *  points at /wallet (per-token balances + send), matching Pay. */
export function ConnectWalletPill() {
  const { network } = useActiveNetwork();
  return (
    <ConnectWalletPillView
      {...useConnectWalletPill(network)}
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
