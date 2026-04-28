"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { useActiveNetwork } from "../lib/activeNetwork";

export function WrongChainBanner() {
  const { network } = useActiveNetwork();
  const { wrongChain, networkLabel, connect } = useConnectWalletPill(network);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={connect}
    />
  );
}
