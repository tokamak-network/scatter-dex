"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Operators-app pill — binds the SDK wallet hook to the shared
 *  presentational view via `useConnectWalletPill`, so the only
 *  thing that varies per app is the `NetworkConfig` passed in. */
export function ConnectWalletPill() {
  return <ConnectWalletPillView {...useConnectWalletPill(DEMO_NETWORK)} />;
}
