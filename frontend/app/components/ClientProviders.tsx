"use client";

import { WalletProvider } from "../lib/wallet";
import Header from "./Header";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <Header />
      <main className="pt-16">{children}</main>
    </WalletProvider>
  );
}
