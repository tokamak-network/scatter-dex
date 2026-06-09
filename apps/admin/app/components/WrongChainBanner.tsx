"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Full-width banner that appears whenever the connected wallet is on a
 *  different chain than the app's configured network, with a one-click
 *  "Switch to <network>" button (wallet_switchEthereumChain + add-chain
 *  fallback). Without it, an admin on the wrong network would silently
 *  read via the public-RPC fallback but every write would target the wrong
 *  chain — so we guide the switch instead. */
export function WrongChainBanner() {
  const { wrongChain, networkLabel, switchChain } = useConnectWalletPill(DEMO_NETWORK);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={switchChain}
    />
  );
}
