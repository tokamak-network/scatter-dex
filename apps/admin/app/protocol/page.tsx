"use client";

import { useEffect, useState } from "react";
import { Contract, formatUnits } from "ethers";
import { ZERO_ADDRESS, isConfiguredAddress } from "@zkscatter/sdk";
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

const ERC20_META_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

interface Field<T> {
  value: T | null;
  error: string | null;
}

interface RegistrySnapshot {
  minBond: Field<bigint>;
  treasury: Field<string>;
  identityRegistry: Field<string>;
  bondToken: Field<string>;
  owner: Field<string>;
  relayerCount: Field<bigint>;
}

interface BondTokenMeta {
  decimals: number;
  symbol: string;
}

/** Native ETH placeholder when `bondToken == address(0)` —
 *  RelayerRegistry treats this as the chain's native asset. */
const NATIVE_BOND: BondTokenMeta = { decimals: 18, symbol: "ETH" };

export default function ProtocolPage() {
  const registryAddress = DEMO_NETWORK.contracts.relayerRegistry;
  const configured = isConfiguredAddress(registryAddress);

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

function fieldFromSettled<T>(result: PromiseSettledResult<T>): Field<T> {
  return result.status === "fulfilled"
    ? { value: result.value, error: null }
    : { value: null, error: explainSettledReason(result.reason) };
}

function explainSettledReason(reason: unknown): string {
  if (reason instanceof Error) {
    const sm = (reason as { shortMessage?: string }).shortMessage;
    return sm ?? reason.message;
  }
  return String(reason);
}

function RegistryParams() {
  const { readProvider } = useWallet();
  const [snap, setSnap] = useState<RegistrySnapshot | null>(null);
  const [tokenMeta, setTokenMeta] = useState<BondTokenMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    const contract = new Contract(
      DEMO_NETWORK.contracts.relayerRegistry,
      REGISTRY_ABI,
      readProvider,
    );
    void Promise.allSettled([
      contract.minBond() as Promise<bigint>,
      contract.treasury() as Promise<string>,
      contract.identityRegistry() as Promise<string>,
      contract.bondToken() as Promise<string>,
      contract.owner() as Promise<string>,
      contract.getRelayerCount() as Promise<bigint>,
    ]).then((results) => {
      if (cancelled) return;
      const [minBond, treasury, identityRegistry, bondToken, owner, relayerCount] = results;
      setSnap({
        minBond: fieldFromSettled(minBond as PromiseSettledResult<bigint>),
        treasury: fieldFromSettled(treasury as PromiseSettledResult<string>),
        identityRegistry: fieldFromSettled(identityRegistry as PromiseSettledResult<string>),
        bondToken: fieldFromSettled(bondToken as PromiseSettledResult<string>),
        owner: fieldFromSettled(owner as PromiseSettledResult<string>),
        relayerCount: fieldFromSettled(relayerCount as PromiseSettledResult<bigint>),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [readProvider]);

  // Resolve bond-token decimals + symbol from chain. Falls back to
  // ETH defaults when bondToken is the zero address (native bond
  // mode), or to an `(token)` label when an ERC20 doesn't expose
  // standard metadata.
  useEffect(() => {
    const bondToken = snap?.bondToken.value;
    if (bondToken == null) return;
    if (!isConfiguredAddress(bondToken)) {
      setTokenMeta(NATIVE_BOND);
      return;
    }
    let cancelled = false;
    const erc20 = new Contract(bondToken, ERC20_META_ABI, readProvider);
    void Promise.allSettled([
      erc20.decimals() as Promise<number | bigint>,
      erc20.symbol() as Promise<string>,
    ]).then(([decimals, symbol]) => {
      if (cancelled) return;
      setTokenMeta({
        decimals:
          decimals.status === "fulfilled" ? Number(decimals.value) : 18,
        symbol: symbol.status === "fulfilled" ? symbol.value : "token",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [snap?.bondToken.value, readProvider]);

  if (!snap) {
    return (
      <section>
        <SectionHeader title="RelayerRegistry" badge="live" />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-text-muted)]">
          Reading on-chain…
        </div>
      </section>
    );
  }

  const meta = tokenMeta ?? NATIVE_BOND;

  return (
    <section>
      <SectionHeader title="RelayerRegistry" badge="live" />
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Minimum bond"
          value={formatField(snap.minBond, (v) => `${formatUnits(v, meta.decimals)} ${meta.symbol}`)}
          sub={
            snap.minBond.error ?? "Operator must post ≥ this to register"
          }
        />
        <Stat
          label="Treasury"
          value={formatField(snap.treasury, shortAddr)}
          sub={snap.treasury.error ?? "Protocol fee destination"}
        />
        <Stat
          label="Identity registry"
          value={formatField(snap.identityRegistry, shortAddr)}
          sub={snap.identityRegistry.error ?? "Operator-CA contract"}
        />
        <Stat
          label="Bond token"
          value={
            snap.bondToken.value === ZERO_ADDRESS
              ? "Native (ETH)"
              : formatField(snap.bondToken, shortAddr)
          }
          sub={
            snap.bondToken.error ??
            (snap.bondToken.value === ZERO_ADDRESS
              ? "Bonds posted as msg.value"
              : `ERC20 · ${meta.symbol}`)
          }
        />
        <Stat
          label="Owner (multisig)"
          value={formatField(snap.owner, shortAddr)}
          sub={snap.owner.error ?? "Holds setMinBond / setTreasury rights"}
        />
        <Stat
          label="Active relayers"
          value={formatField(snap.relayerCount, (v) => v.toString())}
          sub={snap.relayerCount.error ?? "Total registered operators"}
        />
      </div>
    </section>
  );
}

function formatField<T>(field: Field<T>, render: (v: T) => string): string {
  if (field.error) return "—";
  if (field.value === null) return "…";
  return render(field.value);
}
