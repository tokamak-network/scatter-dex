"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import {
  addRelayerBond,
  EXIT_COOLDOWN_SECONDS,
  executeRelayerExit,
  MAX_RELAYER_FEE_BPS,
  requestRelayerExit,
  updateRelayerInfo,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { DEMO_NETWORK } from "../lib/network";
import { useOperator, type OperatorState } from "../lib/useOperator";
import { useRegistryWrite, type WritePhase } from "../lib/useRegistryWrite";

const REGISTRY = DEMO_NETWORK.contracts.relayerRegistry;

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
  const write = useRegistryWrite({ onSuccess: refresh, minBond: row?.bond });

  const [url, setUrl] = useState("");
  const [feeBps, setFeeBps] = useState("");
  const seeded = useRef(false);

  // Seed the form from the on-chain row exactly once, after the
  // first successful read. We don't re-sync on subsequent refreshes
  // because that would silently clobber any in-progress edits when
  // the user-driven `refresh()` resolves.
  useEffect(() => {
    if (!row || seeded.current) return;
    setUrl(row.url);
    setFeeBps(String(row.feeBps));
    seeded.current = true;
  }, [row]);

  const onSave = () => {
    if (!signer) return;
    write.run(() => updateRelayerInfo(REGISTRY, { url, feeBps: Number(feeBps) }, signer));
  };

  const dirty = !!row && (url !== row.url || feeBps !== String(row.feeBps));
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
  const { signer } = useWallet();
  const { row, refresh, registryDeployed } = operator;
  const write = useRegistryWrite({ onSuccess: refresh });

  const [topUp, setTopUp] = useState("0.05");

  const onTopUp = () => {
    if (!signer) return;
    write.run(() => addRelayerBond(REGISTRY, topUp, signer));
  };

  const disabled =
    !signer || !registryDeployed || !row || row.status !== "active" ||
    write.phase.kind === "submitting";

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-4 font-semibold">Bond</h2>
      <div className="grid grid-cols-2 gap-4">
        <Stat
          compact
          label="Current bond"
          value={row ? `${row.bondEth} ETH` : "—"}
          sub={row ? `Status: ${row.status}` : "Connect wallet to load"}
        />
        <Stat compact label="Slashed to date" value="—" sub="Indexer pending" />
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
          {write.phase.kind === "submitting" ? "Submitting…" : "Top up"}
        </button>
      </div>
      <WriteResult phase={write.phase} />
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        Calls <code className="font-mono">RelayerRegistry.addBond()</code>. Larger bonds
        increase trust signaling but lock more capital.
      </p>
    </section>
  );
}

function ExitPanel({ operator }: { operator: OperatorState }) {
  const { signer } = useWallet();
  const { row, refresh, registryDeployed } = operator;
  const write = useRegistryWrite({ onSuccess: refresh });

  if (!registryDeployed || !row) return null;

  if (row.status === "active") {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-warning-soft)] p-6">
        <h2 className="mb-2 font-semibold text-[var(--color-warning)]">Exit registry</h2>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          Stops accepting orders and starts a 7-day cool-down. Bond becomes
          withdrawable after the cool-down. You can re-register after exit.
        </p>
        <button
          onClick={() => signer && write.run(() => requestRelayerExit(REGISTRY, signer))}
          disabled={!signer || write.phase.kind === "submitting"}
          className="rounded-lg border border-[var(--color-warning)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {write.phase.kind === "submitting" ? "Submitting…" : "Request exit"}
        </button>
        <WriteResult phase={write.phase} />
      </section>
    );
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

  // status === "offline" or "unregistered"
  if (row.status === "unregistered") {
    return (
      <section className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
        Not registered yet. <Link href="/register" className="font-medium text-[var(--color-primary)] hover:underline">Register a relayer →</Link> to enable exit and bond management.
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
      Relayer is offline. Re-register before performing further actions.
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
  // Tick every minute — countdown's smallest displayed unit is
  // minutes, so a finer tick wastes renders. Branch is gated on
  // `status === "cooldown"` so this only runs while the panel is
  // mounted; cleared as soon as the user lands on the dashboard.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  const remaining = readyAtSeconds - now;
  const ready = remaining <= 0;

  return (
    <section className={`rounded-xl border p-6 ${ready ? "border-[var(--color-success)] bg-[var(--color-success-soft)]" : "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"}`}>
      <h2 className={`mb-2 font-semibold ${ready ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
        {ready ? "Bond ready to withdraw" : "Cool-down in progress"}
      </h2>
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        {ready
          ? `Cool-down complete. Withdrawing returns ${row.bondEth} ETH and removes you from the active relayer set.`
          : <>Exit requested. Bond will be withdrawable in <span className="font-mono font-semibold text-[var(--color-text)]">{formatRemaining(remaining)}</span>. The relayer is no longer accepting new orders.</>}
      </p>
      <button
        onClick={onExecute}
        disabled={!signer || !ready || phase.kind === "submitting"}
        className="rounded-lg bg-[var(--color-success)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {phase.kind === "submitting"
          ? "Submitting…"
          : ready ? `Execute exit · withdraw ${row.bondEth} ETH` : "Withdraw bond (cool-down active)"}
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

function WriteResult({ phase }: { phase: WritePhase }) {
  if (phase.kind === "error") {
    return (
      <div className="mt-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
        {phase.msg}
      </div>
    );
  }
  if (phase.kind === "success") {
    return (
      <div className="mt-3 rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-xs">
        <span className="font-medium text-[var(--color-success)]">Confirmed.</span>{" "}
        {phase.txHash && (
          <a
            href={`${DEMO_NETWORK.explorerBase}/tx/${phase.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-text-muted)] hover:underline"
          >
            {phase.txHash.slice(0, 10)}…
          </a>
        )}
      </div>
    );
  }
  return null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
