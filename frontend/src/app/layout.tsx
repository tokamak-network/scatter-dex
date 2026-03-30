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

// Inject all NEXT_PUBLIC_* env vars into the client via a <script> tag.
// Next.js 16 Turbopack does not inline NEXT_PUBLIC_* from process.env
// into client bundles when env vars are set at container runtime.
function buildRuntimeEnvScript(): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value) {
      env[key] = value;
    }
  }
  // Escape </script> sequences to prevent XSS via injected values
  const json = JSON.stringify(env).replace(/</g, "\\u003c");
  return `window.__ENV__=${json}`;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}>
      <body className="min-h-full flex flex-col bg-gray-950 text-white">
        <script dangerouslySetInnerHTML={{ __html: buildRuntimeEnvScript() }} />
        <WalletProvider>
          <Navbar />
          <main className="flex-1">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
