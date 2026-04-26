import Link from "next/link";

const recipients = [
  { name: "Alice",   address: "0xab12…abcd", amount: "3,500", status: "claimed",    when: "Apr 1, 14:02" },
  { name: "Bob",     address: "0xcd34…ef12", amount: "4,200", status: "claimed",    when: "Apr 1, 14:08" },
  { name: "Carol",   address: "0xef56…3456", amount: "3,800", status: "claimed",    when: "Apr 1, 15:21" },
  { name: "Dan",     address: "0x7890…7890", amount: "5,000", status: "pending",    when: "—" },
  { name: "Eve",     address: "0x1234…5678", amount: "4,500", status: "pending",    when: "—" },
  { name: "Frank",   address: "0x2468…1357", amount: "3,200", status: "pending",    when: "—" },
];

export default async function PayoutDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claimed = recipients.filter((r) => r.status === "claimed").length;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Link href="/" className="hover:text-[var(--color-text)]">Payouts</Link>
        <span>/</span>
        <span className="font-mono text-xs">{id}</span>
      </div>

      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">April payroll</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Submitted Apr 1, 2026 · One on-chain tx · Stealth claim links
          </p>
        </div>
        <div className="flex gap-2">
          <button className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm">
            Remind unclaimed
          </button>
          <button className="rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm">
            Export (CSV / PDF)
          </button>
        </div>
      </header>

      <section className="grid grid-cols-4 gap-4">
        <Stat label="Total" value="$84,500" />
        <Stat label="Claimed" value={`${claimed} / ${recipients.length}`} />
        <Stat label="On-chain tx" value="0x9a…41" mono />
        <Stat label="Audit signature" value="zk-X509 ✓" />
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
                <th className="px-5 py-3 text-left">Claimed at</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.address} className="border-t border-[var(--color-border)]">
                  <td className="px-5 py-3">{r.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{r.address}</td>
                  <td className="px-5 py-3 text-right font-mono">{r.amount} USDC</td>
                  <td className="px-5 py-3">
                    {r.status === "claimed" ? (
                      <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]">
                        Claimed
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[var(--color-text-muted)]">{r.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Each recipient sees only their own amount when they claim. The on-chain transaction reveals only the
          stealth addresses, not the mapping to names or per-recipient amounts.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
