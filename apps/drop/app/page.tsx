import Link from "next/link";

export default function Landing() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />
          Powered by zkScatter · Tokamak Network
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Get your token to real humans,
          <br />
          <span className="text-[var(--color-primary)]">not bot farms.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Sybil-resistant private airdrops for token launch teams.
          Real one-person-one-claim via zk-X509, gasless claim for recipients,
          and per-wallet amounts hidden on-chain to reduce day-one dump pressure.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/campaigns/new"
            className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Try a sample campaign →
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-[var(--color-primary-soft)]"
          >
            See dashboard
          </Link>
        </div>
        <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
          No signup needed for the demo. Mock data only.
        </p>
      </section>

      {/* Who is this for */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Who is this for?</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          You&apos;re shipping a token and you want it in the right hands.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PersonaCard
            badge="Token launch team"
            title="You're about to run a TGE or governance drop"
            body="Last time, sybil farmers took 10–30% of the supply and dumped it on day one. You want a real defense, not heuristics."
          />
          <PersonaCard
            badge="NFT / community"
            title="You want to reward real holders"
            body="You need to filter wash-trading wallets and reward people who actually engaged — not bots scripted to farm allowlists."
          />
          <PersonaCard
            badge="DAO governance"
            title="You distribute voting power or rewards"
            body="You want recipients to claim without paying gas, and you want your distribution to look credible — not bot-farmed."
          />
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">How it works</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Four steps. Live in under an hour.
        </p>
        <div className="grid grid-cols-4 gap-4">
          <Step n={1} title="Pick a recipient source" body="Snapshot voters, NFT holders, or upload a CSV. We compute the merkle root." />
          <Step n={2} title="Set sybil & privacy policy" body="Require zk-X509 (real 1 person = 1 claim). Toggle gasless claim." />
          <Step n={3} title="Launch the campaign" body="One transaction commits the campaign on-chain. Share the claim URL or embed the widget on your site." />
          <Step n={4} title="Monitor live" body="See claim rate, sybil attempts blocked, and per-day curve — share the live counter on Twitter." />
        </div>
      </section>

      {/* Why us */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Why Scatter Drop</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Existing tools either let bots in, charge recipients gas, or expose
          claim amounts publicly. We close all three holes.
        </p>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Feature</th>
                <th className="px-5 py-3 text-center">Merkle distributor</th>
                <th className="px-5 py-3 text-center">Galxe / Layer3</th>
                <th className="px-5 py-3 text-center text-[var(--color-primary)]">Scatter Drop</th>
              </tr>
            </thead>
            <tbody>
              <Compare label="Anti-sybil (provable, not heuristic)" us />
              <Compare label="Gasless claim for recipients" us />
              <Compare label="Per-recipient amount hidden on-chain" us />
              <Compare label="Embeddable claim widget on your site" mid us />
              <Compare label="Audit-grade signed export" us />
            </tbody>
          </table>
        </div>
      </section>

      {/* Stats / proof */}
      <section className="grid grid-cols-3 gap-4">
        <StatBig n="64%" label="Avg claim rate" sub="vs 25% industry baseline" />
        <StatBig n="3,841" label="Sybil attempts blocked" sub="across pilot campaigns" />
        <StatBig n="0" label="Recipient gas paid" sub="campaign covers it" />
      </section>

      {/* Pricing */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Pricing</h2>
        <p className="mx-auto mb-3 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Pick the model that matches your drop size.
        </p>
        <p className="mx-auto mb-10 inline-block max-w-2xl rounded-full bg-[var(--color-primary-soft)] px-3 py-1 text-center text-xs font-medium text-[var(--color-primary)]">
          🎉 Launch event: zero fees on drops that launch before Dec 31, 2026.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PriceCard plan="Small drop" price="$99" sub="Per campaign · up to $50K distributed" features={["zk-X509 anti-sybil", "Gasless claim", "Standard claim page"]} />
          <PriceCard plan="Standard" price="0.2%" sub="Of distributed token value (no minimum)" features={["Everything in Small", "Live dashboard + Twitter widget", "Snapshot / NFT import", "Sybil block report"]} featured />
          <PriceCard plan="Launch partner" price="Custom" sub="From $2K · white-label" features={["Everything in Standard", "Custom domain & branding", "Embeddable widget for your site", "Co-marketing"]} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-primary-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Ready to try?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          Walk through the campaign builder with mock data — see the recipient
          claim flow before you commit a real token.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/campaigns/new" className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
            Build a sample campaign
          </Link>
          <Link href="/claim/c_xyz_genesis" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white">
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

function StatBig({ n, label, sub }: { n: string; label: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
      <div className="text-4xl font-bold text-[var(--color-primary)]">{n}</div>
      <div className="mt-2 font-semibold">{label}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
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
