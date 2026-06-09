"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

export function WrongChainBanner() {
  // `switchChain` (wallet_switchEthereumChain + add-chain fallback), NOT
  // `connect` — the button must move the wallet to the app's network, not
  // re-prompt the connection.
  const { wrongChain, networkLabel, switchChain, currentChainId, currentChainLabel } =
    useConnectWalletPill(DEMO_NETWORK);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={switchChain}
      currentChainId={currentChainId}
      currentChainLabel={currentChainLabel}
    />
  );
}
