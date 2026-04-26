import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Pro — Private limit orders for serious traders",
  description:
    "MEV-free, balance-private, regulator-ready private limit orders on Ethereum L2.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
          🎉 Launch event — zero trading fees on every order until Dec 31, 2026.
        </div>
        <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="inline-block h-6 w-6 rounded bg-[var(--color-primary)]" />
              Scatter <span className="text-xs font-medium text-[var(--color-text-muted)]">Pro</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
              <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
              <Link href="/app" className="hover:text-[var(--color-text)]">Workbench</Link>
              <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
              <span className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
                zk-X509 ✓ · 0x12…ab
              </span>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
        <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
          Scatter Pro · Powered by zkScatter · Tokamak Network · KISA-registered relayers
        </footer>
      </body>
    </html>
  );
}
