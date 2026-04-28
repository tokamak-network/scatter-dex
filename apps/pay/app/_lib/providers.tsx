"use client";

import { useMemo } from "react";
import { WalletProvider } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";
import { VaultProvider } from "./vault";
import { EdDSAKeyProvider } from "./eddsaKey";
import { RelayersProvider } from "./relayers";
import { FolderStorageProvider } from "./folderStorage";
import { WalletBookProvider } from "./walletBook";

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return (
    <FolderStorageProvider>
      <WalletProvider network={network}>
        <EdDSAKeyProvider>
          <RelayersProvider>
            <VaultProvider>
              <WalletBookProvider>{children}</WalletBookProvider>
            </VaultProvider>
          </RelayersProvider>
        </EdDSAKeyProvider>
      </WalletProvider>
    </FolderStorageProvider>
  );
}
