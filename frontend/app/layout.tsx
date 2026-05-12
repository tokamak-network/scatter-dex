import type { Metadata } from "next";
import "./globals.css";
import { ClientProviders } from "./components/ClientProviders";

export const metadata: Metadata = {
  title: "zkScatter | Privacy-Preserving DEX",
  description: "Secure and decentralized trading with zero-knowledge settlements.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen selection:bg-primary/30">
        <div className="noise-overlay" />
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
