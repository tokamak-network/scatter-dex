"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useWallet } from "../lib/wallet";
import { RPC_URL, EXPECTED_CHAIN_ID, getChainName } from "../lib/config";
import { shortenAddress } from "../lib/utils";

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/identity", label: "Identity Verification" },
  { href: "/trade", label: "Secret Trade" },
  { href: "/relayer", label: "Relayer" },
];

function shortenRpc(url: string) {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? `:${u.port}` : "");
  } catch {
    return url;
  }
}

export default function Header() {
  const pathname = usePathname();
  const { account, chainId, connect, disconnect } = useWallet();

  const isWrongNetwork = account && chainId !== null && chainId !== EXPECTED_CHAIN_ID;

  return (
    <>
      <header className="fixed top-0 left-0 w-full z-40 bg-background">
        <nav className="flex justify-between items-center w-full px-8 h-16 max-w-[1920px] mx-auto">
          {/* Left: Logo + Service Info */}
          <div className="flex items-center gap-4">
            <Link href="/" className="text-2xl font-headline font-bold tracking-tight text-on-surface">
              zkScatter
            </Link>
            <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-md bg-surface-container border border-outline-variant/10">
              <span className="w-1.5 h-1.5 rounded-full bg-tertiary" />
              <span className="text-[10px] font-mono text-on-surface-variant">
                {getChainName(EXPECTED_CHAIN_ID)} ({EXPECTED_CHAIN_ID})
              </span>
              <span className="text-outline-variant">|</span>
              <span className="text-[10px] font-mono text-on-surface-variant">
                {shortenRpc(RPC_URL)}
              </span>
            </div>
          </div>

          {/* Center: Nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => {
              const active = pathname === link.href || (link.href !== "/" && pathname.startsWith(link.href));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`text-sm font-medium transition-colors ${
                    active
                      ? "text-primary border-b-2 border-primary pb-1"
                      : "text-on-surface-variant hover:text-on-surface"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>

          {/* Right: Wallet */}
          <div className="flex items-center gap-3">
            {account && chainId !== null && (
              <div
                className={`hidden md:flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-mono ${
                  isWrongNetwork
                    ? "bg-error/10 border border-error/30 text-error"
                    : "bg-surface-container border border-outline-variant/10 text-on-surface-variant"
                }`}
              >
                {isWrongNetwork && <AlertTriangle className="w-3.5 h-3.5" />}
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: isWrongNetwork ? undefined : "#9bffce" }} />
                {getChainName(chainId)}
              </div>
            )}
            {account ? (
              <button
                onClick={disconnect}
                className="bg-surface-container text-on-surface px-5 py-2 rounded-md font-semibold text-sm border border-outline-variant/20 hover:bg-surface-bright transition-all font-mono"
              >
                {shortenAddress(account)}
              </button>
            ) : (
              <button
                onClick={connect}
                className="gradient-btn text-on-primary-fixed px-5 py-2 rounded-md font-semibold text-sm active:scale-95 duration-100 transition-all"
              >
                Connect Wallet
              </button>
            )}
          </div>
        </nav>
      </header>

      {/* Wrong Network Banner */}
      {isWrongNetwork && (
        <div className="fixed top-16 left-0 w-full z-30 bg-error/10 border-b border-error/20 px-8 py-3 flex items-center justify-center gap-3">
          <AlertTriangle className="w-4 h-4 text-error" />
          <span className="text-sm text-error font-medium">
            Wrong network: connected to {getChainName(chainId!)} ({chainId}) — please switch to{" "}
            <strong>{getChainName(EXPECTED_CHAIN_ID)} ({EXPECTED_CHAIN_ID})</strong>
          </span>
        </div>
      )}
    </>
  );
}
