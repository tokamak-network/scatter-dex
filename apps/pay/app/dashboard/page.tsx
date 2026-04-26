import Link from "next/link";

const recentPayouts = [
  { id: "p_2026_04_payroll", label: "April payroll", token: "USDC", total: "84,500", recipients: 23, claimed: 18, date: "2026-04-01" },
  { id: "p_2026_03_vendors", label: "Q1 vendor settlement", token: "USDC", total: "31,200", recipients: 7, claimed: 7, date: "2026-03-28" },
  { id: "p_2026_03_payroll", label: "March payroll", token: "USDC", total: "82,100", recipients: 22, claimed: 22, date: "2026-03-01" },
];

const recurring = [
  { id: "r_monthly_payroll", label: "Monthly payroll", nextRun: "2026-05-01", recipients: 23, token: "USDC" },
];

export default function Dashboard() {
  return (
    <div className="space-y-10">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Payouts</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Send to many recipients in one private transaction. Recipients can't see each other's amounts.
          </p>
        </div>
        <Link
          href="/payouts/new"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          New payout
        </Link>
      </section>

      <section className="grid grid-cols-3 gap-4">
        <Stat label="This month" value="$84,500" sub="23 recipients" />
        <Stat label="Pending claims" value="5" sub="of 23 (April payroll)" />
        <Stat label="Saved on gas" value="~$112" sub="vs 23 separate sends" />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recurring</h2>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {recurring.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0">
              <div>
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  Next: {r.nextRun} · {r.recipients} recipients · {r.token}
                </div>
              </div>
              <button className="text-sm text-[var(--color-primary)] hover:underline">Manage</button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recent payouts</h2>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {recentPayouts.map((p) => (
            <Link
              key={p.id}
              href={`/payouts/${p.id}`}
              className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 hover:bg-[var(--color-primary-soft)]"
            >
              <div>
                <div className="font-medium">{p.label}</div>
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
          ))}
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
