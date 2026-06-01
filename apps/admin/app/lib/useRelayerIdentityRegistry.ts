"use client";

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "./network";

const ABI = ["function identityRegistry() external view returns (address)"];

/**
 * Reads the Relayer-CA IdentityRegistry that
 * `RelayerRegistry.identityRegistry()` currently trusts — the on-chain
 * source of truth that the admin's own **Identity (relayer)** tab sets.
 *
 * This replaces the static `NEXT_PUBLIC_IDENTITY_REGISTRY_ADDRESS` env var:
 * reading on-chain keeps the Operator-CA page in sync with whatever was set
 * on-chain (no env edit + dev-server restart needed), and works for both the
 * mock registry (local/dev) and a real zk-X509 registry.
 */
export function useRelayerIdentityRegistry(): { address: string | null; loading: boolean } {
  const { readProvider } = useWallet();
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const relayerRegistry = DEMO_NETWORK.contracts.relayerRegistry;
    // `relayerRegistry` falls back to the zero address when unconfigured, so
    // guard with isConfiguredAddress (a plain truthiness check would let the
    // zero address through and revert the call).
    if (!readProvider || !isConfiguredAddress(relayerRegistry)) {
      setAddress(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const c = new Contract(relayerRegistry, ABI, readProvider);
    void (c.identityRegistry() as Promise<string>)
      .then((addr) => {
        if (!cancelled) setAddress(addr);
      })
      .catch((err) => {
        console.warn("Failed to read RelayerRegistry.identityRegistry() on-chain:", err);
        if (!cancelled) setAddress(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  return { address, loading };
}
