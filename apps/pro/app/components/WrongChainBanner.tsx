"use client";

import { useConnectWalletPill } from "@zkscatter/sdk/react";
import { WrongChainBannerView } from "@zkscatter/ui";
import { useActiveNetwork } from "../lib/activeNetwork";

export function WrongChainBanner() {
  const { network } = useActiveNetwork();
  // `switchChain` (not `connect`) is the helper that actually calls
  // `wallet_switchEthereumChain` and falls back to
  // `wallet_addEthereumChain` for unknown chains (e.g. Localhost
  // 31337 which MetaMask doesn't ship). Wiring `connect` here was
  // why the banner button silently no-op'd.
  const { wrongChain, networkLabel, switchChain } = useConnectWalletPill(network);
  return (
    <WrongChainBannerView
      wrongChain={wrongChain}
      networkLabel={networkLabel}
      switchChain={switchChain}
    />
  );
}
