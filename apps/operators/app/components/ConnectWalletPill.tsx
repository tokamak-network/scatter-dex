"use client";

import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { chainName } from "@zkscatter/sdk";
import { ConnectWalletPillView } from "@zkscatter/ui";
import { DEMO_NETWORK } from "../lib/network";

/** Operators-app pill: thin wrapper around the shared
 *  presentational view in `@zkscatter/ui`. Reads the wallet state
 *  from the SDK and resolves the network label against the app's
 *  own `NetworkConfig`. Pro app does the same against its own. */
export function ConnectWalletPill() {
  const { account, walletName, connect, disconnect, connectError, chainId } =
    useWallet();

  return (
    <ConnectWalletPillView
      account={account}
      shortAccount={shortAddr(account)}
      walletName={walletName}
      connect={connect}
      disconnect={disconnect}
      connectError={connectError}
      networkLabel={DEMO_NETWORK.name ?? chainName(DEMO_NETWORK.chainId)}
      wrongChain={chainId !== null && chainId !== DEMO_NETWORK.chainId}
    />
  );
}
