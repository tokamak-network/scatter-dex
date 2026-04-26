"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Row = { name: string; address: string; amount: string };

const SAMPLE_CSV = `Alice,0xab12cd34ef56789012345678901234567890abcd,3500
Bob,0xcd34ef56789012345678901234567890abcdef12,4200
Carol,0xef56789012345678901234567890abcdef123456,3800
Dan,0x789012345678901234567890abcdef1234567890,5000`;

const STEPPER_LABELS = ["Token & total", "Recipients", "Review & sign"] as const;

export default function NewPayout() {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("USDC");
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [stealth, setStealth] = useState(true);
  const [notify, setNotify] = useState(true);

  const rows: Row[] = useMemo(() => {
    return csv
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(",").map((x) => (x ?? "").trim());
        return { name: parts[0] ?? "", address: parts[1] ?? "", amount: parts[2] ?? "" };
      })
      .filter((r) => r.address.length > 0);
  }, [csv]);

  const total = useMemo(
    () => rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0),
    [rows],
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/" className="hover:text-[var(--color-text)]">Payouts</Link>
        <span>/</span>
        <span>New</span>
      </div>

      <Stepper step={step} />

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {step === 1 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Token & total</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Token">
                <select
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                >
                  <option>USDC</option>
                  <option>USDT</option>
                  <option>WETH</option>
                  <option>TON</option>
                </select>
              </Field>
              <Field label="Source wallet">
                <input
                  defaultValue="Acme DAO Safe (0x12…ab)"
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                />
              </Field>
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Funds are escrowed into your private vault before being split to recipients. One on-chain transaction.
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recipients</h2>
              <div className="flex gap-2 text-xs">
                <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Upload CSV</button>
                <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Import from Safe</button>
              </div>
            </div>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white p-3 font-mono text-sm"
              placeholder="name,address,amount"
            />
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">Preview</div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-text-subtle)]">
                  <tr><th className="text-left">Name</th><th className="text-left">Address</th><th className="text-right">Amount</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.address}-${i}`} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5">{r.name}</td>
                      <td className="py-1.5 font-mono text-xs">{r.address.slice(0, 10)}…{r.address.slice(-4)}</td>
                      <td className="py-1.5 text-right font-mono">{r.amount} {token}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 flex justify-between text-sm">
                <span className="text-[var(--color-text-muted)]">{rows.length} recipients</span>
                <span className="font-semibold">{total.toLocaleString()} {token}</span>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <Toggle checked={stealth} onChange={setStealth} label="Send via stealth address (recipients can't be linked on-chain)" />
              <Toggle checked={notify} onChange={setNotify} label="Email / Discord notification to each recipient" />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & sign</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
              <Row k="Token" v={token} />
              <Row k="Recipients" v={`${rows.length}`} />
              <Row k="Total" v={`${total.toLocaleString()} ${token}`} />
              <Row k="Stealth" v={stealth ? "Yes" : "No"} />
              <Row k="Notification" v={notify ? "Email + Discord" : "None"} />
              <Row k="Estimated gas" v="~$0.50 (one tx)" />
              <Row k="ScatterPay fee" v={`Free (launch event until Dec 31, 2026 · normally 0.05%, capped at $20)`} />
            </dl>
            <button className="w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
              Sign & submit
            </button>
            <div className="text-center text-xs text-[var(--color-text-muted)]">
              You'll be asked to sign once. Recipients claim individually.
            </div>
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
        {step < 3 ? (
          <button
            onClick={() => setStep((s) => s + 1)}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Next
          </button>
        ) : (
          <Link
            href="/payouts/p_2026_04_payroll"
            className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
          >
            View sample result →
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
        const done = n < step;
        return (
          <div
            key={l}
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                : done
                ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
            }`}
          >
            <span className="mr-2 font-semibold">{n}</span>
            {l}
          </div>
        );
      })}
    </div>
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

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  // dt/dd as direct children of the parent <dl> (valid HTML).
  // The grid layout on the <dl> places key + value on one row.
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}
