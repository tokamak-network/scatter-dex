import type { Metadata } from "next";
import Link from "next/link";
import { TokamakMark } from "@zkscatter/ui";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Drop — Sybil-resistant private airdrops",
  description:
    "Run an airdrop without bots, without gas costs for recipients, and without leaking who got how much.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
          🎉 Launch event — zero campaign fees on drops launched before Dec 31, 2026.
        </div>
        <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <TokamakMark />
              Scatter Drop
            </Link>
            <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
              <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
              <Link href="/dashboard" className="hover:text-[var(--color-text)]">Campaigns</Link>
              <Link href="/campaigns/new" className="hover:text-[var(--color-text)]">New campaign</Link>
              <span className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
                Project: $XYZ
              </span>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
        <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
          <div>Scatter Drop · Powered by zkScatter · zk-X509 anti-sybil · Tokamak Network</div>
          <div className="mt-1">
            Not a mixer or anonymity tool. Use is prohibited for money laundering, terrorist financing, sanctions evasion, Travel Rule evasion, or any other illegal activity.
          </div>
        </footer>
      </body>
    </html>
  );
}
