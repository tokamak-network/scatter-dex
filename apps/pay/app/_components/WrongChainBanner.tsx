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
      switchChain={() => {
        console.log("[WrongChainBanner] switchChain clicked");
        void switchChain()
          .then(() => console.log("[WrongChainBanner] switchChain resolved"))
          .catch((err) => {
            console.warn("[WrongChainBanner] switchChain failed", err);
            window.alert(
              `Couldn't switch network — ${
                err instanceof Error ? err.message : String(err)
              }. Open MetaMask and add Localhost (chainId 31337, RPC http://localhost:8545) manually.`,
            );
          });
      }}
    />
  );
}
