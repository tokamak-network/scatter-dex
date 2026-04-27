"use client";

import Link from "next/link";
import { useState } from "react";
import { Stat } from "../components/Stat";

const COOLDOWN_REMAINING_MOCK = "5d 14h 02m";

export default function ProfilePage() {
  const [name, setName] = useState("Acme Relayer");
  const [description, setDescription] = useState(
    "Privacy-first routing for OTC desks and DAOs. Operated from us-east-1 with hot failover.",
  );
  const [contact, setContact] = useState("ops@acme-relayer.xyz");
  const [website, setWebsite] = useState("https://acme-relayer.xyz");
  const [socialX, setSocialX] = useState("@acme_relayer");
  const [url, setUrl] = useState("https://relayer.acme-relayer.xyz");
  const [feeBps, setFeeBps] = useState("30");
  const [saved, setSaved] = useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header>
        <Link href="/dashboard" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Relayer profile</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Public information traders see when picking a relayer. Endpoint and fee
          are recorded on-chain; the rest is signed metadata served from your node.
        </p>
      </header>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">On-chain settings</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Updating these fields submits a transaction to{" "}
          <code className="font-mono">RelayerRegistry.update()</code>.
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
              min="0"
              max="500"
              value={feeBps}
              onChange={(e) => setFeeBps(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
            />
          </Field>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Operator metadata</h2>
        <p className="mb-4 text-xs text-[var(--color-text-muted)]">
          Served from your node's <code className="font-mono">/api/info</code>. Sanitized
          client-side before display — keep it short and accurate.
        </p>
        <div className="space-y-5">
          <Field label="Display name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={48}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={240}
              rows={3}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <div className="grid grid-cols-3 gap-5">
            <Field label="Contact">
              <input
                type="text"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
            </Field>
            <Field label="Website">
              <input
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
            </Field>
            <Field label="X / Twitter">
              <input
                type="text"
                value={socialX}
                onChange={(e) => setSocialX(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
            </Field>
          </div>
        </div>

        <button
          onClick={() => setSaved(true)}
          className="mt-6 rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Save metadata
        </button>
        {saved && (
          <span className="ml-3 text-xs text-[var(--color-success)]">Saved (mock)</span>
        )}
      </section>

      <BondPanel />
      <ExitPanel />
    </div>
  );
}

function BondPanel() {
  const [topUp, setTopUp] = useState("0.05");
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="mb-4 font-semibold">Bond</h2>
      <div className="grid grid-cols-3 gap-4">
        <Stat compact label="Current bond" value="0.10 ETH" sub="≈ $310" />
        <Stat compact label="Minimum bond" value="0.10 ETH" sub="Set by governance" />
        <Stat compact label="Slashed to date" value="0 ETH" sub="No incidents" />
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
        <button className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]">
          Top up
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        Calls <code className="font-mono">RelayerRegistry.addBond()</code>. Larger bonds
        increase trust signaling but lock more capital.
      </p>
    </section>
  );
}

function ExitPanel() {
  const [exitState, setExitState] = useState<"active" | "cooldown" | "ready">("active");

  if (exitState === "active") {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-warning-soft)] p-6">
        <h2 className="mb-2 font-semibold text-[var(--color-warning)]">Exit registry</h2>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          Stops accepting orders and starts a 7-day cool-down. Bond becomes
          withdrawable after the cool-down. You can re-register after exit.
        </p>
        <button
          onClick={() => setExitState("cooldown")}
          className="rounded-lg border border-[var(--color-warning)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
        >
          Request exit
        </button>
      </section>
    );
  }

  if (exitState === "cooldown") {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-6">
        <h2 className="mb-2 font-semibold text-[var(--color-warning)]">Cool-down in progress</h2>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          Exit requested. Bond will be withdrawable in{" "}
          <span className="font-mono font-semibold text-[var(--color-text)]">{COOLDOWN_REMAINING_MOCK}</span>.
          The relayer is no longer accepting new orders.
        </p>
        <button
          disabled
          className="cursor-not-allowed rounded-lg border border-[var(--color-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-text-subtle)]"
        >
          Withdraw bond (cool-down active)
        </button>
        <button
          onClick={() => setExitState("ready")}
          className="ml-3 text-xs text-[var(--color-text-muted)] underline"
        >
          (demo) jump to ready state
        </button>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-success)] bg-[var(--color-success-soft)] p-6">
      <h2 className="mb-2 font-semibold text-[var(--color-success)]">Bond ready to withdraw</h2>
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        Cool-down complete. Withdrawing returns 0.10 ETH to your operator address
        and removes you from the active relayer set.
      </p>
      <button className="rounded-lg bg-[var(--color-success)] px-4 py-2 text-sm font-medium text-white hover:opacity-90">
        Execute exit · withdraw 0.10 ETH
      </button>
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        Calls <code className="font-mono">RelayerRegistry.executeExit()</code>.
      </p>
    </section>
  );
}


function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}
