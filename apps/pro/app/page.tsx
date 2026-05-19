import Link from "next/link";

export default function Landing() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          MEV-free · Balance-private · Regulator-ready
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Get the price you see.
          <br />
          <span className="text-[var(--color-primary)]">No MEV. No desk spread. No RFQ leak.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Limit orders matched directly with other size traders. Skip the
          OTC desk spread, skip the Telegram intros, settle on Ethereum
          mainnet. ETH / USDC / USDT / TON pairs at launch.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/app"
            className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Open the workbench →
          </Link>
          <Link
            href="/orders"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-[var(--color-primary-soft)]"
          >
            See order history
          </Link>
        </div>
      </section>

      {/* Quick proof bar */}
      <section className="grid grid-cols-4 gap-4">
        <StatBig n="1-3%" label="Saved per trade" sub="vs OTC desk spread" />
        <StatBig n="0%" label="MEV exposure" sub="limit orders, not AMM" />
        <StatBig n="~$0.01" label="Cost per proof" sub="Mainnet settlement" />
        <StatBig n="100%" label="On-chain auditable" sub="Dual-CA registry" />
      </section>

      {/* Who is this for */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Who is this for?</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Built for traders whose positions are big enough that being seen
          on-chain costs real money.
        </p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <PersonaCard
            badge="OTC desk"
            title="Skip the spread"
            body="Stop paying Wintermute 1–2% per trade. Match directly with another OTC trader over the shared private orderbook — no Telegram intros, no RFQ leak."
          />
          <PersonaCard
            badge="Semi-pro trader"
            title="No MEV bleed"
            body="$50K trades on Uniswap lose 1–3% to sandwiches. Limit orders matched off-chain skip the AMM curve and the front-runner entirely."
          />
          <PersonaCard
            badge="Privacy-conscious whale"
            title="Stop being a target"
            body="Copy traders, liquidation bots, and tax-tracking services all watch big wallets. Trade without leaving public data behind for the next desk to read."
          />
          <PersonaCard
            badge="Treasury / family office"
            title="One trade, many recipients"
            body="Sell size in a single order and route the proceeds across multiple wallets — different addresses, optional per-recipient vesting, all in one private transaction."
          />
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">How it works</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Three steps. No new chain to learn, no exotic wallet.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Step
            n={1}
            title="Deposit into a private vault"
            body="Wrap or approve your token, deposit once. Funds enter a Poseidon commitment — visible to you, not to the public order book."
          />
          <Step
            n={2}
            title="Place a private limit order"
            body="Set price, size, and recipient. Sign with your trading key. The order joins the shared orderbook anonymously and waits for a match."
          />
          <Step
            n={3}
            title="Settle and claim"
            body="When matched, the relayer batches settlements on-chain. You claim the proceeds gaslessly to your wallet — KYC-gated and compliance-aware."
          />
        </div>
      </section>

      {/* Strengths / differentiators */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Why Scatter Pro</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          The only DEX that combines MEV immunity, balance privacy, and a
          public regulatory record.
        </p>

        <div className="mb-6 grid grid-cols-3 gap-4">
          <Strength
            title="MEV-free by construction"
            body="No AMM curve. Limit-order matching means no slippage to sandwich and no flash-loan attacks against your fill."
          />
          <Strength
            title="Balance privacy that holds"
            body="Your vault, change notes, and counterparty all hide on-chain. No mempool leak, no settlement-trace doxxing."
          />
          <Strength
            title="Regulator-ready, not regulator-hostile"
            body="Dual-CA architecture: you verify identity privately once, relayers are publicly registered. Auditable trail without losing privacy."
          />
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Feature</th>
                <th className="px-5 py-3 text-center">Uniswap</th>
                <th className="px-5 py-3 text-center">CowSwap</th>
                <th className="px-5 py-3 text-center">Tornado-style</th>
                <th className="px-5 py-3 text-center text-[var(--color-primary)]">Scatter Pro</th>
              </tr>
            </thead>
            <tbody>
              <Compare label="MEV-free fills" mid us />
              <Compare label="Wallet balance hidden after trade" right us />
              <Compare label="Regulator-clean (no mixer flag)" left mid us />
              <Compare label="Audit trail for accountants" left mid us />
              <Compare label="Settles in one tx (batched)" mid us />
              <Compare label="Mobile companion (Quick Sign)" us />
            </tbody>
          </table>
          <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-2 text-xs text-[var(--color-text-muted)]">
            ✓ = supported · — = not supported. CowSwap mitigates MEV via batching but does not hide your balance.
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Pricing</h2>
        <p className="mx-auto mb-3 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Pay per trade. Volume earns a rate cut.
        </p>
        <p className="mx-auto mb-10 inline-block max-w-2xl rounded-full bg-[var(--color-primary-soft)] px-3 py-1 text-center text-xs font-medium text-[var(--color-primary)]">
          🎉 Launch event: zero trading fees on every order until Dec 31, 2026.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PriceCard plan="Standard" price="0.02%" sub="Per trade · relayer fee included" features={["Private limit orders", "Gasless claim", "Mobile Quick Sign"]} />
          <PriceCard plan="Active" price="0.01%" sub="Per trade · once monthly volume ≥ $500K" features={["Everything in Standard", "Priority relayer routing", "Custom alerts"]} featured />
          <PriceCard plan="OTC desk" price="Custom" sub="White-label, dedicated relayer" features={["Everything in Active", "Multi-trader accounts", "Direct counterparty matching", "Compliance export"]} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-primary-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Ready to see it in motion?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          Pick a workspace folder, deposit into the escrow pool, and
          place a private limit order in under a minute.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/app" className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
            Open the workbench
          </Link>
          <Link href="/orders" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white">
            See order history
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

function Strength({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="font-semibold">{title}</div>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">{body}</p>
    </div>
  );
}

function Compare({ label, left, mid, right, us }: { label: string; left?: boolean; mid?: boolean; right?: boolean; us?: boolean }) {
  const Cell = ({ on }: { on?: boolean }) => (
    <td className="px-5 py-3 text-center">
      {on ? <span className="text-[var(--color-success)]">✓</span> : <span className="text-[var(--color-text-subtle)]">—</span>}
    </td>
  );
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-5 py-3">{label}</td>
      <Cell on={left} />
      <Cell on={mid} />
      <Cell on={right} />
      <Cell on={us} />
    </tr>
  );
}

function StatBig({ n, label, sub }: { n: string; label: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
      <div className="text-3xl font-bold text-[var(--color-primary)]">{n}</div>
      <div className="mt-2 text-sm font-semibold">{label}</div>
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
