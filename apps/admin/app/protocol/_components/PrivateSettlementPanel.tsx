"use client";

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { Stat } from "../../components/Stat";
import { PauseControl } from "./PauseControl";
import { SetAddressCard } from "./SetAddressCard";

const ABI = [
  "function paused() external view returns (bool)",
  "function relayerRegistry() external view returns (address)",
  "function feeVault() external view returns (address)",
  "function sanctionsList() external view returns (address)",
  "function identityGate() external view returns (address)",
  "function dexPlatformFeeBps() external view returns (uint256)",
  "function setRelayerRegistry(address _registry) external",
  "function setFeeVault(address _vault) external",
  "function setSanctionsList(address _list) external",
  "function setIdentityGate(address _gate) external",
];

interface Snapshot {
  relayerRegistry: string | null;
  feeVault: string | null;
  sanctionsList: string | null;
  identityGate: string | null;
  dexPlatformFeeBps: bigint | null;
}

const EMPTY: Snapshot = {
  relayerRegistry: null,
  feeVault: null,
  sanctionsList: null,
  identityGate: null,
  dexPlatformFeeBps: null,
};

export function PrivateSettlementPanel({ address }: { address: string }) {
  const { readProvider } = useWallet();
  const [snap, setSnap] = useState<Snapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void Promise.allSettled([
      c.relayerRegistry() as Promise<string>,
      c.feeVault() as Promise<string>,
      c.sanctionsList() as Promise<string>,
      c.identityGate() as Promise<string>,
      c.dexPlatformFeeBps() as Promise<bigint>,
    ]).then(([r, fv, sa, ig, dex]) => {
      if (cancelled) return;
      setSnap({
        relayerRegistry: r.status === "fulfilled" ? r.value : null,
        feeVault: fv.status === "fulfilled" ? fv.value : null,
        sanctionsList: sa.status === "fulfilled" ? sa.value : null,
        identityGate: ig.status === "fulfilled" ? ig.value : null,
        dexPlatformFeeBps: dex.status === "fulfilled" ? dex.value : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider]);

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Relayer registry"
          value={snap.relayerRegistry ? shortAddr(snap.relayerRegistry) : "…"}
          sub="0x0 disables relayer gating"
          compact
        />
        <Stat
          label="Fee vault"
          value={snap.feeVault ? shortAddr(snap.feeVault) : "…"}
          sub="0x0 sends fees direct to relayer (legacy)"
          compact
        />
        <Stat
          label="DEX platform fee"
          value={
            snap.dexPlatformFeeBps != null
              ? `${Number(snap.dexPlatformFeeBps) / 100}%`
              : "…"
          }
          sub="Cut on DEX-mode settlements"
          compact
        />
        <Stat
          label="Sanctions list"
          value={snap.sanctionsList ? shortAddr(snap.sanctionsList) : "…"}
          sub="Mirror of CommitmentPool entry"
          compact
        />
        <Stat
          label="Identity gate"
          value={snap.identityGate ? shortAddr(snap.identityGate) : "…"}
          sub="Mirror of CommitmentPool entry"
          compact
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PauseControl address={address} label="PrivateSettlement" />
        <SetAddressCard
          title="Set relayer registry"
          description="PrivateSettlement.setRelayerRegistry(address). 0x0 disables relayer gating."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="relayerRegistry"
          setterFn="setRelayerRegistry"
          submitLabel="Update relayer registry"
          allowZeroAddress
        />
        <SetAddressCard
          title="Set fee vault"
          description="PrivateSettlement.setFeeVault(address). 0x0 reverts to legacy direct-to-relayer mode."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="feeVault"
          setterFn="setFeeVault"
          submitLabel="Update fee vault"
          allowZeroAddress
        />
        <SetAddressCard
          title="Set sanctions list"
          description="PrivateSettlement.setSanctionsList(address). Pass 0x0 to disable."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="sanctionsList"
          setterFn="setSanctionsList"
          submitLabel="Update sanctions list"
          allowZeroAddress
        />
        <SetAddressCard
          title="Set identity gate"
          description="PrivateSettlement.setIdentityGate(address). Pass 0x0 to disable identity checks."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="identityGate"
          setterFn="setIdentityGate"
          submitLabel="Update identity gate"
          allowZeroAddress
        />
      </div>
    </section>
  );
}
