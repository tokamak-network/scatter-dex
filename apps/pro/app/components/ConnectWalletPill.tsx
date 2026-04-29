"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { useActiveNetwork } from "../lib/activeNetwork";

/** Pro-app pill — binds the SDK wallet hook to the shared
 *  presentational view. Uses the live active-network so the pill's
 *  `networkLabel` / `wrongChain` reflect the user's runtime
 *  selection (matches `WrongChainBanner`); using the static
 *  `DEMO_NETWORK` instead would diverge once the network roster
 *  grows beyond one entry. */
export function ConnectWalletPill() {
  const { network } = useActiveNetwork();
  return <ConnectWalletPillView {...useConnectWalletPill(network)} />;
}
