"use client";

import { useCallback, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function addRegistry(address _registry) external",
  "function removeRegistry(address _registry) external",
  "function owner() external view returns (address)",
];

interface Props {
  address: string;
}

/** IdentityGate aggregates multiple IdentityRegistry contracts via
 *  OR-combine. Admin adds/removes trusted registry addresses here.
 *  There's no on-chain enumerator, so the UI is action-driven rather
 *  than list-driven. */
export function IdentityGatePanel({ address }: Props) {
  const { signer } = useWallet();
  const [input, setInput] = useState("");
  const valid = isValidEvmAddress(input.trim());

  const add = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    return invoke(signer, address, "addRegistry", input.trim());
  }, [signer, valid, input, address]);

  const remove = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    return invoke(signer, address, "removeRegistry", input.trim());
  }, [signer, valid, input, address]);

  return (
    <AdminWriteCard
      title="Trusted IdentityRegistry set"
      description="IdentityGate aggregates multiple registries with OR-combine. Add a registry to trust it; remove to stop trusting."
      submitLabel="Add registry"
      secondaryLabel="Remove registry"
      disabled={!valid}
      secondaryDisabled={!valid}
      onSubmit={add}
      onSecondary={remove}
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
      <p className="text-[10px] text-[var(--color-text-subtle)]">
        Note: IdentityGate has no on-chain enumerator. Track current entries via
        AddedRegistry / RemovedRegistry events.
      </p>
    </AdminWriteCard>
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
