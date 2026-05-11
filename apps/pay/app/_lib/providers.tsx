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
import { PreferencesProvider } from "./preferences";

/** Bridge component — mounts the SDK's `MetaAddressProvider` under
 *  the `<FolderStorageProvider>` and reactively passes `folderReady`
 *  so the keypair load (and the one-shot localStorage migration the
 *  SDK runs) re-runs the moment a folder is picked.
 *
 *  We also `key` the provider by the active folder id so a workspace
 *  switch fully remounts it. Without the key, switching between two
 *  folders that both report `ready=true` would leave the previous
 *  folder's keys in state until the inner effect happened to fire,
 *  briefly leaking the old workspace's meta-address into the new one. */
function FolderAwareMetaAddressProvider({ children }: { children: ReactNode }) {
  const folder = useFolderStorage();
  return (
    <MetaAddressProvider key={folder.currentId ?? "no-folder"} folderReady={folder.ready}>
      {children}
    </MetaAddressProvider>
  );
}

export function PayProviders({ children }: { children: React.ReactNode }) {
  const network = useMemo(() => getNetworkConfig(), []);
  return (
    <PreferencesProvider>
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
    </PreferencesProvider>
  );
}
