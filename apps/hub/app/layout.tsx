import type { Metadata } from "next";
import { Nav } from "./components/Nav";
import { Footer } from "./components/Footer";
import "./globals.css";

export const metadata: Metadata = {
  title: "zkScatter — Private trades. Compliant identity. One ZK stack.",
  description:
    "Off-chain matching, on-chain ZK settlement, KYC-aware without doxxing your users. Apps for trading, payroll, and mobile.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
