import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScatterPay — Private bulk payouts",
  description:
    "Pay your team or vendors in one transaction. Recipients can't see each other's amounts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
          🎉 Launch event — all plans free until Dec 31, 2026. No credit card required.
        </div>
        <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="inline-block h-6 w-6 rounded bg-[var(--color-primary)]" />
              ScatterPay
            </Link>
            <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
              <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
              <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
              <Link href="/payouts/new" className="hover:text-[var(--color-text)]">New payout</Link>
              <span className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
                Acme DAO · 0x12…ab
              </span>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
        <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
          ScatterPay · Powered by ScatterDEX · zk-X509 audit trail · Tokamak Network
        </footer>
      </body>
    </html>
  );
}
