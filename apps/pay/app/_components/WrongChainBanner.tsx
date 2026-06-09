"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { getNetworkConfig } from "../_lib/network";

export function WrongChainBanner() {
  const cfg = getNetworkConfig();
  const { wrongChain, networkLabel, switchChain, currentChainId, currentChainLabel } =
    useConnectWalletPill(cfg);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      currentChainId={currentChainId}
      currentChainLabel={currentChainLabel}
      switchChain={() => {
        void switchChain().catch((err) => {
          // The switch can fail because the chain isn't in the wallet yet or
          // the user rejected the add-chain prompt — so say "add or select"
          // and include the chainId, which works across dev/prod networks.
          window.alert(
            `Couldn't switch network — ${
              err instanceof Error ? err.message : String(err)
            }. Open MetaMask and add or select ${networkLabel} (chain ${cfg.chainId}) manually.`,
          );
        });
      }}
    />
  );
}
