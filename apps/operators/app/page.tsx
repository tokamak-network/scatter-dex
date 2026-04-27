import Link from "next/link";

export default function Landing() {
  return (
    <div className="space-y-24">
      {/* Hero */}
      <section className="pt-12 text-center">
        <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" />
          Permissionless · Bond-secured · MEV-resistant
        </div>
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight">
          Earn fees routing private orders.
          <br />
          <span className="text-[var(--color-primary)]">No proprietary stack to run.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)]">
          Run a zkScatter relayer with the open-source node. Stake a small bond,
          publish a fee, and start collecting per-trade revenue from privacy-seeking
          OTC desks, payroll teams, and DAOs.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Link
            href="/register"
            className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Register a relayer →
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-[var(--color-primary-soft)]"
          >
            See operator dashboard
          </Link>
        </div>
        <p className="mt-4 text-xs text-[var(--color-text-subtle)]">
          Demo flows below use mock data. Connect a wallet on /register to bond on-chain.
        </p>
      </section>

      {/* Who is this for */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Who runs a relayer?</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          You're a fit if any of these matches.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <PersonaCard
            badge="Validator / staker"
            title="You already operate node infra"
            body="Idle bandwidth and a 24/7 box are most of the cost. Adding a relayer is a small marginal lift for a new fee stream."
          />
          <PersonaCard
            badge="Market maker"
            title="You quote on-chain liquidity"
            body="Routing your own orders through your own relayer captures the relayer fee instead of paying it to a third party."
          />
          <PersonaCard
            badge="Privacy infra DAO"
            title="You run RPCs, sequencers, or bridges"
            body="A relayer is the same operational profile, with a clear revenue contract from day one."
          />
        </div>
      </section>

      {/* How it works */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">How operating works</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Three steps to a live, paying relayer.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Step
            n={1}
            title="Register on-chain"
            body="Post a bond to the RelayerRegistry contract and publish your endpoint URL plus per-trade fee in basis points."
          />
          <Step
            n={2}
            title="Run the node"
            body="Spin up the open-source relayer (Docker / single binary). It accepts signed orders, batches them, and submits settlement transactions."
          />
          <Step
            n={3}
            title="Collect fees"
            body="Each settled order pays your fee directly to your operator address. Withdraw any time; exit the registry to recover your bond after the cool-down."
          />
        </div>
      </section>

      {/* Why us */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Why operate on Scatter</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Other private trading networks gate operator slots, take a cut, or
          require proprietary hardware. Scatter is open and contract-priced.
        </p>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Property</th>
                <th className="px-5 py-3 text-center">Closed networks</th>
                <th className="px-5 py-3 text-center">Generic MEV stack</th>
                <th className="px-5 py-3 text-center text-[var(--color-primary)]">Scatter</th>
              </tr>
            </thead>
            <tbody>
              <Compare label="Permissionless registration" us />
              <Compare label="Bond-secured slashing protections" us />
              <Compare label="No revenue share to a foundation" mid us />
              <Compare label="Open-source node binary" mid us />
              <Compare label="Per-trade fee published on-chain" us />
            </tbody>
          </table>
        </div>
      </section>

      {/* Economics */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Operator economics</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          Indicative numbers from the testnet pilot. Production parameters set by governance.
        </p>
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Minimum bond" value="0.1 ETH" sub="Recoverable on exit" />
          <Stat label="Default fee" value="30 bps" sub="0.30% per settled trade" />
          <Stat label="Pilot fill rate" value="~92%" sub="Across active relayers" />
        </div>
      </section>

      {/* Setup */}
      <section>
        <h2 className="mb-2 text-center text-2xl font-semibold">Run the node</h2>
        <p className="mx-auto mb-10 max-w-2xl text-center text-sm text-[var(--color-text-muted)]">
          The relayer node is open-source. Single Docker image, single config file.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="mb-2 font-semibold">Quick start</div>
            <pre className="overflow-x-auto rounded-lg bg-[var(--color-bg)] p-4 text-xs leading-relaxed">
{`docker run -d \\
  --name scatter-relayer \\
  -p 8080:8080 \\
  -e RPC_URL=$RPC_URL \\
  -e OPERATOR_KEY=$OPERATOR_KEY \\
  -e REGISTRY_ADDR=$REGISTRY_ADDR \\
  ghcr.io/tokamak-network/scatter-relayer:latest`}
            </pre>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Health probe: <code className="font-mono">GET /api/info</code>.
              Submission endpoint: <code className="font-mono">POST /api/orders</code>.
            </p>
          </div>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
            <div className="mb-2 font-semibold">Operator guide</div>
            <ul className="space-y-2 text-sm text-[var(--color-text-muted)]">
              <li>· Hardware: 2 vCPU, 4 GB RAM, 50 GB SSD</li>
              <li>· Trusted RPC with archive support recommended</li>
              <li>· HTTPS termination required for registration</li>
              <li>· Prometheus metrics at <code className="font-mono">/metrics</code></li>
              <li>· Logs to stdout, structured JSON</li>
            </ul>
            <a
              href="https://github.com/tokamak-network/scatter-dex"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-block text-sm font-medium text-[var(--color-primary)] hover:underline"
            >
              Read the operator guide →
            </a>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="rounded-2xl border border-[var(--color-border)] bg-gradient-to-br from-[var(--color-primary-soft)] to-[var(--color-surface)] p-10 text-center">
        <h2 className="text-2xl font-semibold">Ready to operate?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--color-text-muted)]">
          Walk through the registration flow with mock data, then connect a wallet
          when you're ready to bond on-chain.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link href="/register" className="rounded-lg bg-[var(--color-primary)] px-6 py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]">
            Walk through registration
          </Link>
          <Link href="/orders" className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-3 font-medium hover:bg-white">
            See routed orders
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

function Compare({ label, mid, us }: { label: string; mid?: boolean; us?: boolean }) {
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
      <Cell />
      <Cell on={mid} />
      <Cell on={us} />
    </tr>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
