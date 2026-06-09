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
  exitCooldown: bigint | null;
}

const EMPTY: Snapshot = {
  minBond: null,
  treasury: null,
  identityRegistry: null,
  bondToken: null,
  owner: null,
  relayerCount: null,
  exitCooldown: null,
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
      c.exitCooldown() as Promise<bigint>,
    ]).then((rs) => {
      if (cancelled) return;
      const [minBond, treasury, identityRegistry, bondToken, owner, relayerCount, exitCooldown] = rs;
      setSnap({
        minBond: minBond.status === "fulfilled" ? minBond.value : null,
        treasury: treasury.status === "fulfilled" ? treasury.value : null,
        identityRegistry: identityRegistry.status === "fulfilled" ? identityRegistry.value : null,
        bondToken: bondToken.status === "fulfilled" ? bondToken.value : null,
        owner: owner.status === "fulfilled" ? owner.value : null,
        exitCooldown: exitCooldown.status === "fulfilled" ? exitCooldown.value : null,
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
        <Stat
          label="Exit cooldown"
          value={snap.exitCooldown != null ? formatDuration(snap.exitCooldown) : "…"}
          sub="Wait between requestExit and executeExit"
          compact
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <BondEditor
          address={address}
          currentToken={snap.bondToken}
          currentMinBond={snap.minBond}
          tokens={networkTokens}
          onSuccess={reload}
          signer={signer}
          rpcProvider={rpcProvider}
        />
        <ExitCooldownEditor
          address={address}
          current={snap.exitCooldown}
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

      <RelayersTable
        address={address}
        readProvider={readProvider}
        tokens={networkTokens}
        reloadKey={reloadKey}
        exitCooldown={snap.exitCooldown}
      />
    </section>
  );
}

interface RelayerRow {
  addr: string;
  name: string;
  url: string;
  feeBps: number;
  bond: bigint;
  bondToken: string;
  exitRequestedAt: number;
  active: boolean;
}

/** Read-only list of registered relayers with their bond (token + amount),
 *  fee, and exit status. Iterates `relayerList` so it surfaces both active and
 *  exiting relayers (a relayer stays `active` until `executeExit`). Each bond is
 *  shown in the token THAT relayer recorded at register time (per-relayer
 *  `bondToken`), formatted via the whitelist's decimals/symbol. */
function RelayersTable({
  address,
  readProvider,
  tokens,
  reloadKey,
  exitCooldown,
}: {
  address: string;
  readProvider: Provider;
  tokens: TokenInfo[];
  reloadKey: number;
  exitCooldown: bigint | null;
}) {
  const [rows, setRows] = useState<RelayerRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const c = new Contract(address, ABI, readProvider);
    (async () => {
      try {
        const count = Number((await c.getRelayerCount()) as bigint);
        const addrs = await Promise.all(
          Array.from({ length: count }, (_, i) => c.relayerList(i) as Promise<string>),
        );
        const all = await Promise.all(
          addrs.map(async (a): Promise<RelayerRow> => {
            const r = await c.relayers(a);
            return {
              addr: a,
              name: r.name ?? "",
              url: r.url ?? "",
              feeBps: Number(r.fee),
              bond: r.bond as bigint,
              bondToken: r.bondToken as string,
              exitRequestedAt: Number(r.exitRequestedAt),
              active: r.active as boolean,
            };
          }),
        );
        if (!cancelled) {
          // Hide fully-exited entries (active=false); keep active + exiting.
          setRows(all.filter((r) => r.active));
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, readProvider, reloadKey]);

  // token address → { symbol, decimals } from the whitelist (native = ETH/18).
  const tokenMeta = (tok: string): { symbol: string; decimals: number } => {
    if (!tok || !isConfiguredAddress(tok)) return { symbol: "ETH", decimals: 18 };
    const t = tokens.find((x) => eqAddr(x.address, tok));
    return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: "?", decimals: 18 };
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-3">
        <div className="font-medium">Registered relayers</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
          Active and exiting operators with their bond, fee, and status. Bond is shown
          in the token each relayer staked.
        </div>
      </div>
      {error ? (
        <div className="px-5 py-4 text-sm text-[var(--color-danger)]">
          ⚠ Failed to read the relayer list from the chain.
        </div>
      ) : rows == null ? (
        <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-4 text-sm text-[var(--color-text-muted)]">
          No relayers registered yet.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-2 text-left">Relayer</th>
              <th className="px-5 py-2 text-right">Bond</th>
              <th className="px-5 py-2 text-right">Fee</th>
              <th className="px-5 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = tokenMeta(r.bondToken);
              const exiting = r.exitRequestedAt > 0;
              const readyAt = exitCooldown != null ? r.exitRequestedAt + Number(exitCooldown) : null;
              return (
                <tr key={r.addr} className="border-t border-[var(--color-border)]">
                  <td className="px-5 py-3">
                    <div className="font-medium">{r.name || shortAddr(r.addr)}</div>
                    <div className="font-mono text-[10px] text-[var(--color-text-subtle)]">
                      {shortAddr(r.addr)}
                      {r.url ? ` · ${r.url}` : ""}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {formatUnits(r.bond, m.decimals)} {m.symbol}
                  </td>
                  <td className="px-5 py-3 text-right font-mono">
                    {(r.feeBps / 100).toFixed(2)}%
                  </td>
                  <td className="px-5 py-3 text-right">
                    {exiting ? (
                      <span className="text-[var(--color-warning)]">
                        Exiting
                        {readyAt
                          ? ` · ready ${new Date(readyAt * 1000).toISOString().slice(0, 16).replace("T", " ")}`
                          : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--color-success)]">Active</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Set the GLOBAL bond token AND minimum amount in ONE transaction
 *  (`setBond(token, minBond)`). Combining them avoids the foot-gun of changing
 *  the token while the amount stays denominated in the previous token's
 *  decimals — the amount field always re-denominates to the selected token.
 *  Existing relayers keep the token recorded at their register time, so a switch
 *  never strands a bond. Native ETH is `address(0)`. */
function BondEditor({
  address,
  currentToken,
  currentMinBond,
  tokens,
  onSuccess,
  signer,
  rpcProvider,
}: {
  address: string;
  currentToken: string | null;
  currentMinBond: bigint | null;
  tokens: TokenInfo[];
  onSuccess: () => void;
  signer: Signer | null;
  rpcProvider: Provider;
}) {
  // Native ETH (address(0)) + each whitelisted ERC20. If the on-chain bond
  // token isn't whitelisted, surface it as an "Unknown" option so the controlled
  // <select> always has a row matching the current value.
  const options = useMemo(() => {
    const base = [
      { value: ZERO_ADDRESS, label: "Native ETH — msg.value", symbol: "ETH", decimals: 18 },
      ...tokens
        .filter((t) => !t.isNative)
        .map((t) => ({
          value: t.address,
          label: `${t.symbol} · ${shortAddr(t.address)}`,
          symbol: t.symbol,
          decimals: t.decimals,
        })),
    ];
    if (currentToken && isConfiguredAddress(currentToken) && !base.some((o) => eqAddr(o.value, currentToken))) {
      base.push({ value: currentToken, label: `Unknown · ${shortAddr(currentToken)}`, symbol: "token", decimals: 18 });
    }
    return base;
  }, [tokens, currentToken]);

  const currentOption = useMemo(() => {
    if (!currentToken || !isConfiguredAddress(currentToken)) return options[0]!; // native ETH
    return options.find((o) => eqAddr(o.value, currentToken)) ?? options[0]!;
  }, [currentToken, options]);

  const [selected, setSelected] = useState<string>(currentOption.value);
  useEffect(() => setSelected(currentOption.value), [currentOption.value]);

  const selectedOption = useMemo(
    () => options.find((o) => o.value === selected) ?? options[0]!,
    [options, selected],
  );

  // Amount is denominated in the SELECTED token's decimals.
  const [amount, setAmount] = useState("");
  const parsedAmount = (() => {
    if (!amount.trim()) return null;
    try {
      const v = parseUnits(amount.trim(), selectedOption.decimals);
      return v >= 0n ? v : null;
    } catch {
      return null;
    }
  })();

  const tokenChanged = !eqAddr(selected, currentOption.value);
  // Valid to submit when the amount parses AND either the token or amount differs.
  const amountChanged = parsedAmount != null && parsedAmount !== currentMinBond;
  const canSubmit = parsedAmount != null && (tokenChanged || amountChanged);

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (parsedAmount == null) throw new Error("Enter a valid bond amount");
    const c = new Contract(address, ABI, signer);
    return runWrite(c, "setBond", [selected, parsedAmount], { estimateProvider: rpcProvider });
  }, [address, selected, parsedAmount, signer, rpcProvider]);

  return (
    <AdminWriteCard
      title="Set bond (token + amount)"
      description="RelayerRegistry.setBond(token, minBond) — sets the bond token and minimum amount together, in one transaction."
      submitLabel={`Set ${amount || "—"} ${selectedOption.symbol}`}
      disabled={!canSubmit}
      onSubmit={submit}
      onSuccess={onSuccess}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current:{" "}
        <strong>
          {currentMinBond != null
            ? `${formatUnits(currentMinBond, currentOption.decimals)} ${currentOption.symbol}`
            : "…"}
        </strong>{" "}
        <span className="text-[var(--color-text-subtle)]">({currentOption.label})</span>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Bond token
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
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Minimum bond ({selectedOption.symbol})
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Token + amount are set atomically. Existing relayers keep the token they
        bonded in; only new registrations use this. 0 makes the bond optional.
      </p>
    </AdminWriteCard>
  );
}

/** Format a duration in seconds as a compact "Nd Nh Nm Ns" string. */
function formatDuration(seconds: bigint): string {
  if (seconds === 0n) return "0 (immediate)";
  const parts: string[] = [];
  const units: [bigint, string][] = [
    [86400n, "d"],
    [3600n, "h"],
    [60n, "m"],
    [1n, "s"],
  ];
  let rem = seconds;
  for (const [size, suffix] of units) {
    const n = rem / size;
    if (n > 0n) parts.push(`${n}${suffix}`);
    rem %= size;
  }
  return parts.join(" ");
}

/** Set the exit cooldown (the wait between requestExit and executeExit). The
 *  input is in HOURS for ergonomics; the contract stores seconds (capped at
 *  MAX_EXIT_COOLDOWN = 30 days). */
function ExitCooldownEditor({
  address,
  current,
  onSuccess,
  signer,
  rpcProvider,
}: {
  address: string;
  current: bigint | null;
  onSuccess: () => void;
  signer: Signer | null;
  rpcProvider: Provider;
}) {
  const MAX_HOURS = 30 * 24; // MAX_EXIT_COOLDOWN
  const [hours, setHours] = useState("");

  const parsed = (() => {
    const t = hours.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > MAX_HOURS) return null;
    // Whole seconds; reject fractional seconds from odd hour inputs.
    const secs = Math.round(n * 3600);
    return BigInt(secs);
  })();

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (parsed == null) throw new Error(`Enter hours between 0 and ${MAX_HOURS}`);
    const c = new Contract(address, ABI, signer);
    return runWrite(c, "setExitCooldown", [parsed], { estimateProvider: rpcProvider });
  }, [address, parsed, signer, rpcProvider, MAX_HOURS]);

  return (
    <AdminWriteCard
      title="Set exit cooldown"
      description="RelayerRegistry.setExitCooldown(seconds) — the wait between requestExit and executeExit. Max 30 days."
      submitLabel={parsed != null ? `Set to ${formatDuration(parsed)}` : "Set exit cooldown"}
      disabled={parsed == null}
      onSubmit={submit}
      onSuccess={onSuccess}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current: <strong>{current != null ? formatDuration(current) : "…"}</strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New cooldown — in HOURS (max {MAX_HOURS}h = 30d)
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={MAX_HOURS}
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="168"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
          <span className="font-mono text-[var(--color-text-muted)]">
            hours = {parsed != null ? formatDuration(parsed) : "—"}
          </span>
        </div>
      </label>
      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Enter HOURS (e.g. 168 = 7 days, 24 = 1 day, 0 = immediate exit). Applied
        live: shortening lets relayers already mid-exit out sooner. Default 168h (7d).
      </p>
    </AdminWriteCard>
  );
}

