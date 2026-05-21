"use client";

import Link from "next/link";
import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Header wallet pill — mirrors Pay/Pro's `ConnectWalletPill` pattern
 *  so the connect/disconnect UX matches across apps.
 *
 *  Replaced the previous panel-style dropdown (balances + identity
 *  rows inline) with the shared `ConnectWalletPillView`; the rich
 *  balance/identity readout lives at `/wallet` now so the header
 *  stays light and the per-page identity row (`OperatorIdentityBar`)
 *  doesn't duplicate the info two clicks deep. */
export function OperatorWalletDropdown() {
  return (
    <ConnectWalletPillView
      {...useConnectWalletPill(DEMO_NETWORK)}
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
