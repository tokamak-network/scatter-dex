import Link from "next/link";
import { Stat } from "../components/Stat";

const recentSettlements = [
  { id: "s_2026_04_27_a", pair: "USDC/WETH", volume: "82,400", fee: "24.72", at: "2026-04-27 09:14", status: "settled" },
  { id: "s_2026_04_27_b", pair: "USDT/WBTC", volume: "55,100", fee: "16.53", at: "2026-04-27 08:51", status: "settled" },
  { id: "s_2026_04_27_c", pair: "USDC/TON",  volume: "12,800", fee: "3.84",  at: "2026-04-27 08:32", status: "settled" },
  { id: "s_2026_04_27_d", pair: "USDC/WETH", volume: "9,200",  fee: "2.76",  at: "2026-04-27 08:10", status: "settled" },
];

export default function Dashboard() {
  return (
    <div className="space-y-10">
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Operator dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Live view of fills, fee revenue, and node health for relayer{" "}
            <span className="font-mono text-[var(--color-text)]">0xA1…f4</span>.
          </p>
        </div>
        <Link
          href="/orders"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          View live orders →
        </Link>
      </section>

      <section className="grid grid-cols-4 gap-4">
        <Stat label="Fee revenue (24h)" value="$348.21" sub="↑ 12% vs prior day" />
        <Stat label="Settled orders (24h)" value="61" sub="of 64 routed" />
        <Stat label="Avg settle latency" value="2.4s" sub="p50, last 1k orders" />
        <Stat label="Bond posted" value="0.10 ETH" sub="≈ $310 at current price" />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Health</h2>
        <div className="grid grid-cols-3 gap-4">
          <HealthCard label="Node status" value="Healthy" tone="success" sub="Uptime 14d 6h" />
          <HealthCard label="RPC backend" value="OK" tone="success" sub="p95 latency 86ms" />
          <HealthCard label="Last settlement" value="3 min ago" tone="success" sub="Block 18,432,901" />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recent settlements</h2>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {recentSettlements.map((s) => (
            <Link
              key={s.id}
              href={`/orders?settlement=${s.id}`}
              className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0 hover:bg-[var(--color-primary-soft)]"
            >
              <div>
                <div className="font-medium">{s.pair}</div>
                <div className="text-xs text-[var(--color-text-muted)]">{s.at}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm">{s.volume} USD</div>
                <div className="text-xs text-[var(--color-success)]">+ {s.fee} fee</div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function HealthCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "success" | "warning" | "danger";
  sub: string;
}) {
  const dot = {
    success: "bg-[var(--color-success)]",
    warning: "bg-[var(--color-warning)]",
    danger:  "bg-[var(--color-danger)]",
  }[tone];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="text-base font-semibold">{value}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
