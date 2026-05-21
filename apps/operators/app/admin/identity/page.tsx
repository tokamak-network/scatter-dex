"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { RELAYER_REGISTRY_ABI } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { RelayerRegistryAdminProvider, useRelayerRegistryAdmin } from "../../lib/identity";
import { SectionHeader } from "../../components/SectionHeader";
import { Stat } from "../../components/Stat";

export default function AdminIdentityPage() {
  return (
    <RelayerRegistryAdminProvider>
      <AdminIdentityPageInner />
    </RelayerRegistryAdminProvider>
  );
}

function roleLabel(args: {
  account: string | null;
  snapshot: unknown;
  isOwner: boolean;
}): string {
  if (!args.account) return "Disconnected";
  if (!args.snapshot) return "Loading…";
  return args.isOwner ? "Owner" : "Read-only";
}

function AdminIdentityPageInner() {
  const { account, signer, connect } = useWallet();
  const { snapshot, loading, error, refresh } = useRelayerRegistryAdmin();
  const registryAddress = DEMO_NETWORK.contracts.relayerRegistry;
  const isOwner =
    !!account &&
    !!snapshot &&
    account.toLowerCase() === snapshot.owner.toLowerCase();
  // Hoist the signer-bound contract so each ActionCard's onSubmit is
  // a one-liner (`registry.setX(value)`) instead of rebuilding it per
  // submit. `null` when the wallet hasn't connected — disables every
  // write button via `!signer` guard above.
  const writeRegistry = useMemo(
    () =>
      signer ? new ethers.Contract(registryAddress, RELAYER_REGISTRY_ABI, signer) : null,
    [signer, registryAddress],
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">RelayerRegistry authorities (admin)</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Owner-controlled parameters for{" "}
          <code className="font-mono">RelayerRegistry</code>. Non-owners can
          audit this page; mutating actions are disabled.
        </p>
      </header>

      {!account && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
          <button
            onClick={connect}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Connect wallet
          </button>
          <span className="ml-3 text-[var(--color-text-muted)]">
            to manage authorities (read-only view also available).
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <section>
        <SectionHeader title="Current state" badge={loading ? "loading…" : "live"} />
        <div className="grid grid-cols-2 gap-4">
          <Stat
            label="Contract"
            value={registryAddress ? shortAddr(registryAddress) : "—"}
            sub="RelayerRegistry proxy"
          />
          <Stat
            label="Owner"
            value={snapshot ? shortAddr(snapshot.owner) : "—"}
            sub={
              snapshot?.pendingOwner
                ? `Pending: ${shortAddr(snapshot.pendingOwner)}`
                : "Ownable2Step (single)"
            }
          />
          <Stat
            label="IdentityRegistry (CA)"
            value={snapshot ? shortAddr(snapshot.identityRegistry) : "—"}
            sub="Gates register() via isVerified()"
          />
          <Stat
            label="Treasury"
            value={snapshot ? shortAddr(snapshot.treasury) : "—"}
            sub="Receives fee splits"
          />
          <Stat
            label="Minimum bond"
            value={
              snapshot ? `${ethers.formatEther(snapshot.minBond)} ETH` : "—"
            }
            sub="0 = bond optional"
          />
          <Stat
            label="Your role"
            value={roleLabel({ account, snapshot, isOwner })}
            sub={account ? shortAddr(account) : ""}
          />
        </div>
      </section>

      {snapshot && (
        <>
          <ActionCard
            title="Swap IdentityRegistry (CA)"
            description="Replaces the registry that gates register() — does not affect already-registered relayers."
            fieldLabel="New IdentityRegistry address"
            placeholder="0x…"
            currentValue={snapshot.identityRegistry}
            disabled={!isOwner || !signer}
            onSubmit={async (value) => {
              const tx = await writeRegistry!.setIdentityRegistry(value);
              await tx.wait();
              return tx.hash;
            }}
            validate={validateAddress}
            onDone={refresh}
          />

          <ActionCard
            title="Change treasury"
            description="Address that receives the protocol's fee splits."
            fieldLabel="New treasury address"
            placeholder="0x…"
            currentValue={snapshot.treasury}
            disabled={!isOwner || !signer}
            onSubmit={async (value) => {
              const tx = await writeRegistry!.setTreasury(value);
              await tx.wait();
              return tx.hash;
            }}
            validate={validateAddress}
            onDone={refresh}
          />

          <ActionCard
            title="Set minimum bond"
            description="ETH amount a new relayer must post on register(). Set to 0 to make bond optional."
            fieldLabel="Minimum bond (ETH)"
            placeholder="0.1"
            currentValue={ethers.formatEther(snapshot.minBond)}
            disabled={!isOwner || !signer}
            onSubmit={async (value) => {
              const tx = await writeRegistry!.setMinBond(ethers.parseEther(value));
              await tx.wait();
              return tx.hash;
            }}
            validate={validateEth}
            onDone={refresh}
          />

          <ActionCard
            title="Transfer ownership"
            description="Two-step (Ownable2Step) — the new owner must call acceptOwnership() to finalize."
            fieldLabel="New owner address"
            placeholder="0x…"
            currentValue={snapshot.owner}
            disabled={!isOwner || !signer}
            onSubmit={async (value) => {
              const tx = await writeRegistry!.transferOwnership(value);
              await tx.wait();
              return tx.hash;
            }}
            validate={validateAddress}
            onDone={refresh}
          />
        </>
      )}

      <p className="text-xs text-[var(--color-text-subtle)]">
        Looking for your own verification status?{" "}
        <Link href="/operator-ca" className="text-[var(--color-primary)] hover:underline">
          /operator-ca
        </Link>{" "}
        — Pay/Pro&apos;s admin console is at{" "}
        <code className="font-mono">/admin/identity</code> in those apps and
        controls the multi-CA <code className="font-mono">IdentityGate</code>.
      </p>
    </div>
  );
}

function validateAddress(value: string): string | null {
  if (!value) return "address required";
  if (!ethers.isAddress(value)) return "not a valid 0x address";
  if (value.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    return "zero address rejected on-chain";
  }
  return null;
}

function validateEth(value: string): string | null {
  if (!value) return "amount required";
  try {
    ethers.parseEther(value);
    return null;
  } catch {
    return "not a valid ETH amount";
  }
}

interface ActionCardProps {
  title: string;
  description: string;
  fieldLabel: string;
  placeholder: string;
  currentValue: string;
  disabled: boolean;
  validate: (value: string) => string | null;
  onSubmit: (value: string) => Promise<string>;
  onDone: () => void;
}

function ActionCard({
  title,
  description,
  fieldLabel,
  placeholder,
  currentValue,
  disabled,
  validate,
  onSubmit,
  onDone,
}: ActionCardProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setErr(null);
    setTxHash(null);
    // Validate the trimmed form so " 0x… " (paste with whitespace)
    // passes validation iff submit() would actually accept it.
    const trimmed = value.trim();
    const validationErr = validate(trimmed);
    if (validationErr) {
      setErr(validationErr);
      return;
    }
    setBusy(true);
    try {
      const hash = await onSubmit(trimmed);
      setTxHash(hash);
      setValue("");
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [value, validate, onSubmit, onDone]);

  return (
    <section className="rounded-md border border-[var(--color-border)] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{description}</p>
      <p className="mt-2 text-xs">
        <span className="text-[var(--color-text-subtle)]">Current:</span>{" "}
        <code className="font-mono">{currentValue}</code>
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[260px]">
          <span className="block text-xs text-[var(--color-text-muted)]">{fieldLabel}</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            disabled={disabled || busy}
            className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 font-mono text-xs disabled:opacity-60"
          />
        </label>
        <button
          onClick={submit}
          disabled={disabled || busy || !value}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {busy ? "Submitting…" : "Apply"}
        </button>
      </div>
      {err && (
        <p className="mt-2 text-xs text-[var(--color-danger)]">{err}</p>
      )}
      {txHash && (
        <p className="mt-2 text-xs text-[var(--color-success)]">
          ✓ Tx: <code className="font-mono">{txHash}</code>
        </p>
      )}
    </section>
  );
}
