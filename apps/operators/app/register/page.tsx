"use client";

import Link from "next/link";
import { useState } from "react";

export default function RegisterPage() {
  const [url, setUrl] = useState("https://relayer.example.com");
  const [feeBps, setFeeBps] = useState("30");
  const [bondEth, setBondEth] = useState("0.1");
  const [submitted, setSubmitted] = useState(false);

  const feePct = (Number(feeBps) / 100).toFixed(2);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <header>
        <Link href="/" className="text-xs text-[var(--color-text-muted)] hover:underline">
          ← Back
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Register a relayer</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Post a bond, publish your endpoint, and start accepting orders. You can
          edit fee and metadata any time after registration.
        </p>
      </header>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Pre-flight</h2>
        <ul className="space-y-2 text-sm">
          <CheckItem label="Wallet connected" status="todo" hint="Connect via the header on register submit" />
          <CheckItem label="Operator address verified in IdentityRegistry" status="todo" hint="Required for slashing accountability" />
          <CheckItem label="Endpoint reachable over HTTPS" status="todo" hint="We probe /api/info before accepting registration" />
          <CheckItem label="Bond available in wallet" status="todo" hint="Minimum 0.1 ETH at current parameters" />
        </ul>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="mb-4 font-semibold">Registration</h2>

        <div className="space-y-5">
          <Field label="Endpoint URL" hint="HTTPS only. Must respond at /api/info.">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://relayer.example.com"
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
            />
          </Field>

          <Field label="Per-trade fee" hint={`Basis points. ${feeBps} bps = ${feePct}% per settled order.`}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                max="500"
                value={feeBps}
                onChange={(e) => setFeeBps(e.target.value)}
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
              <span className="text-sm text-[var(--color-text-muted)]">bps</span>
            </div>
          </Field>

          <Field label="Bond" hint="Refundable on exit after the cool-down period.">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0.1"
                step="0.01"
                value={bondEth}
                onChange={(e) => setBondEth(e.target.value)}
                className="w-32 rounded-lg border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
              />
              <span className="text-sm text-[var(--color-text-muted)]">ETH</span>
            </div>
          </Field>
        </div>

        <button
          onClick={() => setSubmitted(true)}
          className="mt-6 w-full rounded-lg bg-[var(--color-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Register on-chain
        </button>

        {submitted && (
          <p className="mt-3 text-center text-xs text-[var(--color-text-muted)]">
            Demo: real submission lands in v1.1. Wired through SDK{" "}
            <code className="font-mono text-[var(--color-text)]">relayerRegistry.register()</code>.
          </p>
        )}
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function CheckItem({ label, status, hint }: { label: string; status: "ok" | "todo"; hint?: string }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={
          status === "ok"
            ? "mt-0.5 inline-block h-4 w-4 rounded-full bg-[var(--color-success)]"
            : "mt-0.5 inline-block h-4 w-4 rounded-full border border-[var(--color-border-strong)]"
        }
      />
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-[var(--color-text-muted)]">{hint}</div>}
      </div>
    </li>
  );
}
