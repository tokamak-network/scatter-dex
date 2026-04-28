"use client";

import { useMemo } from "react";
import { WalletProvider } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";
import { VaultProvider } from "./vault";
import { EdDSAKeyProvider } from "./eddsaKey";
import { RelayersProvider } from "./relayers";

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return (
    <WalletProvider network={network}>
      <EdDSAKeyProvider>
        <RelayersProvider>
          <VaultProvider>{children}</VaultProvider>
        </RelayersProvider>
      </EdDSAKeyProvider>
    </WalletProvider>
  );
}
