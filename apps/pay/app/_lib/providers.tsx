"use client";

import { useMemo } from "react";
import { WalletProvider } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";
import { VaultProvider } from "./vault";
import { EdDSAKeyProvider } from "@zkscatter/sdk/react";
import { RelayersProvider } from "./relayers";
import { FolderStorageProvider } from "./folderStorage";
import { WalletBookProvider } from "./walletBook";
import { CommitmentTreeProvider } from "./commitmentTree";
import { VaultReconciler } from "./vaultReconciler";
import {
  IdentityBatchProvider,
  IdentityGateAdminProvider,
  IdentityStatusProvider,
} from "./identity";

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return (
    <FolderStorageProvider>
      <WalletProvider network={network}>
        <EdDSAKeyProvider>
          <RelayersProvider>
            <VaultProvider>
              <CommitmentTreeProvider>
                <VaultReconciler />
                <WalletBookProvider>
                  <IdentityStatusProvider>
                    <IdentityGateAdminProvider>
                      <IdentityBatchProvider>{children}</IdentityBatchProvider>
                    </IdentityGateAdminProvider>
                  </IdentityStatusProvider>
                </WalletBookProvider>
              </CommitmentTreeProvider>
            </VaultProvider>
          </RelayersProvider>
        </EdDSAKeyProvider>
      </WalletProvider>
    </FolderStorageProvider>
  );
}
