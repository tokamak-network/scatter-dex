"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Contract, formatUnits, parseUnits, type Provider, type Signer } from "ethers";
import {
  eqAddr,
  isConfiguredAddress,
  RELAYER_REGISTRY_ABI,
  runWrite,
  ZERO_ADDRESS,
  type TokenInfo,
} from "@zkscatter/sdk";
import { shortAddr, useNetworkTokens, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { Stat } from "../../components/Stat";
import { DEMO_NETWORK } from "../../lib/network";

// Single source of truth for the RelayerRegistry shape — no local subset.
const ABI = RELAYER_REGISTRY_ABI;

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
  const { signer, readProvider, rpcProvider } = useWallet();
  // Whitelisted tokens (Pool∩Settlement) to offer as bond-token choices.
  const { tokens: networkTokens } = useNetworkTokens(DEMO_NETWORK);
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
    // The whitelist already carries decimals/symbol — reuse it and skip the
    // extra on-chain reads when the bond token is one of those tokens.
    const known = networkTokens.find((t) => eqAddr(t.address, snap.bondToken!));
    if (known) {
      setBondMeta({ decimals: known.decimals, symbol: known.symbol });
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
  }, [snap.bondToken, readProvider, networkTokens]);

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
        <BondTokenEditor
          address={address}
          current={snap.bondToken}
          tokens={networkTokens}
          onSuccess={reload}
          signer={signer}
          rpcProvider={rpcProvider}
        />
        <MinBondEditor
          address={address}
          current={snap.minBond}
          decimals={bondMeta.decimals}
          symbol={bondMeta.symbol}
          onSuccess={reload}
          signer={signer}
          rpcProvider={rpcProvider}
        />
        {/* `setTreasury` was here too. Removed for the same reason as
            FeeVault.setTreasury — it's a one-shot deploy-time op that
            rarely (if ever) changes in practice, and a wrong-address
            click on this card would redirect every future protocol fee
            stream. If a multisig migration ever becomes necessary, call
            it via cast/forge with full review. */}
        {/* Identity-registry swap + operator X.509 issuance moved out
            of the RelayerRegistry tab so this surface stays focused on
            bond / treasury / counts. Identity is split into two sibling
            sub-routes — /protocol/identity-user (user-side IdentityGate
            trusted set) and /protocol/identity-relayer (operator CA
            swap). The link below points at the relayer-side route since
            that's the op this card was previously hosting. */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 md:col-span-2">
          <h3 className="text-sm font-semibold">Identity (CA) management</h3>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Swap the operator CA that <code className="font-mono">register()</code>{" "}
            verifies against, or manage the user-side trusted set, from the dedicated
            Identity tab.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/protocol/identity-relayer"
              className="inline-block rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)]"
            >
              Open Relayer Identity tab →
            </Link>
            <Link
              href="/operator-ca"
              className="inline-block rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Issue operator X.509 →
            </Link>
          </div>
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
  rpcProvider,
}: {
  address: string;
  current: bigint | null;
  decimals: number;
  symbol: string;
  onSuccess: () => void;
  signer: Signer | null;
  rpcProvider: Provider;
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
    return runWrite(c, "setMinBond", [amount], { estimateProvider: rpcProvider });
  }, [input, decimals, address, signer, rpcProvider]);

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

/** Set the GLOBAL bond token NEW registrations stake in — a whitelisted ERC20
 *  or native ETH (`address(0)`). Existing relayers keep the token recorded at
 *  their register time, so a switch never strands a bond. The minimum-bond
 *  amount is denominated in the chosen token's units; after changing the token,
 *  re-set the amount in the "Set minimum bond" card with the right decimals. */
function BondTokenEditor({
  address,
  current,
  tokens,
  onSuccess,
  signer,
  rpcProvider,
}: {
  address: string;
  current: string | null;
  tokens: TokenInfo[];
  onSuccess: () => void;
  signer: Signer | null;
  rpcProvider: Provider;
}) {
  // Native ETH (address(0)) + each whitelisted ERC20 (drop the synthetic
  // native-ETH alias so ETH appears exactly once, as the address(0) option).
  // If the on-chain bond token isn't whitelisted, surface it as an "Unknown"
  // option so the controlled <select> always has a row matching the current
  // value (otherwise it renders blank).
  const options = useMemo(() => {
    const base = [
      { value: ZERO_ADDRESS, label: "Native ETH — msg.value", symbol: "ETH" },
      ...tokens
        .filter((t) => !t.isNative)
        .map((t) => ({ value: t.address, label: `${t.symbol} · ${shortAddr(t.address)}`, symbol: t.symbol })),
    ];
    if (current && isConfiguredAddress(current) && !base.some((o) => eqAddr(o.value, current))) {
      base.push({ value: current, label: `Unknown · ${shortAddr(current)}`, symbol: "token" });
    }
    return base;
  }, [tokens, current]);

  // Resolve the on-chain bond token to its option (value + label) once.
  const currentOption = useMemo(() => {
    if (!current || !isConfiguredAddress(current)) return options[0]!; // native ETH
    return options.find((o) => eqAddr(o.value, current)) ?? options[0]!;
  }, [current, options]);

  const [selected, setSelected] = useState<string>(currentOption.value);
  useEffect(() => setSelected(currentOption.value), [currentOption.value]);

  const changed = !eqAddr(selected, currentOption.value);

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    const c = new Contract(address, ABI, signer);
    return runWrite(c, "setBondToken", [selected], { estimateProvider: rpcProvider });
  }, [address, selected, signer, rpcProvider]);

  const selLabel = useMemo(
    () => options.find((o) => o.value === selected)?.symbol ?? "token",
    [options, selected],
  );

  return (
    <AdminWriteCard
      title="Set bond token"
      description="RelayerRegistry.setBondToken(address) — the token new relayers bond in. Whitelisted ERC20 or native ETH."
      submitLabel={`Set bond token to ${selLabel}`}
      disabled={!changed}
      onSubmit={submit}
      onSuccess={onSuccess}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current: <strong>{currentOption.label}</strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New bond token
        </span>
        <select
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Existing relayers keep the token they bonded in; only new registrations use
        this. After changing, re-set the minimum bond in its own units.
      </p>
    </AdminWriteCard>
  );
}

