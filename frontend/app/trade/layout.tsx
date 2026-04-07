"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, ShieldCheck, Gift, FileText } from "lucide-react";

const privateLinks = [
  { href: "/trade/private-escrow", label: "Escrow", icon: Lock },
  { href: "/trade/private-order", label: "Order", icon: ShieldCheck },
  { href: "/trade/private-claim", label: "Claim", icon: Gift },
  { href: "/trade/private-history", label: "History", icon: FileText },
];

export default function TradeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const renderLink = (link: typeof privateLinks[number]) => {
    const active = pathname === link.href || pathname.startsWith(link.href + "/");
    const Icon = link.icon;
    return (
      <Link
        key={link.href}
        href={link.href}
        className={`flex items-center gap-3 rounded-md px-4 py-2.5 transition-all duration-200 ${
          active
            ? "bg-surface-bright text-primary"
            : "text-on-surface-variant hover:bg-surface-bright/30 hover:text-on-surface"
        }`}
      >
        <Icon className="w-5 h-5" />
        <span className="font-medium text-sm">{link.label}</span>
      </Link>
    );
  };

  return (
    <div className="flex flex-1 min-h-[calc(100vh-64px)]">
      {/* Sidebar */}
      <aside className="fixed left-0 top-16 h-[calc(100vh-64px)] w-64 bg-surface-container flex flex-col py-6 border-r border-outline-variant/15 z-30">
        <div className="px-6 mb-6">
          <h2 className="text-lg font-headline font-semibold text-on-surface">
            Secret Trade
          </h2>
          <p className="text-xs text-on-surface-variant/70">ZK Privacy-Preserving Exchange</p>
        </div>

        <div className="flex flex-col gap-0.5 px-2">
          {privateLinks.map(renderLink)}
        </div>
      </aside>

      {/* Main Content */}
      <section className="flex-1 ml-64 p-8 max-w-[1600px]">{children}</section>
    </div>
  );
}
