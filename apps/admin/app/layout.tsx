import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider, ChunkReloadGuard } from "@zkscatter/sdk/react";
import { Pill, StatusDot, AppShellHeader } from "@zkscatter/ui";
import { OperatorCaNav } from "./components/OperatorCaNav";
import { AdminBadge } from "./components/AdminBadge";
import { Brand } from "./components/Brand";
import { ConnectWalletPill } from "./components/ConnectWalletPill";
import { WrongChainBanner } from "./components/WrongChainBanner";
import { DEMO_NETWORK } from "./lib/network";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Admin — Platform administration",
  description:
    "Platform admin console for zkScatter: issue operator X.509 certificates, manage SanctionsList, protocol parameters, and treasury.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ChunkReloadGuard />
        <WalletProvider network={DEMO_NETWORK}>
          <AppShellHeader
            brand={<Brand />}
            chainPill={
              <Pill title={DEMO_NETWORK.name ?? "Network"}>
                <StatusDot kind="online" />
                <span>{DEMO_NETWORK.name ?? "Network"}</span>
              </Pill>
            }
            navLinks={
              <>
                <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                <OperatorCaNav />
                <Link href="/sanctions" className="hover:text-[var(--color-text)]">Sanctions</Link>
                <Link href="/protocol" className="hover:text-[var(--color-text)]">Protocol</Link>
                <Link href="/treasury" className="hover:text-[var(--color-text)]">Treasury</Link>
                <Link href="/audit" className="hover:text-[var(--color-text)]">Audit</Link>
              </>
            }
            walletSlot={
              <span className="flex items-center gap-2">
                <AdminBadge />
                <ConnectWalletPill />
              </span>
            }
          />
          <WrongChainBanner />
          <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
          <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
            Scatter Admin · Powered by zkScatter · Tokamak Network
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
