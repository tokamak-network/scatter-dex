"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Shield, ArrowLeftRight, Radio, ClipboardList, Lock, ShieldCheck, Gift, FileText } from "lucide-react";

const sidebarLinks = [
  { href: "/trade/escrow", label: "Escrow", icon: Shield },
  { href: "/trade/private-escrow", label: "Private Escrow", icon: Lock },
  { href: "/trade/order", label: "Order", icon: ArrowLeftRight },
  { href: "/trade/private-order", label: "Private Order", icon: ShieldCheck },
  { href: "/trade/private-claim", label: "Private Claim", icon: Gift },
  { href: "/trade/private-history", label: "Private History", icon: FileText },
  { href: "/trade/history", label: "History", icon: ClipboardList },
  { href: "/trade/relayers", label: "Relayers", icon: Radio },
];

export default function TradeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-1 min-h-[calc(100vh-64px)]">
      {/* Sidebar */}
      <aside className="fixed left-0 top-16 h-[calc(100vh-64px)] w-64 bg-surface-container flex flex-col py-6 border-r border-outline-variant/15 z-30">
        <div className="px-6 mb-8">
          <h2 className="text-lg font-headline font-semibold text-on-surface">
            Trading Terminal
          </h2>
          <p className="text-xs text-on-surface-variant/70">Fluid Logic Execution</p>
        </div>
        <div className="flex flex-col gap-1 px-2">
          {sidebarLinks.map((link) => {
            const active = pathname === link.href || pathname.startsWith(link.href + "/");
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`flex items-center gap-3 rounded-md px-4 py-3 transition-all duration-200 ${
                  active
                    ? "bg-surface-bright text-primary"
                    : "text-on-surface-variant hover:bg-surface-bright/30 hover:text-on-surface"
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium text-sm">{link.label}</span>
              </Link>
            );
          })}
        </div>
      </aside>

      {/* Main Content */}
      <section className="flex-1 ml-64 p-8 max-w-[1600px]">{children}</section>
    </div>
  );
}
