import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider } from "@zkscatter/sdk/react";
import { TokamakMark } from "@zkscatter/ui";
import { ConnectWalletPill } from "./components/ConnectWalletPill";
import { DEMO_NETWORK } from "./lib/network";
import { OperatorProvider } from "./lib/useOperator";
import { FeeVaultProvider } from "./lib/useFeeVault";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Operators — Run a zkScatter relayer",
  description:
    "Register a relayer, manage your fee policy, and monitor settlement performance on the zkScatter network.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider network={DEMO_NETWORK}>
          <OperatorProvider>
            <FeeVaultProvider>
            <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
              Operator preview — Sepolia testnet. Pages with mock data are tagged inline.
            </div>
            <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
                <Link href="/" className="flex items-center gap-2 font-semibold">
                  <TokamakMark />
                  Scatter Operators
                </Link>
                <nav className="flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
                  <a
                    href={process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter.xyz"}
                    className="hover:text-[var(--color-text)]"
                  >
                    ← All apps
                  </a>
                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                  <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
                  <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
                  <Link href="/treasury" className="hover:text-[var(--color-text)]">Treasury</Link>
                  <Link href="/leaderboard" className="hover:text-[var(--color-text)]">Leaderboard</Link>
                  <Link href="/profile" className="hover:text-[var(--color-text)]">Profile</Link>
                  <Link href="/register" className="hover:text-[var(--color-text)]">Register</Link>
                  <ConnectWalletPill />
                </nav>
              </div>
            </header>
            <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
            <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
              Scatter Operators · Powered by zkScatter · Tokamak Network
            </footer>
            </FeeVaultProvider>
          </OperatorProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
