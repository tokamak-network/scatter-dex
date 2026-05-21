"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function addRegistry(address _registry) external",
  "function removeRegistry(address _registry) external",
  "function owner() external view returns (address)",
  "function getRegistryCount() external view returns (uint256)",
  "function getRegistries() external view returns (address[])",
];

interface Props {
  address: string;
}

/** IdentityGate aggregates multiple IdentityRegistry contracts via
 *  OR-combine. Admin adds/removes trusted registry addresses here.
 *  Current entries are read via `getRegistries()`. */
export function IdentityGatePanel({ address }: Props) {
  const { signer, readProvider } = useWallet();
  const [input, setInput] = useState("");
  const [registries, setRegistries] = useState<string[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const valid = isValidEvmAddress(input.trim());

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void c
      .getRegistries()
      .then((rs: string[]) => {
        if (!cancelled) setRegistries(rs);
      })
      .catch(() => {
        if (!cancelled) setRegistries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  const add = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    return invoke(signer, address, "addRegistry", input.trim());
  }, [signer, valid, input, address]);

  const remove = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    return invoke(signer, address, "removeRegistry", input.trim());
  }, [signer, valid, input, address]);

  return (
    <div className="space-y-4">
      <RegistryList registries={registries} />

      <AdminWriteCard
        title="Trusted IdentityRegistry set"
        description="IdentityGate aggregates multiple registries with OR-combine. Add a registry to trust it; remove to stop trusting."
        submitLabel="Add registry"
        secondaryLabel="Remove registry"
        disabled={!valid}
        secondaryDisabled={!valid}
        onSubmit={add}
        onSecondary={remove}
        onSuccess={() => {
          setInput("");
          setReloadKey((k) => k + 1);
        }}
      >
        <label className="block text-xs">
          <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
            Registry address
          </span>
          <input
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
            placeholder="0x…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
      </AdminWriteCard>
    </div>
  );
}

function RegistryList({ registries }: { registries: string[] | null }) {
  if (registries === null) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-text-muted)]">
        Reading registries…
      </div>
    );
  }
  if (registries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-text-muted)]">
        No registries trusted. Add one below to enable identity gating.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Current trusted set ({registries.length})
      </div>
      <ul className="space-y-1 text-xs">
        {registries.map((r) => (
          <li key={r} className="font-mono text-[var(--color-text-muted)]">
            {shortAddr(r)} · <span className="break-all">{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function invoke(signer: Signer, address: string, fn: string, arg: string) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<string, (a: string) => Promise<{
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    }>>
  )[fn];
  return (await setter(arg)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
