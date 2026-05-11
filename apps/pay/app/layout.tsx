import type { Metadata } from "next";
import Link from "next/link";
import { PayProviders } from "./_lib/providers";
import { ConnectWalletPill } from "./_components/ConnectWalletPill";
import { Brand } from "./_components/Brand";
import { WrongChainBanner } from "./_components/WrongChainBanner";
import { StealthMenu } from "./_components/StealthMenu";
import { IdentityPill } from "./_components/IdentityPill";
import { IdentityMenu } from "./_components/IdentityMenu";
import { Pill, StatusDot, AppShellHeader } from "@zkscatter/ui";
import { chainName } from "@zkscatter/sdk";
import { getNetworkConfig } from "./_lib/network";
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
          <AppShellHeader
            brand={<Brand />}
            chainPill={<PayNetworkPill />}
            walletSlot={
              <div className="flex items-center gap-2">
                <IdentityPill />
                <ConnectWalletPill />
              </div>
            }
            navLinks={
              <>
                <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                <Link href="/dashboard" className="hover:text-[var(--color-text)]">Dashboard</Link>
                <Link href="/payouts/new" className="hover:text-[var(--color-text)]">New payout</Link>
                <Link href="/inbox" className="hover:text-[var(--color-text)]">Claims</Link>
                <Link href="/address-book" className="hover:text-[var(--color-text)]">Address book</Link>
                <IdentityMenu />
                <StealthMenu />
              </>
            }
          />
          <WrongChainBanner />
          <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
          <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
            Scatter Pay · Powered by zkScatter · zk-X509 audit trail · Tokamak Network
          </footer>
        </PayProviders>
      </body>
    </html>
  );
}

function PayNetworkPill() {
  const cfg = getNetworkConfig();
  const label = cfg.name ?? chainName(cfg.chainId);
  return (
    <Pill title={label}>
      <StatusDot kind="online" />
      <span>{label}</span>
    </Pill>
  );
}
