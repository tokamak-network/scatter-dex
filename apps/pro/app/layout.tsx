import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider } from "@zkscatter/sdk/react";
import { ConnectWalletPill } from "./components/ConnectWalletPill";
import { RelayerPill } from "./components/RelayerPill";
import { NetworkSwitcher } from "./components/NetworkSwitcher";
import { VaultProvider } from "./lib/vault";
import { OrdersProvider } from "./lib/orders";
import { EdDSAKeyProvider } from "./lib/eddsaKey";
import { RelayersProvider } from "./lib/relayers";
import { TradeFormProvider } from "./lib/tradeForm";
import { ActiveNetworkProvider } from "./lib/activeNetwork";
import { MetaAddressProvider } from "./lib/metaAddress";
import { CommitmentTreeProvider } from "./lib/commitmentTree";
import { TokamakMark, ToastProvider } from "@zkscatter/ui";
import { DEMO_NETWORK } from "./lib/network";
import "./globals.css";

export const metadata: Metadata = {
  title: "Scatter Pro — Get the price you see",
  description:
    "Limit orders matched directly with other size traders. No MEV, no OTC desk spread, no RFQ leak. Settled on Ethereum mainnet.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider network={DEMO_NETWORK}>
          <ActiveNetworkProvider>
            <MetaAddressProvider>
              <CommitmentTreeProvider>
                <EdDSAKeyProvider>
                  <RelayersProvider>
                    <VaultProvider>
                      <OrdersProvider>
                        <TradeFormProvider>
                          <ToastProvider>
                            <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
                              🎉 Launch event — zero trading fees on every order until Dec 31, 2026.
                            </div>
                            <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
                              <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
                                <Link
                                  href="/"
                                  className="flex items-center gap-2 font-semibold tracking-tight text-[var(--color-primary)]"
                                >
                                  <TokamakMark height={22} />
                                  <span className="text-[var(--color-text)]">Scatter Pro</span>
                                </Link>
                                <nav className="flex items-center gap-4 text-sm text-[var(--color-text-muted)]">
                                  <a
                                    href={process.env.NEXT_PUBLIC_HUB_URL ?? "https://zkscatter.xyz"}
                                    className="hover:text-[var(--color-text)]"
                                  >
                                    ← All apps
                                  </a>
                                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                                  <Link href="/app" className="hover:text-[var(--color-text)]">Workbench</Link>
                                  <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
                                  <Link href="/inbox" className="hover:text-[var(--color-text)]">Inbox</Link>
                                  <NetworkSwitcher />
                                  <RelayerPill />
                                  <ConnectWalletPill />
                                </nav>
                              </div>
                            </header>
                            <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
                            <footer className="border-t border-[var(--color-border)] py-6 text-center text-xs text-[var(--color-text-subtle)]">
                              Scatter Pro · Powered by zkScatter · Tokamak Network
                            </footer>
                          </ToastProvider>
                        </TradeFormProvider>
                      </OrdersProvider>
                    </VaultProvider>
                  </RelayersProvider>
                </EdDSAKeyProvider>
              </CommitmentTreeProvider>
            </MetaAddressProvider>
          </ActiveNetworkProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
