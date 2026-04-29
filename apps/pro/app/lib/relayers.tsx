"use client";

import type { ReactNode } from "react";
import { RelayersProvider as SdkRelayersProvider } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";

export { useRelayers } from "@zkscatter/sdk/react";

export function RelayersProvider({ children }: { children: ReactNode }) {
  return (
    <SdkRelayersProvider registryAddress={DEMO_NETWORK.contracts.relayerRegistry}>
      {children}
    </SdkRelayersProvider>
  );
}
