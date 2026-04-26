"use client";

import Link from "next/link";
import { useState } from "react";

const STEPPER_LABELS = ["Token & supply", "Recipients", "Sybil & privacy", "Window"] as const;

export default function NewCampaign() {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("$XYZ");
  const [supply, setSupply] = useState("1000000");
  const [source, setSource] = useState<"csv" | "snapshot" | "nft">("snapshot");
  const [requireKyc, setRequireKyc] = useState(true);
  const [stealth, setStealth] = useState(true);
  const [gasless, setGasless] = useState(true);
  const [minActivity, setMinActivity] = useState(true);
  const [days, setDays] = useState("30");
  const [recover, setRecover] = useState(true);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/" className="hover:text-[var(--color-text)]">Campaigns</Link>
        <span>/</span>
        <span>New</span>
      </div>

      <Stepper step={step} />

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {step === 1 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Token & supply</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Token symbol">
                <input value={token} onChange={(e) => setToken(e.target.value)} className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2" />
              </Field>
              <Field label="Total supply to distribute">
                <input
                  type="number"
                  inputMode="decimal"
                  value={supply}
                  onChange={(e) => setSupply(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
                />
              </Field>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Recipients</h2>
            <div className="grid grid-cols-3 gap-3">
              <SourceCard active={source === "snapshot"} onClick={() => setSource("snapshot")} title="Snapshot" sub="Import voters from a Snapshot proposal" />
              <SourceCard active={source === "nft"} onClick={() => setSource("nft")} title="NFT holders" sub="Auto-extract from collection address" />
              <SourceCard active={source === "csv"} onClick={() => setSource("csv")} title="CSV" sub="Upload a list of addresses + weights" />
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
              <div className="font-medium">Estimated eligible</div>
              <div className="mt-1 text-2xl font-semibold">12,453 wallets</div>
              <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                Sample from {source === "snapshot" ? "Snapshot proposal sample.eth/proposal/0x12…" : source === "nft" ? "NFT 0xab…cd" : "CSV"}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Sybil & privacy policy</h2>
            <div className="space-y-3 text-sm">
              <Toggle checked={requireKyc} onChange={setRequireKyc} label="Require zk-X509 (real 1-person-1-claim)" sub="Best defense against bot farms. Recipient verifies privately; you only see a count." />
              <Toggle checked={minActivity} onChange={setMinActivity} label="Require ≥3 months of wallet activity" sub="Filters dormant farming wallets." />
              <Toggle checked={stealth} onChange={setStealth} label="Stealth-address claim (recipient amounts hidden on-chain)" sub="Reduces immediate sell pressure: traders can't see who got how much." />
              <Toggle checked={gasless} onChange={setGasless} label="Gasless claim (you cover gas)" sub="Lifts claim rate by ~30–40%." />
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Window & recovery</h2>
            <Field label="Claim window (days)">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="w-32 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
              />
            </Field>
            <Toggle checked={recover} onChange={setRecover} label="Sweep unclaimed back to treasury after window" />
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
              <h3 className="mb-2 font-medium">Summary</h3>
              <Row k="Token" v={`${supply} ${token}`} />
              <Row k="Eligible" v="~12,453 wallets" />
              <Row k="Sybil policy" v={[requireKyc && "zk-X509", minActivity && "3mo activity"].filter(Boolean).join(" + ") || "None"} />
              <Row k="Privacy" v={stealth ? "Stealth claim" : "Public claim"} />
              <Row k="Gas" v={gasless ? "You pay (gasless for recipients)" : "Recipient pays"} />
              <Row k="Window" v={`${days} days, ${recover ? "sweep unclaimed" : "leave forever"}`} />
              <Row k="Scatter Drop fee" v="Free (launch event until Dec 31, 2026 · normally 0.2%)" />
            </div>
            <button className="w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
              Sign & launch campaign
            </button>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <button
          disabled={step === 1}
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm disabled:opacity-40"
        >
          Back
        </button>
        {step < 4 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Next
          </button>
        ) : (
          <Link href="/" className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm">
            Back to campaigns
          </Link>
        )}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex gap-2">
      {STEPPER_LABELS.map((l, i) => {
        const n = i + 1;
        const active = n === step;
        return (
          <div key={l} className={`flex-1 rounded-md border px-3 py-2 text-sm ${active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]" : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]"}`}>
            <span className="mr-2 font-semibold">{n}</span>{l}
          </div>
        );
      })}
    </div>
  );
}

function SourceCard({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-4 text-left ${active ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
    >
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label, sub }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1" />
      <span>
        <span className="font-medium">{label}</span>
        {sub && <span className="block text-xs text-[var(--color-text-muted)]">{sub}</span>}
      </span>
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-[var(--color-text-muted)]">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
