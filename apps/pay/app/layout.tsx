import type { Metadata } from "next";
import Link from "next/link";
import { PayProviders } from "./_lib/providers";
import { WalletButton } from "./_components/WalletButton";
import { Brand } from "./_components/Brand";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Pay — Private bulk payouts",
  description:
    "Send payroll, grants, and bonuses without leaking who got what. One-to-many private payouts on zkScatter.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PayProviders>
          <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
            🎉 Launch event — all plans free until Dec 31, 2026. No credit card required.
          </div>
          <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
              <Brand />
              <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
                <a
                  href={process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter.xyz"}
                  className="hover:text-[var(--color-text)]"
                >
                  ← All apps
                </a>
                <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
                <Link href="/payouts/new" className="hover:text-[var(--color-text)]">New payout</Link>
                <Link href="/recipients" className="hover:text-[var(--color-text)]">Recipients</Link>
                <WalletButton />
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
          <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
            Scatter Pay · Powered by zkScatter · zk-X509 audit trail · Tokamak Network
          </footer>
        </PayProviders>
      </body>
    </html>
  );
}
