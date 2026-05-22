"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Admin app wallet pill. Mirrors Pay/Pro/Operators — binds the shared
 *  view to the SDK wallet hook so the connect/disconnect UX matches
 *  the rest of the suite. Used by the layout's top-right slot so admin
 *  pages can read `useWallet().account` to gate owner-only affordances
 *  (CA addRegistry, operator attestation, protocol writes) instead of
 *  trying to talk to the chain without a signer. */
export function ConnectWalletPill() {
  return <ConnectWalletPillView {...useConnectWalletPill(DEMO_NETWORK)} />;
}
