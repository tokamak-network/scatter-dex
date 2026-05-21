import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider } from "@zkscatter/sdk/react";
import { WrongChainBanner } from "./components/WrongChainBanner";
import { Brand } from "./components/Brand";
import { OperatorWalletDropdown } from "./components/OperatorWalletDropdown";
import { OperatorIdentityPill } from "./components/OperatorIdentityPill";
import { Pill, StatusDot, AppShellHeader } from "@zkscatter/ui";
import { DEMO_NETWORK } from "./lib/network";
import { OperatorProvider } from "./lib/useOperator";
import { FeeVaultProvider } from "./lib/useFeeVault";
import { OperatorIdentityProvider } from "./lib/identity";
import { IdentityMenu } from "./components/IdentityMenu";
import { DocsMenu } from "./components/DocsMenu";
import { MyMenu } from "./components/MyMenu";
import { PlatformMenu } from "./components/PlatformMenu";
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
            <OperatorIdentityProvider>
            <FeeVaultProvider>
            <AppShellHeader
              brand={<Brand />}
              chainPill={
                <Pill title={DEMO_NETWORK.name ?? "Network"}>
                  <StatusDot kind="online" />
                  <span>{DEMO_NETWORK.name ?? "Network"}</span>
                </Pill>
              }
              walletSlot={
                <div className="flex items-center gap-2">
                  <OperatorIdentityPill />
                  <OperatorWalletDropdown />
                </div>
              }
              topRibbon={
                <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
                  Relayer preview — Sepolia testnet. Pages with mock data are tagged inline.
                </div>
              }
              navLinks={
                <>
                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                  <PlatformMenu />
                  <MyMenu />
                  <DocsMenu />
                  <IdentityMenu />
                </>
              }
            />
            <WrongChainBanner />
            <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
            <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
              Scatter Relayer · Powered by zkScatter · Tokamak Network
            </footer>
            </FeeVaultProvider>
            </OperatorIdentityProvider>
          </OperatorProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
