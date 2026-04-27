"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Row = { name: string; address: string; amount: string };

type TemplateId = "payroll" | "grants" | "bonus" | "contractor";

type Template = {
  id: TemplateId;
  name: string;
  tagline: string;
  body: string;
  defaultLabel: string;
  defaultToken: string;
  identifierLabel: string;
  reasonLabel?: string;
  sampleCsv: string;
  exportNote: string;
};

const TEMPLATES: Template[] = [
  {
    id: "payroll",
    name: "Payroll",
    tagline: "Monthly salaries",
    body: "Monthly salary run for employees. Withholding-friendly export.",
    defaultLabel: "April payroll",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    sampleCsv: `Alice,0xab12cd34ef56789012345678901234567890abcd,3500
Bob,0xcd34ef56789012345678901234567890abcdef12,4200
Carol,0xef56789012345678901234567890abcdef123456,3800
Dan,0x789012345678901234567890abcdef1234567890,5000`,
    exportNote: "Payroll export includes per-employee breakdown for withholding reconciliation.",
  },
  {
    id: "grants",
    name: "Grants",
    tagline: "DAO grants",
    body: "Pay grant recipients from a Snapshot result or working group.",
    defaultLabel: "Q2 grants — public goods WG",
    defaultToken: "USDC",
    identifierLabel: "Recipient",
    reasonLabel: "Proposal / Snapshot link",
    sampleCsv: `Project Lighthouse,0xab12cd34ef56789012345678901234567890abcd,15000
ZK Toolkit,0xcd34ef56789012345678901234567890abcdef12,8000
Docs Crew,0xef56789012345678901234567890abcdef123456,4500`,
    exportNote: "Grants export pairs each transfer with its proposal link for transparency reports.",
  },
  {
    id: "bonus",
    name: "Bonus",
    tagline: "Bonuses & incentives",
    body: "One-off bonus rounds where size differences should stay private.",
    defaultLabel: "EOY bonus 2026",
    defaultToken: "USDC",
    identifierLabel: "Employee",
    reasonLabel: "Reason / approver",
    sampleCsv: `Alice,0xab12cd34ef56789012345678901234567890abcd,2000
Bob,0xcd34ef56789012345678901234567890abcdef12,3500
Carol,0xef56789012345678901234567890abcdef123456,1500`,
    exportNote: "Bonus export records the approver and reason against each line.",
  },
  {
    id: "contractor",
    name: "Contractor batch",
    tagline: "Freelancer settlement",
    body: "Settle a wave of contractors at once without leaking per-contractor rates.",
    defaultLabel: "April contractor settlement",
    defaultToken: "USDC",
    identifierLabel: "Contractor",
    reasonLabel: "Invoice reference",
    sampleCsv: `Studio North,0xab12cd34ef56789012345678901234567890abcd,6200
J. Park (design),0xcd34ef56789012345678901234567890abcdef12,2400
M. Lee (research),0xef56789012345678901234567890abcdef123456,3100`,
    exportNote: "Contractor export attaches invoice references for sole-proprietor accounting.",
  },
];

const STEPPER_LABELS = [
  "Template",
  "Token & total",
  "Recipients",
  "Review & sign",
] as const;

// TODO: read from org settings
const LARGE_AMOUNT_THRESHOLD = 50_000;

function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const REASON_PLACEHOLDER: Record<TemplateId, string> = {
  payroll: "",
  grants: "https://snapshot.org/#/acme.eth/proposal/0x…",
  bonus: "Approved by CEO · EOY review cycle",
  contractor: "INV-2026-04-*",
};

export default function NewPayout() {
  const [step, setStep] = useState(1);
  const [templateId, setTemplateId] = useState<TemplateId>("payroll");
  const template = TEMPLATES.find((t) => t.id === templateId)!;

  const [label, setLabel] = useState(template.defaultLabel);
  const [token, setToken] = useState(template.defaultToken);
  const [chain, setChain] = useState("Tokamak L2");
  const [csv, setCsv] = useState(template.sampleCsv);
  const [stealth, setStealth] = useState(true);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState("");
  const [claimFrom, setClaimFrom] = useState<string>(today());
  const [showConfirm, setShowConfirm] = useState(false);

  function doSubmit() {
    setShowConfirm(false);
    // TODO Phase B: ensureAllowance + generateAuthorizeProof + callSettleAuth
    window.location.assign("/payouts/p_2026_04_payroll");
  }

  function pickTemplate(id: TemplateId) {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplateId(id);
    setLabel(t.defaultLabel);
    setToken(t.defaultToken);
    setCsv(t.sampleCsv);
    setReason("");
  }

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

  const validation = useMemo(() => {
    const issues: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
        issues.push(`Invalid address: ${r.address || "(empty)"}`);
      } else if (seen.has(r.address.toLowerCase())) {
        issues.push(`Duplicate address: ${r.address}`);
      }
      seen.add(r.address.toLowerCase());
      if (!r.amount || isNaN(parseFloat(r.amount))) {
        issues.push(`Invalid amount for ${r.name || r.address}`);
      }
    }
    return issues.slice(0, 5);
  }, [rows]);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/" className="hover:text-[var(--color-text)]">Payouts</Link>
        <span>/</span>
        <span>New</span>
      </div>

      <Stepper step={step} onJump={setStep} />

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold">Choose a template</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Templates pre-fill labels, sample data, and export format. You can change anything later.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => pickTemplate(t.id)}
                  className={`rounded-xl border p-4 text-left transition ${
                    templateId === t.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-primary)]">
                    {t.name}
                  </div>
                  <div className="mt-1 font-semibold">{t.tagline}</div>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t.body}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Token & total</h2>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Run label">
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                />
              </Field>
              <Field label="Chain">
                <select
                  value={chain}
                  onChange={(e) => setChain(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                >
                  <option>Tokamak L2</option>
                  <option>Ethereum</option>
                  <option>Base</option>
                  <option>Arbitrum</option>
                </select>
              </Field>
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
                <select
                  defaultValue="safe-acme"
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
                >
                  <option value="safe-acme">Acme DAO Safe (0x12…ab) — multisig 3/5</option>
                  <option value="eoa-treasury">Treasury EOA (0x9f…d2)</option>
                  <option value="connect">Connect another…</option>
                </select>
              </Field>
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              Funds escrow into your private vault before being split to recipients. One on-chain transaction.
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recipients</h2>
              <div className="flex gap-2 text-xs">
                <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Upload CSV</button>
                <button className="rounded border border-[var(--color-border-strong)] px-2 py-1">Import from Safe</button>
              </div>
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Format: <span className="font-mono">{template.identifierLabel.toLowerCase()},address,amount</span> — one per line.
            </div>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white p-3 font-mono text-sm"
              placeholder={`${template.identifierLabel.toLowerCase()},address,amount`}
            />
            {template.reasonLabel && (
              <Field label={template.reasonLabel}>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={REASON_PLACEHOLDER[template.id]}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
                />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              <Field label="Available to claim from">
                <input
                  type="date"
                  value={claimFrom}
                  min={today()}
                  onChange={(e) => setClaimFrom(e.target.value)}
                  className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-[10px] text-[var(--color-text-subtle)]">
                  Recipients can claim any time after this date — there is no expiry.
                </span>
              </Field>
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 text-xs font-semibold text-[var(--color-text-muted)]">Preview</div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-text-subtle)]">
                  <tr>
                    <th className="text-left">{template.identifierLabel}</th>
                    <th className="text-left">Address</th>
                    <th className="text-right">Amount</th>
                  </tr>
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
            {validation.length > 0 && (
              <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
                <div className="mb-1 font-semibold">Fix before continuing</div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {validation.map((v) => <li key={v}>{v}</li>)}
                </ul>
              </div>
            )}
            <div className="space-y-2 text-sm">
              <Toggle checked={stealth} onChange={setStealth} label="Send via stealth address (recipients can't be linked on-chain)" />
              <Toggle checked={notify} onChange={setNotify} label="Email / Discord notification to each recipient" />
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & sign</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 divide-y divide-[var(--color-border)] text-sm">
              <Row k="Template" v={template.name} />
              <Row k="Label" v={label} />
              <Row k="Chain" v={chain} />
              <Row k="Token" v={token} />
              <Row k="Recipients" v={`${rows.length}`} />
              <Row k="Total" v={`${total.toLocaleString()} ${token}`} />
              <Row k="Available to claim from" v={claimFrom} />
              {template.reasonLabel && <Row k={template.reasonLabel} v={reason || "—"} />}
              <Row k="Stealth" v={stealth ? "Yes" : "No"} />
              <Row k="Notification" v={notify ? "Email + Discord" : "None"} />
              <Row k="Estimated gas" v="~$0.50 (one tx · varies by chain)" />
              <Row k="Scatter Pay fee" v="Free (launch event until Dec 31, 2026 · normally 0.05%, capped at $20)" />
            </dl>
            <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              <strong className="mb-0.5 block">This cannot be reversed.</strong>
              Once signed and settled, recipients can claim any time after the
              date above — forever. The sender cannot recall a settled run.
            </div>
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              {template.exportNote}
            </div>
            <button
              disabled={validation.length > 0}
              onClick={() => {
                if (total >= LARGE_AMOUNT_THRESHOLD) setShowConfirm(true);
                else doSubmit();
              }}
              className="w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              Sign & submit
            </button>
            <div className="text-center text-xs text-[var(--color-text-muted)]">
              You&apos;ll be asked to sign once. Recipients claim individually.
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
        {step < 4 ? (
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

      {showConfirm && (
        <ConfirmLargeAmount
          total={total}
          token={token}
          recipients={rows.length}
          onCancel={() => setShowConfirm(false)}
          onConfirm={doSubmit}
        />
      )}
    </div>
  );
}

function ConfirmLargeAmount({
  total,
  token,
  recipients,
  onCancel,
  onConfirm,
}: {
  total: number;
  token: string;
  recipients: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Confirm large payout</h3>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          You&apos;re about to send{" "}
          <strong>{total.toLocaleString()} {token}</strong> to{" "}
          <strong>{recipients} recipients</strong>. Once signed, this run
          cannot be reversed — recipients can claim it any time, forever.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Sign & submit
          </button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div className="flex gap-2">
      {STEPPER_LABELS.map((l, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        const clickable = done || active;
        return (
          <button
            key={l}
            disabled={!clickable}
            onClick={() => clickable && onJump(n)}
            className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                : done
                ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-subtle)]"
            }`}
          >
            <span className="mr-2 font-semibold">{n}</span>
            {l}
          </button>
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
  return (
    <>
      <dt className="py-2 text-[var(--color-text-muted)]">{k}</dt>
      <dd className="py-2 text-right font-medium">{v}</dd>
    </>
  );
}
