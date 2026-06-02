"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";

const RELAYER_REGISTRY_ABI = [
  "function identityRegistry() view returns (address)",
];

/** Reads the relayer identity registry the protocol actually gates
 *  `RelayerRegistry.register()` against — `RelayerRegistry.identityRegistry()`
 *  (the Relayer-CA, the same address the admin manages). The Verify step
 *  deep-links to THIS registry's register tab
 *  (`/registry/<addr>?tab=register`) so the operator proves their
 *  accredited certificate against the registry that gates registration —
 *  NOT the Pay/end-user IdentityGate, which routes to a different
 *  (user-identity) registry. Returns `null` until resolved, if the
 *  RelayerRegistry address is unset, or if the read fails (caller falls
 *  back to the dashboard base URL). */
export function useGateRegistry(): string | null {
  const { readProvider } = useWallet();
  const relayerRegistry = DEMO_NETWORK.contracts.relayerRegistry;
  const [addr, setAddr] = useState<string | null>(null);

  useEffect(() => {
    if (
      !readProvider ||
      !relayerRegistry ||
      !isConfiguredAddress(relayerRegistry)
    ) {
      setAddr(null);
      return;
    }
    let cancelled = false;
    const c = new ethers.Contract(
      relayerRegistry,
      RELAYER_REGISTRY_ABI,
      readProvider,
    );
    (c.identityRegistry() as Promise<string>)
      .then((reg) => {
        if (!cancelled) setAddr(isConfiguredAddress(reg) ? reg : null);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn("[useGateRegistry] identityRegistry read failed", err);
          setAddr(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider, relayerRegistry]);

  return addr;
}
