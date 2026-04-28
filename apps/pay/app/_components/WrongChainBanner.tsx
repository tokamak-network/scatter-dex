"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

export function WrongChainBanner() {
  const { wrongChain, networkLabel, connect } = useConnectWalletPill(getNetworkConfig());
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={connect}
    />
  );
}
