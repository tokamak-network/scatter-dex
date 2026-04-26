"use client";

import Link from "next/link";
import { useState } from "react";
import { useVault } from "../lib/vault";
import { DepositModal } from "../components/DepositModal";
import { OrderModal } from "../components/OrderModal";

const orderbook = {
  asks: [
    { price: "4,225.10", size: "1.2" },
    { price: "4,218.50", size: "0.8" },
    { price: "4,210.00", size: "2.5" },
  ],
  bids: [
    { price: "4,198.20", size: "1.4" },
    { price: "4,190.00", size: "3.1" },
    { price: "4,182.00", size: "0.9" },
  ],
};

export default function Workbench() {
  const [side, setSide] = useState<"sell" | "buy">("sell");
  const [price, setPrice] = useState("4,205");
  const [size, setSize] = useState("2.0");
  const [depositOpen, setDepositOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const { notes } = useVault();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Workbench</h1>
        <Link href="/orders" className="text-sm text-[var(--color-primary)] hover:underline">
          View order history →
        </Link>
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Vault */}
        <aside className="col-span-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">My vault</div>
          <div className="space-y-3">
            {notes.map((n) => (
              <div key={n.id} className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <div className="text-xs text-[var(--color-text-muted)]">{n.label}</div>
                <div className="mt-0.5 font-mono text-sm font-semibold">{n.amount} {n.symbol}</div>
              </div>
            ))}
            {notes.length === 0 && (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-muted)]">
                Your vault is empty. Deposit to start trading privately.
              </div>
            )}
          </div>
          <button
            onClick={() => setDepositOpen(true)}
            className="mt-4 w-full rounded-md border border-[var(--color-border-strong)] bg-white py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
          >
            + Deposit
          </button>
          <div className="mt-5 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            Funds in your vault are not visible to public dashboards.
          </div>
        </aside>

        {/* Order form */}
        <section className="col-span-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Place private order</div>
          <div className="mb-4 flex rounded-md border border-[var(--color-border)] p-1 text-sm">
            <button onClick={() => setSide("sell")} className={`flex-1 rounded ${side === "sell" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}>Sell ETH</button>
            <button onClick={() => setSide("buy")} className={`flex-1 rounded ${side === "buy" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}>Buy ETH</button>
          </div>
          <div className="space-y-3 text-sm">
            <Field label="Price (USDC / ETH)">
              <input value={price} onChange={(e) => setPrice(e.target.value)} className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono" />
            </Field>
            <Field label="Size (ETH)">
              <input value={size} onChange={(e) => setSize(e.target.value)} className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono" />
            </Field>
            <Field label="Receive at">
              <select className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2">
                <option>Same wallet</option>
                <option>Stealth address (new)</option>
                <option>Different address…</option>
              </select>
            </Field>
          </div>
          <div className="mt-4 rounded-md border border-[var(--color-success-soft)] bg-[var(--color-success-soft)] p-3 text-xs">
            <div className="flex justify-between"><span>Estimated fill</span><span className="font-mono">$4,205.30</span></div>
            <div className="flex justify-between"><span>vs Uniswap quote</span><span className="font-mono">$4,176.10</span></div>
            <div className="mt-1 flex justify-between font-medium text-[var(--color-success)]"><span>Slippage saved</span><span>−0.7% (≈ $58.40)</span></div>
          </div>
          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            Launch event: 0% fee until Dec 31, 2026 (normally 0.02%) + $0.01 settlement. Proof generation is ~1–2&nbsp;s on desktop, ~5–9&nbsp;s on mobile.
          </div>
          <button
            onClick={() => setOrderOpen(true)}
            className="mt-4 w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Sign &amp; submit
          </button>
        </section>

        {/* Orderbook */}
        <aside className="col-span-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Orderbook · ETH/USDC</div>
          <div className="text-sm">
            {orderbook.asks.slice().reverse().map((o) => (
              <Row key={`a-${o.price}`} side="ask" price={o.price} size={o.size} />
            ))}
            <div className="my-1 rounded bg-[var(--color-bg)] py-1 text-center text-xs text-[var(--color-text-muted)]">
              mid 4,204.10
            </div>
            {orderbook.bids.map((o) => (
              <Row key={`b-${o.price}`} side="bid" price={o.price} size={o.size} />
            ))}
          </div>
          <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            Depth: $1.2M · Avg fill: 0.3%
          </div>
        </aside>
      </div>

      <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} />
      <OrderModal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        side={side}
        pair="ETH/USDC"
        price={price}
        size={size}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Row({ side, price, size }: { side: "ask" | "bid"; price: string; size: string }) {
  return (
    <div className={`flex justify-between rounded px-2 py-1 font-mono text-xs ${side === "ask" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]"}`}>
      <span>{price}</span>
      <span className="text-[var(--color-text-muted)]">{size}</span>
    </div>
  );
}
