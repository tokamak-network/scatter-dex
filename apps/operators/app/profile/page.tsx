"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  addRelayerBond,
  approveBondToken,
  EXIT_COOLDOWN_SECONDS,
  executeRelayerExit,
  loadBondAllowance,
  MAX_RELAYER_FEE_BPS,
  NATIVE_BOND_TOKEN,
  requestRelayerExit,
  updateRelayerInfo,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { WriteResult } from "../components/WriteResult";
import { DEMO_NETWORK } from "../lib/network";
import { useOperator, type OperatorState } from "../lib/useOperator";
import { useRegistryWrite } from "../lib/useRegistryWrite";
import type { WritePhase } from "../lib/useChainWrite";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

/** Render bond amount with a unit. Native bonds get "ETH"; ERC20
 *  bonds drop the unit because we don't carry the token symbol on
 *  the operator row, and labelling an arbitrary ERC20 amount as
 *  "ETH" would mislead operators on networks where the registry
 *  is configured in token mode. */
function bondLabel(row: NonNullable<OperatorState["row"]>): string {
  return row.bondToken === NATIVE_BOND_TOKEN ? `${row.bondEth} ETH` : row.bondEth;
}

export default function ProfilePage() {
  const operator = useOperator();
  const { registryDeployed: deployed } = operator;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <OperatorIdentityBar />
      <header>
        <Link href="/dashboard" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Relayer profile</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Endpoint and fee are recorded on-chain; bond + exit cool-down are
          managed below. Off-chain metadata (display name, description, social
          links) ships when the relayer-node config flow lands.
        </p>
      </header>

      {!deployed && (
        <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-sm">
          RelayerRegistry not yet deployed on {DEMO_NETWORK.name}. The forms below
          are wired through the SDK and will submit real transactions once a
          registry address is configured.
        </div>
      )}

      <OnChainSettings operator={operator} />
      <BondPanel operator={operator} />
      <ExitPanel operator={operator} />
    </div>
  );
}

function OnChainSettings({ operator }: { operator: OperatorState }) {
  const { signer } = useWallet();
  const { row, refresh, registryDeployed } = operator;
  // updateInfo can't raise InsufficientBond, so omit minBond — passing
  // the operator's current bond would give wrong copy if the helper
  // is later reused for a path that does raise it.
  const write = useRegistryWrite({ onSuccess: refresh });

  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [feeBps, setFeeBps] = useState("");
  const seeded = useRef(false);

  // Seed the form from the on-chain row exactly once, after the
  // first successful read. We don't re-sync on subsequent refreshes
  // because that would silently clobber any in-progress edits when
  // the user-driven `refresh()` resolves.
  useEffect(() => {
    if (!row || seeded.current) return;
    setUrl(row.url);
    setName(row.name);
    setFeeBps(String(row.feeBps));
    seeded.current = true;
  }, [row]);

  const onSave = () => {
    if (!signer) return;
    write.run(() => updateRelayerInfo(REGISTRY, { url, name, feeBps: Number(feeBps) }, signer));
  };

  const dirty = !!row && (url !== row.url || name !== row.name || feeBps !== String(row.feeBps));
  const disabled =
    !signer || !registryDeployed || !row || row.status !== "active" ||
    !dirty || write.phase.kind === "submitting";

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-4 font-semibold">On-chain settings</h2>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Updating these fields submits a transaction to{" "}
        <code className="font-mono">RelayerRegistry.updateInfo()</code>.
      </p>
      <div className="grid grid-cols-2 gap-5">
        <Field label="Endpoint URL">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
          />
        </Field>
        <Field label="Display name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            placeholder="Acme Relayer"
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Fee (bps)">
          <input
            type="number"
            min={0}
            max={MAX_RELAYER_FEE_BPS}
            value={feeBps}
            onChange={(e) => setFeeBps(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
          />
        </Field>
      </div>

      <WriteResult phase={write.phase} />

      <button
        onClick={onSave}
        disabled={disabled}
        className="mt-5 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {write.phase.kind === "submitting" ? "Saving…" : "Save on-chain settings"}
      </button>
    </section>
  );
}

function BondPanel({ operator }: { operator: OperatorState }) {
  const { signer, account, readProvider } = useWallet();
  const { row, refresh, registryDeployed } = operator;
  const write = useRegistryWrite({ onSuccess: refresh });

  const [topUp, setTopUp] = useState("0.05");
  // Tracks the ERC20 approve step separately from the addBond write,
  // so the button can label them distinctly. Native mode skips
  // approving entirely and behaves exactly as before.
  const [approving, setApproving] = useState(false);

  const isErc20 = !!row && row.bondToken !== NATIVE_BOND_TOKEN;

  const onTopUp = async () => {
    if (!signer || !row || !account) return;
    if (isErc20) {
      // Read live allowance just before submit so a recent approval
      // (or revoke) on another tab is reflected without an extra
      // long-lived state slot.
      try {
        setApproving(true);
        const allowance = await loadBondAllowance(REGISTRY, row.bondToken, account, readProvider);
        const needed = parseEth(topUp);
        if (needed !== null && allowance < needed) {
          const approveTx = await approveBondToken(row.bondToken, REGISTRY, topUp, signer);
          await approveTx.wait();
        }
      } catch (err) {
        // Surface approve failures through the same WriteResult banner.
        // Re-throwing into write.run() would attempt the addBond anyway,
        // which is wrong on a failed approval.
        write.fail(err);
        setApproving(false);
        return;
      } finally {
        setApproving(false);
      }
    }
    // Pass the bondToken explicitly so addRelayerBond doesn't have to
    // re-read it from the registry — saves one RPC vs. the omit-arg path.
    write.run(() => addRelayerBond(REGISTRY, topUp, signer, row.bondToken));
  };

  const busy = approving || write.phase.kind === "submitting";
  const disabled =
    !signer || !registryDeployed || !row || row.status !== "active" || busy;

  const buttonLabel =
    approving ? "Approving…" :
    write.phase.kind === "submitting" ? "Submitting…" :
    "Top up";

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-4 font-semibold">Bond</h2>
      <div className="grid grid-cols-2 gap-4">
        <Stat
          compact
          label="Current bond"
          value={row ? bondLabel(row) : "—"}
          sub={row ? `Status: ${row.status}` : "Connect wallet to load"}
        />
        <Stat
          compact
          label="Bond at risk"
          value="None today"
          sub="No slashing path in current registry"
        />
      </div>
      <div className="mt-5 flex items-end gap-3">
        <Field label="Add bond">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="0.01"
              value={topUp}
              onChange={(e) => setTopUp(e.target.value)}
              className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
            />
            <span className="text-sm text-[var(--color-text-muted)]">ETH</span>
          </div>
        </Field>
        <button
          onClick={onTopUp}
          disabled={disabled}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </div>
      <WriteResult phase={write.phase} />
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        {isErc20
          ? <>Calls <code className="font-mono">ERC20.approve()</code> then <code className="font-mono">RelayerRegistry.addBond()</code>. Approval is skipped if existing allowance is sufficient.</>
          : <>Calls <code className="font-mono">RelayerRegistry.addBond()</code>. Larger bonds increase trust signaling but lock more capital.</>}
      </p>
    </section>
  );
}

/** Parse a decimal-ETH string into 18-decimal base units, returning
 *  null on bad input (so the caller can decide whether to halt or
 *  fall through). Stays out of `useChainWrite` because it's only
 *  used here.
 *
 *  Behaviour aligned with `ethers.parseEther` for the inputs we
 *  accept: a leading-decimal form like `.5` is treated as `0.5`,
 *  and more than 18 fractional digits is rejected (rather than
 *  silently truncated) so the parser doesn't disagree with the
 *  SDK helper that runs at submit time. */
function parseEth(input: string): bigint | null {
  if (!/^[0-9]*\.?[0-9]+$/.test(input)) return null;
  const [rawWhole, frac = ""] = input.split(".");
  if (frac.length > 18) return null;
  const whole = rawWhole === "" ? "0" : rawWhole;
  const fracPadded = frac.padEnd(18, "0");
  try {
    return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
  } catch {
    return null;
  }
}

function ExitPanel({ operator }: { operator: OperatorState }) {
  const { signer } = useWallet();
  const { row, refresh, registryDeployed, account, loading } = operator;
  const write = useRegistryWrite({ onSuccess: refresh });

  // Render an explicit placeholder for each "can't act yet" state
  // instead of disappearing — same convention BondCard / FeeCard
  // / RegisteredCard follow on the dashboard.
  if (!account) return <ExitHint>Connect a wallet to manage exit and bond.</ExitHint>;
  if (!registryDeployed) return <ExitHint>Registry not deployed on {DEMO_NETWORK.name}.</ExitHint>;
  if (loading || !row) return <ExitHint>Reading registry…</ExitHint>;

  if (row.status === "active") {
    return <ActiveExitPanel row={row} signer={signer} write={write} />;
  }

  if (row.status === "cooldown") {
    return (
      <CooldownPanel
        row={row}
        signer={signer}
        phase={write.phase}
        onExecute={() => signer && write.run(() => executeRelayerExit(REGISTRY, signer))}
      />
    );
  }

  if (row.status === "unregistered") {
    return (
      <ExitHint>
        Not registered yet. <Link href="/register" className="font-medium text-[var(--color-primary)] hover:underline">Register a relayer →</Link> to enable exit and bond management.
      </ExitHint>
    );
  }
  return <ExitHint>Relayer is offline. Re-register before performing further actions.</ExitHint>;
}

function ActiveExitPanel({
  row,
  signer,
  write,
}: {
  row: NonNullable<OperatorState["row"]>;
  signer: ReturnType<typeof useWallet>["signer"];
  write: ReturnType<typeof useRegistryWrite>;
}) {
  const [confirming, setConfirming] = useState(false);
  const submitting = write.phase.kind === "submitting";

  const onCancel = () => {
    setConfirming(false);
    write.reset();
  };

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-warning-soft)] p-6">
      <h2 className="mb-2 font-semibold text-[var(--color-warning)]">Exit registry</h2>
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Starts a {Math.round(EXIT_COOLDOWN_SECONDS / 86400)}-day cool-down on{" "}
        <code className="font-mono">RelayerRegistry</code>. After the cool-down,
        executing exit returns your full bond ({bondLabel(row)}) and removes
        you from the active relayer set.
      </p>

      <ul className="mb-4 space-y-1.5 rounded-lg border border-[var(--color-warning)] bg-white px-4 py-3 text-xs text-[var(--color-text-muted)]">
        <li>
          <span className="font-medium text-[var(--color-text)]">Effective immediately:</span>{" "}
          <code className="font-mono">isActiveRelayer</code> returns{" "}
          <code className="font-mono">false</code>. New orders <em>and</em>{" "}
          settlement of in-flight orders both revert with{" "}
          <code className="font-mono">NotActiveRelayer</code>.
        </li>
        <li>
          <span className="font-medium text-[var(--color-text)]">Recommended before clicking:</span>{" "}
          drain your pending settlement queue, otherwise those orders will
          fail and likely be picked up by another relayer.
        </li>
        <li>
          <span className="font-medium text-[var(--color-text)]">Re-registration:</span>{" "}
          allowed after <code className="font-mono">executeExit</code> — same
          bond requirement as a fresh registration.
        </li>
      </ul>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={!signer}
          className="rounded-lg border border-[var(--color-warning)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Request exit…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() =>
              signer && write.run(() => requestRelayerExit(REGISTRY, signer))
            }
            disabled={!signer || submitting}
            className="rounded-lg bg-[var(--color-warning)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Submitting…" : "Confirm — request exit"}
          </button>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg border border-[var(--color-border-strong)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      )}
      <WriteResult phase={write.phase} />
    </section>
  );
}

function ExitHint({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
      {children}
    </section>
  );
}

function CooldownPanel({
  row,
  signer,
  phase,
  onExecute,
}: {
  row: NonNullable<OperatorState["row"]>;
  signer: ReturnType<typeof useWallet>["signer"];
  phase: WritePhase;
  onExecute: () => void;
}) {
  const readyAtSeconds = row.exitRequestedAt + EXIT_COOLDOWN_SECONDS;
  // `now` stays undefined on the SSR pass so we don't bake the
  // server's clock into the markup (Next would flag a hydration
  // mismatch). The effect populates it on mount and ticks once a
  // minute — minutes is the smallest displayed unit, finer ticks
  // would waste renders.
  const [now, setNow] = useState<number | undefined>(undefined);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  if (now === undefined) {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-6 text-sm text-[var(--color-text-muted)]">
        Loading cool-down…
      </section>
    );
  }

  const remaining = readyAtSeconds - now;
  const ready = remaining <= 0;

  return (
    <section className={`rounded-xl border p-6 ${ready ? "border-[var(--color-success)] bg-[var(--color-success-soft)]" : "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"}`}>
      <h2 className={`mb-2 font-semibold ${ready ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
        {ready ? "Bond ready to withdraw" : "Cool-down in progress"}
      </h2>
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        {ready ? (
          `Cool-down complete. Withdrawing returns ${bondLabel(row)} and removes you from the active relayer set.`
        ) : (
          <>
            Exit requested. Bond will be withdrawable in{" "}
            <span className="font-mono font-semibold text-[var(--color-text)]">
              {formatRemaining(remaining)}
            </span>
            . <code className="font-mono">isActiveRelayer</code> is{" "}
            <code className="font-mono">false</code> for the whole window —
            both new orders and settlement of in-flight orders revert with{" "}
            <code className="font-mono">NotActiveRelayer</code>. Cancelling
            the exit is not supported by the current registry; you must wait
            and re-register after <code className="font-mono">executeExit</code>.
          </>
        )}
      </p>
      <button
        onClick={onExecute}
        disabled={!signer || !ready || phase.kind === "submitting"}
        className="rounded-lg bg-[var(--color-success)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {phase.kind === "submitting"
          ? "Submitting…"
          : ready ? `Execute exit · withdraw ${bondLabel(row)}` : "Withdraw bond (cool-down active)"}
      </button>
      <WriteResult phase={phase} />
    </section>
  );
}

function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
