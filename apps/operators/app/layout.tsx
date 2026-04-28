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
            <AppShellHeader
              brand={<Brand />}
              chainPill={
                <Pill title={DEMO_NETWORK.name ?? "Network"}>
                  <StatusDot kind="online" />
                  <span>{DEMO_NETWORK.name ?? "Network"}</span>
                </Pill>
              }
              walletSlot={<ConnectWalletPill />}
              hubUrl={process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter.xyz"}
              topRibbon={
                <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
                  Operator preview — Sepolia testnet. Pages with mock data are tagged inline.
                </div>
              }
              navLinks={
                <>
                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                  <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
                  <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
                  <Link href="/treasury" className="hover:text-[var(--color-text)]">Treasury</Link>
                  <Link href="/leaderboard" className="hover:text-[var(--color-text)]">Leaderboard</Link>
                  <Link href="/profile" className="hover:text-[var(--color-text)]">Profile</Link>
                  <Link href="/register" className="hover:text-[var(--color-text)]">Register</Link>
                </>
              }
            />
            <WrongChainBanner />
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
