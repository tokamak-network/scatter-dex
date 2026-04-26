import Link from "next/link";

const orders = [
  { id: "ord_8412", side: "Sell", pair: "ETH/USDC", price: "4,205", size: "2.0", status: "settled",  date: "Apr 26, 09:14" },
  { id: "ord_8401", side: "Buy",  pair: "WBTC/USDC", price: "67,210", size: "0.15", status: "matching", date: "Apr 26, 08:51" },
  { id: "ord_8388", side: "Sell", pair: "ETH/USDC", price: "4,198", size: "1.5", status: "settled",  date: "Apr 25, 22:30" },
  { id: "ord_8377", side: "Buy",  pair: "TON/USDC", price: "5.42",   size: "1500", status: "cancelled", date: "Apr 25, 18:02" },
];

export default function Orders() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <Link href="/app" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Back to workbench
        </Link>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Order</th>
              <th className="px-5 py-3 text-left">Side</th>
              <th className="px-5 py-3 text-left">Pair</th>
              <th className="px-5 py-3 text-right">Price</th>
              <th className="px-5 py-3 text-right">Size</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">When</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className="border-t border-[var(--color-border)]">
                <td className="px-5 py-3 font-mono text-xs">{o.id}</td>
                <td className="px-5 py-3">{o.side}</td>
                <td className="px-5 py-3">{o.pair}</td>
                <td className="px-5 py-3 text-right font-mono">{o.price}</td>
                <td className="px-5 py-3 text-right font-mono">{o.size}</td>
                <td className="px-5 py-3"><Pill s={o.status} /></td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{o.date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pill({ s }: { s: string }) {
  const map: Record<string, string> = {
    settled:   "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    matching:  "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    cancelled: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[s] || ""}`}>{s}</span>;
}
