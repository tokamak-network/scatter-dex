"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

export function WrongChainBanner() {
  const { wrongChain, networkLabel, switchChain, currentChainId, currentChainLabel } =
    useConnectWalletPill(getNetworkConfig());
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      currentChainId={currentChainId}
      currentChainLabel={currentChainLabel}
      switchChain={() => {
        void switchChain().catch((err) => {
          window.alert(
            `Couldn't switch network — ${
              err instanceof Error ? err.message : String(err)
            }. Open MetaMask and select ${networkLabel} manually.`,
          );
        });
      }}
    />
  );
}
