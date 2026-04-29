import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider } from "@zkscatter/sdk/react";
import { ConnectWalletPill } from "./components/ConnectWalletPill";
import { WrongChainBanner } from "./components/WrongChainBanner";
import { Brand } from "./components/Brand";
import { Pill, StatusDot, AppShellHeader } from "@zkscatter/ui";
import { DEMO_NETWORK } from "./lib/network";
import { OperatorProvider } from "./lib/useOperator";
import { FeeVaultProvider } from "./lib/useFeeVault";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Relayer — Run a zkScatter relayer node",
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
            <AppShellHeader
              brand={<Brand />}
              chainPill={
                <Pill title={DEMO_NETWORK.name ?? "Network"}>
                  <StatusDot kind="online" />
                  <span>{DEMO_NETWORK.name ?? "Network"}</span>
                </Pill>
              }
              walletSlot={<ConnectWalletPill />}
              topRibbon={
                <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
                  Relayer preview — Sepolia testnet. Pages with mock data are tagged inline.
                </div>
              }
              navLinks={
                <>
                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                  <Link href="/onboarding" className="hover:text-[var(--color-text)]">Get started</Link>
                  <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
                  <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
                  <Link href="/treasury" className="hover:text-[var(--color-text)]">Treasury</Link>
                  <Link href="/leaderboard" className="hover:text-[var(--color-text)]">Leaderboard</Link>
                  <Link href="/profile" className="hover:text-[var(--color-text)]">Profile</Link>
                  <Link href="/runtime" className="hover:text-[var(--color-text)]">Runtime</Link>
                  <Link href="/register" className="hover:text-[var(--color-text)]">Register</Link>
                </>
              }
            />
            <WrongChainBanner />
            <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
            <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
              Scatter Relayer · Powered by zkScatter · Tokamak Network
            </footer>
            </FeeVaultProvider>
          </OperatorProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
