"use client";

import { useMemo } from "react";
import { WalletProvider } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return <WalletProvider network={network}>{children}</WalletProvider>;
}
