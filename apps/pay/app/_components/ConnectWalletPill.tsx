"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

/** Pay-app pill — binds the SDK wallet hook to the shared
 *  presentational view via `useConnectWalletPill`, so every app
 *  ships the same connect / disconnect dropdown UX. */
export function ConnectWalletPill() {
  return <ConnectWalletPillView {...useConnectWalletPill(getNetworkConfig())} />;
}
