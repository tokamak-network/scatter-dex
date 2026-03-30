import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet";
import Navbar from "@/components/Navbar";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ScatterDEX",
  description: "Privacy-preserving DEX with Scatter Settlement",
};

// Inject runtime env vars into the client via a <script> tag.
// Next.js 16 Turbopack does not inline NEXT_PUBLIC_* from process.env
// into client bundles when env vars are set at container runtime.
const runtimeEnv = JSON.stringify({
  NEXT_PUBLIC_SETTLEMENT_ADDRESS: process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS ?? "",
  NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS: process.env.NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS ?? "",
  NEXT_PUBLIC_RPC_URL: process.env.NEXT_PUBLIC_RPC_URL ?? "http://localhost:8545",
  NEXT_PUBLIC_TOKEN_LIST: process.env.NEXT_PUBLIC_TOKEN_LIST ?? "",
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="min-h-full flex flex-col bg-gray-950 text-white">
        <script dangerouslySetInnerHTML={{ __html: `window.__ENV__=${runtimeEnv}` }} />
        <WalletProvider>
          <Navbar />
          <main className="flex-1">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
