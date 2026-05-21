"use client";

import { useEffect, useState } from "react";
import { Contract, formatUnits } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { DEMO_NETWORK } from "../lib/network";

const REGISTRY_ABI = [
  "function minBond() external view returns (uint256)",
  "function treasury() external view returns (address)",
  "function identityRegistry() external view returns (address)",
  "function bondToken() external view returns (address)",
  "function owner() external view returns (address)",
  "function getRelayerCount() external view returns (uint256)",
];

interface RegistrySnapshot {
  minBond: string;
  treasury: string;
  identityRegistry: string;
  bondToken: string;
  owner: string;
  relayerCount: string;
}

export default function ProtocolPage() {
  const registryAddress = DEMO_NETWORK.contracts.relayerRegistry;
  const configured = registryAddress && registryAddress !== "0x0000000000000000000000000000000000000000";

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Protocol parameters</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Governed parameters across <code className="font-mono">RelayerRegistry</code>,{" "}
          <code className="font-mono">CommitmentPool</code>, and{" "}
          <code className="font-mono">PrivateSettlement</code>. Read-only first; writes are
          performed by the multisig.
        </p>
      </header>

      {configured ? (
        <RegistryParams />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          <p>
            Set <code className="font-mono">NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS</code> to
            read protocol parameters from <strong>{DEMO_NETWORK.name}</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

function RegistryParams() {
  const { readProvider } = useWallet();
  const [snap, setSnap] = useState<RegistrySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const contract = new Contract(
      DEMO_NETWORK.contracts.relayerRegistry,
      REGISTRY_ABI,
      readProvider,
    );
    void Promise.all([
      contract.minBond() as Promise<bigint>,
      contract.treasury() as Promise<string>,
      contract.identityRegistry() as Promise<string>,
      contract.bondToken() as Promise<string>,
      contract.owner() as Promise<string>,
      contract.getRelayerCount() as Promise<bigint>,
    ])
      .then(([minBond, treasury, identityRegistry, bondToken, owner, relayerCount]) => {
        if (cancelled) return;
        setSnap({
          minBond: `${formatUnits(minBond, 18)} TON`,
          treasury,
          identityRegistry,
          bondToken,
          owner,
          relayerCount: relayerCount.toString(),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  if (error) {
    return (
      <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
        Failed to read RelayerRegistry: {error}
      </div>
    );
  }

  return (
    <section>
      <SectionHeader title="RelayerRegistry" badge="live" />
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Minimum bond"
          value={snap?.minBond ?? "…"}
          sub="Operator must post ≥ this to register"
        />
        <Stat
          label="Treasury"
          value={snap?.treasury ? shortAddr(snap.treasury) : "…"}
          sub="Protocol fee destination"
        />
        <Stat
          label="Identity registry"
          value={snap?.identityRegistry ? shortAddr(snap.identityRegistry) : "…"}
          sub="Operator-CA contract"
        />
        <Stat
          label="Bond token"
          value={snap?.bondToken ? shortAddr(snap.bondToken) : "…"}
          sub="ERC20 used for bonds"
        />
        <Stat
          label="Owner (multisig)"
          value={snap?.owner ? shortAddr(snap.owner) : "…"}
          sub="Holds setMinBond / setTreasury rights"
        />
        <Stat
          label="Active relayers"
          value={snap?.relayerCount ?? "…"}
          sub="Total registered operators"
        />
      </div>
    </section>
  );
}

