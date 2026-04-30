"use client";

import { useMemo, type ReactNode } from "react";
import { MetaAddressProvider, WalletProvider } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";
import { VaultProvider } from "./vault";
import { EdDSAKeyProvider } from "@zkscatter/sdk/react";
import { RelayersProvider } from "./relayers";
import { FolderStorageProvider, useFolderStorage } from "./folderStorage";
import { WalletBookProvider } from "./walletBook";
import { CommitmentTreeProvider } from "./commitmentTree";
import { VaultReconciler } from "./vaultReconciler";

/** Bridge component — mounts the SDK's `MetaAddressProvider` under
 *  the `<FolderStorageProvider>` and reactively passes `folderReady`
 *  so the keypair load (and the one-shot localStorage migration the
 *  SDK runs) re-runs the moment a folder is picked or switched. */
function FolderAwareMetaAddressProvider({ children }: { children: ReactNode }) {
  const folder = useFolderStorage();
  return <MetaAddressProvider folderReady={folder.ready}>{children}</MetaAddressProvider>;
}

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return (
    <FolderStorageProvider>
      <FolderAwareMetaAddressProvider>
        <WalletProvider network={network}>
          <EdDSAKeyProvider>
            <RelayersProvider>
              <VaultProvider>
                <CommitmentTreeProvider>
                  <VaultReconciler />
                  <WalletBookProvider>{children}</WalletBookProvider>
                </CommitmentTreeProvider>
              </VaultProvider>
            </RelayersProvider>
          </EdDSAKeyProvider>
        </WalletProvider>
      </FolderAwareMetaAddressProvider>
    </FolderStorageProvider>
  );
}
