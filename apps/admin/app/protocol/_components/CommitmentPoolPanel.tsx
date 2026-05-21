"use client";

import { useEffect, useState } from "react";
import { Contract } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { Stat } from "../../components/Stat";
import { PauseControl } from "./PauseControl";
import { SetAddressCard } from "./SetAddressCard";
import { SettlementQueue } from "./SettlementQueue";

const ABI = [
  "function paused() external view returns (bool)",
  "function authorizedSettlement() external view returns (address)",
  "function sanctionsList() external view returns (address)",
  "function identityGate() external view returns (address)",
  "function setSanctionsList(address _list) external",
  "function setIdentityGate(address _gate) external",
];

interface Snapshot {
  authorizedSettlement: string | null;
  sanctionsList: string | null;
  identityGate: string | null;
}

const EMPTY: Snapshot = {
  authorizedSettlement: null,
  sanctionsList: null,
  identityGate: null,
};

export function CommitmentPoolPanel({ address }: { address: string }) {
  const { readProvider } = useWallet();
  const [snap, setSnap] = useState<Snapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void Promise.allSettled([
      c.authorizedSettlement() as Promise<string>,
      c.sanctionsList() as Promise<string>,
      c.identityGate() as Promise<string>,
    ]).then(([s, sa, ig]) => {
      if (cancelled) return;
      setSnap({
        authorizedSettlement: s.status === "fulfilled" ? s.value : null,
        sanctionsList: sa.status === "fulfilled" ? sa.value : null,
        identityGate: ig.status === "fulfilled" ? ig.value : null,
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
          label="Authorized settlement"
          value={snap.authorizedSettlement ? shortAddr(snap.authorizedSettlement) : "…"}
          sub="PrivateSettlement contract bound to this pool"
          compact
        />
        <Stat
          label="Sanctions list"
          value={snap.sanctionsList ? shortAddr(snap.sanctionsList) : "…"}
          sub="0x0 disables sanctions checks"
          compact
        />
        <Stat
          label="Identity gate"
          value={snap.identityGate ? shortAddr(snap.identityGate) : "…"}
          sub="0x0 disables identity verification"
          compact
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PauseControl address={address} label="CommitmentPool" />
        <SetAddressCard
          title="Set sanctions list"
          description="CommitmentPool.setSanctionsList(address). Pass 0x0 to disable."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="sanctionsList"
          setterFn="setSanctionsList"
          submitLabel="Update sanctions list"
          allowZeroAddress
        />
        <SetAddressCard
          title="Set identity gate"
          description="CommitmentPool.setIdentityGate(address). Pass 0x0 to disable identity checks."
          contractAddress={address}
          contractAbi={ABI}
          readerFn="identityGate"
          setterFn="setIdentityGate"
          submitLabel="Update identity gate"
          allowZeroAddress
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-muted)]">
          Settlement rotation{" "}
          <span className="ml-1 rounded-full bg-[var(--color-danger-soft)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-danger)]">
            critical · timelocked
          </span>
        </h3>
        <SettlementQueue address={address} />
      </div>
    </section>
  );
}
