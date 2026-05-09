"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

export function WrongChainBanner() {
  const { wrongChain, networkLabel, switchChain } = useConnectWalletPill(getNetworkConfig());
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={() =>
        void switchChain().catch((err) =>
          console.warn("[WrongChainBanner] switchChain failed", err),
        )
      }
    />
  );
}
