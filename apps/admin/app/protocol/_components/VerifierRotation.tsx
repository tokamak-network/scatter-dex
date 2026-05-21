"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, type Signer } from "ethers";
import { ZERO_ADDRESS, eqAddr } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function authorizeVerifierByTier(uint8 tier) external view returns (address)",
  "function claimVerifierByTier(uint8 tier) external view returns (address)",
  "function batchAuthorizeVerifierByTier(uint8 tier) external view returns (address)",
  "function cancelVerifier() external view returns (address)",
  "function setAuthorizeVerifier(uint8 tier, address _verifier) external",
  "function setClaimVerifier(uint8 tier, address _verifier) external",
  "function setBatchAuthorizeVerifier(uint8 tier, address _verifier) external",
  "function setCancelVerifier(address _verifier) external",
];

// Tier values match the on-chain `maxClaimsPerSide` per-side bound.
// PrivateSettlement seeds tier 16 in initialize() and tests exercise
// 16/64/128; other values are treated as unknown tiers and revert.
const DEFAULT_TIER = 16;
const TIER_OPTIONS = [16, 64, 128] as const;

type TierKind = "authorize" | "claim" | "batchAuthorize";

interface TierVerifierProps {
  address: string;
  kind: TierKind;
}

const KIND_META: Record<TierKind, {
  label: string;
  readerFn: string;
  setterFn: string;
  description: string;
}> = {
  authorize: {
    label: "Authorize verifier (per tier)",
    readerFn: "authorizeVerifierByTier",
    setterFn: "setAuthorizeVerifier",
    description:
      "PrivateSettlement.setAuthorizeVerifier(uint8 tier, address). Rotation is high-risk: the verifier validates proof-of-knowledge for settles at this tier.",
  },
  claim: {
    label: "Claim verifier (per tier)",
    readerFn: "claimVerifierByTier",
    setterFn: "setClaimVerifier",
    description:
      "PrivateSettlement.setClaimVerifier(uint8 tier, address). Validates withdraw / claim proofs for this tier.",
  },
  batchAuthorize: {
    label: "Batch-authorize verifier (per tier)",
    readerFn: "batchAuthorizeVerifierByTier",
    setterFn: "setBatchAuthorizeVerifier",
    description:
      "PrivateSettlement.setBatchAuthorizeVerifier(uint8 tier, address). Optional batch path; safe to leave zero if not used.",
  },
};

export function VerifierRotation({ address }: { address: string }) {
  return (
    <div className="space-y-4">
      <TierVerifierCard address={address} kind="authorize" />
      <TierVerifierCard address={address} kind="claim" />
      <TierVerifierCard address={address} kind="batchAuthorize" />
      <CancelVerifierCard address={address} />
    </div>
  );
}

function TierVerifierCard({ address, kind }: TierVerifierProps) {
  const { signer, readProvider } = useWallet();
  const meta = KIND_META[kind];
  const [tier, setTier] = useState<number>(DEFAULT_TIER);
  const [input, setInput] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    const reader = (
      c as unknown as Record<string, (t: number) => Promise<string>>
    )[meta.readerFn];
    void reader(tier)
      .then((v) => {
        if (!cancelled) setCurrent(v);
      })
      .catch(() => {
        if (!cancelled) setCurrent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, meta.readerFn, tier, reloadKey]);

  const trimmed = input.trim();
  // Allow 0x0 here — clearing a verifier is a legitimate
  // (if dangerous) admin op for tiers that aren't in use.
  const valid = isValidEvmAddress(trimmed) || eqAddr(trimmed, ZERO_ADDRESS);

  const submit = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    return invokeTier(signer, address, meta.setterFn, tier, trimmed);
  }, [signer, valid, address, meta.setterFn, tier, trimmed]);

  return (
    <AdminWriteCard
      title={meta.label}
      description={meta.description}
      submitLabel="Rotate verifier"
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        setReloadKey((k) => k + 1);
      }}
    >
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="uppercase tracking-wide text-[var(--color-text-subtle)]">Tier</span>
          <select
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
            value={tier}
            onChange={(e) => setTier(Number(e.target.value))}
          >
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[var(--color-text-muted)]">
          Current:{" "}
          <strong className="font-mono">
            {current
              ? eqAddr(current, ZERO_ADDRESS)
                ? "0x0 (unset)"
                : shortAddr(current)
              : "…"}
          </strong>
        </span>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New verifier address (0x0 to clear)
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

function CancelVerifierCard({ address }: { address: string }) {
  const { signer, readProvider } = useWallet();
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    void c
      .cancelVerifier()
      .then((v: string) => {
        if (!cancelled) setCurrent(v);
      })
      .catch(() => {
        if (!cancelled) setCurrent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  const trimmed = input.trim();
  const valid = isValidEvmAddress(trimmed) || eqAddr(trimmed, ZERO_ADDRESS);

  const submit = useCallback(async () => {
    if (!signer || !valid) throw new Error("Invalid input");
    const c = new Contract(address, ABI, signer);
    return (await c.setCancelVerifier(trimmed)) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [signer, valid, address, trimmed]);

  return (
    <AdminWriteCard
      title="Cancel verifier (single)"
      description="PrivateSettlement.setCancelVerifier(address). Non-tier; verifies cancel-order proofs."
      submitLabel="Rotate cancel verifier"
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        setReloadKey((k) => k + 1);
      }}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current:{" "}
        <strong className="font-mono">
          {current
            ? eqAddr(current, ZERO_ADDRESS)
              ? "0x0 (unset — cancel disabled)"
              : shortAddr(current)
            : "…"}
        </strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New verifier (0x0 disables cancel)
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

async function invokeTier(
  signer: Signer,
  address: string,
  fn: string,
  tier: number,
  verifier: string,
) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<
      string,
      (t: number, v: string) => Promise<{
        hash: string;
        wait(): Promise<{ hash?: string } | null>;
      }>
    >
  )[fn];
  return (await setter(tier, verifier)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
