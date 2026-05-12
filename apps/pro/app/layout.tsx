import type { Metadata } from "next";
import Link from "next/link";
import { WalletProvider } from "@zkscatter/sdk/react";
import { ConnectWalletPill } from "./components/ConnectWalletPill";
import { WrongChainBanner } from "./components/WrongChainBanner";
import { AppShellHeader } from "@zkscatter/ui";
import { NetworkSwitcher } from "./components/NetworkSwitcher";
import { VaultProvider } from "./lib/vault";
import { VaultReconciler } from "./lib/vaultReconciler";
import { OrdersProvider } from "./lib/orders";
import { ClaimReconciler } from "./lib/claimReconciler";
import { EdDSAKeyProvider } from "@zkscatter/sdk/react";
import { RelayersProvider } from "./lib/relayers";
import { TradeFormProvider } from "./lib/tradeForm";
import { ActiveNetworkProvider } from "./lib/activeNetwork";
import { FolderProvider } from "./lib/folder";
import { WalletBookProvider } from "./lib/walletBook";
import { CommitmentTreeProvider } from "./lib/commitmentTree";
import { ToastProvider } from "@zkscatter/ui";
import { Brand } from "./components/Brand";
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
            <FolderProvider>
             <WalletBookProvider>
              <CommitmentTreeProvider>
                <EdDSAKeyProvider>
                  <RelayersProvider>
                    <VaultProvider>
                      <VaultReconciler />
                      <OrdersProvider>
                        <ClaimReconciler />
                        <TradeFormProvider>
                          <ToastProvider>
                            <AppShellHeader
                              brand={<Brand />}
                              chainPill={<NetworkSwitcher />}
                              walletSlot={<ConnectWalletPill />}
                              topRibbon={
                                <div className="bg-[var(--color-primary)] py-2 text-center text-xs font-medium text-white">
                                  🎉 Launch event — zero trading fees on every order until Dec 31, 2026.
                                </div>
                              }
                              navLinks={
                                <>
                                  <Link href="/" className="hover:text-[var(--color-text)]">Home</Link>
                                  <Link href="/app" className="hover:text-[var(--color-text)]">Workbench</Link>
                                  <Link href="/orders" className="hover:text-[var(--color-text)]">Orders</Link>
                                  <Link href="/address-book" className="hover:text-[var(--color-text)]">Address book</Link>
                                </>
                              }
                            />
                            <WrongChainBanner />
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
             </WalletBookProvider>
            </FolderProvider>
          </ActiveNetworkProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
