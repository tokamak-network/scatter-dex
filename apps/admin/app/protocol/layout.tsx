"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** Sub-nav for the /protocol section. The protocol page used to be
 *  a single very long scroll with five distinct concern areas
 *  (RelayerRegistry, Token whitelist, CommitmentPool,
 *  PrivateSettlement, IdentityGate). Splitting into sub-routes
 *  makes each area its own focused screen the admin can deep-link
 *  to. The sub-nav lives in a layout so it persists across the
 *  child pages. */
const TABS: { href: string; label: string }[] = [
  { href: "/protocol/relayer-registry", label: "RelayerRegistry" },
  { href: "/protocol/tokens", label: "Tokens" },
  { href: "/protocol/commitment-pool", label: "CommitmentPool" },
  { href: "/protocol/settlement", label: "PrivateSettlement" },
  { href: "/protocol/identity-user", label: "Identity (user)" },
  { href: "/protocol/identity-relayer", label: "Identity (relayer)" },
];

export default function ProtocolLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Protocol parameters</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Governed parameters across <code className="font-mono">RelayerRegistry</code>,{" "}
          <code className="font-mono">CommitmentPool</code>,{" "}
          <code className="font-mono">PrivateSettlement</code>, and{" "}
          <code className="font-mono">IdentityGate</code>. Reads are live; writes require the
          contract owner's signature.
        </p>
      </header>
      <nav className="border-b border-[var(--color-border)]">
        <ul className="flex flex-wrap gap-1">
          {TABS.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + "/");
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  className={
                    "inline-block border-b-2 px-3 py-2 text-sm transition " +
                    (active
                      ? "border-[var(--color-primary)] font-medium text-[var(--color-text)]"
                      : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]")
                  }
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div>{children}</div>
    </div>
  );
}
