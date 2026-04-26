import Link from "next/link";

export default function Landing() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          Powered by ScatterDEX · Tokamak Network
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Pay your team in one transaction.
          <br />
          <span className="text-[var(--color-primary)]">They can&apos;t see each other&apos;s amounts.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Private payroll and vendor payouts for crypto-native companies and DAOs.
          Send to 100 people in a single on-chain transaction — recipients only see their own amount,
          and you get an audit-ready accounting export.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/payouts/new"
            className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Try a sample payout →
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-[var(--color-primary-soft)]"
          >
            See dashboard
          </Link>
        </div>
        <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
          No signup needed for the demo. Mock data only — your wallet is not connected.
        </p>
      </section>

      {/* Who is this for */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Who is this for?</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          You&apos;re probably the right user if any of these sounds familiar.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PersonaCard
            badge="Finance ops"
            title="You run payroll for a 5–50 person crypto company"
            body="Today you batch transfers in Safe + a spreadsheet, and every payday your whole team's salary is public on-chain."
          />
          <PersonaCard
            badge="DAO operator"
            title="You distribute grants or contributor pay"
            body="You want recipients to receive funds without leaking who got how much — both for negotiation power and culture."
          />
          <PersonaCard
            badge="Agency / studio"
            title="You settle multiple vendors monthly"
            body="Vendors learning each other's rates damages your negotiating position. You also need a clean export for your accountant."
          />
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">How it works</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Three steps. No new wallet for your recipients to install.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Step
            n={1}
            title="Paste your list"
            body="Upload a CSV or import from Safe. Names, addresses, amounts. We validate it live — typos and decimal mismatches fail loudly."
          />
          <Step
            n={2}
            title="Sign once"
            body="One signature, one on-chain transaction. Funds escrow into a private vault and are split into per-recipient stealth addresses."
          />
          <Step
            n={3}
            title="They claim privately"
            body="Each recipient gets a unique link. They click, connect their wallet, and the funds land — gas paid by you, amount visible only to them."
          />
        </div>
      </section>

      {/* Why us */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Why ScatterPay</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Other tools either leak amounts on-chain, charge per-recipient gas,
          or skip the audit trail. We do all three correctly.
        </p>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Feature</th>
                <th className="px-5 py-3 text-center">Safe + sheet</th>
                <th className="px-5 py-3 text-center">Request / Sablier</th>
                <th className="px-5 py-3 text-center text-[var(--color-primary)]">ScatterPay</th>
              </tr>
            </thead>
            <tbody>
              <Compare label="Recipients can't see each other's amounts" us />
              <Compare label="One on-chain transaction" left us />
              <Compare label="Gasless claim for recipients" us />
              <Compare label="Audit-grade signed export" us />
              <Compare label="Recurring payouts" mid us />
            </tbody>
          </table>
        </div>
      </section>

      {/* Pricing */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Pricing</h2>
        <p className="mx-auto mb-3 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Start free. Pay when you outgrow it.
        </p>
        <p className="mx-auto mb-10 inline-block max-w-2xl rounded-full bg-[var(--color-primary-soft)] px-3 py-1 text-center text-xs font-medium text-[var(--color-primary)]">
          🎉 Launch event: every plan free until Dec 31, 2026 — no card on file.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PriceCard plan="Free" price="$0" sub="3 payouts/mo, ≤ 20 recipients" features={["Stealth claim links", "Basic export"]} />
          <PriceCard
            plan="Team"
            price="$19"
            per="/mo"
            sub="Unlimited payouts, ≤ 100 recipients/run"
            features={["Everything in Free", "CSV + Safe import", "Email notifications"]}
            featured
          />
          <PriceCard plan="Business" price="$79" per="/mo" sub="Unlimited + recurring + Safe deep integration" features={["Everything in Team", "Recurring payouts", "Audit-grade PDF export", "Priority support"]} />
        </div>
        <p className="mt-3 text-center text-xs text-[var(--color-text-muted)]">
          Plus 0.05% of payout value per run (capped at $20). Enterprise / white-label available.
        </p>
      </section>

      {/* Final CTA */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-primary-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Ready to try?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          The demo is fully clickable with mock data — walk through the wizard
          and the recipient flow before you connect a wallet.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/payouts/new" className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
            Walk through the wizard
          </Link>
          <Link href="/claim/demo" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white">
            See the recipient page
          </Link>
        </div>
      </section>
    </div>
  );
}

function PersonaCard({ badge, title, body }: { badge: string; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="mb-3 inline-block rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-primary)]">
        {badge}
      </div>
      <div className="font-semibold">{title}</div>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-semibold text-white">
        {n}
      </div>
      <div className="font-semibold">{title}</div>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function Compare({ label, left, mid, us }: { label: string; left?: boolean; mid?: boolean; us?: boolean }) {
  const Cell = ({ on }: { on?: boolean }) => (
    <td className="px-5 py-3 text-center">
      {on ? (
        <span className="text-[var(--color-success)]">✓</span>
      ) : (
        <span className="text-[var(--color-text-subtle)]">—</span>
      )}
    </td>
  );
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-5 py-3">{label}</td>
      <Cell on={left} />
      <Cell on={mid} />
      <Cell on={us} />
    </tr>
  );
}

function PriceCard({
  plan, price, per, sub, features, featured,
}: { plan: string; price: string; per?: string; sub: string; features: string[]; featured?: boolean }) {
  return (
    <div className={`rounded-xl border p-6 ${featured ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] shadow-sm" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{plan}</div>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-3xl font-bold">{price}</span>
        {per && <span className="text-sm text-[var(--color-text-muted)]">{per}</span>}
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
      <ul className="mt-4 space-y-2 text-sm">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-0.5 text-[var(--color-success)]">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
