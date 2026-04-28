"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";

type Status = "claimed" | "available" | "locked";

interface Recipient {
  name: string;
  address: string;
  amount: string;
  status: Status;
  when: string; // claimed-at if claimed, claim-from if locked
}

const recipients: Recipient[] = [
  { name: "Alice", address: "0xab12…abcd", amount: "3,500", status: "claimed",   when: "Apr 1, 14:02" },
  { name: "Bob",   address: "0xcd34…ef12", amount: "4,200", status: "claimed",   when: "Apr 1, 14:08" },
  { name: "Carol", address: "0xef56…3456", amount: "3,800", status: "claimed",   when: "Apr 1, 15:21" },
  { name: "Dan",   address: "0x7890…7890", amount: "5,000", status: "available", when: "—" },
  { name: "Eve",   address: "0x1234…5678", amount: "4,500", status: "available", when: "—" },
  { name: "Frank", address: "0x2468…1357", amount: "3,200", status: "locked",    when: "May 1, 00:00" },
];

const PAYOUT_LABEL = "April payroll";
const PAYOUT_ID = "p_2026_04_payroll";

export default function PayoutDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? PAYOUT_ID;
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  if (id !== PAYOUT_ID) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <Link href="/dashboard" className="hover:text-[var(--color-text)]">Payouts</Link>
          <span>/</span>
          <span className="font-mono text-xs">{id}</span>
        </div>
        <h1 className="text-2xl font-semibold">Payout not found</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Phase A only ships a sample run (<span className="font-mono">{PAYOUT_ID}</span>). Live
          payout pages arrive in Phase B once the wizard is wired to the contract.
        </p>
        <Link
          href="/dashboard"
          className="inline-block rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm"
        >
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  const claimed = recipients.filter((r) => r.status === "claimed").length;
  const available = recipients.filter((r) => r.status === "available").length;
  const locked = recipients.filter((r) => r.status === "locked").length;

  function copyClaimLink(name: string) {
    // Real link uses /claim/<id>#<secret>; demo just copies the run url.
    const url = `${window.location.origin}/claim/${PAYOUT_ID}_${name.toLowerCase()}#demo-secret`;
    navigator.clipboard.writeText(url);
    setOpenMenu(null);
  }

  function emailPayslip(name: string) {
    // Placeholder — Phase B wires this to Pay's notification service.
    alert(`Sending payslip email to ${name}…`);
    setOpenMenu(null);
  }

  function emailClaimLink(name: string) {
    alert(`Re-sending claim link to ${name}…`);
    setOpenMenu(null);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/dashboard" className="hover:text-[var(--color-text)]">Payouts</Link>
        <span>/</span>
        <span className="font-mono text-xs">{PAYOUT_ID}</span>
      </div>

      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{PAYOUT_LABEL}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Submitted Apr 1, 2026 · One on-chain tx · Stealth claim links · No expiry
          </p>
        </div>
        <div className="flex gap-2">
          <button className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm">
            Remind unclaimed
          </button>
          <Link
            href={`/payouts/new?clone=${PAYOUT_ID}`}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm"
          >
            Run again →
          </Link>
          <button className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm">
            Export (CSV / PDF)
          </button>
        </div>
      </header>

      <section className="grid grid-cols-4 gap-4">
        <Stat label="Total" value="$84,500" />
        <Stat label="Claimed" value={`${claimed} / ${recipients.length}`} />
        <Stat label="Available now" value={`${available}`} sub="not yet claimed" />
        <Stat label="Locked" value={`${locked}`} sub="claim-from in future" />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recipients</h2>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Name</th>
                <th className="px-5 py-3 text-left">Stealth address</th>
                <th className="px-5 py-3 text-right">Amount</th>
                <th className="px-5 py-3 text-left">Status</th>
                <th className="px-5 py-3 text-left">Claim from / claimed at</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.address} className="border-t border-[var(--color-border)]">
                  <td className="px-5 py-3">{r.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{r.address}</td>
                  <td className="px-5 py-3 text-right font-mono">{r.amount} USDC</td>
                  <td className="px-5 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-5 py-3 text-[var(--color-text-muted)]">{r.when}</td>
                  <td className="px-5 py-3 text-right">
                    <RowMenu
                      open={openMenu === r.address}
                      onOpen={() => setOpenMenu((cur) => (cur === r.address ? null : r.address))}
                      onClose={closeMenu}
                      onCopy={() => copyClaimLink(r.name)}
                      onResend={() => emailClaimLink(r.name)}
                      onPayslipEmail={() => emailPayslip(r.name)}
                      payslipHref={`/payouts/${PAYOUT_ID}/payslip/${r.name.toLowerCase()}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Each recipient sees only their own amount when they claim. The on-chain transaction reveals only the
          stealth addresses, not the mapping to names or per-recipient amounts. Claim links never expire.
        </p>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (status === "claimed") {
    return (
      <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
        Claimed
      </span>
    );
  }
  if (status === "available") {
    return (
      <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
        Available
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]">
      Locked
    </span>
  );
}

interface RowMenuProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCopy: () => void;
  onResend: () => void;
  onPayslipEmail: () => void;
  payslipHref: string;
}

function RowMenu({ open, onOpen, onClose, onCopy, onResend, onPayslipEmail, payslipHref }: RowMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick({ enabled: open, ref, onClose });
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button
        onClick={onOpen}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
      >
        Actions ▾
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left text-xs shadow-lg">
          <button onClick={onCopy} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]">
            Copy claim link
          </button>
          <button onClick={onResend} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]">
            Resend claim link
          </button>
          <Link
            href={payslipHref}
            target="_blank"
            className="block w-full px-3 py-1.5 hover:bg-[var(--color-primary-soft)]"
          >
            Print payslip (PDF)
          </Link>
          <button onClick={onPayslipEmail} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]">
            Email payslip
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, mono, sub }: { label: string; value: string; mono?: boolean; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}
