"use client";

import Link from "next/link";
import { useState } from "react";

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

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-warning-soft)] p-6">
        <h2 className="mb-2 font-semibold text-[var(--color-warning)]">Exit registry</h2>
        <p className="mb-4 text-sm text-[var(--color-text-muted)]">
          Stops accepting orders and starts the cool-down. Bond becomes withdrawable
          after the cool-down completes.
        </p>
        <button className="rounded-lg border border-[var(--color-warning)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]">
          Request exit
        </button>
      </section>
    </div>
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
