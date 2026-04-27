"use client";

import Link from "next/link";
import { useState } from "react";
import { PoolBalanceCard } from "../_components/PoolBalanceCard";

type Category = "all" | "payroll" | "grants" | "bonus" | "contractor";

type Payout = {
  id: string;
  label: string;
  category: Exclude<Category, "all">;
  token: string;
  total: string;
  recipients: number;
  claimed: number;
  date: string;
};

const allPayouts: Payout[] = [
  { id: "p_2026_04_payroll",  label: "April payroll",            category: "payroll",    token: "USDC", total: "84,500",  recipients: 23, claimed: 18, date: "2026-04-01" },
  { id: "p_2026_04_contract", label: "April contractor batch",   category: "contractor", token: "USDC", total: "11,700",  recipients: 6,  claimed: 5,  date: "2026-04-10" },
  { id: "p_2026_q1_grants",   label: "Q1 public-goods grants",   category: "grants",     token: "USDC", total: "62,500",  recipients: 9,  claimed: 9,  date: "2026-03-30" },
  { id: "p_2026_03_payroll",  label: "March payroll",            category: "payroll",    token: "USDC", total: "82,100",  recipients: 22, claimed: 22, date: "2026-03-01" },
  { id: "p_2026_03_bonus",    label: "Q1 retention bonus",       category: "bonus",      token: "USDC", total: "27,000",  recipients: 12, claimed: 12, date: "2026-03-15" },
];

const TABS: { id: Category; label: string }[] = [
  { id: "all",        label: "All" },
  { id: "payroll",    label: "Payroll" },
  { id: "grants",     label: "Grants" },
  { id: "bonus",      label: "Bonus" },
  { id: "contractor", label: "Contractor" },
];

const CATEGORY_BADGE: Record<Exclude<Category, "all">, string> = {
  payroll:    "Payroll",
  grants:     "Grants",
  bonus:      "Bonus",
  contractor: "Contractor",
};

const TOTAL_THIS_MONTH = allPayouts
  .filter((p) => p.date.startsWith("2026-04"))
  .reduce((s, p) => s + parseFloat(p.total.replace(/,/g, "")), 0);

const PENDING_CLAIMS = allPayouts.reduce((s, p) => s + (p.recipients - p.claimed), 0);

const PAYOUTS_BY_CATEGORY: Record<Category, Payout[]> = {
  all: allPayouts,
  payroll: allPayouts.filter((p) => p.category === "payroll"),
  grants: allPayouts.filter((p) => p.category === "grants"),
  bonus: allPayouts.filter((p) => p.category === "bonus"),
  contractor: allPayouts.filter((p) => p.category === "contractor"),
};

export default function Dashboard() {
  const [tab, setTab] = useState<Category>("all");
  const visible = PAYOUTS_BY_CATEGORY[tab];

  return (
    <div className="space-y-10">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Payouts</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            One-to-many private payouts. Recipients can&apos;t see each other&apos;s amounts.
          </p>
        </div>
        <Link
          href="/payouts/new"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          New payout
        </Link>
      </section>

      <PoolBalanceCard />

      <section className="grid grid-cols-3 gap-4">
        <Stat label="This month" value={`$${TOTAL_THIS_MONTH.toLocaleString()}`} sub="across payroll + contractor + …" />
        <Stat label="Pending claims" value={`${PENDING_CLAIMS}`} sub="across open runs" />
        <Stat label="Saved on gas" value="~$112" sub="vs separate transfers" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">Recent payouts</h2>
          <div className="flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 text-xs">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded px-2.5 py-1 ${
                  tab === t.id
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {visible.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
              No {tab} payouts yet.
            </div>
          ) : (
            visible.map((p) => (
              <Link
                key={p.id}
                href={`/payouts/${p.id}`}
                className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 hover:bg-[var(--color-primary-soft)]"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.label}</span>
                    <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                      {CATEGORY_BADGE[p.category]}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{p.date} · {p.recipients} recipients</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-sm">{p.total} {p.token}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {p.claimed === p.recipients ? (
                      <span className="text-[var(--color-success)]">All claimed</span>
                    ) : (
                      <span>{p.claimed}/{p.recipients} claimed</span>
                    )}
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
