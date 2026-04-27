"use client";

import Link from "next/link";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { SectionHeader } from "../components/SectionHeader";
import { useOperator, type OperatorState } from "../lib/useOperator";

const recentSettlements = [
  { id: "s_2026_04_27_a", pair: "USDC/WETH", volume: "82,400", fee: "24.72", at: "2026-04-27 09:14", status: "settled" },
  { id: "s_2026_04_27_b", pair: "USDT/WBTC", volume: "55,100", fee: "16.53", at: "2026-04-27 08:51", status: "settled" },
  { id: "s_2026_04_27_c", pair: "USDC/TON",  volume: "12,800", fee: "3.84",  at: "2026-04-27 08:32", status: "settled" },
  { id: "s_2026_04_27_d", pair: "USDC/WETH", volume: "9,200",  fee: "2.76",  at: "2026-04-27 08:10", status: "settled" },
];

export default function Dashboard() {
  const operator = useOperator();

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />
      <section className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Operator dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Live view of fills, fee revenue, and node health.
          </p>
        </div>
        <Link
          href="/orders"
          className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          View live orders →
        </Link>
      </section>

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <BondCard operator={operator} />
          <FeeCard operator={operator} />
          <RegisteredCard operator={operator} />
        </div>
      </section>

      <section>
        <SectionHeader title="Operations" badge="mock" hint="Wired in once the indexer ships" />
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Fee revenue (24h)" value="$348.21" sub="↑ 12% vs prior day" />
          <Stat label="Settled orders (24h)" value="61" sub="of 64 routed" />
          <Stat label="Avg settle latency" value="2.4s" sub="p50, last 1k orders" />
        </div>
      </section>

      <section>
        <SectionHeader title="Health" badge="mock" />
        <div className="grid grid-cols-3 gap-4">
          <HealthCard label="Node status" value="Healthy" tone="success" sub="Uptime 14d 6h" />
          <HealthCard label="RPC backend" value="OK" tone="success" sub="p95 latency 86ms" />
          <HealthCard label="Last settlement" value="3 min ago" tone="success" sub="Block 18,432,901" />
        </div>
      </section>

      <section>
        <SectionHeader title="Recent settlements" badge="mock" />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {recentSettlements.map((s) => (
            <Link
              key={s.id}
              href="/orders"
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

/** Render the same loading / unconnected / undeployed / error
 *  placeholder text across every on-chain card so a wallet that
 *  errored on registry read shows a useful sub everywhere, not
 *  just on the bond card. Returns null when the row is fully
 *  loaded — caller renders the live value. */
function operatorPlaceholder(state: OperatorState): { value: string; sub: string } | null {
  if (!state.account) return { value: "—", sub: "Connect wallet to load" };
  if (!state.registryDeployed) return { value: "—", sub: "Registry not deployed" };
  if (state.loading) return { value: "…", sub: "Reading registry" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  if (!state.row || state.row.status === "unregistered") {
    return { value: "—", sub: "Not registered yet" };
  }
  return null;
}

function BondCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Bond posted" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  return <Stat label="Bond posted" value={`${row.bondEth} ETH`} sub={`Status: ${row.status}`} />;
}

function FeeCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Per-trade fee" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  return <Stat label="Per-trade fee" value={`${row.feeBps} bps`} sub={`= ${(row.feeBps / 100).toFixed(2)}% per fill`} />;
}

function RegisteredCard({ operator }: { operator: OperatorState }) {
  const ph = operatorPlaceholder(operator);
  if (ph) return <Stat label="Registered" value={ph.value} sub={ph.sub} />;
  const row = operator.row!;
  // Locale-stable ISO formatting — `toLocaleDateString` would
  // disagree between server and client and trip Next's hydration
  // mismatch warning. The date-using branch only renders post-
  // mount (gated by `account`), so `Date.now()` is safe here.
  const value = formatIsoDate(row.registeredAt);
  const ageDays = Math.floor((Date.now() - row.registeredAt * 1000) / (1000 * 60 * 60 * 24));
  const sub = row.exitRequestedAt > 0
    ? `Exit requested ${formatIsoDate(row.exitRequestedAt)}`
    : `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
  return <Stat label="Registered" value={value} sub={sub} />;
}

function formatIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
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
