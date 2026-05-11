import Link from "next/link";

export default function Landing() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          Powered by zkScatter · Tokamak Network
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Send payroll, grants, and bonuses
          <br />
          <span className="text-[var(--color-primary)]">without leaking who got what.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          One-to-many private payouts for crypto-native companies and DAOs.
          Send to up to 128 recipients in a single private settlement — each recipient sees only their own amount,
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

      {/* Use cases */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Built for one-to-many payouts</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Anywhere you send money to multiple people and the per-recipient amount is sensitive.
          One-to-one vendor invoices live in a separate product.
        </p>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <PersonaCard
            badge="Payroll"
            title="Monthly salaries"
            body="Run payroll for 5–50 people without publishing every salary on-chain. Sign once, recipients claim privately."
          />
          <PersonaCard
            badge="Grants"
            title="DAO grants"
            body="Pay grant recipients from a Snapshot result or working group. Per-grant amounts stay private between treasury and recipient."
          />
          <PersonaCard
            badge="Bonus"
            title="Bonuses & incentives"
            body="One-off bonus rounds where size differences would create friction. Recipients only see their own amount."
          />
          <PersonaCard
            badge="Contractors"
            title="Contractor batch"
            body="Settle a wave of freelancers at once without leaking per-contractor rates to the rest of the cohort."
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
        <h2 className="mb-2 text-center text-2xl font-semibold">Why Scatter Pay</h2>
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
                <th className="px-5 py-3 text-center text-[var(--color-primary)]">Scatter Pay</th>
              </tr>
            </thead>
            <tbody>
              <Compare label="Recipients can't see each other's amounts" us />
              <Compare label="One on-chain transaction for N recipients" left us />
              <Compare label="Gasless claim for recipients" us />
              <Compare label="Categories for payroll / grants / bonuses" us />
              <Compare label="Audit-grade signed export" us />
            </tbody>
          </table>
        </div>
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
          <Link href="/claim?id=demo" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white">
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

