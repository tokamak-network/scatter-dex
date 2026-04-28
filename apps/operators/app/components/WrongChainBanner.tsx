"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

export function WrongChainBanner() {
  const { wrongChain, networkLabel, connect } = useConnectWalletPill(DEMO_NETWORK);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={connect}
    />
  );
}
