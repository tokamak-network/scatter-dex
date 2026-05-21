"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Contract, formatUnits, parseUnits } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { Stat } from "../../components/Stat";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function minBond() external view returns (uint256)",
  "function treasury() external view returns (address)",
  "function identityRegistry() external view returns (address)",
  "function bondToken() external view returns (address)",
  "function owner() external view returns (address)",
  "function getRelayerCount() external view returns (uint256)",
  "function setMinBond(uint256 _minBond) external",
  "function setTreasury(address _treasury) external",
  "function setIdentityRegistry(address _identityRegistry) external",
];

const ERC20_META = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
];

interface Snapshot {
  minBond: bigint | null;
  treasury: string | null;
  identityRegistry: string | null;
  bondToken: string | null;
  owner: string | null;
  relayerCount: bigint | null;
}

const EMPTY: Snapshot = {
  minBond: null,
  treasury: null,
  identityRegistry: null,
  bondToken: null,
  owner: null,
  relayerCount: null,
};

export function RelayerRegistryPanel({ address }: { address: string }) {
  const { signer, readProvider } = useWallet();
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const [bondMeta, setBondMeta] = useState<{ decimals: number; symbol: string }>({
    decimals: 18,
    symbol: "ETH",
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void Promise.allSettled([
      c.minBond() as Promise<bigint>,
      c.treasury() as Promise<string>,
      c.identityRegistry() as Promise<string>,
      c.bondToken() as Promise<string>,
      c.owner() as Promise<string>,
      c.getRelayerCount() as Promise<bigint>,
    ]).then((rs) => {
      if (cancelled) return;
      const [minBond, treasury, identityRegistry, bondToken, owner, relayerCount] = rs;
      setSnap({
        minBond: minBond.status === "fulfilled" ? minBond.value : null,
        treasury: treasury.status === "fulfilled" ? treasury.value : null,
        identityRegistry: identityRegistry.status === "fulfilled" ? identityRegistry.value : null,
        bondToken: bondToken.status === "fulfilled" ? bondToken.value : null,
        owner: owner.status === "fulfilled" ? owner.value : null,
        relayerCount: relayerCount.status === "fulfilled" ? relayerCount.value : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  useEffect(() => {
    if (!snap.bondToken) return;
    if (!isConfiguredAddress(snap.bondToken)) {
      setBondMeta({ decimals: 18, symbol: "ETH" });
      return;
    }
    let cancelled = false;
    const erc = new Contract(snap.bondToken, ERC20_META, readProvider);
    void Promise.allSettled([
      erc.decimals() as Promise<number | bigint>,
      erc.symbol() as Promise<string>,
    ]).then(([d, s]) => {
      if (cancelled) return;
      setBondMeta({
        decimals: d.status === "fulfilled" ? Number(d.value) : 18,
        symbol: s.status === "fulfilled" ? s.value : "token",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [snap.bondToken, readProvider]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Stat
          label="Minimum bond"
          value={
            snap.minBond != null
              ? `${formatUnits(snap.minBond, bondMeta.decimals)} ${bondMeta.symbol}`
              : "…"
          }
          sub="Operator must post ≥ this to register"
          compact
        />
        <Stat
          label="Treasury"
          value={snap.treasury ? shortAddr(snap.treasury) : "…"}
          sub="Protocol fee destination"
          compact
        />
        <Stat
          label="Identity registry (CA)"
          value={snap.identityRegistry ? shortAddr(snap.identityRegistry) : "…"}
          sub="Operator-CA contract"
          compact
        />
        <Stat
          label="Bond token"
          value={
            snap.bondToken && isConfiguredAddress(snap.bondToken)
              ? shortAddr(snap.bondToken)
              : "Native (ETH)"
          }
          sub={
            snap.bondToken && isConfiguredAddress(snap.bondToken)
              ? `ERC20 · ${bondMeta.symbol}`
              : "Bonds posted as msg.value"
          }
          compact
        />
        <Stat
          label="Owner (multisig)"
          value={snap.owner ? shortAddr(snap.owner) : "…"}
          sub="Holds setMinBond / setTreasury / setIdentityRegistry"
          compact
        />
        <Stat
          label="Active relayers"
          value={snap.relayerCount != null ? snap.relayerCount.toString() : "…"}
          sub="Total registered operators"
          compact
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <MinBondEditor
          address={address}
          current={snap.minBond}
          decimals={bondMeta.decimals}
          symbol={bondMeta.symbol}
          onSuccess={reload}
          signer={signer}
        />
        <SetAddressCard
          title="Set treasury"
          description="RelayerRegistry.setTreasury(address) — protocol fee destination."
          submitLabel="Set treasury"
          fnName="setTreasury"
          contractAbi={ABI}
          contractAddress={address}
          current={snap.treasury}
          onSuccess={reload}
          signer={signer}
        />
        <SetAddressCard
          title="Set identity registry (Operator CA)"
          description="RelayerRegistry.setIdentityRegistry(address) — the contract RelayerRegistry asks isVerified() against."
          submitLabel="Set identity registry"
          fnName="setIdentityRegistry"
          contractAbi={ABI}
          contractAddress={address}
          current={snap.identityRegistry}
          onSuccess={reload}
          signer={signer}
        />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h3 className="text-sm font-semibold">Issue operator X.509</h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            After pointing <code className="font-mono">setIdentityRegistry()</code> at the right
            CA, issue an operator's X.509 cert and attest them on-chain.
          </p>
          <Link
            href="/operator-ca"
            className="mt-3 inline-block rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Open Operator CA →
          </Link>
        </div>
      </div>
    </section>
  );
}

function MinBondEditor({
  address,
  current,
  decimals,
  symbol,
  onSuccess,
  signer,
}: {
  address: string;
  current: bigint | null;
  decimals: number;
  symbol: string;
  onSuccess: () => void;
  signer: import("ethers").Signer | null;
}) {
  const [input, setInput] = useState("");

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    let amount: bigint;
    try {
      amount = parseUnits(input.trim(), decimals);
    } catch {
      throw new Error(`Invalid amount — must be a decimal number with up to ${decimals} places`);
    }
    if (amount < 0n) throw new Error("Bond must be non-negative");
    const c = new Contract(address, ABI, signer);
    return (await c.setMinBond(amount)) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [input, decimals, address, signer]);

  const validNumber = (() => {
    if (!input.trim()) return false;
    try {
      parseUnits(input.trim(), decimals);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <AdminWriteCard
      title="Set minimum bond"
      description={`RelayerRegistry.setMinBond(uint256) — denominated in ${symbol}.`}
      submitLabel={`Set to ${input || "—"} ${symbol}`}
      disabled={!validNumber}
      onSubmit={submit}
      onSuccess={onSuccess}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current:{" "}
        <strong>
          {current != null ? `${formatUnits(current, decimals)} ${symbol}` : "…"}
        </strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New bond ({symbol})
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          placeholder="0.0"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
    </AdminWriteCard>
  );
}

interface SetAddressCardProps {
  title: string;
  description: string;
  submitLabel: string;
  fnName: string;
  contractAbi: string[];
  contractAddress: string;
  current: string | null;
  onSuccess: () => void;
  signer: import("ethers").Signer | null;
}

function SetAddressCard({
  title,
  description,
  submitLabel,
  fnName,
  contractAbi,
  contractAddress,
  current,
  onSuccess,
  signer,
}: SetAddressCardProps) {
  const [input, setInput] = useState("");
  const valid = isValidEvmAddress(input.trim());

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (!valid) throw new Error("Invalid address");
    const c = new Contract(contractAddress, contractAbi, signer);
    return (await (c as unknown as Record<string, (a: string) => Promise<{
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    }>>)[fnName](input.trim())) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [valid, input, signer, contractAddress, contractAbi, fnName]);

  return (
    <AdminWriteCard
      title={title}
      description={description}
      submitLabel={submitLabel}
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        onSuccess();
      }}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current: <strong className="font-mono">{current ? shortAddr(current) : "…"}</strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New address
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
    </AdminWriteCard>
  );
}

