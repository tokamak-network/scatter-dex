"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

interface Props {
  /** Card heading. */
  title: string;
  /** One-line description; renders below the title. */
  description: string;
  /** Display name for the read of the current value (e.g. "Current sanctions list"). */
  readerLabel?: string;
  /** Contract being written to. */
  contractAddress: string;
  /** Full ABI fragment for the read function and the write setter. */
  contractAbi: string[];
  /** Name of the view that reads the current address. */
  readerFn: string;
  /** Name of the setter to invoke. */
  setterFn: string;
  /** Override the submit button label. */
  submitLabel?: string;
  /** Allow the zero address (e.g. setSanctionsList(0) → disable). */
  allowZeroAddress?: boolean;
}

/** Generic admin write surface: read a single-address slot from a
 *  contract and surface a setter that takes one address. Used for
 *  every "set a sub-contract address" admin operation
 *  (setSanctionsList, setIdentityGate, setRelayerRegistry, etc). */
export function SetAddressCard({
  title,
  description,
  readerLabel,
  contractAddress,
  contractAbi,
  readerFn,
  setterFn,
  submitLabel,
  allowZeroAddress,
}: Props) {
  const { signer, readProvider } = useWallet();
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(contractAddress, contractAbi, readProvider);
    const reader = (c as unknown as Record<string, () => Promise<string>>)[readerFn];
    void reader()
      .then((v) => {
        if (!cancelled) setCurrent(v);
      })
      .catch(() => {
        if (!cancelled) setCurrent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [contractAddress, contractAbi, readerFn, readProvider, reloadKey]);

  const trimmed = input.trim();
  const isZero =
    trimmed.toLowerCase() === "0x0000000000000000000000000000000000000000";
  const valid = isValidEvmAddress(trimmed) && (allowZeroAddress || !isZero);

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (!valid) throw new Error("Invalid address");
    return invoke(signer, contractAddress, contractAbi, setterFn, trimmed);
  }, [signer, valid, contractAddress, contractAbi, setterFn, trimmed]);

  return (
    <AdminWriteCard
      title={title}
      description={description}
      submitLabel={submitLabel ?? "Update"}
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        setReloadKey((k) => k + 1);
      }}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        {readerLabel ?? "Current"}:{" "}
        <strong className="font-mono">{current ? shortAddr(current) : "…"}</strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New address {allowZeroAddress && "(0x0 disables)"}
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

async function invoke(
  signer: Signer,
  address: string,
  abi: string[],
  fn: string,
  arg: string,
) {
  const c = new Contract(address, abi, signer);
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
